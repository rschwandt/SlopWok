// SQLite über das in Node eingebaute node:sqlite – keine nativen Abhängigkeiten.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mergeAutoDinners } from './logic.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS households (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, invite TEXT NOT NULL UNIQUE,
  settings TEXT NOT NULL DEFAULT '{}', created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, display TEXT NOT NULL,
  pass TEXT NOT NULL, settings TEXT NOT NULL DEFAULT '{}',
  household_id INTEGER NOT NULL REFERENCES households(id), created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created INTEGER NOT NULL
);
-- owner_id NULL = mitgeliefertes Gericht; key = stabile Kennung der mitgelieferten Gerichte
CREATE TABLE IF NOT EXISTS dishes (
  id INTEGER PRIMARY KEY, owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL, key TEXT UNIQUE,
  name TEXT NOT NULL, slot TEXT NOT NULL, data TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL
);
-- Eine geplante Mahlzeit eines Haushalts. leftover_of: Rest einer früheren Mahlzeit (nichts einzukaufen).
-- custom: freier Eintrag ohne Gericht, JSON {name, protein, kcal}.
CREATE TABLE IF NOT EXISTS meals (
  id INTEGER PRIMARY KEY, household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  date TEXT NOT NULL, slot TEXT NOT NULL, dish_id INTEGER REFERENCES dishes(id), custom TEXT,
  cook_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  leftover_of INTEGER REFERENCES meals(id) ON DELETE CASCADE,
  created_by INTEGER, created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS meals_hh_date ON meals(household_id, date);
CREATE TABLE IF NOT EXISTS meal_eaters (
  meal_id INTEGER NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  portions REAL NOT NULL DEFAULT 1, eaten INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (meal_id, user_id)
);
CREATE INDEX IF NOT EXISTS eaters_user ON meal_eaters(user_id);
-- Ein Einkauf deckt die Tage from_date..to_date ab.
CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY, household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  from_date TEXT NOT NULL, to_date TEXT NOT NULL, shopper_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  done_at INTEGER, UNIQUE (household_id, from_date)
);
CREATE TABLE IF NOT EXISTS trip_checks (
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE, key TEXT NOT NULL, PRIMARY KEY (trip_id, key)
);
CREATE TABLE IF NOT EXISTS trip_items (
  id INTEGER PRIMARY KEY, trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  text TEXT NOT NULL, by_id INTEGER, got INTEGER NOT NULL DEFAULT 0
);
-- kind: 'expense' (Ausgabe, auf shares verteilt) oder 'transfer' (Ausgleichszahlung payer -> Empfänger in shares)
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY, household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  payer_id INTEGER NOT NULL REFERENCES users(id), cents INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'expense', split TEXT NOT NULL DEFAULT 'equal',
  trip_id INTEGER REFERENCES trips(id) ON DELETE SET NULL, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS expense_shares (
  expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id), cents INTEGER NOT NULL, PRIMARY KEY (expense_id, user_id)
);
CREATE TABLE IF NOT EXISTS follows (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY (user_id, target_id)
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_id INTEGER REFERENCES users(id) ON DELETE SET NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notif_user ON notifications(user_id, created);
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL, auth TEXT NOT NULL, created INTEGER NOT NULL
);
-- Vorschlagsmodus: hier wurde ein Vorschlag bewusst entfernt und soll nicht wiederkommen
CREATE TABLE IF NOT EXISTS auto_skips (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, date TEXT NOT NULL, slot TEXT NOT NULL,
  PRIMARY KEY (user_id, date, slot)
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  // Nachträglich ergänzte Spalten für Datenbanken aus älteren Versionen
  const hasCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c);
  if (!hasCol('meals', 'auto')) db.exec('ALTER TABLE meals ADD COLUMN auto INTEGER NOT NULL DEFAULT 0');

  const cache = new Map();
  const stmt = sql => { let s = cache.get(sql); if (!s) cache.set(sql, (s = db.prepare(sql))); return s; };
  const api = {
    raw: db,
    get: (sql, ...p) => stmt(sql).get(...p),
    all: (sql, ...p) => stmt(sql).all(...p),
    run: (sql, ...p) => stmt(sql).run(...p),
    insert: (sql, ...p) => Number(stmt(sql).run(...p).lastInsertRowid),
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    kv: {
      get: k => { const r = api.get('SELECT v FROM kv WHERE k = ?', k); return r ? JSON.parse(r.v) : undefined; },
      set: (k, v) => api.run('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v))
    },
    close: () => db.close()
  };
  seed(api);
  splitSoloMeals(api);
  mergeDinnersOnce(api);
  return api;
}

// Einmalig: Haushalte, in die jemand samt eigenem Vorschlagsplan gezogen ist, hatten mehrere vorgeschlagene warme
// Gerichte pro Tag. Die werden zusammengelegt; außerdem doppelte eigene Mahlzeiten (gleiches Gericht, gleiche
// Mahlzeit, gleicher Tag – Rest der Aufteilung durch splitSoloMeals) entfernt, solange nichts davon gegessen ist.
function mergeDinnersOnce(db) {
  if (db.kv.get('mergeDinners')) return;
  const n = new Date(), today = n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
  db.tx(() => {
    for (const h of db.all('SELECT id FROM households')) mergeAutoDinners(db, h.id, today);
    db.run(`DELETE FROM meals WHERE id IN (
      SELECT m2.id FROM meals m1 JOIN meals m2 ON m2.household_id = m1.household_id AND m2.date = m1.date AND m2.slot = m1.slot
        AND m2.dish_id = m1.dish_id AND m2.id > m1.id
      JOIN meal_eaters e1 ON e1.meal_id = m1.id JOIN meal_eaters e2 ON e2.meal_id = m2.id AND e2.user_id = e1.user_id
      WHERE m1.date >= ? AND m1.slot != 'dinner' AND m1.leftover_of IS NULL AND m2.leftover_of IS NULL AND e2.eaten = 0
        AND (SELECT COUNT(*) FROM meal_eaters x WHERE x.meal_id = m2.id) = 1)`, today);
    db.kv.set('mergeDinners', 1);
  });
}

// Seit nur noch das warme Gericht gemeinsam ist: ältere gemeinsame Frühstücke, Mittage, Snacks und Extras
// einmalig in je eine Mahlzeit pro Person aufteilen (Reste vom warmen Gericht bleiben gemeinsam).
function splitSoloMeals(db) {
  if (db.kv.get('soloMeals')) return;
  db.tx(() => {
    const shared = db.all(`SELECT m.* FROM meals m WHERE m.slot != 'dinner' AND m.leftover_of IS NULL
                           AND (SELECT COUNT(*) FROM meal_eaters e WHERE e.meal_id = m.id) > 1`);
    for (const m of shared) {
      const [, ...rest] = db.all('SELECT * FROM meal_eaters WHERE meal_id = ? ORDER BY user_id', m.id);
      for (const e of rest) {
        const id = db.insert('INSERT INTO meals (household_id, date, slot, dish_id, custom, auto, created_by, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          m.household_id, m.date, m.slot, m.dish_id, m.custom, m.auto, m.created_by, m.created);
        db.run('UPDATE meal_eaters SET meal_id = ? WHERE meal_id = ? AND user_id = ?', id, m.id, e.user_id);
      }
    }
    db.run("UPDATE meals SET cook_id = NULL WHERE slot != 'dinner'");
    db.kv.set('soloMeals', 1);
  });
}

// Mitgelieferte Gerichte einspielen bzw. aktualisieren (erkennbar am key, gehören niemandem).
function seed(db) {
  const seedData = JSON.parse(fs.readFileSync(path.join(here, 'seed.json'), 'utf8'));
  const hash = crypto.createHash('sha1').update(JSON.stringify(seedData.dishes)).digest('hex');
  if (db.kv.get('seedHash') === hash) return;
  db.tx(() => {
    for (const d of seedData.dishes) {
      const { key, ...data } = d;
      db.run(`INSERT INTO dishes (owner_id, key, name, slot, data, created) VALUES (NULL, ?, ?, ?, ?, ?)
              ON CONFLICT (key) DO UPDATE SET name = excluded.name, slot = excluded.slot, data = excluded.data`,
        key, d.name, d.slot, JSON.stringify(data), Date.now());
    }
    db.kv.set('seedHash', hash);
    db.kv.set('template', seedData.template);
    db.kv.set('basicInfo', seedData.basicInfo);
  });
}
