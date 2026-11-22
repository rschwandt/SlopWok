import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { matchWeek, nextWeek } from '../server/swipe.js';
import * as L from '../server/logic.js';

const server = createServer({ db: openDb(':memory:'), loginLimit: 10000 });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
test.after(() => server.close());

const n = new Date();
const today = L.isoOf(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
const week = nextWeek(today), last = L.addDays(week, 6);
let serial = 0;

async function household(size, mode = 'auto') {
  const people = [];
  let invite;
  for (let i = 0; i < size; i++) {
    let cookie = '';
    const call = async (method, path, body) => {
      const res = await fetch(base + path, {
        method, headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: method === 'GET' ? undefined : JSON.stringify({ today, ...body })
      });
      cookie = res.headers.get('set-cookie')?.split(';')[0] || cookie;
      return { status: res.status, ...(await res.json()) };
    };
    const me = await call('POST', '/api/register', { name: 'swiper' + ++serial, password: 'geheim-geheim', invite });
    invite ||= me.household.invite;
    const p = { id: me.user.id, hh: me.household.id, invite, call };
    p.vote = (dishId, like = true) => call('POST', '/api/swipe', { week, dishId, like });
    p.week = async () => (await call('GET', `/api/meals?from=${week}&to=${L.addDays(week, 7)}`)).meals;
    await call('PATCH', '/api/me', { settings: { mode } });
    people.push(p);
  }
  await people[0].week(); // Vorschläge stehen schon, bevor jemand swipet
  people.dishes = (await people[0].call('GET', '/api/swipe')).deck;
  return people;
}
const ids = (...who) => who.map(p => p.id).sort((a, b) => a - b);
const eaters = m => m.eaters.map(e => e.userId).sort((a, b) => a - b);
const dinners = meals => meals.filter(m => m.slot === 'dinner' && m.date <= last);
const matches = meals => dinners(meals).filter(m => m.swiped);
function onePerDay(meals, who) {
  for (let i = 0; i < 7; i++) {
    const d = L.addDays(week, i);
    for (const p of who) assert.equal(dinners(meals).filter(m => m.date === d && eaters(m).includes(p.id)).length, 1, d + ' Person ' + p.id);
  }
}

test('A und B mögen es, C nicht: A und B kochen zusammen, C bekommt einen anderen Vorschlag', async () => {
  const h = await household(3), [a, b, c] = h, x = h.dishes[0];
  await a.vote(x); await b.vote(x); await c.vote(x, false);
  const meals = await a.week(), [m] = matches(meals);
  assert.equal(matches(meals).length, 1);
  assert.deepEqual(eaters(m), ids(a, b));
  const alt = dinners(meals).find(o => o.date === m.date && eaters(o).includes(c.id));
  assert.deepEqual(eaters(alt), ids(c));
  assert.ok(alt.auto && alt.dishId !== x);
  assert.ok(dinners(meals).filter(o => eaters(o).includes(c.id)).every(o => o.dishId !== x));
  onePerDay(meals, h);
});

test('Was alle mögen, geht vor', async () => {
  const h = await household(3), [a, b] = h, all = h.dishes.slice(0, 7), pair = h.dishes[7];
  await a.vote(pair); await b.vote(pair);
  for (const d of all) for (const p of h) await p.vote(d);
  const got = matches(await a.week());
  assert.equal(got.length, 7);
  assert.deepEqual(got.map(m => m.dishId).sort(), [...all].sort());
  assert.ok(got.every(m => m.eaters.length === 3));
});

test('Reichen die gemeinsamen nicht, füllen Teilmengen die übrigen Tage', async () => {
  const h = await household(3), [a, b, c] = h, [all, ab, only] = h.dishes;
  for (const p of h) await p.vote(all);
  await a.vote(ab); await b.vote(ab); await c.vote(only);
  const meals = await a.week(), by = id => matches(meals).find(m => m.dishId === id);
  assert.deepEqual(eaters(by(all)), ids(a, b, c));
  assert.deepEqual(eaters(by(ab)), ids(a, b));
  assert.equal(by(only), undefined, 'allein ist kein Match');
  assert.deepEqual(eaters(dinners(meals).find(m => m.date === by(ab).date && eaters(m).includes(c.id))), ids(c));
  onePerDay(meals, h);
});

test('Im Haushalt ist ein einzelnes Like kein Match und lässt den Plan gemeinsam', async () => {
  const h = await household(3), [a] = h;
  for (const d of h.dishes.slice(0, 5)) await a.vote(d);
  const list = dinners(await a.week());
  assert.equal(matches(list).length, 0);
  assert.equal(list.length, 7);
  assert.ok(list.every(m => m.eaters.length === 3));
});

test('Wer aus einem Match in ein anderes wechselt, lässt niemanden mit einem Ein-Personen-Match zurück', async () => {
  const h = await household(4), [a, b, c, d] = h, [x, y] = h.dishes;
  await a.vote(x); await b.vote(x); await c.vote(y); await d.vote(y);
  const m = matches(await a.week()).find(o => o.dishId === x);
  await c.call('PATCH', '/api/meals/' + m.id, { eaters: [a, b, c].map(p => ({ userId: p.id, portions: 1 })) });
  const meals = await a.week();
  assert.ok(matches(meals).every(o => o.eaters.length > 1));
  onePerDay(meals, h);
});

test('Zwei Paare in einem Haushalt kochen am selben Tag', async () => {
  const h = await household(4), [a, b, c, d] = h, [x, y] = h.dishes;
  await a.vote(x); await b.vote(x); await c.vote(y); await d.vote(y);
  const got = matches(await a.week());
  assert.deepEqual(got.map(eaters).sort(), [ids(a, b), ids(c, d)].sort());
  assert.equal(got[0].date, got[1].date);
});

test('Ohne Stimmen und nach dem Zurücknehmen gibt es die gemeinsamen Vorschläge wie bisher', async () => {
  const h = await household(3), [a, b] = h, x = h.dishes[0];
  const shared = async () => {
    const list = dinners(await a.week());
    assert.equal(list.length, 7);
    assert.ok(list.every(m => m.auto && !m.swiped && m.eaters.length === 3));
  };
  await shared();
  await a.vote(x); await b.vote(x);
  await a.vote(x, null); await b.vote(x, null);
  await shared();
});

test('Ohne Vorschlagsmodus entstehen nur die Matches', async () => {
  const h = await household(3, 'manual'), [a, b, c] = h, x = h.dishes[0];
  await a.vote(x); await b.vote(x); await c.vote(x, false);
  const list = dinners(await a.week());
  assert.equal(list.length, 1);
  assert.deepEqual(eaters(list[0]), ids(a, b));
});

test('Allein landet das Gemochte in der eigenen Woche', async () => {
  const h = await household(1), [a] = h;
  for (const d of h.dishes.slice(0, 3)) await a.vote(d);
  const meals = await a.week();
  assert.equal(matches(meals).length, 3);
  onePerDay(meals, h);
});

test('Der Rest vom Match ist das Mittag am Folgetag und wird nicht extra eingekauft', async () => {
  const h = await household(2), [a, b] = h, x = h.dishes[0];
  await a.vote(x); await b.vote(x);
  const meals = await a.week(), m = matches(meals)[0];
  const rest = meals.filter(o => o.leftoverOf === m.id);
  assert.equal(rest.length, 1);
  assert.equal(rest[0].date, L.addDays(m.date, 1));
  assert.deepEqual(eaters(rest[0]), ids(a, b));
  assert.equal(m.cook, 4);
  for (const p of h) assert.equal((await p.week()).filter(o => o.slot === 'lunch' && o.date === rest[0].date && eaters(o).includes(p.id)).length, 1);
});

test('Selbst Geplantes und geänderte Vorschläge bleiben stehen', async () => {
  const h = await household(2), [a] = h, start = dinners(await a.week());
  const changed = start[0];
  await a.call('PATCH', '/api/meals/' + changed.id, { cookId: a.id });
  await a.call('DELETE', '/api/meals/' + start[1].id);
  const own = (await a.call('POST', '/api/meals', { date: start[1].date, slot: 'dinner', dishId: h.dishes[20], eaters: h.map(p => ({ userId: p.id, portions: 1 })) })).meal;
  for (const d of h.dishes.slice(0, 9)) for (const p of h) await p.vote(d);
  const meals = await a.week();
  assert.equal(meals.find(m => m.id === changed.id).dishId, changed.dishId);
  assert.equal(meals.find(m => m.id === own.id).dishId, own.dishId);
  assert.equal(matches(meals).length, 5);
  onePerDay(meals, h);
});

test('Schon eingekaufte Tage ändern sich nicht', async () => {
  const h = await household(2), [a] = h, trip = L.tripRange([0, 2, 5], week);
  const before = dinners(await a.week()).filter(m => m.date <= trip.to);
  assert.equal((await a.call('POST', `/api/shopping/${trip.from}/done`, {})).status, 200);
  for (const d of h.dishes.slice(0, 9)) for (const p of h) await p.vote(d);
  const meals = await a.week();
  for (const m of before) assert.deepEqual(meals.find(o => o.id === m.id), m);
  assert.ok(matches(meals).length && matches(meals).every(m => m.date > trip.to));
  assert.ok((await a.call('GET', '/api/swipe')).bought.includes(week));
});

test('Ein entferntes Match kommt nicht zurück', async () => {
  const h = await household(2), [a, b] = h, [x, y] = h.dishes;
  await a.vote(x); await b.vote(x);
  const m = matches(await a.week())[0];
  await a.call('DELETE', '/api/meals/' + m.id);
  await a.vote(y); await b.vote(y);
  const meals = await a.week();
  assert.deepEqual(matches(meals).map(o => o.dishId), [y]);
  assert.equal(dinners(meals).filter(o => o.date === m.date).length, 0);
});

test('Aussteigen aus einem Match hält bei der nächsten Stimme', async () => {
  const h = await household(3), [a, b, c] = h, [x, y] = h.dishes;
  for (const p of h) await p.vote(x);
  const m = matches(await a.week())[0];
  await a.call('PATCH', '/api/meals/' + m.id, { eaters: [a, b].map(p => ({ userId: p.id, portions: 1 })) });
  await c.vote(y);
  const meals = await c.week();
  assert.ok(!dinners(meals).some(o => eaters(o).includes(c.id) && (o.date === m.date || o.dishId === x)));
});

test('Ein getauschtes Match taucht nicht an einem anderen Tag wieder auf', async () => {
  const h = await household(2), [a, b] = h, [x, y] = h.dishes;
  await a.vote(x); await b.vote(x);
  await a.call('POST', `/api/meals/${matches(await a.week())[0].id}/swap`, {});
  await a.vote(y);
  assert.ok(!matches(await a.week()).some(m => m.dishId === x));
});

test('Mitessen bei einem Match ersetzt den eigenen Vorschlag', async () => {
  const h = await household(3), [a, b, c] = h, x = h.dishes[0];
  await a.vote(x); await b.vote(x);
  const m = matches(await c.week())[0];
  await c.call('PATCH', '/api/meals/' + m.id, { eaters: h.map(p => ({ userId: p.id, portions: 1 })) });
  onePerDay(await c.week(), h);
  await c.vote(x, false);
  onePerDay(await c.week(), h);
});

test('Plan leeren lässt die Matches nicht wiederauferstehen', async () => {
  const h = await household(2, 'manual'), [a, b] = h, [x, y] = h.dishes;
  await a.vote(x); await b.vote(x);
  await a.call('POST', '/api/plan/clear', { from: week });
  await a.vote(y); await b.vote(y);
  assert.deepEqual(matches(await b.week()).map(m => m.dishId), [y]);
});

test('Wegzug und Beitritt verteilen die Woche neu', async () => {
  const h = await household(3), [a, b, c] = h, x = h.dishes[0];
  for (const p of h) await p.vote(x);
  await c.call('POST', '/api/household/leave');
  assert.deepEqual(matches(await a.week()).map(eaters), [ids(a, b)]);
  assert.deepEqual(matches(await c.week()).map(eaters), [ids(c)]); // wer allein wohnt, braucht kein Gegenüber
  await c.call('POST', '/api/household/join', { code: a.invite });
  const meals = await a.week();
  assert.deepEqual(matches(meals).map(eaters), [ids(a, b, c)]);
  onePerDay(meals, h);
});

test('Ein gelöschtes Gericht verschwindet aus den vorläufigen Matches', async () => {
  const h = await household(1), [a] = h;
  const { dish } = await a.call('POST', '/api/dishes', { name: 'Testcurry', slot: 'dinner', protein: 30, kcal: 600, ingredients: [{ name: 'Reis', amount: 80, unit: 'g' }] });
  await a.vote(dish.id);
  assert.equal(matches(await a.week()).length, 1);
  await a.call('DELETE', '/api/dishes/' + dish.id);
  const meals = await a.week();
  assert.equal(matches(meals).length, 0);
  onePerDay(meals, h);
});

test('Stimmen sind privat und werden geprüft', async () => {
  const h = await household(2), [a, b] = h, x = h.dishes[0];
  await a.vote(x, false);
  const seen = await b.call('GET', '/api/swipe');
  assert.deepEqual(seen.votes, {});
  assert.deepEqual(seen.voters, [a.id]);
  assert.equal((await a.call('GET', '/api/me')).swipeWeek, week);

  const [stranger] = await household(1);
  assert.deepEqual((await stranger.call('GET', '/api/swipe')).voters, []);
  const { dish } = await stranger.call('POST', '/api/dishes', { name: 'Fremdes', slot: 'dinner', protein: 1, kcal: 1, ingredients: [{ name: 'X', amount: 1, unit: 'g' }] });
  assert.equal((await a.vote(dish.id)).status, 404);
  const breakfast = (await a.call('GET', '/api/dishes')).dishes.find(d => d.slot === 'breakfast');
  assert.equal((await a.vote(breakfast.id)).status, 404);
  assert.equal((await a.vote(x, 'ja')).status, 400);
  for (const w of [L.addDays(week, -7), L.addDays(week, 7)])
    assert.equal((await a.call('POST', '/api/swipe', { week: w, dishId: x, like: true })).status, 409);
  assert.equal((await fetch(base + '/api/swipe')).status, 401);
});

test('Die Reihenfolge der Karten ändert sich durch Stimmen nicht', async () => {
  const h = await household(1, 'manual'), [a] = h;
  await a.call('PATCH', '/api/me', { settings: { mode: 'auto' } });
  const { deck } = await a.call('GET', '/api/swipe'); // legt die Vorschläge erst an
  assert.deepEqual((await a.vote(deck[0])).deck, deck);
  assert.deepEqual((await a.call('GET', '/api/swipe')).deck, deck);
});

test('Die kommende Woche beginnt immer am nächsten Montag', () => {
  assert.equal(nextWeek('2026-11-22'), '2026-11-23'); // Sonntag
  assert.equal(nextWeek('2026-11-23'), '2026-11-30'); // Montag
  assert.equal(nextWeek('2026-12-31'), '2027-01-04');
});

test('In der nächsten Woche beginnt eine neue Runde, die alte bleibt stehen', async t => {
  const db = openDb(':memory:'), s = createServer({ db });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  t.after(() => s.close());
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch('http://127.0.0.1:' + s.address().port + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body && JSON.stringify({ today, ...body }) });
    cookie = res.headers.get('set-cookie')?.split(';')[0] || cookie;
    return res.json();
  };
  await call('POST', '/api/register', { name: 'wochen', password: 'geheim-geheim' });
  const first = await call('GET', '/api/swipe');
  const planned = (await call('POST', '/api/swipe', { week, dishId: first.deck[0], like: true })).meals;
  t.mock.timers.enable({ apis: ['Date'], now: new Date(week + 'T12:00:00').getTime() }); // es wird Montag
  const next = await call('GET', '/api/swipe?today=' + week);
  assert.equal(next.week, L.addDays(week, 7));
  assert.deepEqual(next.votes, {});
  await call('POST', '/api/swipe', { today: week, week: next.week, dishId: first.deck[1], like: true });
  assert.deepEqual((await call('GET', `/api/meals?from=${week}&to=${last}&today=${week}`)).meals.filter(m => m.swiped), planned.filter(m => m.swiped));
});

test('Gemochtes ohne Gericht im Plan kommt in der nächsten Runde für alle nach vorne', async t => {
  const db = openDb(':memory:'), s = createServer({ db });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  t.after(() => s.close());
  let invite = '';
  const join = async name => {
    let cookie = '';
    const call = async (method, path, body) => {
      const res = await fetch('http://127.0.0.1:' + s.address().port + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body && JSON.stringify(body) });
      cookie = res.headers.get('set-cookie')?.split(';')[0] || cookie;
      return res.json();
    };
    const me = await call('POST', '/api/register', { name, password: 'geheim-geheim', invite, today });
    invite ||= me.household.invite;
    return call;
  };
  const one = await join('runde1'), two = await join('runde2'); // ohne Vorschläge, damit nichts zufällig im Plan steht
  const { deck } = await one('GET', '/api/swipe?today=' + today);
  const [cooked, alone, no] = [deck[20], deck[25], deck[27]];
  for (const [who, dishId, like] of [[one, cooked, true], [two, cooked, true], [one, alone, true], [two, no, false]])
    await who('POST', '/api/swipe', { today, week, dishId, like });
  t.mock.timers.enable({ apis: ['Date'], now: new Date(week + 'T12:00:00').getTime() }); // nächste Runde
  const mine = await one('GET', '/api/swipe?today=' + week), theirs = await two('GET', '/api/swipe?today=' + week);
  assert.equal(mine.deck[0], alone);
  assert.deepEqual(theirs.deck, mine.deck);
  assert.deepEqual(mine.again, [alone]);
  assert.deepEqual(theirs.again, [], 'wer es mochte, bleibt privat');
  assert.deepEqual(mine.votes, {}, 'aufgenommen heißt nicht schon gewählt');
});

// Zufallszahlen mit festem Startwert, damit ein Fehlschlag wiederholbar ist
function random(seed) {
  let x = seed;
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

test('Verteilung: immer die größte mögliche Runde, niemand doppelt', () => {
  const r = random(1);
  for (let run = 0; run < 5000; run++) {
    const users = Array.from({ length: 1 + Math.floor(r() * 6) }, (_, i) => i + 1);
    const days = Array.from({ length: 7 }, (_, i) => ({ date: 'd' + i, free: new Set(users.filter(() => r() < 0.85)) }));
    const p = r(), min = r() < 0.5 ? 1 : 2, likes = new Map();
    for (let d = 1; d <= 14; d++) likes.set(d, new Set(users.filter(() => r() < p)));
    const free = new Map(days.map(d => [d.date, new Set(d.free)])), left = new Map([...likes].map(([d, u]) => [d, new Set(u)]));
    const biggest = () => Math.max(0, ...[...left.values()].flatMap(u => [...free.values()].map(f => [...u].filter(x => f.has(x)).length)));
    for (const m of matchWeek({ days, likes, min })) {
      assert.ok(m.users.length >= min, 'zu klein, Lauf ' + run);
      assert.equal(m.users.length, biggest(), 'Lauf ' + run);
      for (const u of m.users) {
        assert.ok(free.get(m.date).delete(u), 'zwei Gerichte am Tag, Lauf ' + run);
        assert.ok(left.get(m.dishId).delete(u), 'Gericht doppelt oder nicht gemocht, Lauf ' + run);
      }
    }
    assert.ok(biggest() < min, 'Match übersehen, Lauf ' + run);
  }
});

test('Zufällige Abläufe über die API hinterlassen einen stimmigen Plan', async () => {
  const r = random(7), one = list => list[Math.floor(r() * list.length)];
  for (let run = 0; run < 15; run++) {
    const h = await household(2 + Math.floor(r() * 4)), deck = h.dishes.slice(0, r() < 0.5 ? 8 : 28);
    for (let i = 0; i < 45; i++) {
      const res = await one(h).vote(one(deck), one([true, true, false, null]));
      assert.equal(res.status, 200, 'Lauf ' + run);
    }
    const meals = await h[0].week();
    onePerDay(meals, h);
    const state = await Promise.all(h.map(p => p.call('GET', '/api/swipe')));
    for (const m of dinners(meals)) {
      for (const id of eaters(m)) {
        const v = state[h.findIndex(p => p.id === id)].votes[m.dishId];
        if (m.swiped) assert.ok(m.eaters.length > 1, 'Match allein, Lauf ' + run);
        if (m.swiped) assert.equal(v, true, 'nicht gemochtes Match, Lauf ' + run);
      }
      if (!m.swiped) assert.ok(!matches(meals).some(o => o.date === m.date && o.dishId === m.dishId), 'dasselbe Gericht doppelt gekocht, Lauf ' + run);
    }
    for (const p of h) {
      const own = await p.week();
      for (let i = 1; i < 7; i++) assert.equal(own.filter(m => m.date === L.addDays(week, i) && m.slot === 'lunch' && eaters(m).includes(p.id)).length, 1, 'Mittag, Lauf ' + run);
    }
  }
});
