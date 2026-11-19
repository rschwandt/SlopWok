// Gerichteformat „slopwok.dish/v1" – Prüfung und Normalisierung.
// Läuft unverändert im Browser (Import-Vorschau) und auf dem Server (verbindliche Prüfung).

export const FORMAT = 'slopwok.dish/v1';

export const SLOTS = ['breakfast', 'lunch', 'snack', 'dinner'];
export const SLOT_LABEL = { breakfast: 'Frühstück', lunch: 'Mittag', snack: 'Snack', dinner: 'Warmes Gericht', extra: 'Extra' };
const SLOT_ALIAS = {
  frühstück: 'breakfast', fruehstueck: 'breakfast', morgens: 'breakfast',
  mittag: 'lunch', mittagessen: 'lunch',
  zwischenmahlzeit: 'snack', nachtisch: 'snack', dessert: 'snack',
  abendessen: 'dinner', abend: 'dinner', hauptgericht: 'dinner', 'warmes gericht': 'dinner', main: 'dinner'
};

export const CATEGORIES = [
  ['gemuese', 'Obst & Gemüse'], ['kuehl', 'Kühlregal'], ['brot', 'Brot & Backwaren'], ['tk', 'Tiefkühl'],
  ['trocken', 'Nudeln, Reis & Getreide'], ['huelsen', 'Soja & Hülsenfrüchte (trocken)'], ['dose', 'Dosen & Gläser'],
  ['nuss', 'Nüsse, Samen & Mus'], ['gewuerz', 'Gewürze, Öl & Soßen'], ['getraenk', 'Getränke'], ['sonst', 'Sonstiges']
];
const CAT_IDS = new Set(CATEGORIES.map(c => c[0]));

export const UNITS = ['g', 'ml', 'Stk', 'EL', 'TL', 'Zehe', 'Scheibe', 'Stange', 'Bund', 'Dose', 'Prise'];
const UNIT_ALIAS = {
  gramm: 'g', gr: 'g', milliliter: 'ml', stück: 'Stk', stueck: 'Stk', 'stk.': 'Stk', stk: 'Stk', st: 'Stk', x: 'Stk',
  el: 'EL', esslöffel: 'EL', tl: 'TL', teelöffel: 'TL', zehe: 'Zehe', zehen: 'Zehe', scheibe: 'Scheibe', scheiben: 'Scheibe',
  stange: 'Stange', stangen: 'Stange', bund: 'Bund', dose: 'Dose', dosen: 'Dose', prise: 'Prise', prisen: 'Prise', g: 'g', ml: 'ml'
};

const str = (v, max) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');
const num = v => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.replace(',', '.')) : NaN);

function normUnit(u, amount) {
  const raw = str(u, 16);
  const low = raw.toLowerCase();
  if (low === 'kg') return ['g', amount * 1000];
  if (low === 'l' || low === 'liter') return ['ml', amount * 1000];
  return [UNIT_ALIAS[low] || raw || 'Stk', amount];
}

// Gibt { dish, errors } zurück. errors ist eine Liste deutscher Klartext-Meldungen; bei Fehlern ist dish null.
export function validateDish(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { dish: null, errors: ['Kein Objekt.'] };
  const name = str(input.name, 120);
  if (name.length < 2) errors.push('„name" fehlt.');

  let slot = str(input.slot, 30).toLowerCase() || 'dinner';
  slot = SLOT_ALIAS[slot] || slot;
  if (!SLOTS.includes(slot)) errors.push('„slot" muss breakfast, lunch, snack oder dinner sein.');

  const protein = num(input.protein), kcal = num(input.kcal);
  if (!(protein >= 0 && protein <= 300)) errors.push('„protein" (Gramm pro Portion) fehlt oder ist unplausibel.');
  if (!(kcal >= 0 && kcal <= 5000)) errors.push('„kcal" (pro Portion) fehlt oder ist unplausibel.');
  let minutes = num(input.minutes);
  if (!(minutes >= 0 && minutes <= 1440)) minutes = 0;

  const ingredients = [];
  if (input.ingredients != null && !Array.isArray(input.ingredients)) errors.push('„ingredients" muss eine Liste sein.');
  (Array.isArray(input.ingredients) ? input.ingredients : []).slice(0, 60).forEach((raw, i) => {
    const where = 'Zutat ' + (i + 1);
    if (!raw || typeof raw !== 'object') return errors.push(where + ': kein Objekt.');
    const n = str(raw.name, 80);
    if (!n) return errors.push(where + ': „name" fehlt.');
    const a0 = num(raw.amount);
    if (!(a0 > 0 && a0 < 100000)) return errors.push(where + ' (' + n + '): „amount" muss eine Zahl größer 0 sein, pro Portion.');
    const [unit, amount] = normUnit(raw.unit, a0);
    const category = CAT_IDS.has(raw.category) ? raw.category : 'sonst';
    const o = { name: n, amount: Math.round(amount * 100) / 100, unit, category };
    if (raw.pack && typeof raw.pack === 'object') {
      const [, size] = normUnit(raw.unit, num(raw.pack.size));
      if (size > 0) o.pack = { size, label: str(raw.pack.label, 60) };
    }
    const store = str(raw.store, 40);
    if (store) o.store = store;
    ingredients.push(o);
  });

  const list = (v, max, len) => (Array.isArray(v) ? v.map(x => str(x, len)).filter(Boolean).slice(0, max) : []);
  if (errors.length) return { dish: null, errors };
  const dish = {
    name, slot, minutes: Math.round(minutes), protein: Math.round(protein * 10) / 10, kcal: Math.round(kcal),
    tags: list(input.tags, 12, 40), ingredients, basics: list(input.basics, 40, 60), steps: list(input.steps, 40, 1000)
  };
  const tip = str(input.tip, 500);
  // Quelle: Link zur Originalseite (für Bilder usw.) oder ein Hinweis wie „Kochbuch X, S. 42"
  let source = str(input.source ?? input.url ?? input.link ?? input.quelle ?? input.sourceUrl, 500);
  if (/^www\./i.test(source)) source = 'https://' + source;
  if (tip) dish.tip = tip;
  if (source) dish.source = source;
  return { dish, errors };
}

// Klickbarer Link zur Quelle – nur http(s), alles andere bleibt reiner Text.
export function sourceHref(source) {
  if (!source) return null;
  try { const u = new URL(source); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null; } catch { return null; }
}
// Kurzform für die Anzeige: bei Links die Domain, sonst der Text selbst.
export const sourceLabel = source => { const h = sourceHref(source); return h ? new URL(h).hostname.replace(/^www\./, '') : source; };

// Nimmt beliebigen eingefügten Text (auch mit ```json … ``` drumherum) und liefert die enthaltenen Gerichte-Rohdaten.
export function parseImport(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  if (!t) return { items: [], error: 'Kein Text eingefügt.' };
  if (t[0] !== '{' && t[0] !== '[') {
    const a = t.search(/[{[]/);
    if (a < 0) return { items: [], error: 'Kein JSON gefunden.' };
    const close = t[a] === '{' ? '}' : ']';
    t = t.slice(a, t.lastIndexOf(close) + 1);
  }
  let data;
  try { data = JSON.parse(t); } catch (e) { return { items: [], error: 'Das JSON ist nicht gültig: ' + e.message }; }
  const items = Array.isArray(data) ? data : Array.isArray(data.dishes) ? data.dishes : [data];
  if (items.length > 100) return { items: [], error: 'Höchstens 100 Gerichte pro Import.' };
  return { items, error: null };
}

// Export eines gespeicherten Gerichts zurück ins Austauschformat.
export function exportDish(d) {
  const { name, slot, minutes, protein, kcal, tags, ingredients, basics, steps, tip, source } = d;
  return { format: FORMAT, name, slot, minutes, protein, kcal, tags, ingredients, basics, steps, ...(tip ? { tip } : {}), ...(source ? { source } : {}) };
}

export const LLM_PROMPT = `Wandle das folgende Rezept in JSON im Format "${FORMAT}" um. Antworte nur mit dem JSON, ohne Erklärung.

Regeln:
- Alle Mengen, "protein" (Gramm) und "kcal" gelten PRO PORTION. Rechne um, wenn das Rezept für mehrere Portionen ist.
- "slot": eines von "breakfast", "lunch", "snack", "dinner".
- "minutes": gesamte Zubereitungszeit.
- "ingredients": nur was man frisch einkauft. Jede Zutat: "name", "amount" (Zahl), "unit" (g, ml, Stk, EL, TL, Zehe, Scheibe, Stange, Bund, Dose, Prise), "category" (gemuese, kuehl, brot, tk, trocken, huelsen, dose, nuss, gewuerz, getraenk, sonst). Optional "pack": {"size": Zahl in derselben Einheit, "label": "Pack 200 g"} für die übliche Packungsgröße im Supermarkt, und "store" für einen Spezialladen.
- "basics": Gewürze, Öl, Soßen und Vorräte, die man meist zu Hause hat – nur Namen, ohne Menge.
- "steps": kurze Zubereitungsschritte auf Deutsch, Mengen dort pro Portion.
- Schätze Protein und Kalorien aus den Zutaten, wenn das Rezept sie nicht nennt.
- "source": die vollständige URL der Seite, von der das Rezept stammt (dort gibt es Bilder und Details). Ohne Webseite Buch o. Ä. als Text; weglassen, wenn unbekannt.
- Mehrere Rezepte: {"format": "${FORMAT}", "dishes": [ ... ]}.

Beispiel:
{
  "format": "${FORMAT}",
  "name": "Tofu-Erdnuss-Curry mit Spinat und Reis",
  "slot": "dinner",
  "minutes": 35,
  "protein": 41,
  "kcal": 900,
  "tags": ["vegan"],
  "ingredients": [
    {"name": "Tofu natur", "amount": 200, "unit": "g", "category": "kuehl", "pack": {"size": 200, "label": "Pack 200 g"}},
    {"name": "Reis", "amount": 80, "unit": "g", "category": "trocken", "pack": {"size": 1000, "label": "Pack 1 kg"}},
    {"name": "Zwiebel", "amount": 0.5, "unit": "Stk", "category": "gemuese"}
  ],
  "basics": ["Rote Currypaste", "Sojasoße", "Rapsöl"],
  "steps": ["Tofu würfeln und knusprig braten.", "Reis kochen.", "Sauce ansetzen, Tofu unterheben."],
  "tip": "Schmeckt aufgewärmt noch besser.",
  "source": "https://example.org/rezept"
}

Rezept:
`;
