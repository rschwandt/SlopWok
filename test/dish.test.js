import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { validateDish, parseImport, exportDish, LLM_PROMPT } from '../shared/dish.js';
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
