// Swipen: Jede Person wählt warme Gerichte für die kommende Woche. Wer dasselbe mag, kocht zusammen.
// Ziel sind gemeinsame Gerichte: Ein Match braucht zwei Personen (außer man lebt allein). Was gemocht, aber nicht
// gekocht wird, kommt in der nächsten Runde nach vorne.
//
// Nach jeder Stimme wird die Woche neu verteilt, ab Montag steht sie fest. Angefasst werden nur „lose" Gerichte
// (Vorschläge und Matches, die niemand geändert hat). Selbst Geplantes und schon Eingekauftes bleibt stehen.
import * as L from './logic.js';

export const nextWeek = today => L.addDays(today, 7 - L.wdOf(today));

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// Verteilt Gerichte auf Tage, immer die größtmögliche Runde zuerst: erst was alle mögen, dann die Teilmengen.
//   days:  [{ date, free: Set<userId> }]
//   likes: Map<dishId, Set<userId>>, ohne die, die das Gericht in der Woche schon bekommen
//   min:   so viele braucht ein Match mindestens
//   prev:  bisherige Matches als „datum|gericht", damit sich bei Gleichstand wenig verschiebt
//   rank:  kleiner = bei Gleichstand eher dran
export function matchWeek({ days, likes, min = 1, prev = new Set(), rank = () => 0 }) {
  const free = days.map(d => ({ date: d.date, users: new Set(d.free) }));
  const open = new Map([...likes].map(([id, users]) => [id, new Set(users)]));
  const before = new Set([...prev].map(k => Number(k.split('|')[1])));
  const shared = new Map(); // wie oft jemand schon in einer Runde mitkocht, für den Ausgleich
  const out = [];
  for (;;) {
    let best = null;
    for (const [dishId, users] of open) {
      for (const day of free) {
        const group = [...users].filter(u => day.users.has(u));
        if (group.length < min) continue;
        const score = [
          -group.length,                                                      // möglichst viele zusammen
          group.reduce((a, u) => a + (shared.get(u) || 0), 0) / group.length, // wer bisher seltener mitkocht
          users.size - group.length,                                          // möglichst alle, die es mögen
          before.has(dishId) ? 0 : 1,                                         // was schon im Plan steht
          rank(dishId),
          dishId,
          day.users.size,                                                     // volle Tage für große Runden aufheben
          prev.has(day.date + '|' + dishId) ? 0 : 1
        ];
        if (!best || less(score, best.score)) best = { score, dishId, day, group };
      }
    }
    if (!best) return out;
    const { dishId, day, group } = best;
    for (const u of group) {
      day.users.delete(u);
      open.get(dishId).delete(u);
      if (group.length > 1) shared.set(u, (shared.get(u) || 0) + 1);
    }
    if (!open.get(dishId).size) open.delete(dishId);
    out.push({ date: day.date, dishId, users: group.sort((a, b) => a - b) });
  }
}
function less(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

export function makeSwipe(db, auto) {
  const swipeable = hhId => db.all(`SELECT id, data FROM dishes WHERE deleted = 0 AND slot = 'dinner'
      AND (key IS NOT NULL OR owner_id IN (SELECT id FROM users WHERE household_id = ?))`, hhId)
    .filter(r => !(JSON.parse(r.data).tags || []).includes('Extra')).map(r => r.id);

  // Was jemand in der Vorrunde mochte und in deren Woche nicht als warmes Gericht bekommt.
  const leftOver = (hhId, week) => db.all(`SELECT s.user_id, s.dish_id FROM swipes s JOIN users u ON u.id = s.user_id
    WHERE u.household_id = ? AND s.week = ? AND s.liked = 1 AND NOT EXISTS (
      SELECT 1 FROM meals m JOIN meal_eaters e ON e.meal_id = m.id
      WHERE e.user_id = s.user_id AND m.dish_id = s.dish_id AND m.slot = 'dinner' AND m.leftover_of IS NULL AND m.date BETWEEN ? AND ?)`,
  hhId, L.addDays(week, -7), L.addDays(week, -7), L.addDays(week, -1));

  // Zuerst das aus der Vorrunde Übriggebliebene (was mehrere mochten ganz vorn), dann was lange nicht dran war.
  // Für den ganzen Haushalt gleich, damit man sich auch trifft, wenn jemand nur die ersten Karten durchgeht.
  function ranking(hhId, week) {
    const last = new Map(db.all(`SELECT dish_id, MAX(date) AS d FROM meals WHERE household_id = ? AND dish_id IS NOT NULL
      AND leftover_of IS NULL AND date >= ? AND date < ? GROUP BY dish_id`, hhId, L.addDays(week, -28), week).map(r => [r.dish_id, r.d]));
    const again = new Map();
    for (const r of leftOver(hhId, week)) again.set(r.dish_id, (again.get(r.dish_id) || 0) + 1);
    return id => -(again.get(id) || 0) * 1e5 + (29 - (last.has(id) ? L.diffDays(last.get(id), week) : 29)) * 1000 + hash(week + '|' + id) % 1000;
  }

  const boughtDays = (hhId, week) => {
    const trips = db.all('SELECT from_date, to_date FROM trips WHERE household_id = ? AND done_at IS NOT NULL AND to_date >= ? AND from_date <= ?', hhId, week, L.addDays(week, 6));
    return Array.from({ length: 7 }, (_, i) => L.addDays(week, i)).filter(d => trips.some(t => t.from_date <= d && d <= t.to_date));
  };

  // Verteilt die kommende Woche eines Haushalts neu. Läuft in der Transaktion des Aufrufers.
  function replan(hhId, today, byId) {
    const week = nextWeek(today), last = L.addDays(week, 6);
    const users = db.all('SELECT * FROM users WHERE household_id = ? ORDER BY id', hhId).map(u => ({ id: u.id, s: L.userSettings(u) }));
    if (!users.length) return;
    const byUser = new Map(users.map(u => [u.id, u]));
    const votes = db.all('SELECT s.* FROM swipes s JOIN users u ON u.id = s.user_id WHERE u.household_id = ? AND s.week = ?', hhId, week);
    const dinners = db.all(`SELECT * FROM meals WHERE household_id = ? AND date BETWEEN ? AND ? AND slot = 'dinner'
      AND leftover_of IS NULL ORDER BY date, id`, hhId, week, last);
    if (!votes.length && !dinners.some(m => m.swiped)) return; // niemand swipet: alles wie ohne Swipen

    // ---------- Bestand: was ist lose, was steht fest? ----------
    const bought = new Set(boughtDays(hhId, week));
    for (const m of dinners) {
      m.eaters = db.all('SELECT * FROM meal_eaters WHERE meal_id = ?', m.id);
      m.ids = m.eaters.map(e => e.user_id).filter(id => byUser.has(id)).sort((a, b) => a - b);
      m.rest = db.all('SELECT e.* FROM meal_eaters e JOIN meals k ON k.id = e.meal_id WHERE k.leftover_of = ?', m.id);
      m.loose = !!(m.auto || m.swiped) && !m.pinned && !m.cook_id && !bought.has(m.date) && ![...m.eaters, ...m.rest].some(e => e.eaten);
    }
    const skipped = new Set(db.all("SELECT user_id, date FROM auto_skips WHERE slot = 'dinner' AND date BETWEEN ? AND ?", week, last).map(r => r.date + '|' + r.user_id));
    const days = [];
    for (let date = week; date <= last; date = L.addDays(date, 1)) {
      if (bought.has(date)) continue;
      const all = dinners.filter(m => m.date === date), loose = all.filter(m => m.loose), fixed = all.filter(m => !m.loose);
      const inLoose = new Set(loose.flatMap(m => m.ids)), busy = new Set(fixed.flatMap(m => m.ids));
      const free = new Set(users.map(u => u.id).filter(id => !busy.has(id) && (inLoose.has(id) || !skipped.has(date + '|' + id))));
      days.push({ date, loose, fixed, inLoose, free });
    }

    // ---------- Matches ----------
    const canPick = new Set(swipeable(hhId));
    const likes = new Map(), dislikes = new Map(users.map(u => [u.id, new Set()]));
    for (const v of votes) {
      if (!v.liked) { dislikes.get(v.user_id).add(v.dish_id); continue; }
      if (v.spent || !canPick.has(v.dish_id)) continue;
      if (!likes.has(v.dish_id)) likes.set(v.dish_id, new Set());
      likes.get(v.dish_id).add(v.user_id);
    }
    for (const m of dinners) if (!m.loose) for (const id of m.ids) likes.get(m.dish_id)?.delete(id); // gibt es schon
    const prev = new Set(dinners.filter(m => m.loose && m.swiped).map(m => m.date + '|' + m.dish_id));
    const matches = matchWeek({ days, likes, min: Math.min(2, users.length), prev, rank: ranking(hhId, week) });

    // ---------- Wer ohne Match bleibt, bekommt wie bisher einen gemeinsamen Vorschlag ----------
    const want = matches.map(m => ({ ...m, swiped: 1 })), open = [];
    for (const day of days) {
      const here = matches.filter(m => m.date === day.date), matched = new Set(here.flatMap(m => m.users));
      const suggested = day.loose.filter(m => !m.swiped);
      const blocked = day.fixed.some(m => !m.swiped); // ein selbst geplantes Gericht verdrängt neue Vorschläge
      const group = [...day.free].filter(id => {
        if (matched.has(id)) return false;
        if (suggested.some(m => m.ids.includes(id))) return true;
        const s = byUser.get(id).s;
        return s.mode === 'auto' && s.autoSlots.includes('dinner') && (!blocked || day.inLoose.has(id));
      });
      if (!group.length) continue;
      const sameDay = new Set([...here.map(m => m.dishId), ...day.fixed.filter(m => m.swiped).map(m => m.dish_id)]);
      const avoid = new Set(group.flatMap(id => [...dislikes.get(id)]));
      for (const m of matches) if (m.users.some(id => group.includes(id))) avoid.add(m.dishId);
      const keep = suggested.find(m => m.dish_id && !avoid.has(m.dish_id) && !sameDay.has(m.dish_id));
      const item = { date: day.date, dishId: keep?.dish_id, users: group.sort((a, b) => a - b), swiped: 0 };
      if (keep) want.push(item); else open.push({ ...item, avoid, sameDay });
    }
    if (open.length) {
      const pick = auto.chooser(hhId, week, last, new Set(dinners.filter(m => m.loose).map(m => m.id)));
      for (const w of want) pick.note(w.dishId, w.date);
      for (const o of open) {
        o.dishId = pick('dinner', o.date, auto.targetFor(o.users.map(id => byUser.get(id)), 'dinner'), [...o.sameDay], o.avoid);
        if (o.dishId) want.push(o);
      }
    }

    // ---------- Nur Unterschiede schreiben ----------
    const loose = days.flatMap(d => d.loose), key = (date, swiped, dishId, ids) => [date, swiped, dishId, ids.join(',')].join('|');
    const kept = new Set(), create = [];
    for (const w of want) {
      const same = loose.find(m => !kept.has(m.id) && key(m.date, m.swiped, m.dish_id, m.ids) === key(w.date, w.swiped, w.dishId, w.users));
      if (same) kept.add(same.id); else create.push(w);
    }
    const hadPortions = new Map(), hadRest = new Map();
    for (const m of loose) {
      if (kept.has(m.id)) continue;
      for (const e of m.eaters) hadPortions.set(m.date + '|' + e.user_id, e.portions);
      for (const e of m.rest) hadRest.set(m.date + '|' + e.user_id, e.portions);
      db.run('DELETE FROM meals WHERE id = ?', m.id); // der Rest hängt per ON DELETE CASCADE dran
    }
    for (const w of create) {
      const id = db.insert('INSERT INTO meals (household_id, date, slot, dish_id, auto, swiped, created_by, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        hhId, w.date, 'dinner', w.dishId, w.swiped ? 0 : 1, w.swiped, byId, Date.now());
      for (const u of w.users)
        db.run('INSERT INTO meal_eaters (meal_id, user_id, portions) VALUES (?, ?, ?)', id, u, hadPortions.get(w.date + '|' + u) ?? (byUser.get(u).s.portion || 1));

      const next = L.addDays(w.date, 1), rest = [];
      for (const u of w.users) {
        const s = byUser.get(u).s, before = hadRest.get(w.date + '|' + u);
        if (before == null && !(s.mode === 'auto' && s.autoLeftover && s.autoSlots.includes('lunch'))) continue;
        if (db.get("SELECT 1 FROM auto_skips WHERE user_id = ? AND date = ? AND slot = 'lunch'", u, next)) continue;
        if (db.get("SELECT 1 FROM meals m JOIN meal_eaters e ON e.meal_id = m.id WHERE m.household_id = ? AND m.date = ? AND m.slot = 'lunch' AND e.user_id = ?", hhId, next, u)) continue;
        rest.push([u, before ?? 1]);
      }
      if (!rest.length) continue;
      const kid = db.insert('INSERT INTO meals (household_id, date, slot, dish_id, leftover_of, auto, created_by, created) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
        hhId, next, 'lunch', w.dishId, id, byId, Date.now());
      for (const [u, p] of rest) db.run('INSERT INTO meal_eaters (meal_id, user_id, portions) VALUES (?, ?, ?)', kid, u, p);
    }
  }

  // Ein aus dem Plan genommenes Match soll bei der nächsten Stimme nicht an einem anderen Tag wiederkommen.
  function spend(meal, userIds) {
    if (!meal.swiped || !meal.dish_id) return;
    const week = L.addDays(meal.date, -L.wdOf(meal.date));
    for (const id of userIds) db.run('UPDATE swipes SET spent = 1 WHERE user_id = ? AND week = ? AND dish_id = ?', id, week, meal.dish_id);
  }

  // Wer in eine Runde einsteigt, verlässt dafür seinen Vorschlag oder sein Match an diesem Tag.
  // true: ein Match hat jemanden verloren, die Woche muss neu verteilt werden (allein ist es kein Match mehr).
  function release(meal, userId) {
    const others = db.all(`SELECT m.* FROM meals m JOIN meal_eaters e ON e.meal_id = m.id
      WHERE m.household_id = ? AND m.date = ? AND m.id != ? AND m.slot = 'dinner' AND m.leftover_of IS NULL
        AND e.user_id = ? AND e.eaten = 0 AND (m.auto = 1 OR m.swiped = 1) AND m.pinned = 0`, meal.household_id, meal.date, meal.id, userId);
    let broke = false;
    for (const o of others) {
      if (!o.swiped && !meal.swiped) continue; // ohne Swipen bleibt es beim bisherigen Verhalten
      if (o.cook_id === userId) continue;
      const ids = [o.id, ...db.all('SELECT id FROM meals WHERE leftover_of = ?', o.id).map(r => r.id)];
      for (const id of ids) db.run('DELETE FROM meal_eaters WHERE meal_id = ? AND user_id = ? AND eaten = 0', id, userId);
      for (const id of ids.reverse()) db.run('DELETE FROM meals WHERE id = ? AND id NOT IN (SELECT meal_id FROM meal_eaters)', id);
      if (o.swiped) broke = true;
    }
    return broke;
  }

  function state(hhId, user, today) {
    const week = nextWeek(today), rank = ranking(hhId, week);
    return {
      week, to: L.addDays(week, 6),
      again: leftOver(hhId, week).filter(r => r.user_id === user.id).map(r => r.dish_id), // nur die eigenen
      deck: swipeable(hhId).sort((a, b) => rank(a) - rank(b) || a - b),
      votes: Object.fromEntries(db.all('SELECT dish_id, liked FROM swipes WHERE user_id = ? AND week = ?', user.id, week).map(r => [r.dish_id, !!r.liked])),
      // Wer schon dabei ist, aber nicht, wie jemand gestimmt hat
      voters: db.all('SELECT DISTINCT s.user_id FROM swipes s JOIN users u ON u.id = s.user_id WHERE u.household_id = ? AND s.week = ?', hhId, week).map(r => r.user_id),
      bought: boughtDays(hhId, week)
    };
  }

  return { replan, spend, release, state, swipeable };
}
