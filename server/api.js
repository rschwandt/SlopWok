// Alle /api-Routen. Jede Route bekommt einen Kontext { db, user, hh, members, params, query, body, today } und gibt ein JSON-Objekt zurück.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { validateDish, SLOTS } from '../shared/dish.js';
import * as L from './logic.js';
import { sendPush, generateVapidKeys } from './push.js';
import { makeAuto } from './auto.js';

const scrypt = promisify(crypto.scrypt);

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg, status = 400) => { throw new HttpError(status, msg); };

// ---------- Hilfen ----------
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + (await scrypt(pw, salt, 32)).toString('hex');
}
async function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const h = await scrypt(pw, Buffer.from(salt, 'hex'), 32);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
}
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const inviteCode = () => Array.from(crypto.randomBytes(8), b => CODE_CHARS[b % CODE_CHARS.length]).join('');
const text = (v, max, min = 0) => {
  const s = typeof v === 'string' ? v.trim().slice(0, max) : '';
  if (s.length < min) bad('Eingabe fehlt oder ist zu kurz.');
  return s;
};
const int = v => (Number.isInteger(Number(v)) ? Number(v) : bad('Ungültige Kennung.'));
function cents(v) {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/\s|€/g, '').replace(',', '.'));
  const c = Math.round(n * 100);
  if (!(c > 0 && c <= 1e7)) bad('Bitte einen Betrag größer 0 angeben.');
  return c;
}
const date = v => (L.isIso(v) ? v : bad('Ungültiges Datum.'));
const MEAL_SLOTS = [...SLOTS, 'extra'];
// Gemeinsam gegessen (und für andere ausgewählt) wird nur das warme Gericht – und sein Rest am Folgetag.
// Frühstück, Mittag, Snack und Extras plant jede Person nur für sich.
const SOLO_MSG = 'Zusammen esst ihr nur das warme Gericht. Frühstück, Mittag, Snack und Extras plant jede Person für sich.';
const isShared = m => m.slot === 'dinner' || !!m.leftover_of;

const publicUser = u => ({ id: u.id, name: u.name, display: u.display });
const membersOf = (db, hhId) => db.all('SELECT * FROM users WHERE household_id = ? ORDER BY id', hhId);

function createHousehold(db, name) {
  return db.insert('INSERT INTO households (name, invite, settings, created) VALUES (?, ?, ?, ?)', name, inviteCode(), '{}', Date.now());
}

// Nutzer aus allen künftigen Mahlzeiten eines Haushalts nehmen; Mahlzeiten ohne Esser verschwinden.
function removeFromFutureMeals(db, userId, hhId, today) {
  db.run('DELETE FROM meal_eaters WHERE user_id = ? AND meal_id IN (SELECT id FROM meals WHERE household_id = ? AND date >= ?)', userId, hhId, today);
  db.run('UPDATE meals SET cook_id = NULL WHERE cook_id = ? AND household_id = ? AND date >= ?', userId, hhId, today);
  db.run('DELETE FROM meals WHERE household_id = ? AND date >= ? AND id NOT IN (SELECT meal_id FROM meal_eaters)', hhId, today);
}
// Haushaltswechsel. War man allein, zieht der eigene Plan mit um und der leere Haushalt wird gelöscht.
function moveUser(db, user, targetHhId, today) {
  const old = user.household_id;
  db.run('UPDATE users SET household_id = ? WHERE id = ?', targetHhId, user.id);
  const left = db.get('SELECT COUNT(*) AS n FROM users WHERE household_id = ?', old).n;
  if (left === 0) {
    db.run('UPDATE meals SET household_id = ? WHERE household_id = ?', targetHhId, old);
    db.run('DELETE FROM households WHERE id = ?', old);
    // Der mitgebrachte Vorschlagsplan darf kein zweites warmes Gericht neben dem des Haushalts aufmachen
    L.mergeAutoDinners(db, targetHhId, today);
  } else {
    removeFromFutureMeals(db, user.id, old, today);
    db.run('UPDATE trips SET shopper_id = NULL WHERE shopper_id = ? AND household_id = ? AND done_at IS NULL', user.id, old);
  }
}

const canSee = (viewer, target) => {
  if (viewer.id === target.id) return true;
  const share = L.userSettings(target).share;
  return share === 'all' || (share === 'household' && viewer.household_id === target.household_id);
};

export function createApi(db, cfg = {}) {
  let vapid = db.kv.get('vapid');
  if (!vapid) db.kv.set('vapid', (vapid = generateVapidKeys()));
  const subject = cfg.vapidSubject || 'mailto:admin@example.com';
  const pushFetch = cfg.pushFetch || fetch;
  const auto = makeAuto(db);

  // Benachrichtigung speichern und (ohne darauf zu warten) als Push verschicken.
  function notify(userId, fromId, kind, msg, title) {
    db.run('INSERT INTO notifications (user_id, from_id, kind, text, created) VALUES (?, ?, ?, ?, ?)', userId, fromId, kind, msg, Date.now());
    db.run('DELETE FROM notifications WHERE user_id = ? AND id NOT IN (SELECT id FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100)', userId, userId);
    const subs = db.all('SELECT * FROM push_subs WHERE user_id = ?', userId);
    const jobs = subs.map(async s => {
      const r = await sendPush(s, { title: title || 'SlopWok', body: msg, tag: kind, url: kind === 'nudge' ? '/#today' : '/#people' }, vapid, subject, pushFetch);
      if (r === 'gone') db.run('DELETE FROM push_subs WHERE endpoint = ?', s.endpoint);
      return r;
    });
    const all = Promise.all(jobs).catch(() => []);
    if (cfg.onPush) cfg.onPush(all);
    return all;
  }

  function mePayload(user) {
    const hh = db.get('SELECT * FROM households WHERE id = ?', user.household_id);
    return {
      user: { ...publicUser(user), settings: L.userSettings(user) },
      household: { id: hh.id, name: hh.name, invite: hh.invite, settings: L.hhSettings(hh), members: membersOf(db, hh.id).map(m => ({ ...publicUser(m), portion: L.userSettings(m).portion })) },
      unread: db.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0', user.id).n,
      // jüngster ungelesener Anstupser der letzten 24 Stunden, für Woki auf „Heute"
      nudge: db.get("SELECT text, created FROM notifications WHERE user_id = ? AND kind = 'nudge' AND read = 0 AND created > ? ORDER BY id DESC LIMIT 1", user.id, Date.now() - 864e5) || null,
      vapidKey: vapid.publicKey,
      template: db.kv.get('template')?.name || null
    };
  }
  function startSession(user) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.run('INSERT INTO sessions (token, user_id, created) VALUES (?, ?, ?)', sha(token), user.id, Date.now());
    return token;
  }

  const routes = [];
  const route = (method, path, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, open: !!opts.open });
  };

  // ---------- Konto ----------
  route('POST', '/api/register', async c => {
    if (cfg.registrationCode && c.body.code !== cfg.registrationCode) bad('Der Registrierungscode stimmt nicht.', 403);
    const name = text(c.body.name, 24).toLowerCase();
    if (!/^[a-z0-9_.-]{3,24}$/.test(name)) bad('Benutzername: 3–24 Zeichen, nur Buchstaben, Ziffern, Punkt, Strich und Unterstrich.');
    const display = text(c.body.display, 40) || name;
    if (typeof c.body.password !== 'string' || c.body.password.length < 8) bad('Das Passwort braucht mindestens 8 Zeichen.');
    if (c.body.password.length > 200) bad('Das Passwort ist zu lang.');
    let target = null;
    const invite = text(c.body.invite, 16).toUpperCase();
    if (invite) target = db.get('SELECT * FROM households WHERE invite = ?', invite) || bad('Diesen Einladungscode gibt es nicht.');
    if (db.get('SELECT 1 FROM users WHERE name = ?', name)) bad('Der Benutzername ist schon vergeben.', 409);
    const pass = await hashPassword(c.body.password);
    const id = db.tx(() => {
      if (db.get('SELECT 1 FROM users WHERE name = ?', name)) bad('Der Benutzername ist schon vergeben.', 409);
      const hhId = target ? target.id : createHousehold(db, 'Haushalt von ' + display);
      return db.insert('INSERT INTO users (name, display, pass, settings, household_id, created) VALUES (?, ?, ?, ?, ?, ?)', name, display, pass, '{}', hhId, Date.now());
    });
    const user = db.get('SELECT * FROM users WHERE id = ?', id);
    if (target) for (const m of membersOf(db, target.id)) if (m.id !== id) notify(m.id, id, 'household', display + ' ist eurem Haushalt beigetreten.');
    return { ...mePayload(user), _session: startSession(user) };
  }, { open: true });

  route('POST', '/api/login', async c => {
    const user = db.get('SELECT * FROM users WHERE name = ?', text(c.body.name, 24));
    const ok = user && typeof c.body.password === 'string' && await checkPassword(c.body.password.slice(0, 200), user.pass);
    if (!ok) bad('Benutzername oder Passwort stimmt nicht.', 401);
    return { ...mePayload(user), _session: startSession(user) };
  }, { open: true });

  route('POST', '/api/logout', c => {
    if (c.token) db.run('DELETE FROM sessions WHERE token = ?', sha(c.token));
    return { _session: '' };
  }, { open: true });

  route('GET', '/api/config', () => ({ registrationCode: !!cfg.registrationCode }), { open: true });
  route('GET', '/api/me', c => mePayload(c.user));

  route('PATCH', '/api/me', async c => {
    const b = c.body, s = L.userSettings(c.user);
    if (b.display != null) db.run('UPDATE users SET display = ? WHERE id = ?', text(b.display, 40, 1), c.user.id);
    if (b.settings && typeof b.settings === 'object') {
      const n = b.settings;
      if (n.pGoal != null) s.pGoal = Math.min(400, Math.max(20, Math.round(+n.pGoal) || s.pGoal));
      if (n.kGoal != null) s.kGoal = Math.min(8000, Math.max(800, Math.round(+n.kGoal) || s.kGoal));
      if (n.portion != null && +n.portion >= 0.5 && +n.portion <= 4) s.portion = Math.round(+n.portion * 4) / 4;
      if (['none', 'household', 'all'].includes(n.share)) s.share = n.share;
      if (typeof n.nudge === 'boolean') s.nudge = n.nudge;
      if (['manual', 'auto'].includes(n.mode)) s.mode = n.mode;
      if (Array.isArray(n.autoSlots)) s.autoSlots = SLOTS.filter(x => n.autoSlots.includes(x));
      if (typeof n.autoLeftover === 'boolean') s.autoLeftover = n.autoLeftover;
      if (n.profile === null) s.profile = null;
      else if (n.profile && typeof n.profile === 'object') {
        const p = n.profile, within = (v, lo, hi) => (Number(v) >= lo && Number(v) <= hi ? Math.round(Number(v) * 10) / 10 : bad('Bitte die Angaben prüfen.'));
        s.profile = {
          weight: within(p.weight, 30, 300), height: within(p.height, 120, 230), age: within(p.age, 14, 99),
          sex: ['m', 'f', 'x'].includes(p.sex) ? p.sex : 'x', activity: within(p.activity, 1, 4),
          goal: ['lose', 'keep', 'gain', 'muscle'].includes(p.goal) ? p.goal : 'keep'
        };
      }
      db.run('UPDATE users SET settings = ? WHERE id = ?', JSON.stringify(s), c.user.id);
      if (s.share !== 'all') db.run('DELETE FROM follows WHERE target_id = ? AND user_id NOT IN (SELECT id FROM users WHERE household_id = ?)', c.user.id, c.user.household_id);
    }
    if (b.password != null) {
      if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 200) bad('Das neue Passwort braucht mindestens 8 Zeichen.');
      if (typeof b.oldPassword !== 'string' || !(await checkPassword(b.oldPassword, c.user.pass))) bad('Das bisherige Passwort stimmt nicht.', 403);
      db.run('UPDATE users SET pass = ? WHERE id = ?', await hashPassword(b.password), c.user.id);
      db.run('DELETE FROM sessions WHERE user_id = ? AND token != ?', c.user.id, sha(c.token));
    }
    return mePayload(db.get('SELECT * FROM users WHERE id = ?', c.user.id));
  });

  // ---------- Haushalt ----------
  route('PATCH', '/api/household', c => {
    const s = L.hhSettings(c.hh);
    if (c.body.name != null) db.run('UPDATE households SET name = ? WHERE id = ?', text(c.body.name, 60, 1), c.hh.id);
    const n = c.body.settings;
    if (n && typeof n === 'object') {
      if (Array.isArray(n.shopDays)) {
        const days = [...new Set(n.shopDays.map(Number).filter(d => d >= 0 && d <= 6))].sort();
        if (days.length) s.shopDays = days;
      }
      if (['equal', 'usage'].includes(n.split)) s.split = n.split;
      db.run('UPDATE households SET settings = ? WHERE id = ?', JSON.stringify(s), c.hh.id);
    }
    return mePayload(c.user);
  });
  route('POST', '/api/household/invite', c => {
    db.run('UPDATE households SET invite = ? WHERE id = ?', inviteCode(), c.hh.id);
    return mePayload(c.user);
  });
  route('POST', '/api/household/join', c => {
    const target = db.get('SELECT * FROM households WHERE invite = ?', text(c.body.code, 16).toUpperCase()) || bad('Diesen Einladungscode gibt es nicht.', 404);
    if (target.id === c.hh.id) bad('Du bist schon in diesem Haushalt.');
    db.tx(() => moveUser(db, c.user, target.id, c.today));
    for (const m of membersOf(db, target.id)) if (m.id !== c.user.id) notify(m.id, c.user.id, 'household', c.user.display + ' ist eurem Haushalt beigetreten.');
    return mePayload(db.get('SELECT * FROM users WHERE id = ?', c.user.id));
  });
  route('POST', '/api/household/leave', c => {
    if (c.members.length < 2) bad('Du bist allein in diesem Haushalt.');
    db.tx(() => moveUser(db, c.user, createHousehold(db, 'Haushalt von ' + c.user.display), c.today));
    return mePayload(db.get('SELECT * FROM users WHERE id = ?', c.user.id));
  });

  // ---------- Gerichte ----------
  const dishOut = (r, userId) => ({ id: r.id, owner: r.owner_id, ownerName: r.owner_display || null, mine: r.owner_id === userId, builtin: r.owner_id == null && !!r.key, ...JSON.parse(r.data) });
  const visibleDish = (c, id) => db.get(`SELECT d.*, u.display AS owner_display FROM dishes d LEFT JOIN users u ON u.id = d.owner_id
    WHERE d.id = ? AND d.deleted = 0 AND (d.key IS NOT NULL OR d.owner_id IN (SELECT id FROM users WHERE household_id = ?))`, id, c.hh.id);

  route('GET', '/api/dishes', c => ({
    dishes: db.all(`SELECT d.*, u.display AS owner_display FROM dishes d LEFT JOIN users u ON u.id = d.owner_id
      WHERE d.deleted = 0 AND (d.key IS NOT NULL OR d.owner_id IN (SELECT id FROM users WHERE household_id = ?)) ORDER BY d.name COLLATE NOCASE`, c.hh.id)
      .map(r => dishOut(r, c.user.id)),
    basicInfo: db.kv.get('basicInfo') || {}
  }));
  const insertDish = (c, dish) => db.insert('INSERT INTO dishes (owner_id, name, slot, data, created) VALUES (?, ?, ?, ?, ?)', c.user.id, dish.name, dish.slot, JSON.stringify(dish), Date.now());
  route('POST', '/api/dishes', c => {
    const { dish, errors } = validateDish(c.body);
    if (!dish) bad(errors.join(' '));
    return { dish: dishOut(visibleDish(c, insertDish(c, dish)), c.user.id) };
  });
  route('POST', '/api/dishes/import', c => {
    const items = Array.isArray(c.body.items) ? c.body.items : bad('„items" fehlt.');
    if (items.length > 100) bad('Höchstens 100 Gerichte pro Import.');
    const checked = items.map(validateDish);
    const failed = checked.map((r, i) => ({ index: i, name: items[i]?.name || '', errors: r.errors })).filter(r => r.errors.length);
    if (failed.length) return { created: [], failed };
    const ids = db.tx(() => checked.map(r => insertDish(c, r.dish)));
    return { created: ids.map(id => dishOut(visibleDish(c, id), c.user.id)), failed: [] };
  });
  route('PUT', '/api/dishes/:id', c => {
    const row = visibleDish(c, int(c.params.id)) || bad('Gericht nicht gefunden.', 404);
    if (row.owner_id !== c.user.id) bad('Nur wer das Gericht angelegt hat, kann es ändern.', 403);
    const { dish, errors } = validateDish(c.body);
    if (!dish) bad(errors.join(' '));
    db.run('UPDATE dishes SET name = ?, slot = ?, data = ? WHERE id = ?', dish.name, dish.slot, JSON.stringify(dish), row.id);
    return { dish: dishOut(visibleDish(c, row.id), c.user.id) };
  });
  route('DELETE', '/api/dishes/:id', c => {
    const row = visibleDish(c, int(c.params.id)) || bad('Gericht nicht gefunden.', 404);
    if (row.owner_id !== c.user.id) bad('Nur wer das Gericht angelegt hat, kann es löschen.', 403);
    db.run('UPDATE dishes SET deleted = 1 WHERE id = ?', row.id); // geplante Mahlzeiten behalten ihr Gericht
    return { ok: true };
  });

  // ---------- Mahlzeiten ----------
  const memberIds = c => new Set(c.members.map(m => m.id));
  function eatersIn(c, list, allowEmpty) {
    if (!Array.isArray(list)) bad('„eaters" fehlt.');
    const ids = memberIds(c), seen = new Set(), out = [];
    for (const e of list) {
      const userId = int(e.userId), portions = Math.round(Number(e.portions) * 4) / 4;
      if (!ids.has(userId)) bad('Mitesser gehören nicht zum Haushalt.');
      if (!(portions >= 0.25 && portions <= 10)) bad('Portionen müssen zwischen ¼ und 10 liegen.');
      if (seen.has(userId)) continue;
      seen.add(userId); out.push({ userId, portions });
    }
    if (!out.length && !allowEmpty) bad('Mindestens eine Person muss mitessen.');
    return out;
  }
  const hhMeal = (c, id) => db.get('SELECT * FROM meals WHERE id = ? AND household_id = ?', int(id), c.hh.id) || bad('Mahlzeit nicht gefunden.', 404);
  function setEaters(mealId, eaters) {
    const old = new Map(db.all('SELECT user_id, eaten FROM meal_eaters WHERE meal_id = ?', mealId).map(r => [r.user_id, r.eaten]));
    db.run('DELETE FROM meal_eaters WHERE meal_id = ?', mealId);
    for (const e of eaters) db.run('INSERT INTO meal_eaters (meal_id, user_id, portions, eaten) VALUES (?, ?, ?, ?)', mealId, e.userId, e.portions, old.get(e.userId) || 0);
  }
  function setLeftover(c, meal, eaters) {
    db.run('DELETE FROM meals WHERE leftover_of = ?', meal.id);
    if (!eaters.length) return;
    const id = db.insert('INSERT INTO meals (household_id, date, slot, dish_id, leftover_of, created_by, created) VALUES (?, ?, ?, ?, ?, ?, ?)',
      c.hh.id, L.addDays(meal.date, 1), 'lunch', meal.dish_id, meal.id, c.user.id, Date.now());
    setEaters(id, eaters);
  }
  // Was jemand von den Mahlzeiten des Haushalts sehen darf: die eigenen und die gemeinsamen. Das „gegessen“ der
  // anderen gehört zu deren Fortschritt und folgt deren Privatsphäre-Einstellung.
  function forViewer(c, meals) {
    const shows = new Set([c.user.id, ...c.members.filter(u => canSee(c.user, u)).map(u => u.id)]);
    return meals
      .filter(m => isShared({ slot: m.slot, leftover_of: m.leftoverOf }) || m.eaters.some(e => e.userId === c.user.id))
      .map(m => ({ ...m, eaters: m.eaters.map(e => (shows.has(e.userId) ? e : { ...e, eaten: false })) }));
  }
  const oneMeal = (c, id) => forViewer(c, L.loadMeals(db, 'm.id = ?', [id]))[0] || null;
  // Eigene Mahlzeit einer anderen Person? Dann darf man sie weder ändern noch löschen.
  function ownOnly(c, m) {
    if (isShared(m)) return;
    if (!db.get('SELECT 1 FROM meal_eaters WHERE meal_id = ? AND user_id = ?', m.id, c.user.id)) bad('Das ist die Mahlzeit von jemand anderem.', 403);
  }
  const soloEaters = (c, eaters) => { if (eaters.length > 1 || (eaters[0] && eaters[0].userId !== c.user.id)) bad(SOLO_MSG); };

  route('GET', '/api/meals', c => {
    const from = date(c.query.from), to = date(c.query.to);
    if (L.diffDays(from, to) < 0 || L.diffDays(from, to) > 62) bad('Zeitraum zu groß.');
    auto.fill(c, to);
    return { meals: forViewer(c, L.mealsInRange(db, c.hh.id, from, to)) };
  });
  route('POST', '/api/meals', c => {
    const b = c.body, d = date(b.date);
    const slot = MEAL_SLOTS.includes(b.slot) ? b.slot : bad('Ungültige Mahlzeit.');
    let dishId = null, custom = null;
    if (b.custom) {
      const p = Number(b.custom.protein) || 0, k = Number(b.custom.kcal) || 0;
      if (p < 0 || p > 500 || k < 0 || k > 10000) bad('Werte unplausibel.');
      custom = JSON.stringify({ name: text(b.custom.name, 80, 1), protein: Math.round(p), kcal: Math.round(k) });
    } else dishId = (visibleDish(c, int(b.dishId)) || bad('Gericht nicht gefunden.', 404)).id;
    const eaters = eatersIn(c, b.eaters);
    if (slot !== 'dinner') soloEaters(c, eaters);
    const left = b.leftover && !custom && slot === 'dinner' ? eatersIn(c, b.leftover, true) : [];
    const cookId = slot === 'dinner' && b.cookId != null && memberIds(c).has(int(b.cookId)) ? int(b.cookId) : null;
    const id = db.tx(() => {
      const mid = db.insert('INSERT INTO meals (household_id, date, slot, dish_id, custom, cook_id, created_by, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        c.hh.id, d, slot, dishId, custom, cookId, c.user.id, Date.now());
      setEaters(mid, eaters);
      setLeftover(c, { id: mid, date: d, dish_id: dishId }, left);
      return mid;
    });
    return { meal: oneMeal(c, id) };
  });
  route('PATCH', '/api/meals/:id', c => {
    const m = hhMeal(c, c.params.id), b = c.body;
    ownOnly(c, m);
    const slot = !m.leftover_of && b.slot != null && MEAL_SLOTS.includes(b.slot) ? b.slot : m.slot;
    const eaters = b.eaters ? eatersIn(c, b.eaters, true) : null;
    if (slot !== 'dinner' && !m.leftover_of) {
      const after = eaters || db.all('SELECT user_id AS userId FROM meal_eaters WHERE meal_id = ?', m.id);
      soloEaters(c, after);
    }
    db.tx(() => {
      if (b.dishId != null && !m.custom) {
        m.dish_id = (visibleDish(c, int(b.dishId)) || bad('Gericht nicht gefunden.', 404)).id;
        db.run('UPDATE meals SET dish_id = ? WHERE id = ? OR leftover_of = ?', m.dish_id, m.id, m.id);
      }
      if (b.date != null && !m.leftover_of) {
        const shift = L.diffDays(m.date, date(b.date));
        m.date = b.date;
        db.run('UPDATE meals SET date = ? WHERE id = ?', m.date, m.id);
        if (shift) for (const k of db.all('SELECT id, date FROM meals WHERE leftover_of = ?', m.id)) db.run('UPDATE meals SET date = ? WHERE id = ?', L.addDays(k.date, shift), k.id);
      }
      if (slot !== m.slot) {
        db.run('UPDATE meals SET slot = ? WHERE id = ?', slot, m.id);
        // Kein warmes Gericht mehr: kein Rest für morgen, niemand kocht
        if (slot !== 'dinner') { db.run('DELETE FROM meals WHERE leftover_of = ?', m.id); db.run('UPDATE meals SET cook_id = NULL WHERE id = ?', m.id); }
      }
      if ('cookId' in b && slot === 'dinner') db.run('UPDATE meals SET cook_id = ? WHERE id = ?', b.cookId != null && memberIds(c).has(int(b.cookId)) ? int(b.cookId) : null, m.id);
      if (eaters) {
        if (!eaters.length) return db.run('DELETE FROM meals WHERE id = ?', m.id);
        setEaters(m.id, eaters);
      }
      if ('leftover' in b && slot === 'dinner' && !m.leftover_of && !m.custom) setLeftover(c, m, b.leftover ? eatersIn(c, b.leftover, true) : []);
    });
    return { meal: oneMeal(c, m.id) };
  });
  route('DELETE', '/api/meals/:id', c => {
    const m = hhMeal(c, c.params.id);
    ownOnly(c, m);
    db.tx(() => {
      // Im Vorschlagsmodus soll ein entfernter Vorschlag nicht sofort wiederkommen
      if (m.date >= c.today && MEAL_SLOTS.includes(m.slot))
        for (const e of db.all('SELECT user_id FROM meal_eaters WHERE meal_id = ?', m.id))
          db.run('INSERT OR IGNORE INTO auto_skips (user_id, date, slot) VALUES (?, ?, ?)', e.user_id, m.date, m.slot);
      db.run('DELETE FROM auto_skips WHERE date < ?', L.addDays(c.today, -2));
      db.run('DELETE FROM meals WHERE id = ?', m.id);
    });
    return { ok: true };
  });
  // Anderes Gericht für dieselbe Mahlzeit vorschlagen lassen
  route('POST', '/api/meals/:id/swap', c => {
    const m = hhMeal(c, c.params.id);
    ownOnly(c, m);
    if (!m.dish_id || m.leftover_of || !SLOTS.includes(m.slot)) bad('Diese Mahlzeit lässt sich nicht tauschen.');
    const seen = Array.isArray(c.body.seen) ? c.body.seen.map(Number).slice(0, 30) : [];
    const next = auto.suggest(c, m.slot, m.date, [m.dish_id, ...seen]) || auto.suggest(c, m.slot, m.date, [m.dish_id]) || bad('Kein anderes passendes Gericht im Fundus.');
    db.run('UPDATE meals SET dish_id = ? WHERE id = ? OR leftover_of = ?', next, m.id, m.id);
    return { meal: oneMeal(c, m.id) };
  });
  route('GET', '/api/plan/suggestion', c => {
    const slot = SLOTS.includes(c.query.slot) ? c.query.slot : bad('Ungültige Mahlzeit.');
    const not = String(c.query.not || '').split(',').map(Number).filter(Boolean).slice(0, 30);
    return { dishId: auto.suggest(c, slot, date(c.query.date), not) || auto.suggest(c, slot, date(c.query.date), []) };
  });
  route('POST', '/api/meals/:id/eaten', c => {
    const m = hhMeal(c, c.params.id);
    const r = db.run('UPDATE meal_eaters SET eaten = ? WHERE meal_id = ? AND user_id = ?', c.body.eaten ? 1 : 0, m.id, c.user.id);
    if (!r.changes) bad('Du isst bei dieser Mahlzeit nicht mit.');
    return { meal: oneMeal(c, m.id) };
  });

  // Mitgelieferten Monatsplan ab einem Datum eintragen. Schon belegte Mahlzeiten bleiben unangetastet.
  route('POST', '/api/plan/template', c => {
    const tpl = db.kv.get('template') || bad('Keine Vorlage vorhanden.', 404);
    const start = date(c.body.start), weeks = Math.min(8, Math.max(1, Math.round(+c.body.weeks) || 4));
    const ids = memberIds(c);
    const who = (Array.isArray(c.body.eaters) ? c.body.eaters.map(Number) : [c.user.id]).filter(id => ids.has(id));
    if (!who.length) bad('Mindestens eine Person auswählen.');
    const portion = Object.fromEntries(c.members.map(m => [m.id, L.userSettings(m).portion]));
    const dishId = Object.fromEntries(db.all('SELECT id, key FROM dishes WHERE key IS NOT NULL AND deleted = 0').map(r => [r.key, r.id]));
    const end = L.addDays(start, weeks * 7);
    // Belegt: das warme Gericht für den ganzen Haushalt, alles andere je Person
    const taken = new Set();
    for (const r of db.all('SELECT m.date, m.slot, e.user_id FROM meals m LEFT JOIN meal_eaters e ON e.meal_id = m.id WHERE m.household_id = ? AND m.date BETWEEN ? AND ?', c.hh.id, start, end))
      taken.add(r.date + r.slot + (r.slot === 'dinner' ? '' : r.user_id));
    const self = who.includes(c.user.id) ? [{ userId: c.user.id, portions: 1 }] : [];
    let n = 0;
    db.tx(() => {
      const add = (d, slot, key, list, leftoverOf) => {
        const eaters = slot === 'dinner' ? list : list.filter(e => !taken.has(d + slot + e.userId));
        if (!dishId[key] || !eaters.length || (slot === 'dinner' && taken.has(d + slot))) return null;
        if (slot === 'dinner') taken.add(d + slot); else for (const e of eaters) taken.add(d + slot + e.userId);
        const id = db.insert('INSERT INTO meals (household_id, date, slot, dish_id, leftover_of, created_by, created) VALUES (?, ?, ?, ?, ?, ?, ?)',
          c.hh.id, d, slot, dishId[key], leftoverOf || null, c.user.id, Date.now());
        setEaters(id, eaters);
        n++;
        return id;
      };
      for (let i = 0; i < weeks * 7; i++) {
        const d = L.addDays(start, i), wd = L.wdOf(d), one = who.map(userId => ({ userId, portions: 1 }));
        if (c.body.breakfast !== false) add(d, 'breakfast', tpl.breakfast[wd], self);
        if (c.body.snack !== false) add(d, 'snack', tpl.snack[wd], self);
        const key = tpl.dinners[i % tpl.dinners.length];
        const dinner = add(d, 'dinner', key, who.map(userId => ({ userId, portions: portion[userId] || 1 })));
        if (dinner && c.body.leftover !== false) add(L.addDays(d, 1), 'lunch', key, one, dinner);
      }
    });
    return { created: n };
  });
  route('POST', '/api/plan/clear', c => {
    const from = date(c.body.from);
    // Gemeinsames und Eigenes – Frühstück, Mittag, Snack und Extras der anderen bleiben stehen (wie bei DELETE)
    const r = db.run(`DELETE FROM meals WHERE household_id = ? AND date >= ? AND id NOT IN (SELECT meal_id FROM meal_eaters WHERE eaten = 1)
      AND (slot = 'dinner' OR leftover_of IS NOT NULL OR id IN (SELECT meal_id FROM meal_eaters WHERE user_id = ?))`, c.hh.id, from, c.user.id);
    return { deleted: Number(r.changes) };
  });

  // ---------- Einkauf ----------
  function tripCtx(c, from) {
    date(from);
    const range = L.tripRange(L.hhSettings(c.hh).shopDays, from);
    const row = db.get('SELECT * FROM trips WHERE household_id = ? AND from_date = ?', c.hh.id, from);
    if (!row && range.from !== from) bad('An diesem Tag ist kein Einkauf geplant.');
    return { from, to: row && row.done_at ? row.to_date : range.from === from ? range.to : row.to_date, row };
  }
  function ensureTrip(c, from) {
    const t = tripCtx(c, from);
    if (t.row) {
      if (t.row.to_date !== t.to) db.run('UPDATE trips SET to_date = ? WHERE id = ?', t.to, t.row.id);
      return t.row;
    }
    db.run('INSERT OR IGNORE INTO trips (household_id, from_date, to_date) VALUES (?, ?, ?)', c.hh.id, t.from, t.to);
    return db.get('SELECT * FROM trips WHERE household_id = ? AND from_date = ?', c.hh.id, from);
  }
  function shoppingPayload(c, anyDate) {
    const { from } = L.tripRange(L.hhSettings(c.hh).shopDays, anyDate);
    const t = tripCtx(c, from);
    const meals = L.mealsInRange(db, c.hh.id, t.from, t.to);
    const { items, basics } = L.shoppingItems(meals);
    const checks = new Set(t.row ? db.all('SELECT key FROM trip_checks WHERE trip_id = ?', t.row.id).map(r => r.key) : []);
    const info = db.kv.get('basicInfo') || {};
    const expense = t.row ? db.get("SELECT id, cents, payer_id AS payerId FROM expenses WHERE trip_id = ? AND kind = 'expense'", t.row.id) : null;
    return {
      from: t.from, to: t.to, prev: L.addDays(t.from, -1), next: L.addDays(t.to, 1),
      shopperId: t.row ? t.row.shopper_id : null, doneAt: t.row ? t.row.done_at : null, expense: expense || null,
      suggestion: L.nextShopper(db, c.hh.id, c.members.map(m => m.id), c.today),
      items: items.map(i => ({ ...i, got: checks.has(i.key) })),
      manual: t.row ? db.all('SELECT id, text, got, by_id AS byId FROM trip_items WHERE trip_id = ? ORDER BY id', t.row.id).map(r => ({ ...r, got: !!r.got })) : [],
      basics: basics.map(b => ({ ...b, ...(info[b.name] || {}) })),
      mealCount: meals.filter(m => m.dish && !m.leftoverOf).length
    };
  }
  route('GET', '/api/shopping', c => {
    const d = date(c.query.date || c.today);
    auto.fill(c, L.tripRange(L.hhSettings(c.hh).shopDays, d).to);
    return shoppingPayload(c, d);
  });
  route('POST', '/api/shopping/:from/shopper', c => {
    const trip = ensureTrip(c, c.params.from);
    const id = c.body.userId == null ? null : int(c.body.userId);
    if (id != null && !memberIds(c).has(id)) bad('Diese Person gehört nicht zum Haushalt.');
    db.run('UPDATE trips SET shopper_id = ? WHERE id = ?', id, trip.id);
    if (id != null && id !== c.user.id && id !== trip.shopper_id)
      notify(id, c.user.id, 'shop', c.user.display + ' hat dich für den Einkauf am ' + trip.from_date.split('-').reverse().slice(0, 2).join('.') + '. eingetragen.');
    return shoppingPayload(c, trip.from_date);
  });
  route('POST', '/api/shopping/:from/check', c => {
    const trip = ensureTrip(c, c.params.from), key = text(c.body.key, 120, 1);
    if (c.body.on) db.run('INSERT OR IGNORE INTO trip_checks (trip_id, key) VALUES (?, ?)', trip.id, key);
    else db.run('DELETE FROM trip_checks WHERE trip_id = ? AND key = ?', trip.id, key);
    return { ok: true };
  });
  route('POST', '/api/shopping/:from/items', c => {
    const trip = ensureTrip(c, c.params.from);
    if (db.get('SELECT COUNT(*) AS n FROM trip_items WHERE trip_id = ?', trip.id).n >= 100) bad('Die Liste ist voll.');
    db.run('INSERT INTO trip_items (trip_id, text, by_id) VALUES (?, ?, ?)', trip.id, text(c.body.text, 80, 1), c.user.id);
    return shoppingPayload(c, trip.from_date);
  });
  const tripItem = (c, id) => db.get('SELECT i.*, t.from_date FROM trip_items i JOIN trips t ON t.id = i.trip_id WHERE i.id = ? AND t.household_id = ?', int(id), c.hh.id) || bad('Eintrag nicht gefunden.', 404);
  route('PATCH', '/api/shopping/items/:id', c => {
    db.run('UPDATE trip_items SET got = ? WHERE id = ?', c.body.got ? 1 : 0, tripItem(c, c.params.id).id);
    return { ok: true };
  });
  route('DELETE', '/api/shopping/items/:id', c => {
    const it = tripItem(c, c.params.id);
    db.run('DELETE FROM trip_items WHERE id = ?', it.id);
    return shoppingPayload(c, it.from_date);
  });
  route('POST', '/api/shopping/:from/done', c => {
    const trip = ensureTrip(c, c.params.from);
    if (trip.done_at) bad('Dieser Einkauf ist schon abgeschlossen.');
    const shopper = trip.shopper_id || c.user.id;
    const hasAmount = c.body.amount != null && String(c.body.amount).trim() !== '';
    const amount = hasAmount ? cents(c.body.amount) : 0;
    db.tx(() => {
      db.run('UPDATE trips SET shopper_id = ?, done_at = ? WHERE id = ?', shopper, Date.now(), trip.id);
      if (amount) addExpense(c, { payerId: shopper, amount, note: 'Einkauf', date: trip.from_date, split: c.body.split, range: { from: trip.from_date, to: trip.to_date }, tripId: trip.id });
    });
    return shoppingPayload(c, trip.from_date);
  });
  route('POST', '/api/shopping/:from/reopen', c => {
    const trip = ensureTrip(c, c.params.from);
    db.tx(() => {
      db.run("DELETE FROM expenses WHERE trip_id = ? AND kind = 'expense'", trip.id);
      db.run('UPDATE trips SET done_at = NULL WHERE id = ?', trip.id);
    });
    return shoppingPayload(c, trip.from_date);
  });

  // ---------- Kasse ----------
  function addExpense(c, { payerId, amount, note, date: d, split, range, tripId, participants }) {
    const ids = c.members.map(m => m.id);
    const part = participants && participants.length ? ids.filter(id => participants.includes(id)) : ids;
    if (!part.length) bad('Niemand ausgewählt, auf den verteilt wird.');
    let mode = ['equal', 'usage'].includes(split) ? split : L.hhSettings(c.hh).split;
    let weights = Object.fromEntries(part.map(id => [id, 1]));
    if (mode === 'usage') {
      const r = range || { from: d, to: L.addDays(d, 2) };
      const w = L.kcalWeights(L.mealsInRange(db, c.hh.id, r.from, r.to), part);
      if (Object.values(w).some(x => x > 0)) weights = w; else mode = 'equal';
    }
    const shares = L.splitCents(amount, weights);
    const id = db.insert('INSERT INTO expenses (household_id, payer_id, cents, note, date, kind, split, trip_id, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      c.hh.id, payerId, amount, note, d, 'expense', mode, tripId || null, Date.now());
    for (const [uid, x] of Object.entries(shares)) db.run('INSERT INTO expense_shares (expense_id, user_id, cents) VALUES (?, ?, ?)', id, +uid, x);
    return id;
  }
  route('GET', '/api/money', c => {
    const bal = L.balances(db, c.hh.id);
    for (const m of c.members) bal[m.id] = bal[m.id] || 0;
    const expenses = db.all('SELECT id, payer_id AS payerId, cents, note, date, kind, split FROM expenses WHERE household_id = ? ORDER BY date DESC, id DESC LIMIT 60', c.hh.id);
    for (const e of expenses) e.shares = Object.fromEntries(db.all('SELECT user_id, cents FROM expense_shares WHERE expense_id = ?', e.id).map(r => [r.user_id, r.cents]));
    const since = L.addDays(c.today, -56);
    const trips = Object.fromEntries(c.members.map(m => [m.id, 0]));
    for (const r of db.all('SELECT shopper_id AS id, COUNT(*) AS n FROM trips WHERE household_id = ? AND from_date >= ? AND done_at IS NOT NULL AND shopper_id IS NOT NULL GROUP BY shopper_id', c.hh.id, since))
      if (r.id in trips) trips[r.id] = r.n;
    const known = new Set(c.members.map(m => m.id));
    const others = Object.keys(bal).map(Number).filter(id => !known.has(id) && bal[id] !== 0);
    for (const e of expenses) for (const id of [e.payerId, ...Object.keys(e.shares).map(Number)]) if (!known.has(id) && !others.includes(id)) others.push(id);
    for (const id of Object.keys(bal)) if (bal[id] === 0 && !known.has(+id)) delete bal[id];
    return {
      balances: bal, transfers: L.settle(bal), expenses, trips,
      formerMembers: others.map(id => db.get('SELECT id, name, display FROM users WHERE id = ?', id)).filter(Boolean),
      total: db.get("SELECT COALESCE(SUM(cents), 0) AS c FROM expenses WHERE household_id = ? AND kind = 'expense' AND date >= ?", c.hh.id, L.addDays(c.today, -30)).c
    };
  });
  route('POST', '/api/expenses', c => {
    const b = c.body, ids = memberIds(c);
    const payerId = b.payerId == null ? c.user.id : int(b.payerId);
    if (!ids.has(payerId)) bad('Diese Person gehört nicht zum Haushalt.');
    const id = db.tx(() => addExpense(c, {
      payerId, amount: cents(b.amount), note: text(b.note, 80) || 'Ausgabe', date: b.date ? date(b.date) : c.today, split: b.split,
      participants: Array.isArray(b.participants) ? b.participants.map(Number) : null
    }));
    return { id };
  });
  route('POST', '/api/transfers', c => {
    const from = int(c.body.fromId), to = int(c.body.toId), amount = cents(c.body.amount);
    const bal = L.balances(db, c.hh.id), ids = memberIds(c);
    const ok = id => ids.has(id) || bal[id];
    if (from === to || !ok(from) || !ok(to)) bad('Ungültige Zahlung.');
    db.tx(() => {
      const id = db.insert('INSERT INTO expenses (household_id, payer_id, cents, note, date, kind, split, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        c.hh.id, from, amount, 'Ausgleich', c.today, 'transfer', 'custom', Date.now());
      db.run('INSERT INTO expense_shares (expense_id, user_id, cents) VALUES (?, ?, ?)', id, to, amount);
    });
    if (to !== c.user.id && ids.has(to)) notify(to, c.user.id, 'money', c.user.display + ' hat eine Ausgleichszahlung über ' + (amount / 100).toFixed(2).replace('.', ',') + ' € eingetragen.');
    return { ok: true };
  });
  route('DELETE', '/api/expenses/:id', c => {
    const e = db.get('SELECT * FROM expenses WHERE id = ? AND household_id = ?', int(c.params.id), c.hh.id) || bad('Eintrag nicht gefunden.', 404);
    db.run('DELETE FROM expenses WHERE id = ?', e.id);
    return { ok: true };
  });

  // ---------- Leute, Fortschritt, Anstupsen ----------
  const NUDGE_GAP = 3 * 3600 * 1000;
  function personCard(c, u) {
    const visible = canSee(c.user, u);
    const card = { ...publicUser(u), self: u.id === c.user.id, sameHousehold: u.household_id === c.user.household_id, visible };
    if (!visible) return card;
    const pr = L.progress(db, u, L.addDays(c.today, -6), c.today);
    const t = pr.days[pr.days.length - 1];
    const last = db.get("SELECT MAX(created) AS t FROM notifications WHERE user_id = ? AND from_id = ? AND kind = 'nudge'", u.id, c.user.id).t || 0;
    return {
      ...card, pGoal: pr.pGoal, kGoal: pr.kGoal, today: t, streak: L.streak(db, u, c.today),
      week: pr.days.map(d => ({ date: d.date, hit: d.hit, pct: Math.min(1, d.eatP / pr.pGoal) })),
      canNudge: !card.self && L.userSettings(u).nudge !== false, nudgeWait: Math.max(0, last + NUDGE_GAP - Date.now())
    };
  }
  route('GET', '/api/people', c => ({
    household: c.members.map(u => personCard(c, u)),
    friends: db.all('SELECT u.* FROM follows f JOIN users u ON u.id = f.target_id WHERE f.user_id = ? AND u.household_id != ? ORDER BY u.display COLLATE NOCASE', c.user.id, c.hh.id).map(u => personCard(c, u)),
    notifications: db.all(`SELECT n.id, n.kind, n.text, n.read, n.created, n.from_id AS fromId FROM notifications n WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 20`, c.user.id).map(n => ({ ...n, read: !!n.read }))
  }));
  route('GET', '/api/progress/:id', c => {
    const u = db.get('SELECT * FROM users WHERE id = ?', int(c.params.id)) || bad('Nicht gefunden.', 404);
    if (!canSee(c.user, u)) bad('Diese Person teilt ihren Fortschritt nicht.', 403);
    const days = Math.min(90, Math.max(7, Math.round(+c.query.days) || 28));
    return { user: publicUser(u), streak: L.streak(db, u, c.today), ...L.progress(db, u, L.addDays(c.today, -(days - 1)), c.today) };
  });
  route('GET', '/api/users/search', c => {
    const q = text(c.query.q, 24);
    if (q.length < 2) return { users: [] };
    const like = '%' + q.replace(/[\\%_]/g, x => '\\' + x) + '%';
    const followed = new Set(db.all('SELECT target_id FROM follows WHERE user_id = ?', c.user.id).map(r => r.target_id));
    return {
      users: db.all(`SELECT * FROM users WHERE id != ? AND household_id != ? AND (name LIKE ? ESCAPE '\\' OR display LIKE ? ESCAPE '\\') LIMIT 40`, c.user.id, c.hh.id, like, like)
        .filter(u => L.userSettings(u).share === 'all').slice(0, 10).map(u => ({ ...publicUser(u), followed: followed.has(u.id) }))
    };
  });
  route('POST', '/api/follows', c => {
    const u = db.get('SELECT * FROM users WHERE id = ?', int(c.body.userId)) || bad('Nicht gefunden.', 404);
    if (u.id === c.user.id || !canSee(c.user, u)) bad('Diese Person teilt ihren Fortschritt nicht.', 403);
    if (db.get('SELECT COUNT(*) AS n FROM follows WHERE user_id = ?', c.user.id).n >= 100) bad('Du folgst schon sehr vielen Leuten.');
    db.run('INSERT OR IGNORE INTO follows (user_id, target_id) VALUES (?, ?)', c.user.id, u.id);
    return { ok: true };
  });
  route('DELETE', '/api/follows/:id', c => {
    db.run('DELETE FROM follows WHERE user_id = ? AND target_id = ?', c.user.id, int(c.params.id));
    return { ok: true };
  });
  route('POST', '/api/nudge', c => {
    const u = db.get('SELECT * FROM users WHERE id = ?', int(c.body.userId)) || bad('Nicht gefunden.', 404);
    if (u.id === c.user.id) bad('Dich selbst kannst du nicht anstupsen.');
    if (!canSee(c.user, u) || L.userSettings(u).nudge === false) bad('Diese Person möchte nicht angestupst werden.', 403);
    const last = db.get("SELECT MAX(created) AS t FROM notifications WHERE user_id = ? AND from_id = ? AND kind = 'nudge'", u.id, c.user.id).t || 0;
    if (Date.now() - last < NUDGE_GAP) bad('Du hast ' + u.display + ' gerade erst angestupst. Später wieder.', 429);
    const t = L.progress(db, u, c.today, c.today).days[0];
    const msg = t.meals && t.eaten >= t.meals ? 'feiert dich: alles für heute abgehakt!'
      : t.eaten ? 'stupst dich an: Da fehlt heute noch was auf deinem Teller.'
      : 'stupst dich an: Schon gegessen? Trag deine Mahlzeiten ein!';
    notify(u.id, c.user.id, 'nudge', c.user.display + ' ' + msg, 'Anstupser von ' + c.user.display);
    return { ok: true, nudgeWait: NUDGE_GAP };
  });
  route('POST', '/api/notifications/read', c => {
    db.run('UPDATE notifications SET read = 1 WHERE user_id = ?', c.user.id);
    return { ok: true };
  });

  // ---------- Push-Abos ----------
  const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)$/;
  route('POST', '/api/push/subscribe', c => {
    const s = c.body || {}, k = s.keys || {};
    let url;
    try { url = new URL(s.endpoint); } catch { bad('Ungültiges Abo.'); }
    if (url.protocol !== 'https:' || !(cfg.pushHosts || PUSH_HOSTS).test(url.hostname)) bad('Dieser Push-Dienst wird nicht unterstützt.');
    if (typeof k.p256dh !== 'string' || typeof k.auth !== 'string' || Buffer.from(k.p256dh, 'base64url').length !== 65 || Buffer.from(k.auth, 'base64url').length !== 16) bad('Ungültiges Abo.');
    db.run('INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created) VALUES (?, ?, ?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth',
      url.href, c.user.id, k.p256dh, k.auth, Date.now());
    db.run('DELETE FROM push_subs WHERE user_id = ? AND endpoint NOT IN (SELECT endpoint FROM push_subs WHERE user_id = ? ORDER BY created DESC LIMIT 10)', c.user.id, c.user.id);
    return { ok: true };
  });
  route('POST', '/api/push/unsubscribe', c => {
    db.run('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?', String(c.body.endpoint || ''), c.user.id);
    return { ok: true };
  });
  route('POST', '/api/push/test', async c => {
    const r = await notify(c.user.id, null, 'test', 'So sehen Benachrichtigungen von SlopWok aus.', 'Test');
    return { sent: r.filter(x => x === 'ok').length, devices: r.length };
  });

  // ---------- Dispatcher ----------
  const serverToday = () => { const n = new Date(); return L.isoOf(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())); };
  return async function handle({ method, path, query, body, token }) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(path);
      if (!m) continue;
      const c = { db, method, query, body: body && typeof body === 'object' ? body : {}, token, params: {} };
      r.keys.forEach((k, i) => { c.params[k] = decodeURIComponent(m[i + 1]); });
      // Der Kalendertag kommt vom Gerät (Zeitzone), darf aber höchstens einen Tag vom Server abweichen.
      const st = serverToday(), claimed = query.today || c.body.today;
      c.today = L.isIso(claimed) && Math.abs(L.diffDays(st, claimed)) <= 1 ? claimed : st;
      if (!r.open) {
        const s = token && db.get('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.created > ?', sha(token), Date.now() - 365 * 864e5);
        if (!s) bad('Bitte melde dich an.', 401);
        c.user = s;
        c.hh = db.get('SELECT * FROM households WHERE id = ?', s.household_id);
        c.members = membersOf(db, c.hh.id);
      }
      return r.handler(c);
    }
    bad('Nicht gefunden.', 404);
  };
}
