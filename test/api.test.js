import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { decrypt } from '../server/push.js';
import * as L from '../server/logic.js';

const pushed = [];
let pushJobs = [];
const server = createServer({
  db: openDb(':memory:'), loginLimit: 1000, pushHosts: /^push\.test$/,
  pushFetch: async (url, init) => { pushed.push({ url, init }); return { ok: true, status: 201 }; },
  onPush: p => pushJobs.push(p)
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
test.after(() => server.close());

const now = new Date();
const today = L.isoOf(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));

function client() {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method, headers: { ...(body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: method === 'GET' ? undefined : JSON.stringify(body || {})
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, ...(await res.json()) };
  };
  return { get: p => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), put: (p, b) => call('PUT', p, b), del: p => call('DELETE', p) };
}

const anna = client(), ben = client(), cleo = client();
let A, B, C;

test('Registrierung, Anmeldung, Sitzung', async () => {
  assert.equal((await anna.get('/api/me')).status, 401);
  assert.equal((await anna.post('/api/register', { name: 'anna', password: 'kurz' })).status, 400);
  A = await anna.post('/api/register', { name: 'anna', display: 'Anna', password: 'geheim-geheim' });
  assert.equal(A.status, 200);
  assert.equal(A.household.members.length, 1);
  assert.equal((await ben.post('/api/register', { name: 'Anna', password: 'geheim-geheim' })).status, 409);
  B = await ben.post('/api/register', { name: 'ben', display: 'Ben', password: 'geheim-geheim', invite: A.household.invite });
  assert.equal(B.household.id, A.household.id);
  C = await cleo.post('/api/register', { name: 'cleo', display: 'Cleo', password: 'geheim-geheim' });
  const again = client();
  assert.equal((await again.post('/api/login', { name: 'anna', password: 'falsch' })).status, 401);
  assert.equal((await again.post('/api/login', { name: 'ANNA', password: 'geheim-geheim' })).user.id, A.user.id);
  await again.post('/api/logout');
  assert.equal((await again.get('/api/me')).status, 401);
});

test('Anfragen ohne JSON-Inhaltstyp oder von fremdem Ursprung werden abgelehnt', async () => {
  const r1 = await fetch(base + '/api/logout', { method: 'POST', body: 'x=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(r1.status, 415);
  const r2 = await fetch(base + '/api/logout', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', Origin: 'https://boese.example' } });
  assert.equal(r2.status, 403);
});

let dishes, chili, oats;
test('Gerichte: mitgelieferte, eigene, Import, Rechte', async () => {
  dishes = (await anna.get('/api/dishes')).dishes;
  assert.equal(dishes.length, 41);
  chili = dishes.find(d => d.name.startsWith('Chili sin Carne'));
  oats = dishes.find(d => d.name === 'Overnight Oats');
  const own = await anna.post('/api/dishes', { name: 'Linsensalat', slot: 'Mittag', protein: '24,5', kcal: 500, ingredients: [{ name: 'Linsen', amount: 0.1, unit: 'kg', category: 'huelsen' }] });
  assert.equal(own.status, 200);
  assert.equal(own.dish.slot, 'lunch');
  assert.deepEqual(own.dish.ingredients[0], { name: 'Linsen', amount: 100, unit: 'g', category: 'huelsen' });
  assert.equal((await anna.post('/api/dishes', { name: 'X' })).status, 400);
  // Haushaltsmitglied sieht es, darf es aber nicht ändern; Fremde sehen es nicht
  assert.ok((await ben.get('/api/dishes')).dishes.some(d => d.id === own.dish.id));
  assert.equal((await ben.del('/api/dishes/' + own.dish.id)).status, 403);
  assert.ok(!(await cleo.get('/api/dishes')).dishes.some(d => d.id === own.dish.id));
  assert.equal((await anna.put('/api/dishes/' + chili.id, { name: 'Hack', protein: 1, kcal: 1 })).status, 403);
  const imp = await anna.post('/api/dishes/import', { items: [{ name: 'A-Gericht', protein: 10, kcal: 100 }, { name: 'B', protein: 'viel' }] });
  assert.equal(imp.created.length, 0);
  assert.equal(imp.failed[0].index, 1);
  const imp2 = await anna.post('/api/dishes/import', { items: [{ name: 'A-Gericht', protein: 10, kcal: 100 }] });
  assert.equal(imp2.created.length, 1);
});

let dinner;
test('Gemeinsame Mahlzeit mit Rest am Folgetag, Abhaken, Fortschritt', async () => {
  const r = await anna.post('/api/meals', {
    date: today, slot: 'dinner', dishId: chili.id, cookId: B.user.id,
    eaters: [{ userId: A.user.id, portions: 1.5 }, { userId: B.user.id, portions: 1 }], leftover: [{ userId: A.user.id, portions: 1 }]
  });
  assert.equal(r.status, 200);
  dinner = r.meal;
  assert.equal(dinner.cook, 3.5); // 1,5 + 1 + 1 Portion Rest
  const next = L.addDays(today, 1);
  const meals = (await ben.get(`/api/meals?from=${today}&to=${next}`)).meals;
  assert.equal(meals.length, 2);
  assert.equal(meals[1].leftoverOf, dinner.id);
  assert.equal(meals[1].date, next);
  // Fremde Person kann nicht mitessen und die Mahlzeit nicht sehen
  assert.equal((await anna.post('/api/meals', { date: today, slot: 'snack', dishId: oats.id, eaters: [{ userId: C.user.id, portions: 1 }] })).status, 400);
  assert.equal((await cleo.post('/api/meals/' + dinner.id + '/eaten', { eaten: true })).status, 404);
  await anna.post('/api/meals/' + dinner.id + '/eaten', { eaten: true });
  const people = await ben.get('/api/people?today=' + today);
  const a = people.household.find(p => p.id === A.user.id);
  assert.equal(a.today.eatP, 66); // 44 g × 1,5
  assert.equal(a.today.eaten, 1);
  assert.equal(a.streak, 0); // 66 g < 80 % von 130 g
  await anna.patch('/api/me', { settings: { pGoal: 80 } });
  assert.equal((await ben.get('/api/people?today=' + today)).household.find(p => p.id === A.user.id).streak, 1);
});

test('Einkaufsliste rechnet Kochmenge und Packungen', async () => {
  await anna.patch('/api/household', { settings: { shopDays: [0, 1, 2, 3, 4, 5, 6] } });
  const s = await anna.get('/api/shopping?date=' + today);
  assert.equal(s.from, today);
  assert.equal(s.to, today);
  const reis = s.items.find(i => i.name === 'Reis');
  assert.equal(reis.need, 280); // 80 g × 3,5
  assert.equal(reis.packs, 1);
  const bohnen = s.items.find(i => i.name === 'Kidneybohnen');
  assert.equal(bohnen.need, 420);
  assert.equal(bohnen.packs, 2); // 2 Dosen à 250 g
  assert.ok(s.basics.some(b => b.name === 'Kreuzkümmel'));
  // Der Rest am Folgetag braucht nichts
  const t = await anna.get('/api/shopping?date=' + L.addDays(today, 1));
  assert.equal(t.items.length, 0);
  await ben.post(`/api/shopping/${today}/check`, { key: reis.key, on: true });
  await ben.post(`/api/shopping/${today}/items`, { text: 'Spülmittel' });
  const s2 = await anna.get('/api/shopping?date=' + today);
  assert.equal(s2.items.find(i => i.name === 'Reis').got, true);
  assert.equal(s2.manual[0].text, 'Spülmittel');
});

test('Kasse: Einkauf abschließen, Verteilung nach Verbrauch, Ausgleich', async () => {
  await ben.post(`/api/shopping/${today}/shopper`, { userId: B.user.id });
  const done = await ben.post(`/api/shopping/${today}/done`, { amount: '35,00', split: 'usage' });
  assert.equal(done.expense.cents, 3500);
  let m = await anna.get('/api/money');
  // Anna 1,5 Portionen, Ben 1 (der Rest liegt am Folgetag außerhalb des Einkaufs): 60 % / 40 %
  assert.equal(m.expenses[0].shares[A.user.id], 2100);
  assert.equal(m.balances[B.user.id], 2100);
  assert.equal(m.balances[A.user.id], -2100);
  assert.deepEqual(m.transfers, [{ from: A.user.id, to: B.user.id, cents: 2100 }]);
  assert.equal(m.trips[B.user.id], 1);
  // Als Nächstes ist Anna dran
  assert.equal((await anna.get('/api/shopping?date=' + L.addDays(today, 1))).suggestion, A.user.id);
  await anna.post('/api/expenses', { amount: 10, note: 'Markt', split: 'equal' });
  await anna.post('/api/transfers', { fromId: A.user.id, toId: B.user.id, amount: '16' });
  m = await anna.get('/api/money');
  assert.equal(m.balances[A.user.id], 0);
  assert.equal(m.balances[B.user.id], 0);
  assert.equal(m.transfers.length, 0);
  assert.equal((await cleo.del('/api/expenses/' + m.expenses[0].id)).status, 404);
});

test('splitCents verteilt Rundungsreste vollständig', () => {
  const s = L.splitCents(1000, { 1: 1, 2: 1, 3: 1 });
  assert.equal(s[1] + s[2] + s[3], 1000);
  assert.deepEqual(Object.values(s).sort(), [333, 333, 334]);
});

test('Privatsphäre, Folgen und Anstupsen mit Push', async () => {
  // Cleo ist nicht im Haushalt: Standard „Haushalt" macht Anna für sie unsichtbar
  assert.equal((await cleo.get('/api/progress/' + A.user.id)).status, 403);
  assert.equal((await cleo.get('/api/users/search?q=ann')).users.length, 0);
  assert.equal((await cleo.post('/api/nudge', { userId: A.user.id })).status, 403);
  await anna.patch('/api/me', { settings: { share: 'all' } });
  assert.equal((await cleo.get('/api/users/search?q=ann')).users[0].name, 'anna');
  assert.equal((await cleo.post('/api/follows', { userId: A.user.id })).status, 200);
  assert.equal((await cleo.get('/api/people')).friends[0].streak, 1);
  assert.equal((await cleo.get('/api/progress/' + A.user.id + '?days=7')).days.length, 7);

  // Anna abonniert Push; Ben stupst an
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { endpoint: 'https://push.test/abc', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  assert.equal((await anna.post('/api/push/subscribe', { ...sub, endpoint: 'https://intern.example/x' })).status, 400);
  assert.equal((await anna.post('/api/push/subscribe', sub)).status, 200);
  pushed.length = 0; pushJobs = [];
  assert.equal((await ben.post('/api/nudge', { userId: A.user.id, today })).status, 200);
  await Promise.all(pushJobs);
  assert.equal(pushed.length, 1);
  assert.match(pushed[0].init.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  const msg = JSON.parse(decrypt(pushed[0].init.body, ua.getPrivateKey(), auth));
  assert.match(msg.body, /^Ben /);
  assert.equal((await ben.post('/api/nudge', { userId: A.user.id })).status, 429);
  const p = await anna.get('/api/people');
  assert.equal(p.notifications[0].kind, 'nudge');
  assert.ok((await anna.get('/api/me')).unread >= 1);
  await anna.post('/api/notifications/read');
  assert.equal((await anna.get('/api/me')).unread, 0);

  // Wieder privat: Cleo sieht nichts mehr, Ben (gleicher Haushalt) auch nicht
  await anna.patch('/api/me', { settings: { share: 'none' } });
  assert.equal((await cleo.get('/api/people')).friends.length, 0);
  assert.equal((await ben.get('/api/people')).household.find(x => x.id === A.user.id).visible, false);
  await anna.patch('/api/me', { settings: { share: 'household', nudge: false } });
  assert.equal((await ben.get('/api/people')).household.find(x => x.id === A.user.id).canNudge, false);
});

test('Monatsplan anwenden und Haushalt wechseln', async () => {
  const start = L.addDays(today, 7);
  const r = await cleo.post('/api/plan/template', { start, weeks: 1 });
  assert.equal(r.created, 28); // 7 × (Frühstück, Snack, Abendessen, Rest-Mittag)
  assert.equal((await cleo.post('/api/plan/template', { start, weeks: 1 })).created, 0);
  // Cleo zieht in Annas Haushalt, ihr Plan zieht mit
  const joined = await cleo.post('/api/household/join', { code: A.household.invite });
  assert.equal(joined.household.members.length, 3);
  const meals = (await anna.get(`/api/meals?from=${start}&to=${L.addDays(start, 6)}`)).meals;
  assert.equal(meals.filter(m => m.eaters.some(e => e.userId === C.user.id)).length, 27);
  // … und wieder aus: künftige Mahlzeiten nur mit ihr verschwinden aus dem Haushalt
  const leftHh = await cleo.post('/api/household/leave');
  assert.equal(leftHh.household.members.length, 1);
  assert.equal((await anna.get(`/api/meals?from=${start}&to=${L.addDays(start, 6)}`)).meals.length, 0);
  assert.equal((await anna.get('/api/me')).household.members.length, 2);
});

test('Statische Dateien und Pfadschutz', async () => {
  assert.equal((await fetch(base + '/')).status, 200);
  assert.match(await (await fetch(base + '/shared/dish.js')).text(), /kochrunde\.dish\/v1/);
  assert.notEqual((await fetch(base + '/shared/../server/api.js')).headers.get('content-type'), 'text/javascript; charset=utf-8x');
  const leak = await (await fetch(base + '/%2e%2e/server/api.js')).text();
  assert.ok(!leak.includes('createApi'));
});
