// Fachlogik: Mahlzeiten laden, Einkaufsliste, Kostenverteilung, Fortschritt.

const DAY = 86400000;
export const isIso = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
export const parseD = s => Date.parse(s + 'T00:00:00Z');
export const isoOf = t => new Date(t).toISOString().slice(0, 10);
export const addDays = (iso, n) => isoOf(parseD(iso) + n * DAY);
export const wdOf = iso => (new Date(parseD(iso)).getUTCDay() + 6) % 7; // Montag = 0
export const diffDays = (a, b) => Math.round((parseD(b) - parseD(a)) / DAY);
const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

// mode: 'manual' = selbst planen, 'auto' = freie Mahlzeiten werden aus dem Fundus vorgeschlagen
export const DEFAULT_USER = {
  pGoal: 130, kGoal: 2800, portion: 1, share: 'household', nudge: true,
  mode: 'manual', autoSlots: ['breakfast', 'lunch', 'snack', 'dinner'], autoLeftover: true, profile: null
};
export const DEFAULT_HH = { shopDays: [0, 2, 5], split: 'equal' };
export const userSettings = u => ({ ...DEFAULT_USER, ...JSON.parse(u.settings || '{}') });
export const hhSettings = h => ({ ...DEFAULT_HH, ...JSON.parse(h.settings || '{}') });

// ---------- Mahlzeiten ----------
export function loadMeals(db, where, params) {
  const rows = db.all(`SELECT m.*, d.name AS dish_name, d.data AS dish_data, d.owner_id AS dish_owner
                       FROM meals m LEFT JOIN dishes d ON d.id = m.dish_id WHERE ${where} ORDER BY m.date, m.id`, ...params);
  if (!rows.length) return [];
  const byId = new Map();
  const meals = rows.map(r => {
    const dish = r.dish_data ? { id: r.dish_id, ...JSON.parse(r.dish_data) } : null;
    const custom = r.custom ? JSON.parse(r.custom) : null;
    const m = {
      id: r.id, householdId: r.household_id, date: r.date, slot: r.slot, dishId: r.dish_id, cookId: r.cook_id, leftoverOf: r.leftover_of, auto: !!r.auto,
      name: dish ? dish.name : custom ? custom.name : '?', protein: dish ? dish.protein : custom ? custom.protein : 0,
      kcal: dish ? dish.kcal : custom ? custom.kcal : 0, dish, custom: !!custom, eaters: [], leftoverPortions: 0
    };
    byId.set(m.id, m);
    return m;
  });
  const ids = [...byId.keys()];
  const marks = ids.map(() => '?').join(',');
  for (const e of db.all(`SELECT * FROM meal_eaters WHERE meal_id IN (${marks})`, ...ids))
    byId.get(e.meal_id).eaters.push({ userId: e.user_id, portions: e.portions, eaten: !!e.eaten });
  // Reste, die aus diesen Mahlzeiten später gegessen werden, zählen zur Kochmenge der Quelle
  for (const r of db.all(`SELECT m.leftover_of AS src, SUM(e.portions) AS p FROM meals m JOIN meal_eaters e ON e.meal_id = m.id
                          WHERE m.leftover_of IN (${marks}) GROUP BY m.leftover_of`, ...ids))
    byId.get(r.src).leftoverPortions = r.p || 0;
  for (const m of meals) m.cook = m.leftoverOf ? 0 : m.eaters.reduce((a, e) => a + e.portions, 0) + m.leftoverPortions;
  return meals;
}
export const mealsInRange = (db, hhId, from, to) => loadMeals(db, 'm.household_id = ? AND m.date BETWEEN ? AND ?', [hhId, from, to]);

// ---------- Einkauf ----------
// Der Einkauf an einem Einkaufstag deckt alle Tage bis zum Tag vor dem nächsten Einkaufstag ab.
export function tripRange(shopDays, date) {
  const days = shopDays && shopDays.length ? shopDays : DEFAULT_HH.shopDays;
  let from = date;
  for (let i = 0; i < 7 && !days.includes(wdOf(from)); i++) from = addDays(from, -1);
  let next = addDays(from, 1);
  for (let i = 0; i < 7 && !days.includes(wdOf(next)); i++) next = addDays(next, 1);
  return { from, to: addDays(next, -1) };
}

const slug = s => s.toLowerCase().replace(/\s+/g, ' ').trim();
export function shoppingItems(meals) {
  const items = new Map(), basics = new Map();
  for (const m of meals) {
    if (!m.dish || m.leftoverOf || !(m.cook > 0)) continue;
    const label = m.dish.name.split(/ mit | vom /)[0] + ' (' + WD[wdOf(m.date)] + ')';
    for (const ing of m.dish.ingredients || []) {
      const key = slug(ing.name) + '|' + ing.unit;
      let it = items.get(key);
      if (!it) items.set(key, (it = { key, name: ing.name, unit: ing.unit, category: ing.category, store: ing.store || '', pack: ing.pack || null, need: 0, why: [] }));
      if (!it.pack && ing.pack) it.pack = ing.pack;
      if (!it.store && ing.store) it.store = ing.store;
      it.need += ing.amount * m.cook;
      if (!it.why.includes(label)) it.why.push(label);
    }
    for (const b of m.dish.basics || []) {
      const e = basics.get(slug(b)) || { name: b, why: [] };
      const short = m.dish.name.split(/ mit | vom /)[0];
      if (!e.why.includes(short)) e.why.push(short);
      basics.set(slug(b), e);
    }
  }
  const list = [...items.values()].map(it => {
    it.need = Math.round(it.need * 100) / 100;
    if (it.pack && it.pack.size > 0) it.packs = Math.max(1, Math.ceil(it.need / it.pack.size - 1e-6));
    return it;
  });
  return { items: list, basics: [...basics.values()].sort((a, b) => a.name.localeCompare(b.name, 'de')) };
}

// ---------- Geld ----------
// Verteilt total (Cent) nach Gewichten; Rundungsreste gehen an die größten Nachkommaanteile.
export function splitCents(total, weights) {
  const ids = Object.keys(weights).filter(id => weights[id] > 0);
  const sum = ids.reduce((a, id) => a + weights[id], 0);
  if (!ids.length || !(sum > 0)) return {};
  const exact = ids.map(id => ({ id, x: total * weights[id] / sum }));
  const out = {};
  let rest = total;
  for (const e of exact) { out[e.id] = Math.floor(e.x); rest -= out[e.id]; }
  exact.sort((a, b) => (b.x - Math.floor(b.x)) - (a.x - Math.floor(a.x)) || a.id - b.id);
  for (let i = 0; rest > 0; i = (i + 1) % exact.length, rest--) out[exact[i].id]++;
  return out;
}

// Geplante Kalorien pro Person im Zeitraum – Maß für „wer isst wie viel mit".
export function kcalWeights(meals, memberIds) {
  const w = Object.fromEntries(memberIds.map(id => [id, 0]));
  for (const m of meals) for (const e of m.eaters) if (e.userId in w) w[e.userId] += m.kcal * e.portions;
  return w;
}

// Saldo je Person: ausgelegt minus eigener Anteil. Positiv = bekommt Geld zurück.
export function balances(db, hhId) {
  const bal = {};
  for (const r of db.all('SELECT payer_id AS id, SUM(cents) AS c FROM expenses WHERE household_id = ? GROUP BY payer_id', hhId))
    bal[r.id] = (bal[r.id] || 0) + r.c;
  for (const r of db.all(`SELECT s.user_id AS id, SUM(s.cents) AS c FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
                          WHERE e.household_id = ? GROUP BY s.user_id`, hhId))
    bal[r.id] = (bal[r.id] || 0) - r.c;
  return bal;
}

// Möglichst wenige Überweisungen, die alle Salden ausgleichen.
export function settle(bal) {
  const debt = [], cred = [];
  for (const [id, c] of Object.entries(bal)) { if (c < 0) debt.push({ id: +id, c: -c }); else if (c > 0) cred.push({ id: +id, c }); }
  debt.sort((a, b) => b.c - a.c); cred.sort((a, b) => b.c - a.c);
  const out = [];
  let i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    const x = Math.min(debt[i].c, cred[j].c);
    if (x > 0) out.push({ from: debt[i].id, to: cred[j].id, cents: x });
    debt[i].c -= x; cred[j].c -= x;
    if (!debt[i].c) i++;
    if (!cred[j].c) j++;
  }
  return out;
}

// Wer ist als Nächstes mit Einkaufen dran: wenigste Einkäufe in den letzten 8 Wochen, bei Gleichstand niedrigster Saldo.
export function nextShopper(db, hhId, memberIds, today) {
  if (memberIds.length < 2) return memberIds[0] ?? null;
  const since = addDays(today, -56);
  const count = Object.fromEntries(memberIds.map(id => [id, 0]));
  for (const r of db.all('SELECT shopper_id AS id, COUNT(*) AS n FROM trips WHERE household_id = ? AND from_date >= ? AND shopper_id IS NOT NULL AND done_at IS NOT NULL GROUP BY shopper_id', hhId, since))
    if (r.id in count) count[r.id] = r.n;
  const bal = balances(db, hhId);
  return [...memberIds].sort((a, b) => count[a] - count[b] || (bal[a] || 0) - (bal[b] || 0) || a - b)[0];
}

// ---------- Fortschritt ----------
export function progress(db, user, from, to) {
  const s = userSettings(user);
  const days = {};
  for (let d = from; d <= to; d = addDays(d, 1)) days[d] = { date: d, planP: 0, planK: 0, eatP: 0, eatK: 0, meals: 0, eaten: 0 };
  const rows = db.all(`SELECT m.date, m.custom, d.data, e.portions, e.eaten FROM meal_eaters e JOIN meals m ON m.id = e.meal_id
                       LEFT JOIN dishes d ON d.id = m.dish_id WHERE e.user_id = ? AND m.date BETWEEN ? AND ?`, user.id, from, to);
  for (const r of rows) {
    const src = r.data ? JSON.parse(r.data) : r.custom ? JSON.parse(r.custom) : { protein: 0, kcal: 0 };
    const day = days[r.date], p = src.protein * r.portions, k = src.kcal * r.portions;
    day.planP += p; day.planK += k; day.meals++;
    if (r.eaten) { day.eatP += p; day.eatK += k; day.eaten++; }
  }
  const list = Object.values(days).map(d => ({
    ...d, planP: Math.round(d.planP), planK: Math.round(d.planK), eatP: Math.round(d.eatP), eatK: Math.round(d.eatK),
    hit: d.eatP >= 0.8 * s.pGoal
  }));
  return { pGoal: s.pGoal, kGoal: s.kGoal, days: list };
}

// Tage in Folge mit mindestens 80 % des Proteinziels. Der heutige Tag zählt mit, sobald er geschafft ist.
export function streak(db, user, today) {
  const { days } = progress(db, user, addDays(today, -89), today);
  let n = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].hit) n++;
    else if (i !== days.length - 1) break;
  }
  return n;
}
