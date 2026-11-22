// Ansicht „Gerichte": Bibliothek, eigenes Gericht anlegen/ändern, Import im Format slopwok.dish/v1.
import { S, post, api, del, esc, ico, nf, pills, head, chip, settingsBtn, toast, copyText, fmtQ, loadDishes, openSheet, closeSheet, drawSheet, currentSheet, sourceHtml } from './core.js';
import { SLOTS, SLOT_LABEL, CATEGORIES, UNITS, validateDish, parseImport, exportDish, LLM_PROMPT, FORMAT, sourceLabel } from '/shared/dish.js';
import { openMealSheet } from './today.js';
import { photosOn, thumbHtml, bannerHtml, addPhotoHtml, figureHtml, pickHtml, compressPhoto, savePhoto, changePhoto, removePhoto, resetPhotoConfirm } from './photo.js';

let q = '', filter = 'all';

function listHtml() {
  const s = q.trim().toLowerCase();
  const list = S.dishes.filter(d => (filter === 'all' || (filter === 'mine' ? !d.builtin : d.slot === filter)) &&
    (!s || d.name.toLowerCase().includes(s) || d.tags.some(t => t.toLowerCase().includes(s)) || d.ingredients.some(i => i.name.toLowerCase().includes(s))));
  if (!list.length) return '<p class="note">' + (filter === 'mine' && !s ? 'Noch keine eigenen Gerichte. Leg eins an oder importiere Rezepte.' : 'Nichts gefunden.') + '</p>';
  return list.map(d => '<button class="row" data-act="dish" data-id="' + d.id + '"><span class="grow"><span class="nm">' + esc(d.name) + '</span>' +
    '<span class="why">' + SLOT_LABEL[d.slot] + ' · ' + nf(d.protein) + ' g Protein · ' + nf(d.kcal) + ' kcal' + (d.minutes ? ' · ' + d.minutes + ' Min.' : '') + (d.builtin ? '' : ' · von ' + esc(d.mine ? 'dir' : d.ownerName || '?')) + '</span></span>' + thumbHtml(d) + '</button>').join('');
}
function render() {
  return head(S.dishes.length + ' Gerichte', 'Gerichte', settingsBtn()) +
    '<div class="actions"><button class="btn" data-act="new">' + ico.plus + 'Neues Gericht</button><button class="linkbtn" data-act="import">' + ico.copy + 'Importieren</button></div>' +
    '<input class="input" type="search" placeholder="Suchen nach Name, Zutat oder Stichwort" data-input="q" value="' + esc(q) + '" aria-label="Gerichte durchsuchen">' +
    '<div class="chips">' + [['all', 'Alle'], ...SLOTS.map(s => [s, SLOT_LABEL[s]]), ['mine', 'Eigene']].map(([v, l]) => chip(l, filter === v, 'data-act="filter" data-v="' + v + '"')).join('') + '</div>' +
    '<div class="card"><div class="rows" id="dishes">' + listHtml() + '</div></div>';
}

// ---------- Detail ----------
function openDish(d) {
  let confirm = false;
  resetPhotoConfirm();
  const redraw = () => { if (currentSheet() === def) drawSheet(); };
  const photoDone = photo => { d.photo = photo; redraw(); if (S.view === 'dishes') S.render(); };
  const def = {
    title: d.name,
    render: () => '<div class="card">' + bannerHtml(d, { edit: true }) + pills(d.protein, d.kcal, d.minutes) + '<span class="note">' + SLOT_LABEL[d.slot] + ' · Mengen für 1 Portion' + (d.tags.length ? ' · ' + esc(d.tags.join(', ')) : '') + '</span>' +
      (d.ingredients.length ? '<ul class="ing">' + d.ingredients.map(i => '<li><span>' + esc(i.name) + '</span><span>' + fmtQ(i.amount, i.unit) + '</span></li>').join('') + '</ul>' : '') +
      (d.basics.length ? '<div class="basics"><b>Aus dem Vorrat:</b> ' + esc(d.basics.join(', ')) + '</div>' : '') +
      (d.steps.length ? '<ol class="steps">' + d.steps.map(s => '<li>' + esc(s) + '</li>').join('') + '</ol>' : '') +
      (d.tip ? '<div class="note">' + esc(d.tip) + '</div>' : '') + sourceHtml(d.source) + '</div>' +
      '<button class="btn wide" data-act="plan">' + ico.t_plan + 'Einplanen</button>' +
      '<div class="actions">' + addPhotoHtml(d) + (d.mine ? '<button class="linkbtn" data-act="edit">' + ico.edit + 'Bearbeiten</button>' : '<button class="linkbtn" data-act="copyEdit">' + ico.edit + 'Als eigenes Gericht anpassen</button>') +
      '<button class="linkbtn" data-act="json">' + ico.copy + 'JSON kopieren</button>' +
      (d.mine ? (confirm ? '<button class="linkbtn danger" data-act="delYes">Wirklich löschen</button>' : '<button class="linkbtn danger" data-act="del">' + ico.trash + 'Löschen</button>') : '') + '</div>',
    onChange: el => { if (el.dataset.change === 'photo') return changePhoto(el, redraw, photoDone); },
    actions: {
      photoDel: el => removePhoto(el, redraw, photoDone),
      plan: () => openMealSheet({ date: S.date, slot: d.slot, dishId: d.id }),
      edit: () => openForm(d, d.id),
      copyEdit: () => openForm(d, null),
      json: () => copyText(JSON.stringify(exportDish(d), null, 2), 'JSON kopiert'),
      del: () => { confirm = true; drawSheet(); },
      delYes: async () => { await del('/api/dishes/' + d.id); closeSheet(); await loadDishes(); toast('Gelöscht'); S.render(); }
    }
  };
  openSheet(def);
}

// ---------- Formular ----------
function openForm(src, id) {
  const st = {
    name: src ? src.name : '', slot: src ? src.slot : 'dinner', minutes: src ? src.minutes : '', protein: src ? src.protein : '', kcal: src ? src.kcal : '',
    ings: src ? src.ingredients.map(i => ({ ...i })) : [{ name: '', amount: '', unit: 'g', category: 'gemuese' }],
    basics: src ? src.basics.join(', ') : '', steps: src ? src.steps.join('\n') : '', tip: src ? src.tip || '' : '', source: src ? src.source || '' : '', tags: src ? src.tags : [], errors: [],
    photo: null, photoGone: false, photoBusy: false // photo: gewählt, wird erst beim Speichern hochgeladen
  };
  const photoField = () => {
    if (!photosOn()) return '';
    if (!st.photo && (st.photoGone || !src?.photo)) return '<div class="actions">' + pickHtml('Foto hinzufügen', '', st.photoBusy) + '</div>';
    const tools = pickHtml('Foto ändern', '', st.photoBusy) + '<button type="button" class="linkbtn danger" data-act="photoClear" aria-label="Foto entfernen">' + ico.trash + '</button>';
    const url = st.photo ? 'data:image/jpeg;base64,' + st.photo.full : esc('/api/dishes/' + src.id + '/photo/' + src.photo);
    return figureHtml(url, 'Foto des Gerichts', tools);
  };
  const f = (key, label, attrs = '') => '<div class="field"><label for="f-' + key + '">' + label + '</label><input id="f-' + key + '" data-input="' + key + '" value="' + esc(st[key]) + '" ' + attrs + '></div>';
  const render = () => photoField() + f('name', 'Name', 'maxlength="120" placeholder="z. B. Linsen-Bolognese"') +
    '<div class="row2"><div class="field"><label for="f-slot">Mahlzeit</label><select id="f-slot" data-change="slot">' + SLOTS.map(s => '<option value="' + s + '"' + (s === st.slot ? ' selected' : '') + '>' + SLOT_LABEL[s] + '</option>').join('') + '</select></div>' +
    f('minutes', 'Minuten', 'inputmode="numeric"') + '</div>' +
    '<div class="row2">' + f('protein', 'Protein (g) pro Portion', 'inputmode="decimal"') + f('kcal', 'Kalorien pro Portion', 'inputmode="numeric"') + '</div>' +
    '<div class="card"><span class="eyebrow">Zutaten für 1 Portion</span>' + st.ings.map((i, k) =>
      '<div class="ing-edit"><div class="ingrow"><input class="input" placeholder="Zutat" aria-label="Zutat ' + (k + 1) + '" data-input="ing" data-k="' + k + '" data-f="name" value="' + esc(i.name) + '">' +
      '<input class="input" placeholder="Menge" aria-label="Menge" inputmode="decimal" data-input="ing" data-k="' + k + '" data-f="amount" value="' + esc(i.amount) + '">' +
      '<select class="input" aria-label="Einheit" data-change="ing" data-k="' + k + '" data-f="unit">' + [...new Set([...UNITS, i.unit])].map(u => '<option' + (u === i.unit ? ' selected' : '') + '>' + esc(u) + '</option>').join('') + '</select>' +
      '<button type="button" class="addbtn x" data-act="rmIng" data-k="' + k + '" aria-label="Zutat entfernen">' + ico.close + '</button>' +
      '<select class="input cat" aria-label="Regal" data-change="ing" data-k="' + k + '" data-f="category">' + CATEGORIES.map(([c, n]) => '<option value="' + c + '"' + (c === i.category ? ' selected' : '') + '>' + n + '</option>').join('') + '</select></div></div>').join('') +
      '<div class="actions"><button type="button" class="linkbtn" data-act="addIng">' + ico.plus + 'Zutat</button></div>' +
      '<span class="note">Nur was frisch gekauft wird. Die Einkaufsliste rechnet daraus die Mengen für alle Esser.</span></div>' +
    f('basics', 'Aus dem Vorrat (mit Komma getrennt)', 'placeholder="Olivenöl, Salz, Kreuzkümmel"') +
    '<div class="field"><label for="f-steps">Zubereitung (ein Schritt pro Zeile)</label><textarea id="f-steps" data-input="steps">' + esc(st.steps) + '</textarea></div>' +
    f('tip', 'Tipp (optional)') +
    f('source', 'Quelle (optional)', 'inputmode="url" autocapitalize="off" spellcheck="false" placeholder="Link zur Rezeptseite oder z. B. Kochbuch, S. 42"') +
    (st.errors.length ? '<div class="err" role="alert">' + st.errors.map(esc).join('<br>') + '</div>' : '') +
    '<button class="btn wide" data-act="save">' + (id ? 'Speichern' : 'Gericht anlegen') + '</button>';
  const redraw = () => { if (currentSheet() === def) drawSheet(); };
  const pickPhoto = async el => {
    const file = el.files && el.files[0];
    if (!file) return;
    st.photoBusy = true; redraw();
    try { st.photo = await compressPhoto(file); st.photoGone = false; } finally { st.photoBusy = false; redraw(); }
  };
  // Erst nach dem Gericht: ein neues hat vorher keine Kennung
  const storePhoto = async dishId => {
    if (!photosOn()) return;
    if (st.photo) return savePhoto(dishId, st.photo);
    if (st.photoGone) { if (id && src?.photo) await del('/api/dishes/' + dishId + '/photo'); return; }
    if (!id && src?.photo) await savePhoto(dishId, { copyFrom: src.id });
  };
  const def = {
    title: id ? 'Gericht bearbeiten' : 'Neues Gericht', render,
    onInput: el => { if (el.dataset.input === 'ing') st.ings[+el.dataset.k][el.dataset.f] = el.value; else st[el.dataset.input] = el.value; },
    onChange: el => {
      if (el.dataset.change === 'photo') return pickPhoto(el);
      if (el.dataset.change === 'ing') st.ings[+el.dataset.k][el.dataset.f] = el.value;
      else if (el.dataset.change === 'slot') st.slot = el.value;
    },
    actions: {
      photoClear: () => { st.photo = null; st.photoGone = true; drawSheet(); },
      addIng: () => { st.ings.push({ name: '', amount: '', unit: 'g', category: st.ings.length ? st.ings[st.ings.length - 1].category : 'gemuese' }); drawSheet(); },
      rmIng: el => { st.ings.splice(+el.dataset.k, 1); drawSheet(); },
      save: async () => {
        if (st.photoBusy) return toast('Das Foto ist gleich fertig …');
        const raw = {
          name: st.name, slot: st.slot, minutes: st.minutes || 0, protein: st.protein, kcal: st.kcal, tags: st.tags,
          ingredients: st.ings.filter(i => String(i.name).trim()), basics: st.basics.split(',').map(s => s.trim()).filter(Boolean),
          steps: st.steps.split('\n').map(s => s.trim()).filter(Boolean), tip: st.tip, source: st.source
        };
        const v = validateDish(raw);
        if (!v.dish) { st.errors = v.errors; drawSheet(); return; }
        const r = await api(id ? 'PUT' : 'POST', '/api/dishes' + (id ? '/' + id : ''), raw);
        let photoError = '';
        try { await storePhoto(r.dish.id); } catch (e) { photoError = e.message; }
        await loadDishes(); closeSheet();
        if (photoError) toast('Gericht gespeichert, das Foto nicht: ' + photoError, true);
        else toast(id ? 'Gespeichert' : 'Angelegt');
        S.render();
        if (!id) { filter = 'mine'; S.render(); }
        return r;
      }
    }
  };
  openSheet(def);
}

// ---------- Import ----------
function openImport() {
  const st = { text: '', checked: null, error: '', source: '' };
  const check = () => {
    const p = parseImport(st.text);
    st.error = p.error || '';
    st.checked = p.error ? null : p.items.map(raw => ({ raw, ...validateDish(raw) }));
  };
  const render = () => {
    let h = '<div class="card"><p>Lass dir Rezepte von einem KI-Assistenten ins passende Format bringen:</p><ol class="steps">' +
      '<li>Prompt kopieren und bei ChatGPT, Claude oder einem anderen Assistenten einfügen.</li><li>Dein Rezept darunter setzen – Text, Link-Inhalt oder ein Foto der Seite. Gib den Link mit, dann kommt er als Quelle ins Gericht und du findest Bilder und Details auf der Originalseite wieder.</li><li>Die Antwort hier einfügen und prüfen.</li></ol>' +
      '<div class="actions"><button class="linkbtn" data-act="prompt">' + ico.copy + 'Prompt kopieren</button></div>' +
      '<span class="note">Format: <b>' + FORMAT + '</b>. Einzelnes Gericht, Liste oder {"dishes": [...]} – alles geht.</span></div>' +
      '<div class="field"><label for="i-text">JSON einfügen</label><textarea id="i-text" class="mono" data-input="text" spellcheck="false" autocapitalize="off" placeholder=\'{"format": "' + FORMAT + '", "name": "…"}\'>' + esc(st.text) + '</textarea></div>' +
      '<div class="field"><label for="i-file">oder Datei wählen (.json)</label><input id="i-file" type="file" accept=".json,application/json,text/plain" data-change="file"></div>';
    if (st.error) h += '<p class="err" role="alert">' + esc(st.error) + '</p>';
    if (st.checked) {
      const ok = st.checked.filter(c => c.dish).length;
      h += '<div class="card"><span class="eyebrow">Prüfung</span><div class="rows">' + st.checked.map(c => '<div class="row"><span class="grow"><span class="nm">' + esc((c.dish || c.raw || {}).name || 'Ohne Namen') + '</span>' +
        (c.dish ? '<span class="why">' + SLOT_LABEL[c.dish.slot] + ' · ' + nf(c.dish.protein) + ' g Protein · ' + nf(c.dish.kcal) + ' kcal · ' + c.dish.ingredients.length + ' Zutaten' + (c.dish.source ? ' · Quelle: ' + esc(sourceLabel(c.dish.source)) : '') + '</span>'
          : '<span class="err">' + c.errors.map(esc).join(' ') + '</span>') + '</span>' + (c.dish ? '<span class="pill">passt</span>' : '') + '</div>').join('') + '</div></div>';
      // Gerichte ohne Quelle: Link hier nachtragen (gilt für alle ohne eigene Quelle)
      const missing = st.checked.filter(c => c.dish && !c.dish.source).length;
      if (ok && ok === st.checked.length && missing) h += '<div class="field"><label for="i-source">Quelle' + (missing < ok ? ' für die ' + missing + ' ohne' : '') + ' (optional)</label><input id="i-source" data-input="source" inputmode="url" autocapitalize="off" spellcheck="false" value="' + esc(st.source) + '" placeholder="Link zur Rezeptseite"><span class="note">Damit du Bilder und Details später auf der Originalseite findest.</span></div>';
      if (ok && ok === st.checked.length) h += '<button class="btn wide" data-act="doImport">' + ok + (ok === 1 ? ' Gericht' : ' Gerichte') + ' importieren</button>';
      else if (st.checked.length) h += '<p class="note">Bitte die markierten Fehler im JSON beheben (oder den Assistenten darum bitten) und noch einmal prüfen.</p><button class="btn wide" data-act="check">Noch einmal prüfen</button>';
      return h;
    }
    return h + '<button class="btn wide" data-act="check">Prüfen</button>';
  };
  openSheet({
    title: 'Gerichte importieren', render,
    onInput: el => { if (el.dataset.input === 'source') { st.source = el.value; return; } st.text = el.value; if (st.checked) { st.checked = null; } },
    onChange: async el => { const file = el.files && el.files[0]; if (!file) return; st.text = (await file.text()).slice(0, 900000); check(); drawSheet(); },
    actions: {
      prompt: () => copyText(LLM_PROMPT, 'Prompt kopiert'),
      check: () => { check(); drawSheet(); },
      doImport: async () => {
        const src = st.source.trim();
        const items = st.checked.map(c => (src && !c.dish.source ? { ...c.raw, source: src } : c.raw));
        const r = await post('/api/dishes/import', { items });
        if (r.failed.length) { st.error = 'Der Server hat ' + r.failed.length + ' Gerichte abgelehnt: ' + r.failed.map(f => f.errors.join(' ')).join(' '); drawSheet(); return; }
        await loadDishes(); closeSheet(); filter = 'mine'; toast(r.created.length + (r.created.length === 1 ? ' Gericht' : ' Gerichte') + ' importiert'); S.render();
      }
    }
  });
}

const actions = {
  filter: el => { filter = el.dataset.v; S.render(); },
  dish: el => openDish(S.dishById.get(+el.dataset.id)),
  new: () => openForm(null, null),
  import: () => openImport()
};
const onInput = el => { q = el.value; document.getElementById('dishes').innerHTML = listHtml(); };
const load = () => loadDishes();
export default { load, render, actions, onInput };
