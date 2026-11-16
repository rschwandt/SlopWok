// Liest die Rezeptdaten aus der ursprünglichen Einzelnutzer-App (ernaehrungsplan-app/index.html)
// und schreibt sie im Kochrunde-Gerichteformat nach server/seed.json.
// Aufruf: node tools/build-seed.mjs [pfad/zur/index.html]
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = process.argv[2] || path.join(root, '..', 'ernaehrungsplan-app', 'index.html');
const html = fs.readFileSync(src, 'utf8');
const script = html.split('<script>')[1].split('</script>')[0];
const ctx = { module: {}, console };
vm.runInNewContext(script + '\n;globalThis.__out = { I, ASIA: [...ASIA], WEEKS, M, BOOST, ROT_B, ROT_S, BASICS, BALIAS };', ctx);
const { I, ASIA, WEEKS, M, BOOST, ROT_B, ROT_S, BASICS, BALIAS } = ctx.__out;

const CAT = { soja: 'huelsen' };
const asia = new Set(ASIA);
const ing = ([id, q]) => {
  const it = I[id];
  const o = { name: it.n, amount: q, unit: it.u, category: CAT[it.c] || it.c };
  if (it.p && it.p !== 1) o.pack = { size: it.p, label: it.pl || '' };
  if (asia.has(id)) o.store = 'Asia-Laden';
  return o;
};
const basics = list => [...new Set((list || []).flatMap(b => BALIAS[b] || [b]))];
const SLOT = { b: 'breakfast', l: 'lunch', s: 'snack' };

const dishes = [];
WEEKS.forEach((w, wi) => w.days.forEach((d, k) => dishes.push({
  key: 'w' + wi + 'd' + k, name: d.n, slot: 'dinner', minutes: d.t, protein: d.p, kcal: d.k,
  tags: ['vegan', w.title], ingredients: d.ing.map(ing), basics: basics(d.b), steps: d.steps, ...(d.tip ? { tip: d.tip } : {})
})));
for (const [key, m] of Object.entries(M)) dishes.push({
  key, name: m.n, slot: SLOT[m.slot], minutes: 5, protein: m.p, kcal: m.k, tags: ['vegan'],
  ingredients: m.ing.map(ing), basics: basics(m.b), steps: m.steps
});
for (const x of BOOST) dishes.push({
  key: x.id, name: x.n, slot: 'snack', minutes: 1, protein: x.p, kcal: x.k, tags: ['vegan', 'Extra'],
  ingredients: x.ing.map(ing), basics: [], steps: []
});

const basicInfo = {};
for (const [n, b] of Object.entries(BASICS)) if (b.info || b.a) basicInfo[n] = { ...(b.info ? { info: b.info } : {}), ...(b.a ? { store: 'Asia-Laden' } : {}) };

const out = {
  dishes,
  template: {
    name: 'Veganer High-Protein-Monatsplan',
    dinners: WEEKS.flatMap((w, wi) => w.days.map((d, k) => 'w' + wi + 'd' + k)),
    breakfast: ROT_B, snack: ROT_S
  },
  basicInfo
};
fs.writeFileSync(path.join(root, 'server', 'seed.json'), JSON.stringify(out, null, 1));
console.log(dishes.length + ' Gerichte nach server/seed.json geschrieben');
