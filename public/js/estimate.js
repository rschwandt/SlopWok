// „Anders gegessen“ und schnelle Extras: Nährwerte schätzen statt Zutaten zusammensuchen. Ausgangspunkt ist eine
// Vorlage, ein eigenes Gericht oder die geplante Mahlzeit; der Regler passt die Größe an, die Zahlen lassen sich
// danach noch von Hand ändern.
import { S, post, put, del, esc, ico, nf, chip, openSheet, closeSheet, drawSheet, toast, todayISO } from './core.js';
import { SLOT_LABEL } from '/shared/dish.js';
import { ESTIMATES, SIZES } from '/shared/estimates.js';

const GROUPS = [...new Set(ESTIMATES.map(e => e.group))];
const sizeAt = f => { const i = SIZES.findIndex(([x]) => x === f); return i < 0 ? 2 : i; };
const fmtF = f => '×' + String(f).replace('.', ',');

// meal: die geplante Mahlzeit, die ersetzt wird (sonst wird ein neuer Eintrag angelegt)
// slots: für neue Einträge die Mahlzeiten, unter denen er landen kann (das erste ist vorausgewählt)
// done: wird nach dem Speichern mit der Antwort des Servers aufgerufen
// quick: Gerichte, die man mit einem Tipp als Extra einträgt (Tag „Extra“, z. B. Proteinshake)
export function openEstimateSheet({ meal, date, slots = ['extra'], quick = [], done }) {
  const me = meal && meal.eaters.find(e => e.userId === S.me.user.id);
  const canKeep = !!(meal && meal.slot === 'dinner' && !meal.leftoverOf && meal.dish);
  const st = { step: 'pick', q: '', group: GROUPS[0], src: '', name: '', p: 0, k: 0, f: 1, keep: false, slot: slots[0] };
  if (me && me.actual) Object.assign(st, { step: 'adjust', src: 'Deine Schätzung', name: me.actual.name, p: me.actual.protein, k: me.actual.kcal, keep: !!me.actual.kept });
  const choose = (src, name, p, k) => { Object.assign(st, { step: 'adjust', src, name, p, k, f: 1 }); drawSheet(); };

  const row = (act, id, name, why, p, k) => '<button class="row" data-act="' + act + '" data-id="' + id + '"><span class="grow"><span class="nm">' + esc(name) + '</span>' +
    (why ? '<span class="why">' + esc(why) + '</span>' : '') + '</span><span class="pill">' + nf(p) + ' g</span><span class="pill k">' + nf(k) + '</span></button>';
  const list = () => {
    const q = st.q.trim().toLowerCase(), hit = s => s.toLowerCase().includes(q);
    const tpl = ESTIMATES.map((e, i) => [e, i]).filter(([e]) => (q ? hit(e.name) || hit(e.group) : st.group === e.group));
    const own = st.group === 'own' || q ? S.dishes.filter(d => !q || hit(d.name) || d.tags.some(hit)).slice(0, 40) : [];
    const rows = tpl.map(([e, i]) => row('tpl', i, e.name, q ? e.group : '', e.protein, e.kcal)).join('') +
      own.map(d => row('dish', d.id, d.name, 'Euer Gericht · pro Portion', d.protein, d.kcal)).join('');
    return rows || '<p class="note">Nichts Passendes. Nimm etwas Ähnliches und stell die Größe ein, oder gib die Werte selbst ein.</p>';
  };
  const vals = () => ({ p: Math.round(st.p * st.f), k: Math.round(st.k * st.f) });
  const sizeLabel = () => SIZES[sizeAt(st.f)][1] + ' (' + fmtF(st.f) + ')';

  const render = () => {
    let h = '';
    if (meal) h += '<p class="note">Statt <b>' + esc(meal.name) + '</b>. Das gilt nur für dich' + (meal.eaters.length > 1 ? ', für die anderen bleibt der Plan, wie er ist' : '') + '.</p>';
    if (st.step === 'pick') {
      if (meal && me && !meal.custom) h += '<div class="card"><div class="rows">' + row('plan', '', 'Wie geplant, nur mehr oder weniger', 'Du hattest ' + nf(me.portions) + ' Portion' + (me.portions === 1 ? '' : 'en') + ' geplant', meal.protein * me.portions, meal.kcal * me.portions) + '</div></div>';
      if (!meal && quick.length) h += '<div class="card"><span class="eyebrow">Schnell</span><div class="rows">' + quick.map(d => row('quick', d.id, d.name, '', d.protein, d.kcal)).join('') + '</div></div>';
      h += '<div class="field"><input class="input" type="search" placeholder="Was war es? z. B. Döner, Pizza, Curry" data-input="q" value="' + esc(st.q) + '" aria-label="Gericht suchen"></div>' +
        (st.q ? '' : '<div class="chips">' + GROUPS.map(g => chip(g, st.group === g, 'data-act="group" data-v="' + g + '"')).join('') + chip('Eure Gerichte', st.group === 'own', 'data-act="group" data-v="own"') + '</div>') +
        '<div class="card"><div class="rows" id="estlist">' + list() + '</div></div>' +
        '<span class="note">Richtwerte für eine normale vegane Portion, eher großzügig: Auswärts wird fast immer zu wenig geschätzt.</span>' +
        '<div class="actions"><button class="linkbtn" data-act="manual">' + ico.edit + 'Werte selbst eingeben</button></div>';
      return h;
    }
    const v = vals();
    h += '<div class="card"><div class="field"><label for="e-name">Was war es?</label><input id="e-name" data-input="name" maxlength="80" value="' + esc(st.name) + '" placeholder="z. B. Döner beim Imbiss"></div>' +
      (st.src ? '<span class="note">Ausgangswert: ' + esc(st.src) + '</span>' : '') +
      '<div class="actions"><button class="linkbtn" data-act="repick">Andere Vorlage</button></div></div>';
    if (st.p || st.k) h += '<div class="card"><div class="split"><span class="lbl">Größe</span><b id="e-size">' + esc(sizeLabel()) + '</b></div>' +
      '<input class="range" type="range" min="0" max="' + (SIZES.length - 1) + '" step="1" value="' + sizeAt(st.f) + '" data-input="size" aria-label="Portionsgröße" aria-valuetext="' + esc(sizeLabel()) + '">' +
      '<div class="range-ticks" aria-hidden="true">' + SIZES.map(([f]) => '<span>' + String(f).replace('0.5', '½').replace('0.75', '¾').replace('1.25', '1¼').replace('1.5', '1½') + '×</span>').join('') + '</div></div>';
    h += '<div class="row2"><div class="field"><label for="e-p">Protein (g)</label><input id="e-p" type="number" inputmode="numeric" min="0" max="500" data-input="p" value="' + (st.p || st.k ? v.p : '') + '"></div>' +
      '<div class="field"><label for="e-k">Kalorien</label><input id="e-k" type="number" inputmode="numeric" min="0" max="10000" data-input="k" value="' + (st.p || st.k ? v.k : '') + '"></div></div>';
    if (canKeep) h += '<div class="field"><span class="lbl">Deine Portion vom warmen Gericht</span><div class="chips">' +
      chip('Übrig, isst jemand anderes oder niemand', !st.keep, 'data-act="keep" data-v="0"') + chip('Esse ich morgen mittags', st.keep, 'data-act="keep" data-v="1"') + '</div>' +
      (st.keep ? '<span class="note">Sie steht morgen als Rest im Plan. Gekocht wird gleich viel.</span>' : '') + '</div>';
    if (!meal && slots.length > 1) h += '<div class="field"><label for="e-slot">Eintragen als</label><select id="e-slot" data-change="slot">' +
      slots.map(s => '<option value="' + s + '"' + (s === st.slot ? ' selected' : '') + '>' + SLOT_LABEL[s] + '</option>').join('') + '</select></div>';
    h += '<button class="btn wide" data-act="save">' + (meal ? 'Als gegessen eintragen' : 'Eintragen') + '</button>';
    if (me && me.actual) h += '<div class="actions"><button class="linkbtn" data-act="undo">' + ico.undo + 'Doch wie geplant</button></div>';
    return h;
  };

  openSheet({
    title: meal ? 'Anders gegessen' : 'Extra eintragen',
    render,
    // Regler und Zahlen ändern nur die Felder, damit Tippen und Ziehen nicht unterbrochen werden
    onInput: el => {
      const k = el.dataset.input, sheet = el.closest('.sheet');
      if (k === 'q') { st.q = el.value; const box = sheet.querySelector('#estlist'); if (box) box.innerHTML = list(); return; }
      if (k === 'name') { st.name = el.value; return; }
      if (k === 'size') {
        st.f = SIZES[+el.value][0];
        const v = vals();
        sheet.querySelector('#e-p').value = v.p; sheet.querySelector('#e-k').value = v.k;
        sheet.querySelector('#e-size').textContent = sizeLabel(); el.setAttribute('aria-valuetext', sizeLabel());
        return;
      }
      // Von Hand geändert: die Größe bleibt stehen, der Regler skaliert ab jetzt die eigene Zahl
      const n = Math.max(0, Number(el.value) || 0) / st.f;
      if (k === 'p') st.p = n; else st.k = n;
    },
    onChange: el => { if (el.dataset.change === 'slot') st.slot = el.value; },
    actions: {
      quick: async el => { const r = await post('/api/meals', { date: date || todayISO(), slot: 'extra', dishId: +el.dataset.id, eaters: [{ userId: S.me.user.id, portions: 1 }], eaten: true }); closeSheet(); toast('Eingetragen'); done && done(r.meal); },
      group: el => { st.group = el.dataset.v; drawSheet(); },
      tpl: el => { const e = ESTIMATES[+el.dataset.id]; choose('Vorlage „' + e.name + '“', e.name, e.protein, e.kcal); },
      dish: el => { const d = S.dishById.get(+el.dataset.id); if (d) choose('„' + d.name + '“, eine Portion', d.name, d.protein, d.kcal); },
      plan: () => choose('wie geplant', meal.name, meal.protein * me.portions, meal.kcal * me.portions),
      manual: () => choose('', st.q.trim(), 0, 0),
      repick: () => { st.step = 'pick'; drawSheet(); },
      keep: el => { st.keep = el.dataset.v === '1'; drawSheet(); },
      undo: async () => { const r = await del('/api/meals/' + meal.id + '/actual'); closeSheet(); toast('Wieder wie geplant'); done && done(r.meal); },
      save: async () => {
        const v = vals(), name = st.name.trim();
        if (!name) return toast('Gib dem Essen einen Namen.', true);
        if (!(v.p > 0 || v.k > 0)) return toast('Wähle eine Vorlage oder trag Werte ein.', true);
        const r = meal
          ? await put('/api/meals/' + meal.id + '/actual', { name, protein: v.p, kcal: v.k, keep: st.keep })
          : await post('/api/meals', { date: date || todayISO(), slot: st.slot, custom: { name, protein: v.p, kcal: v.k }, eaters: [{ userId: S.me.user.id, portions: 1 }], eaten: true });
        closeSheet(); toast('Eingetragen'); done && done(r.meal);
      }
    }
  });
}
