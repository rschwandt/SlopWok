// Ansicht „Heute": Tagesziel, Mahlzeiten abhaken, Mahlzeiten planen (das warme Gericht gemeinsam) und Extras eintragen.
import { S, get, post, patch, del, esc, ico, nf, pills, head, chip, avatar, settingsBtn, members, memberName, solo, toast, fmtCount, fmtNice, portions, shortName,
  todayISO, addDays, wdOf, WDL, WD, dateLabel, openSheet, closeSheet, drawSheet } from './core.js';
import { SLOTS, SLOT_LABEL } from '/shared/dish.js';
import { woki } from './woki.js';

let meals = [], loaded = '';
const open = {}, seen = {};
const myId = () => S.me.user.id;
const mine = m => m.eaters.find(e => e.userId === myId());

function meter(cls, label, unit, plan, eaten, goal, sub) {
  const max = Math.max(goal, plan, 1) * 1.05;
  return '<div class="meter ' + cls + '"><span class="eyebrow">' + label + '</span>' +
    '<div class="big num">' + nf(eaten) + ' <small>/ ' + nf(plan) + ' ' + unit + '</small></div>' +
    '<div class="bar"><i class="plan" style="width:' + (plan / max * 100).toFixed(1) + '%"></i><i class="eaten" style="width:' + (eaten / max * 100).toFixed(1) + '%"></i></div>' +
    '<div class="sub">' + sub + '</div></div>';
}
const ingList = (list, mult) => '<ul class="ing">' + list.map(i => '<li><span>' + esc(i.name) + '</span><span>' + fmtNice(i.amount * mult, i.unit) + '</span></li>').join('') + '</ul>';

function whoLine(m) {
  if (solo()) return '';
  const others = m.eaters.filter(e => e.userId !== myId());
  const parts = [];
  if (others.length) parts.push('mit ' + others.map(e => esc(memberName(e.userId))).join(', '));
  else parts.push('nur du');
  if (m.cookId && !m.leftoverOf) parts.push(m.cookId === myId() ? '<b>du kochst</b>' : esc(memberName(m.cookId)) + ' kocht');
  return '<div class="who">' + m.eaters.map(e => avatar(members().find(x => x.id === e.userId) || {}, 'sm')).join('') + '<span>' + parts.join(' · ') + '</span></div>';
}
function mealCard(m) {
  const me = mine(m), done = me.eaten, d = m.dish, isOpen = !!open[m.id];
  let body = whoLine(m);
  if (m.leftoverOf) body += '<div class="note">' + portions(me.portions) + ' vom Vortag aufwärmen. Nichts einzukaufen.</div>';
  else if (d) {
    if (m.slot === 'dinner' || isOpen) {
      if (m.cook !== 1) {
        const bits = m.eaters.map(e => (e.userId === myId() ? 'du' : esc(memberName(e.userId))) + ' ' + fmtCount(e.portions));
        if (m.leftoverPortions) bits.push('Rest für morgen ' + fmtCount(m.leftoverPortions));
        body += '<div class="note"><b>Kochmenge ' + fmtCount(m.cook) + '× Rezept</b> (' + bits.join(', ') + '). Die Mengen unten sind schon hochgerechnet.</div>';
      }
      if (d.ingredients.length) body += ingList(d.ingredients, m.cook);
      if (d.basics.length) body += '<div class="basics"><b>Aus dem Vorrat:</b> ' + esc(d.basics.join(', ')) + '</div>';
    }
    if (isOpen) body += (d.steps.length ? '<ol class="steps">' + d.steps.map(s => '<li>' + esc(s) + '</li>').join('') + '</ol>' : '<div class="note">Für dieses Gericht sind keine Schritte hinterlegt.</div>') +
      (d.tip ? '<div class="note">' + esc(d.tip) + '</div>' : '');
  }
  let actions = '';
  if (d && !m.leftoverOf) actions += '<button class="linkbtn" data-act="recipe" data-id="' + m.id + '" aria-expanded="' + isOpen + '">' + ico.book + (isOpen ? 'Zubereitung ausblenden' : 'Zubereitung') + '</button>';
  if (m.auto && d && !m.leftoverOf) actions += '<button class="linkbtn" data-act="swapMeal" data-id="' + m.id + '">' + ico.swap + 'Tauschen</button>';
  actions += '<button class="linkbtn" data-act="editMeal" data-id="' + m.id + '">' + ico.edit + 'Ändern</button>';
  return '<article class="meal' + (m.slot === 'dinner' ? ' dinner' : '') + (done ? ' done' : '') + '">' +
    '<div class="meal-top"><button class="check" role="checkbox" aria-checked="' + done + '" aria-label="' + esc(m.name) + ' gegessen" data-act="eat" data-id="' + m.id + '">' + ico.tick + '</button>' +
    '<div><span class="eyebrow">' + SLOT_LABEL[m.slot] + (m.auto && !m.leftoverOf ? ' · Vorschlag' : '') + '</span><h3>' + (m.leftoverOf ? 'Rest: ' : '') + esc(m.name) + '</h3>' +
    pills(m.protein * me.portions, m.kcal * me.portions, m.slot === 'dinner' && d && !m.leftoverOf ? d.minutes : 0) + '</div></div>' +
    body + '<div class="actions">' + actions + '</div></article>';
}

const wokiCard = (title, text) => '<div class="woki-card">' + woki('sleepy') + '<div><h3>' + title + '</h3><p class="muted">' + text + '</p></div></div>';

function render() {
  const date = S.date, isToday = date === todayISO(), g = S.me.user.settings;
  const day = loaded === date ? meals.filter(m => m.date === date) : [];
  // Gemeinsam gibt es nur das warme Gericht – die übrigen Mahlzeiten der anderen gehen dich nichts an
  const my = day.filter(mine), other = day.filter(m => !mine(m) && m.slot === 'dinner');
  let planP = 0, planK = 0, eatP = 0, eatK = 0;
  for (const m of my) { const e = mine(m), p = m.protein * e.portions, k = m.kcal * e.portions; planP += p; planK += k; if (e.eaten) { eatP += p; eatK += k; } }
  let h = '<div class="brand">' + woki('happy') + '<span>SlopWok</span></div>' + head(isToday ? 'Heute' : addDays(todayISO(), 1) === date ? 'Morgen' : addDays(todayISO(), -1) === date ? 'Gestern' : 'Tag', WDL[wdOf(date)] + ',<br>' + dateLabel(date),
    '<button class="iconbtn" data-act="day" data-d="-1" aria-label="Vorheriger Tag">' + ico.prev + '</button>' +
    chip('Heute', isToday, 'data-act="day" data-d="0"') +
    '<button class="iconbtn" data-act="day" data-d="1" aria-label="Nächster Tag">' + ico.next + '</button>' + settingsBtn());
  h += '<section class="meters">' +
    meter('prot', 'Protein', 'g', Math.round(planP), Math.round(eatP), g.pGoal, 'Ziel ' + g.pGoal + ' g · geplant ' + nf(planP) + ' g') +
    meter('kcal', 'Kalorien', 'kcal', Math.round(planK), Math.round(eatK), g.kGoal, 'Ziel ' + nf(g.kGoal) + ' · geplant ' + nf(planK)) + '</section>';

  // Woki meldet sich: Anstupser (öffnet „Leute" und gilt dann als gelesen), alles gegessen, Feierabend ohne Plan
  const planned = my.filter(m => m.slot !== 'extra');
  const late = isToday && loaded === date && !day.length && new Date().getHours() >= 20;
  if (isToday && S.me.nudge) h += '<button class="woki-card nudge" data-act="nav" data-v="people">' + woki('nudge') + '<div><h3>Angestupst!</h3><p>' + esc(S.me.nudge.text) + '</p></div></button>';
  if (isToday && loaded === date && planned.length && planned.every(m => mine(m).eaten)) h += wokiCard('Satt und fertig', 'Alles gegessen, was für heute geplant war. Woki macht Feierabend.');
  else if (late) h += wokiCard('Feierabend', 'Für heute ist nichts mehr geplant. Woki ruht sich aus, morgen geht es weiter.');

  const hints = [];
  for (const m of my) {
    if (m.cookId === myId() && !m.leftoverOf && !solo()) hints.push(['pot', '<b>Du kochst:</b> ' + esc(shortName(m.name)) + ', ' + portions(m.cook) + ' insgesamt.']);
    else if (m.leftoverPortions && solo()) hints.push(['pot', '<b>Mehr kochen:</b> ' + portions(m.cook) + ' ' + esc(shortName(m.name)) + ', der Rest ist dein Mittag morgen.']);
  }
  if (loaded === date && !day.length && !late) hints.push(['info', g.mode === 'auto' ? 'Vorschläge gibt es ab heute für bis zu vier Wochen im Voraus. Diesen Tag kannst du selbst füllen.' : 'Für diesen Tag ist noch nichts geplant. Trag unten Mahlzeiten ein, nimm unter <b>Plan</b> den fertigen Monatsplan oder schalte in den Einstellungen <b>Vorschläge</b> ein.']);
  else if (loaded === date && my.length && planP < g.pGoal * 0.9) hints.push(['info', 'Geplant sind ' + nf(planP) + ' g Protein, zu deinem Ziel fehlen noch <b>' + nf(g.pGoal - planP) + ' g</b>. Eine größere Portion oder ein Extra schließt die Lücke.', 'amber']);
  if (hints.length) h += '<section class="stack">' + hints.map(([ic, t, cl]) => '<div class="hint' + (cl ? ' ' + cl : '') + '">' + ico[ic] + '<span>' + t + '</span></div>').join('') + '</section>';

  h += '<section class="stack">';
  for (const slot of SLOTS) {
    const list = my.filter(m => m.slot === slot);
    h += list.map(mealCard).join('');
    if (!list.length) h += '<button class="slot-add" data-act="addMeal" data-slot="' + slot + '">' + ico.plus + SLOT_LABEL[slot] + ' planen</button>';
  }
  const extras = my.filter(m => m.slot === 'extra');
  h += '<article class="meal"><div><span class="eyebrow">Extras</span><h3>Was sonst noch dazukam</h3></div><div class="rows">' +
    extras.map(m => '<div class="row"><button class="check" role="checkbox" aria-checked="' + mine(m).eaten + '" aria-label="' + esc(m.name) + ' gegessen" data-act="eat" data-id="' + m.id + '">' + ico.tick + '</button>' +
      '<span class="grow"><span class="nm">' + esc(m.name) + '</span></span><span class="pill">+' + nf(m.protein) + ' g</span><span class="pill k">+' + nf(m.kcal) + '</span>' +
      '<button class="addbtn x" data-act="delMeal" data-id="' + m.id + '" aria-label="' + esc(m.name) + ' entfernen">' + ico.close + '</button></div>').join('') +
    '</div><div class="actions"><button class="linkbtn" data-act="addExtra">' + ico.plus + 'Extra eintragen</button></div></article>';
  if (other.length) {
    h += '<article class="card"><div><span class="eyebrow">Im Haushalt</span><h3>Warmes Gericht ohne dich</h3></div><div class="rows">' +
      other.map(m => '<div class="row"><span class="grow"><span class="nm">' + (m.leftoverOf ? 'Rest: ' : '') + esc(m.name) + '</span><span class="why">' + SLOT_LABEL[m.slot] + ' · ' + m.eaters.map(e => esc(memberName(e.userId))).join(', ') + '</span></span>' +
        (m.custom || m.leftoverOf ? '' : '<button class="linkbtn" data-act="joinMeal" data-id="' + m.id + '">Mitessen</button>') + '</div>').join('') + '</div></article>';
  }
  return h + '</section>';
}

async function load() {
  const date = S.date;
  const r = await get('/api/meals?from=' + date + '&to=' + date);
  if (date === S.date) { meals = r.meals; loaded = date; }
}
const find = id => meals.find(m => m.id === +id);
// Antwort des Servers sofort einpflegen, damit die Ansicht ohne Wartezeit stimmt
function put(meal) { const i = meals.findIndex(m => m.id === meal.id); if (i >= 0) meals[i] = meal; else meals.push(meal); S.render(); }

// ---------- Mahlzeit planen / ändern ----------
export async function openMealSheet({ date, slot, meal, dishId }) {
  const defPortion = id => members().find(m => m.id === id)?.portion || 1;
  const st = {
    id: meal ? meal.id : null, date: meal ? meal.date : date, slot: meal ? meal.slot : slot, dishId: meal ? meal.dishId : dishId || null,
    step: meal || dishId ? 'edit' : 'pick', q: '', all: false, custom: !!(meal && meal.custom), leftoverOf: meal ? meal.leftoverOf : null,
    seen: [], eaters: {}, cookId: meal ? meal.cookId : null, left: new Set(), leftOrig: '', confirmDel: false
  };
  if (meal) for (const e of meal.eaters) st.eaters[e.userId] = e.portions;
  else if (slot === 'dinner') for (const m of members()) st.eaters[m.id] = defPortion(m.id);
  else st.eaters[myId()] = 1;
  if (meal && meal.leftoverPortions) {
    try {
      const next = addDays(meal.date, 1);
      const kid = (await get('/api/meals?from=' + next + '&to=' + addDays(next, 6))).meals.find(m => m.leftoverOf === meal.id);
      if (kid) kid.eaters.forEach(e => st.left.add(e.userId));
    } catch {}
  }
  const leftKey = () => [...st.left].sort().join(',');
  st.leftOrig = leftKey();

  const dishList = () => {
    const q = st.q.trim().toLowerCase();
    const list = S.dishes.filter(d => (st.all || q ? true : d.slot === st.slot) && (!q || d.name.toLowerCase().includes(q) || d.tags.some(t => t.toLowerCase().includes(q)))).slice(0, 60);
    return list.length ? list.map(d => '<button class="row" data-act="pick" data-id="' + d.id + '"><span class="grow"><span class="nm">' + esc(d.name) + '</span>' +
      '<span class="why">' + nf(d.protein) + ' g Protein · ' + nf(d.kcal) + ' kcal' + (d.minutes ? ' · ' + d.minutes + ' Min.' : '') + (d.mine ? ' · von dir' : '') + '</span></span></button>').join('')
      : '<p class="note">Nichts gefunden. Unter <b>Gerichte</b> kannst du eigene anlegen oder importieren.</p>';
  };
  // Mitessen und für andere auswählen gibt es nur beim warmen Gericht (und seinem Rest am Folgetag)
  const together = () => !solo() && (st.slot === 'dinner' || !!st.leftoverOf);
  const setSlot = slot => {
    st.slot = slot;
    if (slot === 'dinner' || st.leftoverOf) { if (!st.id && Object.keys(st.eaters).length < 2) for (const m of members()) if (st.eaters[m.id] == null) st.eaters[m.id] = defPortion(m.id); return; }
    st.eaters = { [myId()]: st.eaters[myId()] || 1 }; st.left.clear(); st.cookId = null;
  };
  const total = () => Object.values(st.eaters).reduce((a, b) => a + b, 0) + st.left.size;

  const render = () => {
    if (st.step === 'pick') {
      return '<div class="field"><input class="input" type="search" placeholder="Gericht suchen" data-input="q" value="' + esc(st.q) + '" aria-label="Gericht suchen"></div>' +
        '<div class="chips">' + chip(SLOT_LABEL[st.slot], !st.all, 'data-act="all" data-v="0"') + chip('Alle Gerichte', st.all, 'data-act="all" data-v="1"') +
        (SLOTS.includes(st.slot) ? '<button class="linkbtn" data-act="suggest">' + ico.swap + 'Vorschlagen lassen</button>' : '') + '</div>' +
        '<div class="card"><div class="rows" id="dishlist">' + dishList() + '</div></div>';
    }
    const d = S.dishById.get(st.dishId) || (meal && meal.dish);
    let h = '<div class="card"><div class="split"><h3>' + (st.leftoverOf ? 'Rest: ' : '') + esc(d ? d.name : meal.name) + '</h3></div>' + (d ? pills(d.protein, d.kcal, d.minutes) + '<span class="note">Werte pro Portion</span>' : '') +
      (st.custom || st.leftoverOf ? '' : '<div class="actions"><button class="linkbtn" data-act="repick">Anderes Gericht</button><button class="linkbtn" data-act="suggest">' + ico.swap + 'Anderer Vorschlag</button></div>') + '</div>';
    if (!st.leftoverOf) h += '<div class="row2"><div class="field"><label for="m-date">Tag</label><input id="m-date" type="date" data-change="date" value="' + st.date + '"></div>' +
      '<div class="field"><label for="m-slot">Mahlzeit</label><select id="m-slot" data-change="slot">' + SLOTS.map(s => '<option value="' + s + '"' + (s === st.slot ? ' selected' : '') + '>' + SLOT_LABEL[s] + '</option>').join('') + '</select></div></div>';
    if (!st.custom) {
      const people = together() ? members() : members().filter(m => m.id === myId());
      h += '<div class="card"><span class="eyebrow">' + (people.length < 2 ? 'Wie viel isst du?' : 'Wer isst mit?') + '</span><div class="rows">' + people.map(m => {
        const on = st.eaters[m.id] != null;
        return '<div class="row">' + (people.length < 2 ? '' : '<button class="check" role="checkbox" aria-checked="' + on + '" aria-label="' + esc(m.display) + ' isst mit" data-act="eater" data-id="' + m.id + '">' + ico.tick + '</button>') +
          '<span class="grow"><span class="nm">' + esc(m.id === myId() ? 'Du' : m.display) + '</span></span>' +
          (on ? '<span class="stepper"><button data-act="step" data-id="' + m.id + '" data-d="-0.5" aria-label="weniger">−</button><span>' + fmtCount(st.eaters[m.id]) + ' P.</span><button data-act="step" data-id="' + m.id + '" data-d="0.5" aria-label="mehr">+</button></span>' : '') + '</div>';
      }).join('') + '</div>' + (together() || solo() || st.leftoverOf ? '' : '<span class="note">Zusammen esst ihr nur das warme Gericht. ' + SLOT_LABEL[st.slot] + ' planst du für dich.</span>') + '</div>';
      if (!st.leftoverOf && st.slot === 'dinner') {
        if (!solo()) h += '<div class="field"><span class="lbl">Wer kocht?</span><div class="chips">' + chip('Offen', st.cookId == null, 'data-act="cook" data-id=""') +
          members().map(m => chip(esc(m.id === myId() ? 'Ich' : m.display), st.cookId === m.id, 'data-act="cook" data-id="' + m.id + '"')).join('') + '</div></div>';
        h += '<div class="field"><span class="lbl">Rest als Mittag am nächsten Tag</span><div class="chips">' +
          members().map(m => chip(solo() ? '1 Portion mehr kochen' : esc(m.id === myId() ? 'Für mich' : 'Für ' + m.display), st.left.has(m.id), 'data-act="left" data-id="' + m.id + '"')).join('') + '</div>' +
          '<span class="note">Gekocht wird insgesamt <b>' + fmtCount(total()) + '× Rezept</b>. Der Rest steht am Folgetag als Mittag im Plan und kostet keinen Extra-Einkauf.</span></div>';
      }
    }
    h += '<button class="btn wide" data-act="save">' + (st.id ? 'Speichern' : 'Einplanen') + '</button>';
    if (st.id) h += st.confirmDel
      ? '<div class="actions"><span>Wirklich aus dem Plan nehmen?</span><button class="linkbtn danger" data-act="delYes">Ja, entfernen</button><button class="linkbtn" data-act="delNo">Abbrechen</button></div>'
      : '<div class="actions"><button class="linkbtn danger" data-act="del">' + ico.trash + 'Aus dem Plan nehmen</button></div>';
    return h;
  };
  const after = async msg => { closeSheet(); toast(msg); if (S.view === 'today') S.date = st.date; await S.refresh(); };
  openSheet({
    title: st.id ? 'Mahlzeit ändern' : SLOT_LABEL[st.slot] + ' am ' + WD[wdOf(st.date)] + ', ' + dateLabel(st.date),
    render,
    onInput: el => { st.q = el.value; document.getElementById('dishlist').innerHTML = dishList(); },
    onChange: el => { if (el.dataset.change === 'date' && el.value) st.date = el.value; if (el.dataset.change === 'slot') { setSlot(el.value); drawSheet(); } },
    actions: {
      all: el => { st.all = el.dataset.v === '1'; drawSheet(); },
      pick: el => { st.dishId = +el.dataset.id; st.step = 'edit'; drawSheet(); },
      repick: () => { st.step = 'pick'; st.all = true; drawSheet(); },
      suggest: async () => {
        if (st.dishId) st.seen.push(st.dishId);
        const r = await get('/api/plan/suggestion?date=' + st.date + '&slot=' + st.slot + '&not=' + st.seen.join(','));
        if (!r.dishId) return toast('Für diese Mahlzeit ist nichts im Fundus.', true);
        st.dishId = r.dishId; st.step = 'edit'; drawSheet();
      },
      eater: el => { const id = +el.dataset.id; if (st.eaters[id] != null) delete st.eaters[id]; else st.eaters[id] = defPortion(id); drawSheet(); },
      step: el => { const id = +el.dataset.id; st.eaters[id] = Math.min(10, Math.max(0.5, st.eaters[id] + (+el.dataset.d))); drawSheet(); },
      cook: el => { st.cookId = el.dataset.id ? +el.dataset.id : null; drawSheet(); },
      left: el => { const id = +el.dataset.id; if (st.left.has(id)) st.left.delete(id); else st.left.add(id); drawSheet(); },
      del: () => { st.confirmDel = true; drawSheet(); },
      delNo: () => { st.confirmDel = false; drawSheet(); },
      delYes: async () => { await del('/api/meals/' + st.id); await after('Entfernt'); },
      save: async () => {
        const eaters = Object.entries(st.eaters).map(([userId, p]) => ({ userId: +userId, portions: p }));
        if (!eaters.length) return toast('Mindestens eine Person muss mitessen.', true);
        const leftover = st.slot === 'dinner' ? [...st.left].map(userId => ({ userId, portions: 1 })) : [];
        if (st.id) {
          const body = { eaters, cookId: st.cookId };
          if (!st.leftoverOf) { body.date = st.date; body.slot = st.slot; if (!st.custom) body.dishId = st.dishId; if (leftKey() !== st.leftOrig) body.leftover = leftover; }
          await patch('/api/meals/' + st.id, body);
        } else await post('/api/meals', { date: st.date, slot: st.slot, dishId: st.dishId, eaters, cookId: st.cookId, leftover });
        await after(st.id ? 'Gespeichert' : 'Eingeplant');
      }
    }
  });
}

function openExtraSheet() {
  const quick = S.dishes.filter(d => d.tags.includes('Extra'));
  openSheet({
    title: 'Extra eintragen',
    render: () => (quick.length ? '<div class="card"><span class="eyebrow">Schnell</span><div class="rows">' + quick.map(d => '<button class="row" data-act="quick" data-id="' + d.id + '"><span class="grow"><span class="nm">' + esc(d.name) + '</span></span><span class="pill">+' + nf(d.protein) + ' g</span><span class="pill k">+' + nf(d.kcal) + '</span></button>').join('') + '</div></div>' : '') +
      '<form class="card" data-form="extra"><div class="field"><label for="x-name">Was war es?</label><input id="x-name" name="name" required maxlength="80" placeholder="z. B. Proteinriegel"></div>' +
      '<div class="row2"><div class="field"><label for="x-p">Protein (g)</label><input id="x-p" name="protein" type="number" inputmode="decimal" min="0" max="500" step="any" required></div>' +
      '<div class="field"><label for="x-k">Kalorien</label><input id="x-k" name="kcal" type="number" inputmode="numeric" min="0" max="10000" required></div></div>' +
      '<button class="btn wide">Eintragen</button></form>',
    actions: {
      quick: async el => { await post('/api/meals', { date: S.date, slot: 'extra', dishId: +el.dataset.id, eaters: [{ userId: myId(), portions: 1 }] }); closeSheet(); await S.refresh(); }
    },
    submit: {
      extra: async data => { await post('/api/meals', { date: S.date, slot: 'extra', custom: data, eaters: [{ userId: myId(), portions: 1 }] }); closeSheet(); await S.refresh(); }
    }
  });
}

const actions = {
  day: el => { S.date = el.dataset.d === '0' ? todayISO() : addDays(S.date, +el.dataset.d); S.render(); S.refresh(); },
  recipe: el => { open[el.dataset.id] = !open[el.dataset.id]; S.render(); },
  eat: async el => {
    const m = find(el.dataset.id), e = mine(m);
    e.eaten = !e.eaten; S.render(); // sofort zeigen, Server bestätigt
    try { put((await post('/api/meals/' + m.id + '/eaten', { eaten: e.eaten })).meal); } catch (err) { e.eaten = !e.eaten; S.render(); throw err; }
  },
  swapMeal: async el => {
    const m = find(el.dataset.id);
    (seen[m.id] = seen[m.id] || []).push(m.dishId);
    put((await post('/api/meals/' + m.id + '/swap', { seen: seen[m.id] })).meal);
  },
  addMeal: el => openMealSheet({ date: S.date, slot: el.dataset.slot }),
  editMeal: el => openMealSheet({ meal: find(el.dataset.id) }),
  delMeal: async el => { await del('/api/meals/' + el.dataset.id); await S.refresh(); },
  joinMeal: async el => {
    const m = find(el.dataset.id);
    const r = await patch('/api/meals/' + m.id, { eaters: [...m.eaters, { userId: myId(), portions: S.me.user.settings.portion || 1 }] });
    put(r.meal); toast('Du isst mit');
  },
  addExtra: () => openExtraSheet()
};

export default { load, render, actions };
