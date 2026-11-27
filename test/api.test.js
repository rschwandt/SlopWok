import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
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
  // Rohe Antwort, für Bilder
  const raw = p => fetch(base + p, { headers: cookie ? { Cookie: cookie } : {} });
  return { raw, get: p => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), put: (p, b) => call('PUT', p, b), del: p => call('DELETE', p) };
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

test('Nur das warme Gericht ist gemeinsam, alles andere plant jede Person für sich', async () => {
  const d = L.addDays(today, 50), both = [{ userId: A.user.id, portions: 1 }, { userId: B.user.id, portions: 1 }];
  // Frühstück für zwei oder für jemand anderen geht nicht
  assert.equal((await anna.post('/api/meals', { date: d, slot: 'breakfast', dishId: oats.id, eaters: both })).status, 400);
  assert.equal((await anna.post('/api/meals', { date: d, slot: 'snack', dishId: oats.id, eaters: [both[1]] })).status, 400);
  const mine = (await anna.post('/api/meals', { date: d, slot: 'breakfast', dishId: oats.id, eaters: [both[0]], cookId: B.user.id,
    leftover: [both[1]] })).meal;
  assert.equal(mine.cookId, null);
  assert.equal(mine.leftoverPortions, 0);
  // Ben kann Annas Frühstück weder mitessen noch ändern, tauschen oder löschen
  assert.equal((await ben.patch('/api/meals/' + mine.id, { eaters: both })).status, 403);
  assert.equal((await ben.del('/api/meals/' + mine.id)).status, 403);
  assert.equal((await ben.post('/api/meals/' + mine.id + '/swap', {})).status, 403);
  // Ein gemeinsames warmes Gericht lässt sich nicht zum Frühstück machen, ein eigenes schon
  const din = (await anna.post('/api/meals', { date: d, slot: 'dinner', dishId: chili.id, eaters: both, leftover: [both[1]] })).meal;
  assert.equal((await anna.patch('/api/meals/' + din.id, { slot: 'lunch' })).status, 400);
  const solo = (await anna.patch('/api/meals/' + din.id, { slot: 'lunch', eaters: [both[0]] })).meal;
  assert.equal(solo.slot, 'lunch');
  assert.equal((await anna.get(`/api/meals?from=${d}&to=${L.addDays(d, 1)}`)).meals.filter(m => m.leftoverOf).length, 0);
  // Ben darf beim warmen Gericht mitessen
  const din2 = (await ben.post('/api/meals', { date: d, slot: 'dinner', dishId: chili.id, eaters: [both[1]] })).meal;
  assert.equal((await anna.patch('/api/meals/' + din2.id, { eaters: both })).status, 200);
  for (const m of [mine, solo, din2]) assert.equal((await anna.del('/api/meals/' + m.id)).status, 200);
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
  const meN = await anna.get('/api/me');
  assert.ok(meN.unread >= 1);
  assert.match(meN.nudge.text, /^Ben /);
  await anna.post('/api/notifications/read');
  const meR = await anna.get('/api/me');
  assert.equal(meR.unread, 0);
  assert.equal(meR.nudge, null);

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
  const week = `/api/meals?from=${start}&to=${L.addDays(start, 6)}`;
  const withCleo = async who => (await who.get(week)).meals.filter(m => m.eaters.some(e => e.userId === C.user.id)).length;
  assert.equal(await withCleo(cleo), 27);
  assert.equal(await withCleo(anna), 13); // Anna sieht davon nur die warmen Gerichte und Reste
  // … und wieder aus: künftige Mahlzeiten nur mit ihr verschwinden aus dem Haushalt
  const leftHh = await cleo.post('/api/household/leave');
  assert.equal(leftHh.household.members.length, 1);
  assert.equal((await anna.get(week)).meals.length, 0);
  // auch die eigenen, die Anna ohnehin nicht sähe, sind aus dem Haushalt verschwunden
  assert.equal(L.mealsInRange(server.db, A.household.id, start, L.addDays(start, 6)).length, 0);
  assert.equal((await anna.get('/api/me')).household.members.length, 2);
});

test('Statische Dateien und Pfadschutz', async () => {
  assert.equal((await fetch(base + '/')).status, 200);
  assert.match(await (await fetch(base + '/shared/dish.js')).text(), /slopwok\.dish\/v1/);
  // Kodierte Schrägstriche dürfen nicht aus public/ bzw. shared/ herausführen (Datenbank, secrets.env, .git, Quelltext)
  for (const p of ['/shared/..%2fserver%2fapi.js', '/shared/..%2f..%2fSlopWok%2fserver%2fapi.js', '/shared/%2e%2e%2fpackage.json', '/..%2fserver%2fapi.js', '/%2e%2e/server/api.js', '/js/..%2f..%2fpackage.json']) {
    const text = await new Promise((ok, no) => http.get(base + p, r => { let b = ''; r.on('data', d => (b += d)); r.on('end', () => ok(r.statusCode + ' ' + b)); }).on('error', no));
    assert.ok(!/createApi|"name": "slopwok"/i.test(text), p + ' → ' + text.slice(0, 60));
  }
});

test('Beitritt mit eigenem Vorschlagsplan: ein gemeinsames warmes Gericht pro Tag', async () => {
  const eva = client(), finn = client();
  const E = await eva.post('/api/register', { name: 'eva', password: 'geheim123' });
  const F = await finn.post('/api/register', { name: 'finn', password: 'geheim123' });
  for (const c of [eva, finn]) { await c.patch('/api/me', { settings: { mode: 'auto' } }); await c.get(`/api/meals?from=${today}&to=${today}`); }
  await finn.post('/api/household/join', { code: E.household.invite });
  const meals = (await eva.get(`/api/meals?from=${today}&to=${L.addDays(today, 6)}`)).meals;
  const his = (await finn.get(`/api/meals?from=${today}&to=${L.addDays(today, 6)}`)).meals;
  for (let i = 0; i < 7; i++) {
    const d = L.addDays(today, i), day = meals.filter(m => m.date === d);
    const dinners = day.filter(m => m.slot === 'dinner');
    assert.equal(dinners.length, 1, d);
    assert.deepEqual(dinners[0].eaters.map(e => e.userId).sort(), [E.user.id, F.user.id].sort());
    if (i) assert.equal(day.filter(m => m.slot === 'lunch' && m.leftoverOf).length, 1, d); // ein Rest, für beide
    for (const slot of ['breakfast', 'snack']) for (const view of [meals, his]) assert.equal(view.filter(m => m.date === d && m.slot === slot).length, 1, d + slot);
  }
});

test('Vorschlagsmodus füllt freie Mahlzeiten, tauscht und respektiert Entferntes', async () => {
  const dora = client();
  const D = await dora.post('/api/register', { name: 'dora', password: 'geheim-geheim' });
  assert.equal((await dora.get(`/api/meals?from=${today}&to=${today}`)).meals.length, 0);
  const me = await dora.patch('/api/me', { settings: { mode: 'auto', pGoal: 150, profile: { weight: 70, height: 175, age: 30, sex: 'f', activity: 2, goal: 'muscle' } } });
  assert.equal(me.user.settings.profile.goal, 'muscle');
  assert.equal((await dora.patch('/api/me', { settings: { profile: { weight: 5 } } })).status, 400);
  const to = L.addDays(today, 13);
  let meals = (await dora.get(`/api/meals?from=${today}&to=${to}`)).meals;
  assert.equal(meals.length, 14 * 4);
  assert.ok(meals.every(m => m.auto && m.eaters[0].userId === D.user.id));
  // Ab Tag 2 ist das Mittag der Rest vom Vorabend
  const day2 = meals.filter(m => m.date === L.addDays(today, 1));
  const lunch = day2.find(m => m.slot === 'lunch');
  assert.equal(lunch.leftoverOf, meals.find(m => m.date === today && m.slot === 'dinner').id);
  // Abwechslung: 14 verschiedene warme Gerichte
  assert.equal(new Set(meals.filter(m => m.slot === 'dinner').map(m => m.dishId)).size, 14);
  // Erneutes Laden legt nichts doppelt an
  assert.equal((await dora.get(`/api/meals?from=${today}&to=${to}`)).meals.length, 56);
  // Tauschen ändert das Gericht und den Rest am Folgetag
  const dinner = meals.find(m => m.date === today && m.slot === 'dinner');
  const swapped = (await dora.post('/api/meals/' + dinner.id + '/swap', {})).meal;
  assert.notEqual(swapped.dishId, dinner.dishId);
  meals = (await dora.get(`/api/meals?from=${today}&to=${to}`)).meals;
  assert.equal(meals.find(m => m.id === lunch.id).dishId, swapped.dishId);
  // Entfernter Vorschlag kommt nicht wieder
  const snack = meals.find(m => m.date === today && m.slot === 'snack');
  await dora.del('/api/meals/' + snack.id);
  assert.equal((await dora.get(`/api/meals?from=${today}&to=${today}`)).meals.filter(m => m.slot === 'snack').length, 0);
  const sug = await dora.get(`/api/plan/suggestion?date=${today}&slot=snack`);
  assert.ok(sug.dishId);
  // Nur gewählte Mahlzeiten, kein Rest: Frühstück weg, Mittag wird eigenes Gericht
  await dora.post('/api/plan/clear', { from: today });
  await dora.patch('/api/me', { settings: { autoSlots: ['dinner'] } });
  meals = (await dora.get(`/api/meals?from=${L.addDays(today, 3)}&to=${L.addDays(today, 3)}`)).meals;
  assert.deepEqual(meals.map(m => m.slot), ['dinner']);
});

test('Login-Bremse hinter dem Proxy lässt sich nicht mit eigenem X-Forwarded-For umgehen', async () => {
  const s = createServer({ db: openDb(':memory:'), loginLimit: 3, trustProxy: true });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + s.address().port + '/api/login';
  const codes = [];
  for (let i = 0; i < 5; i++) {
    // Der Angreifer setzt vorne beliebige Adressen, der Proxy hängt die echte (203.0.113.9) hinten an
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.0.0.' + i + ', 203.0.113.9' }, body: JSON.stringify({ name: 'x', password: 'falsch123' }) });
    codes.push(r.status);
  }
  s.close();
  assert.deepEqual(codes, [401, 401, 401, 429, 429]);
});

async function twoInHousehold(n1, n2) {
  const one = client(), two = client();
  const O = await one.post('/api/register', { name: n1, password: 'geheim123' });
  const T = await two.post('/api/register', { name: n2, password: 'geheim123', invite: O.household.invite });
  const all = (await one.get('/api/dishes')).dishes;
  const breakfast = all.find(x => x.slot === 'breakfast').id, main = all.find(x => x.slot === 'dinner').id;
  const eat = (who, portions = 1) => ({ userId: who.user.id, portions });
  return { one, two, O, T, breakfast, main, eat };
}

test('Plan leeren lässt die eigenen Mahlzeiten der anderen stehen', async () => {
  const { one, two, O, T, breakfast, main, eat } = await twoInHousehold('gina', 'hugo');
  const d = L.addDays(today, 3);
  await one.post('/api/meals', { date: d, slot: 'breakfast', dishId: breakfast, eaters: [eat(O)] });
  await two.post('/api/meals', { date: d, slot: 'breakfast', dishId: breakfast, eaters: [eat(T)] });
  await one.post('/api/meals', { date: d, slot: 'dinner', dishId: main, eaters: [eat(O), eat(T)] });
  assert.equal((await two.post('/api/plan/clear', { from: d })).deleted, 2);
  assert.deepEqual((await one.get(`/api/meals?from=${d}&to=${d}`)).meals.map(m => m.slot), ['breakfast']);
});

test('Eigene Mahlzeiten und „gegessen“ der anderen bleiben privat', async () => {
  const { one, two, O, T, breakfast, main, eat } = await twoInHousehold('ida', 'jona');
  const own = (await one.post('/api/meals', { date: today, slot: 'breakfast', dishId: breakfast, eaters: [eat(O)] })).meal;
  const din = (await one.post('/api/meals', { date: today, slot: 'dinner', dishId: main, eaters: [eat(O), eat(T)] })).meal;
  for (const m of [own, din]) await one.post(`/api/meals/${m.id}/eaten`, { eaten: true });
  const seen = async () => (await two.get(`/api/meals?from=${today}&to=${today}`)).meals;
  const eatenOf = m => m.eaters.find(e => e.userId === O.user.id).eaten;
  let view = await seen();
  assert.deepEqual(view.map(m => m.id), [din.id]);
  assert.equal(eatenOf(view[0]), true); // Standard: der Haushalt darf den Fortschritt sehen
  await one.patch('/api/me', { settings: { share: 'none' } });
  view = await seen();
  assert.equal(eatenOf(view[0]), false);
  assert.equal(eatenOf((await two.post(`/api/meals/${din.id}/eaten`, { eaten: true })).meal), false);
  assert.equal(eatenOf((await two.patch(`/api/meals/${din.id}`, { cookId: T.user.id })).meal), false);
});

test('Anders gegessen: Schätzung zählt nur für die eigene Person, Portion kann an den Rest gehen', async () => {
  const { one, two, O, T, breakfast, main, eat } = await twoInHousehold('rosa', 'sven');
  const prog = async (c, u) => (await c.get('/api/progress/' + u.user.id + '?days=7')).days.at(-1);
  const din = (await one.post('/api/meals', { date: today, slot: 'dinner', dishId: main, eaters: [eat(O), eat(T)] })).meal;
  const cookBefore = din.cook;
  // Werte werden geprüft, nur Mitesser dürfen schätzen
  assert.equal((await one.put(`/api/meals/${din.id}/actual`, { name: 'Döner', protein: -1, kcal: 700 })).status, 400);
  const own = (await one.post('/api/meals', { date: today, slot: 'breakfast', dishId: breakfast, eaters: [eat(O)] })).meal;
  assert.equal((await two.put(`/api/meals/${own.id}/actual`, { name: 'x', protein: 1, kcal: 1 })).status, 400);

  let r = (await one.put(`/api/meals/${din.id}/actual`, { name: 'Döner', protein: 40, kcal: 750, keep: true })).meal;
  const mine = r.eaters.find(e => e.userId === O.user.id);
  assert.equal(mine.eaten, true);
  assert.deepEqual(mine.actual, { name: 'Döner', protein: 40, kcal: 750, kept: 1 });
  assert.equal(r.cook, cookBefore); // die Portion wandert in den Rest, gekocht wird gleich viel
  let p = await prog(one, O);
  assert.equal(p.eatP, 40); assert.equal(p.eatK, 750);
  // Die andere Person sieht den Plan unverändert und nicht, was stattdessen gegessen wurde
  const seen = (await two.get(`/api/meals?from=${today}&to=${today}`)).meals.find(m => m.id === din.id);
  assert.equal(seen.name, din.name);
  assert.equal(seen.eaters.find(e => e.userId === O.user.id).actual, null);
  const next = L.addDays(today, 1);
  let rest = (await one.get(`/api/meals?from=${next}&to=${next}`)).meals.find(m => m.leftoverOf === din.id);
  assert.deepEqual(rest.eaters.map(e => [e.userId, e.portions]), [[O.user.id, 1]]);

  // Ändern behält die Schätzung, neu schätzen ohne Rest nimmt die Portion wieder zurück
  await two.patch(`/api/meals/${din.id}`, { cookId: T.user.id });
  r = (await one.put(`/api/meals/${din.id}/actual`, { name: 'Pizza', protein: 30, kcal: 1100 })).meal;
  assert.equal(r.eaters.find(e => e.userId === O.user.id).actual.name, 'Pizza');
  assert.equal(r.cook, cookBefore - 1); // wer anders isst, für den wird nicht gekocht
  rest = (await one.get(`/api/meals?from=${next}&to=${next}`)).meals.find(m => m.leftoverOf === din.id);
  assert.equal(rest, undefined);

  // Abhaken zurücknehmen löscht die Schätzung
  r = (await one.post(`/api/meals/${din.id}/eaten`, { eaten: false })).meal;
  assert.equal(r.eaters.find(e => e.userId === O.user.id).actual, null);
  p = await prog(one, O);
  assert.equal(p.eatP, 0);

  // Nachgetragen als Mahlzeit, gleich abgehakt
  const lunch = (await one.post('/api/meals', { date: today, slot: 'lunch', custom: { name: 'Bowl', protein: 28, kcal: 700 }, eaters: [eat(O)], eaten: true })).meal;
  assert.equal(lunch.eaters[0].eaten, true);
  assert.equal((await prog(one, O)).eatP, 28);
  assert.equal((await one.put(`/api/meals/${lunch.id}/actual`, { name: 'x', protein: 1, kcal: 1 })).status, 400);
});

test('Kommende Tage: nicht abhakbar, anders essen und auswärts kommen nicht auf den Einkaufszettel', async () => {
  const { one, two, O, T, breakfast, main, eat } = await twoInHousehold('tara', 'udo');
  const d = L.addDays(today, 2);
  const shop = async () => (await one.get('/api/shopping?date=' + d));
  const din = (await one.post('/api/meals', { date: d, slot: 'dinner', dishId: main, eaters: [eat(O), eat(T)] })).meal;
  const own = (await two.post('/api/meals', { date: d, slot: 'breakfast', dishId: breakfast, eaters: [eat(T)], eaten: true })).meal;
  assert.equal(own.eaters[0].eaten, false); // „gleich abgehakt“ gilt nicht für die Zukunft
  assert.equal((await one.post(`/api/meals/${din.id}/eaten`, { eaten: true })).status, 400);
  assert.equal((await one.post(`/api/meals/${din.id}/eaten`, { eaten: false })).status, 200);
  const short = (await one.get('/api/dishes')).dishes.find(x => x.id === main).name.split(/ mit | vom /)[0];
  const need = async () => Object.fromEntries((await shop()).items.filter(i => i.why.every(w => w.startsWith(short))).map(i => [i.key, i.need]));
  const before = await need();

  // Udo isst an dem Abend auswärts: im Voraus eingetragen, nicht abgehakt, nur noch eine Portion wird gekauft
  const r = (await two.put(`/api/meals/${din.id}/actual`, { name: 'Pizza', protein: 30, kcal: 1100 })).meal;
  assert.equal(r.eaters.find(e => e.userId === T.user.id).eaten, false);
  assert.equal(r.cook, 1);
  const after = await need();
  assert.ok(Object.keys(before).length);
  for (const k of Object.keys(before)) assert.ok(Math.abs(after[k] - before[k] / 2) < 0.02, k);

  // Isst niemand mehr mit, verschwindet das Gericht vom Zettel; ein freier Eintrag „auswärts“ kommt nie drauf
  await one.put(`/api/meals/${din.id}/actual`, { name: 'Döner', protein: 40, kcal: 750 });
  const out = (await one.post('/api/meals', { date: d, slot: 'lunch', custom: { name: 'Kantine', protein: 30, kcal: 800 }, eaters: [eat(O)], eaten: true })).meal;
  assert.equal(out.eaters[0].eaten, false);
  assert.ok(!(await shop()).items.some(i => i.why.some(w => w.startsWith(short))));
  // Kostenverteilung: wer nur auswärts isst oder anders isst, trägt nichts zum Einkauf bei
  const meals = (await one.get(`/api/meals?from=${d}&to=${d}`)).meals;
  const mealsT = (await two.get(`/api/meals?from=${d}&to=${d}`)).meals;
  assert.equal(L.kcalWeights(meals, [O.user.id])[O.user.id], 0);
  assert.ok(L.kcalWeights(mealsT, [T.user.id])[T.user.id] > 0); // Udos eigenes Frühstück zählt
});

// Kein dekodierbares Bild, aber ein korrekt aufgebautes JPEG: mehr prüft der Server nicht
function jpeg({ w = 64, h = 48, extra = [], scans = 1, scan = [0x11, 0xff, 0x00, 0xff, 0xd0, 0x22], tail = '' } = {}) {
  const seg = (m, body) => Buffer.concat([Buffer.from([0xff, m, (body.length + 2) >> 8, (body.length + 2) & 255]), Buffer.from(body)]);
  const parts = [Buffer.from([0xff, 0xd8]), ...extra.map(([m, text]) => seg(m, Buffer.from(text))), seg(0xdb, [0, 1, 2]),
    seg(0xc0, [8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0])];
  for (let i = 0; i < scans; i++) parts.push(seg(0xda, [1, 1, 0, 0, 63, 0]), Buffer.from(scan));
  return Buffer.concat([...parts, Buffer.from([0xff, 0xd9]), Buffer.from(tail)]);
}
const photoBody = (o = {}) => ({ full: jpeg(o).toString('base64'), thumb: jpeg().toString('base64') });

test('Fotos sind Opt-in und je Haushalt getrennt', async () => {
  const { one, two, main } = await twoInHousehold('kira', 'luis');
  const stranger = client();
  await stranger.post('/api/register', { name: 'mona', password: 'geheim123' });
  const path = `/api/dishes/${main}/photo`;
  assert.equal((await one.get('/api/me')).user.settings.photos, false);
  assert.equal((await one.put(path, photoBody())).status, 403);
  assert.equal((await one.del(path)).status, 403);
  assert.equal((await one.patch('/api/me', { settings: { photos: 'ja' } })).user.settings.photos, false);
  assert.equal((await one.patch('/api/me', { settings: { photos: true } })).user.settings.photos, true);

  const { photo } = await one.put(path, photoBody());
  assert.match(photo, /^[0-9a-f]{16}$/);
  const res = await two.raw(`${path}/${photo}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.match(res.headers.get('cache-control'), /private/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await two.raw(`${path}/${photo}?size=thumb`)).status, 200);
  assert.equal((await stranger.raw(`${path}/${photo}`)).status, 404);
  assert.equal((await client().raw(`${path}/${photo}`)).status, 401);

  const revIn = async who => (await who.get('/api/dishes')).dishes.find(d => d.id === main).photo;
  assert.equal(await revIn(two), photo);
  assert.equal(await revIn(stranger), null); // dasselbe mitgelieferte Gericht, anderer Haushalt
  await stranger.patch('/api/me', { settings: { photos: true } });
  const theirs = (await stranger.put(path, photoBody({ w: 80 }))).photo;
  assert.notEqual(theirs, photo);
  assert.equal(await revIn(one), photo);

  const next = (await one.put(path, photoBody({ w: 96 }))).photo; // ersetzen: neue Adresse, alte ungültig
  assert.notEqual(next, photo);
  assert.equal((await one.raw(`${path}/${photo}`)).status, 404);
  assert.equal((await one.del(path)).photo, null);
  assert.equal(await revIn(two), null);
  assert.equal(await revIn(stranger), theirs);

  const secret = (await stranger.post('/api/dishes', { name: 'Geheimrezept', protein: 1, kcal: 1 })).dish.id;
  assert.equal((await one.put(`/api/dishes/${secret}/photo`, photoBody())).status, 404);
  assert.equal((await one.put(`/api/dishes/${secret}/photo`, { copyFrom: main })).status, 404);
});

test('Fotos: Metadaten und Anhängsel fallen weg, Ungültiges wird abgelehnt', async () => {
  const nina = client();
  await nina.post('/api/register', { name: 'nina', password: 'geheim123' });
  await nina.patch('/api/me', { settings: { photos: true } });
  const path = `/api/dishes/${(await nina.get('/api/dishes')).dishes[0].id}/photo`;
  const dirty = { extra: [[0xe1, 'Exif GPS 52.52,13.40'], [0xed, 'IPTC Straße 5'], [0xfe, 'geheimer Kommentar']], scans: 3, tail: 'angehängtes Video' };
  const { photo } = await nina.put(path, photoBody(dirty));
  assert.deepEqual(Buffer.from(await (await nina.raw(`${path}/${photo}`)).arrayBuffer()), jpeg({ scans: 3 }));
  const status = async full => (await nina.put(path, { full, thumb: photoBody().thumb })).status;
  assert.equal(await status(Buffer.from('<svg onload=alert(1)>').toString('base64')), 400);
  assert.equal(await status(jpeg({ w: 1601 }).toString('base64')), 400);
  assert.equal(await status(jpeg({ h: 0 }).toString('base64')), 400);
  assert.equal(await status(jpeg({ scans: 33 }).toString('base64')), 400);
  assert.equal(await status(jpeg().subarray(0, -2).toString('base64')), 400);
  assert.equal(await status(Buffer.alloc(510_000, 1).toString('base64')), 400);
  assert.equal(await status(42), 400);
  assert.equal((await nina.put(path, { full: photoBody().full, thumb: jpeg({ w: 241 }).toString('base64') })).status, 400);
});

test('Fotos: Kopieren, Umzug und Löschen', async () => {
  const { one, two, breakfast, main, O } = await twoInHousehold('olga', 'paul');
  for (const c of [one, two]) await c.patch('/api/me', { settings: { photos: true } });
  await one.put(`/api/dishes/${main}/photo`, photoBody());
  await two.put(`/api/dishes/${breakfast}/photo`, photoBody());
  const mk = async who => (await who.post('/api/dishes', { name: 'Kopie', protein: 1, kcal: 1 })).dish.id;
  const copy = await mk(two);
  assert.match((await two.put(`/api/dishes/${copy}/photo`, { copyFrom: main })).photo, /^[0-9a-f]{16}$/);

  // Das Foto kommt auch mit der Mahlzeit
  const meal = (await one.post('/api/meals', { date: today, slot: 'dinner', dishId: main, eaters: [{ userId: O.user.id, portions: 1 }] })).meal;
  assert.match(meal.dish.photo, /^[0-9a-f]{16}$/);

  await two.post('/api/household/leave');
  const after = (await two.get('/api/dishes')).dishes;
  const photoOf = id => after.find(d => d.id === id).photo;
  assert.ok(photoOf(breakfast));      // selbst hochgeladen
  assert.equal(photoOf(main), null);  // von der anderen Person
  assert.equal(photoOf(copy), null);  // auch als Kopie nicht

  const count = id => server.db.get('SELECT COUNT(*) AS n FROM dish_photos WHERE dish_id = ?', id).n;
  const unused = await mk(one);
  await one.put(`/api/dishes/${unused}/photo`, photoBody());
  await one.del(`/api/dishes/${unused}`);
  assert.equal(count(unused), 0);
  const used = await mk(one);
  await one.put(`/api/dishes/${used}/photo`, photoBody());
  await one.post('/api/meals', { date: today, slot: 'dinner', dishId: used, eaters: [{ userId: O.user.id, portions: 1 }] });
  await one.del(`/api/dishes/${used}`);
  assert.equal(count(used), 1);
});

test('Woki: Verfassung in /api/me und beim Abhaken, Einstellungen, abschaltbar', async () => {
  const dora = client();
  const D = await dora.post('/api/register', { name: 'wokitest', display: 'Wiebke', password: 'geheim-geheim' });
  // Neues Konto: Woki ist gut drauf, nicht am Ende
  assert.equal(D.woki.stage, 4);
  assert.equal(D.woki.counts.days, 0);
  assert.equal(D.user.settings.remind, '19:00');
  const dish = (await dora.get('/api/dishes')).dishes.find(d => d.slot === 'dinner');
  const meal = (await dora.post('/api/meals', { date: today, slot: 'dinner', dishId: dish.id, eaters: [{ userId: D.user.id, portions: 1 }] })).meal;
  const r = await dora.post(`/api/meals/${meal.id}/eaten`, { eaten: true, today });
  assert.ok(r.woki.today.eaten >= 1);
  assert.equal((await dora.get('/api/woki')).woki.today.eaten, r.woki.today.eaten);

  const s = (await dora.patch('/api/me', { settings: { remind: '25:00', tz: 'Mars/Olympus' } })).user.settings;
  assert.equal(s.remind, '19:00');
  assert.equal(s.tz, null);
  const s2 = (await dora.patch('/api/me', { settings: { remind: '07:30', tz: 'Europe/Berlin' } })).user.settings;
  assert.equal(s2.remind, '07:30');
  assert.equal(s2.tz, 'Europe/Berlin');
  const off = await dora.patch('/api/me', { settings: { woki: false, remind: null } });
  assert.equal(off.woki, null);
  assert.equal(off.user.settings.remind, null);
});

test('Woki-Erinnerung: ab der Uhrzeit, höchstens einmal am Tag, nur mit etwas zu sagen', async () => {
  const eve = client();
  const E = await eve.post('/api/register', { name: 'remindtest', display: 'Rita', password: 'geheim-geheim' });
  await eve.patch('/api/me', { settings: { tz: 'UTC', remind: '19:00' } });
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  await eve.post('/api/push/subscribe', { endpoint: 'https://push.test/eve', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } });
  const at = (h, m = 0) => new Date(Date.parse(today + 'T00:00:00Z') + (h * 60 + m) * 60000);
  const mine = list => list.filter(x => x.userId === E.user.id);

  assert.equal(mine(await server.remind(at(18, 59))).length, 0); // noch zu früh
  pushed.length = 0;
  const sent = mine(await server.remind(at(19, 30)));
  assert.equal(sent.length, 1);
  assert.match(sent[0].msg, /noch nichts eingetragen/);
  const body = pushed.find(p => p.url === 'https://push.test/eve');
  const msg = JSON.parse(decrypt(body.init.body, ua.getPrivateKey(), auth));
  assert.equal(msg.tag, 'woki');
  assert.equal(msg.url, '/#today');
  assert.equal(mine(await server.remind(at(20))).length, 0); // heute schon erinnert
  // Erinnerungen landen nicht unter Neuigkeiten
  assert.equal((await eve.get('/api/people')).notifications.filter(n => n.kind === 'woki').length, 0);

  // Am nächsten Tag zu spät (mehr als drei Stunden nach der Uhrzeit): nichts nachholen
  const late = new Date(at(23, 30).getTime() + 86400000);
  assert.equal(mine(await server.remind(late)).length, 0);
});
