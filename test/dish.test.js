import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { validateDish, parseImport, exportDish, LLM_PROMPT, sourceHref, sourceLabel } from '../shared/dish.js';
import { encrypt, decrypt } from '../server/push.js';
import { tripRange, settle } from '../server/logic.js';

test('parseImport versteht Code-Zäune, Einzelobjekte, Listen und Hüllen', () => {
  assert.equal(parseImport('Hier ist es:\n```json\n{"name":"A"}\n```').items.length, 1);
  assert.equal(parseImport('[{"name":"A"},{"name":"B"}]').items.length, 2);
  assert.equal(parseImport('{"format":"kochrunde.dish/v1","dishes":[{"name":"A"}]}').items.length, 1);
  assert.equal(parseImport('Klar! {"name":"A"} Viel Spaß.').items.length, 1);
  assert.ok(parseImport('{kaputt').error);
  assert.ok(parseImport('').error);
});

test('Das Beispiel aus dem LLM-Prompt ist gültig und übersteht Export/Import', () => {
  const json = LLM_PROMPT.slice(LLM_PROMPT.indexOf('Beispiel:') + 9, LLM_PROMPT.indexOf('Rezept:'));
  const { dish, errors } = validateDish(JSON.parse(json));
  assert.deepEqual(errors, []);
  assert.equal(dish.ingredients.length, 3);
  assert.deepEqual(validateDish(exportDish(dish)).dish, dish);
});

test('validateDish meldet Fehler verständlich', () => {
  const { dish, errors } = validateDish({ name: 'X', slot: 'brunch', ingredients: [{ name: 'Tofu' }] });
  assert.equal(dish, null);
  assert.equal(errors.length, 5);
});

test('Quelle: Link zur Originalseite oder Text, nur http(s) wird klickbar', () => {
  const base = { name: 'Testgericht', protein: 10, kcal: 100 };
  assert.equal(validateDish({ ...base, url: 'https://www.chefkoch.de/rezepte/123' }).dish.source, 'https://www.chefkoch.de/rezepte/123');
  assert.equal(validateDish({ ...base, quelle: 'www.example.org/x' }).dish.source, 'https://www.example.org/x');
  assert.equal(validateDish({ ...base, source: 'Kochbuch, S. 42' }).dish.source, 'Kochbuch, S. 42');
  assert.equal(validateDish(base).dish.source, undefined);
  assert.equal(sourceLabel('https://www.chefkoch.de/rezepte/123'), 'chefkoch.de');
  assert.equal(sourceHref('Kochbuch, S. 42'), null);
  assert.equal(sourceHref('javascript:alert(1)'), null);
  assert.equal(exportDish(validateDish({ ...base, link: 'https://a.example/r' }).dish).source, 'https://a.example/r');
});

test('Einheiten können kein HTML einschleusen', async () => {
  const unitOf = unit => validateDish({ name: 'Test', protein: 1, kcal: 1, ingredients: [{ name: 'X', amount: 1, unit }] }).dish.ingredients[0].unit;
  assert.doesNotMatch(unitOf('<a href=//x.io>'), /[<>&"']/);
  assert.equal(unitOf('constructor'), 'constructor');
  assert.equal(unitOf('Becher'), 'Becher');
  assert.equal(unitOf('esslöffel'), 'EL');
  // Schon gespeicherte Einheiten entschärft die Anzeige selbst (core.js läuft sonst nur im Browser)
  const src = fs.readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8')
    .replace("'/shared/dish.js'", "'" + new URL('../shared/dish.js', import.meta.url).href + "'");
  const core = await import('data:text/javascript,' + encodeURIComponent(src));
  for (const unit of ['<s>hallo', '<plaintext>', 'constructor']) {
    assert.doesNotMatch(core.fmtQ(2, unit) + core.fmtNice(2, unit), /<|native code|undefined/);
  }
});

test('Push-Verschlüsselung lässt sich vom Empfänger entschlüsseln', () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const body = encrypt('Hallo Welt ✓', { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') });
  assert.equal(decrypt(body, ua.getPrivateKey(), auth), 'Hallo Welt ✓');
});

test('Push-Verschlüsselung entspricht dem Testvektor aus RFC 8291 (Anhang A)', () => {
  const body = encrypt('When I grow up, I want to be a watermelon', {
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg'
  }, { privateKey: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'), salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url') });
  assert.equal(body.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('tripRange: Einkauf deckt die Tage bis vor dem nächsten Einkaufstag ab', () => {
  assert.deepEqual(tripRange([0, 2, 5], '2026-11-16'), { from: '2026-11-16', to: '2026-11-17' }); // Montag
  assert.deepEqual(tripRange([0, 2, 5], '2026-11-19'), { from: '2026-11-18', to: '2026-11-20' }); // Donnerstag -> Mi–Fr
  assert.deepEqual(tripRange([5], '2026-11-16'), { from: '2026-11-14', to: '2026-11-20' });
});

test('settle gleicht mit wenigen Zahlungen aus', () => {
  assert.deepEqual(settle({ 1: 3000, 2: -1000, 3: -2000 }), [{ from: 3, to: 1, cents: 2000 }, { from: 2, to: 1, cents: 1000 }]);
});
