// Vorschlagsmodus: füllt freie Mahlzeiten aus dem Fundus, abwechslungsreich und passend zum Proteinziel.
import * as L from './logic.js';

const SHARE = { breakfast: 0.25, lunch: 0.2, snack: 0.2, dinner: 0.35 }; // Anteil am Tagesziel je Mahlzeit
const HORIZON = 13; // Tage ab heute, die im Vorschlagsmodus immer gefüllt sind

export function makeAuto(db) {
  // Wählt Gerichte so, dass dasselbe möglichst lange nicht dran war; unter den besten zählt die Nähe zum Proteinziel.
  function chooser(hhId, from, to, ignore = new Set()) {
    const used = new Map();
    const note = (id, date) => { if (!used.has(id)) used.set(id, []); used.get(id).push(date); };
    for (const r of db.all('SELECT id, dish_id, date FROM meals WHERE household_id = ? AND dish_id IS NOT NULL AND leftover_of IS NULL AND date BETWEEN ? AND ?', hhId, L.addDays(from, -28), L.addDays(to, 28)))
      if (!ignore.has(r.id)) note(r.dish_id, r.date);
    const bySlot = {};
    for (const r of db.all(`SELECT id, slot, data FROM dishes WHERE deleted = 0 AND (key IS NOT NULL OR owner_id IN (SELECT id FROM users WHERE household_id = ?))`, hhId)) {
      const d = JSON.parse(r.data);
      if ((d.tags || []).includes('Extra')) continue;
      (bySlot[r.slot] = bySlot[r.slot] || []).push({ id: r.id, protein: d.protein });
    }
    // avoid: möglichst nicht (z. B. nach links geswipet). Gilt, solange es dann noch Abwechslung gibt.
    function pick(slot, date, target, exclude = [], avoid = new Set()) {
      const day = Math.round(L.parseD(date) / 86400000);
      let list = (bySlot[slot] || []).filter(d => !exclude.includes(d.id)).map(d => ({
        ...d,
        gap: Math.min(999, ...(used.get(d.id) || []).map(x => Math.abs(L.diffDays(x, date)))),
        mix: ((d.id * 2654435761 + day * 40503) >>> 0) % 1000
      }));
      if (!list.length) return null;
      if (avoid.size) {
        const liked = list.filter(d => !avoid.has(d.id) && d.gap >= 3);
        if (liked.length) list = liked;
      }
      list.sort((a, b) => b.gap - a.gap || a.mix - b.mix);
      const best = list.slice(0, 4).filter(d => d.gap >= Math.min(3, list[0].gap));
      best.sort((a, b) => Math.abs(a.protein - target) - Math.abs(b.protein - target));
      note(best[0].id, date);
      return best[0].id;
    }
    pick.note = note;
    return pick;
  }

  const targetFor = (users, slot) => {
    const avg = users.reduce((a, u) => a + u.s.pGoal / (slot === 'dinner' ? u.s.portion || 1 : 1), 0) / users.length;
    return avg * SHARE[slot];
  };

  // Füllt für alle im Haushalt, die Vorschläge wollen, die freien Mahlzeiten von heute bis `until`.
  function fill(c, until) {
    const autos = c.members.map(m => ({ id: m.id, s: L.userSettings(m) })).filter(u => u.s.mode === 'auto');
    if (!autos.length) return 0;
    const from = c.today;
    const cap = L.addDays(from, 27);
    let to = L.addDays(from, HORIZON);
    if (until && until > to) to = until < cap ? until : cap;
    // dinnerDays: Tage mit einem warmen Gericht, das für den Haushalt gilt. Matches zählen nicht dazu, denn
    // wer bei keinem dabei ist, bekommt trotzdem einen Vorschlag.
    const has = new Set(), dinnerDays = new Set(), matchDishes = new Map();
    for (const r of db.all(`SELECT m.date, m.slot, m.swiped, m.dish_id, e.user_id FROM meals m LEFT JOIN meal_eaters e ON e.meal_id = m.id
                            WHERE m.household_id = ? AND m.date BETWEEN ? AND ?`, c.hh.id, from, L.addDays(to, 1))) {
      has.add(r.date + r.slot + r.user_id);
      if (r.slot !== 'dinner') continue;
      if (!r.swiped) dinnerDays.add(r.date);
      else if (r.dish_id) matchDishes.set(r.date, [...(matchDishes.get(r.date) || []), r.dish_id]);
    }
    for (const r of db.all(`SELECT user_id, date, slot FROM auto_skips WHERE date >= ? AND user_id IN (${autos.map(() => '?').join(',')})`, from, ...autos.map(u => u.id)))
      has.add(r.date + r.slot + r.user_id);
    const wants = (u, d, slot) => u.s.autoSlots.includes(slot) && !has.has(d + slot + u.id);

    // Erst prüfen, ob überhaupt etwas fehlt – der Normalfall beim wiederholten Laden.
    const todo = [];
    for (let d = from; d <= to; d = L.addDays(d, 1))
      for (const slot of ['breakfast', 'snack', 'lunch', 'dinner']) todo.push([d, slot]);
    const missing = ([d, slot]) => autos.some(u => wants(u, d, slot)) && !(slot === 'dinner' && dinnerDays.has(d));
    if (!todo.some(missing)) return 0;

    let n = 0;
    db.tx(() => {
      const pick = chooser(c.hh.id, from, to);
      const no = db.all('SELECT s.user_id, s.week, s.dish_id FROM swipes s JOIN users u ON u.id = s.user_id WHERE u.household_id = ? AND s.liked = 0 AND s.week >= ?', c.hh.id, L.addDays(from, -6));
      const add = (d, slot, dishId, users, leftoverOf) => {
        const id = db.insert('INSERT INTO meals (household_id, date, slot, dish_id, leftover_of, auto, created_by, created) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
          c.hh.id, d, slot, dishId, leftoverOf || null, c.user.id, Date.now());
        for (const u of users) {
          db.run('INSERT INTO meal_eaters (meal_id, user_id, portions) VALUES (?, ?, ?)', id, u.id, slot === 'dinner' ? u.s.portion || 1 : 1);
          has.add(d + slot + u.id);
        }
        n++;
        return id;
      };
      // Reihenfolge je Tag: Mittag zuerst (falls kein Rest vom Vortag da ist), das warme Gericht legt den Rest für morgen an.
      for (let d = from; d <= to; d = L.addDays(d, 1)) {
        for (const slot of ['breakfast', 'lunch', 'snack', 'dinner']) {
          if (slot === 'dinner' && dinnerDays.has(d)) continue; // es gibt schon ein warmes Gericht im Haushalt
          const users = autos.filter(u => wants(u, d, slot));
          if (!users.length) continue;
          if (slot !== 'dinner') {
            // Nur das warme Gericht ist gemeinsam – alles andere bekommt jede Person einzeln
            for (const u of users) { const dishId = pick(slot, d, targetFor([u], slot)); if (dishId) add(d, slot, dishId, [u]); }
            continue;
          }
          const monday = L.addDays(d, -L.wdOf(d));
          const avoid = new Set(no.filter(v => v.week === monday && users.some(u => u.id === v.user_id)).map(v => v.dish_id));
          const dishId = pick(slot, d, targetFor(users, slot), matchDishes.get(d) || [], avoid);
          if (!dishId) continue;
          const id = add(d, slot, dishId, users);
          dinnerDays.add(d);
          const next = L.addDays(d, 1);
          const rest = users.filter(u => u.s.autoLeftover && wants(u, next, 'lunch'));
          if (rest.length && next <= L.addDays(to, 1)) add(next, 'lunch', dishId, rest, id);
        }
      }
    });
    return n;
  }

  // Ein einzelner Vorschlag, z. B. zum Tauschen oder für „Vorschlagen lassen".
  function suggest(c, slot, date, exclude) {
    const users = [{ id: c.user.id, s: L.userSettings(c.user) }];
    return chooser(c.hh.id, date, date)(slot, date, targetFor(users, slot), exclude);
  }
  return { fill, suggest, chooser, targetFor };
}
