// Ansicht „Plan": Wochenübersicht des Haushalts und der mitgelieferte Monatsplan.
import { S, get, post, esc, ico, nf, head, chip, settingsBtn, members, memberName, solo, toast, shortName,
  todayISO, addDays, wdOf, WD, dateLabel, mondayOf, openSheet, closeSheet, drawSheet } from './core.js';
import { SLOT_LABEL } from '/shared/dish.js';

let meals = [], loadedFrom = '';
const ORDER = ['breakfast', 'lunch', 'snack'];
const myId = () => S.me.user.id;
const weekStart = () => mondayOf(S.date);

async function load() {
  const from = weekStart();
  const r = await get('/api/meals?from=' + from + '&to=' + addDays(from, 6));
  if (from === weekStart()) { meals = r.meals; loadedFrom = from; }
}

function render() {
  const from = weekStart(), today = todayISO();
  const list = loadedFrom === from ? meals : [];
  let h = head('Woche ' + dateLabel(from) + ' – ' + dateLabel(addDays(from, 6)), 'Plan',
    '<button class="iconbtn" data-act="week" data-d="-7" aria-label="Vorige Woche">' + ico.prev + '</button>' +
    chip('Diese', mondayOf(today) === from, 'data-act="week" data-d="0"') +
    '<button class="iconbtn" data-act="week" data-d="7" aria-label="Nächste Woche">' + ico.next + '</button>' + settingsBtn());
  h += '<section class="week">';
  for (let k = 0; k < 7; k++) {
    const d = addDays(from, k), day = list.filter(m => m.date === d);
    const dinner = day.filter(m => m.slot === 'dinner');
    const rest = day.filter(m => m.slot !== 'dinner' && m.slot !== 'extra' && m.eaters.some(e => e.userId === myId()));
    rest.sort((x, y) => ORDER.indexOf(x.slot) - ORDER.indexOf(y.slot));
    let p = 0;
    for (const m of day) { const e = m.eaters.find(x => x.userId === myId()); if (e) p += m.protein * e.portions; }
    const main = dinner.length ? dinner.map(m => esc(m.name)).join(' · ') : '<span class="muted">Kein warmes Gericht geplant</span>';
    const bits = [];
    for (const m of dinner) {
      if (!solo()) {
        const who = m.eaters.length === members().length ? 'alle' : m.eaters.map(e => memberName(e.userId)).join(', ');
        bits.push(esc(who) + (m.cookId ? ' · ' + esc(memberName(m.cookId)) + (m.cookId === myId() ? ' kochst' : ' kocht') : ''));
      } else if (m.dish && m.dish.minutes) bits.push(m.dish.minutes + ' Min.');
    }
    if (rest.length) bits.push(rest.map(m => SLOT_LABEL[m.slot] + ': ' + (m.leftoverOf ? 'Rest' : esc(shortName(m.name)))).join(' · '));
    h += '<button class="dayrow' + (d === today ? ' today' : '') + '" data-act="nav" data-v="today" data-date="' + d + '"><span class="wd">' + WD[k] + '<small>' + dateLabel(d) + '</small></span>' +
      '<span class="dn">' + main + (bits.length ? '<small>' + bits.join(' · ') + '</small>' : '') + '</span><span class="pp">' + (p ? nf(p) + ' g' : '') + '</span></button>';
  }
  h += '</section>';
  h += '<div class="card"><h2>Fertigen Plan eintragen</h2><p class="note">Der mitgelieferte <b>' + esc(S.me.template || 'Monatsplan') + '</b> füllt 4 Wochen mit Frühstück, Snack, warmem Gericht und dem Rest als Mittag am Folgetag. Schon geplante Mahlzeiten bleiben stehen.</p>' +
    '<div class="actions"><button class="linkbtn" data-act="template">' + ico.t_plan + 'Monatsplan eintragen</button><button class="linkbtn danger" data-act="clear">Plan ab dieser Woche leeren</button></div></div>';
  return h;
}

function openTemplateSheet() {
  const today = todayISO();
  const st = { start: wdOf(today) === 0 ? today : addDays(mondayOf(today), 7), weeks: 4, who: new Set(members().map(m => m.id)), breakfast: true, snack: true, leftover: true };
  openSheet({
    title: 'Monatsplan eintragen',
    render: () => '<div class="row2"><div class="field"><label for="t-start">Start</label><input id="t-start" type="date" data-change="start" value="' + st.start + '"></div>' +
      '<div class="field"><span class="lbl">Wochen</span><div class="chips">' + [1, 2, 4, 8].map(w => chip(w, st.weeks === w, 'data-act="weeks" data-v="' + w + '"')).join('') + '</div></div></div>' +
      (solo() ? '' : '<div class="field"><span class="lbl">Für wen?</span><div class="chips">' + members().map(m => chip(esc(m.id === myId() ? 'Mich' : m.display), st.who.has(m.id), 'data-act="who" data-id="' + m.id + '"')).join('') + '</div></div>') +
      '<div class="field"><span class="lbl">Was soll rein?</span><div class="chips">' + chip('Frühstück', st.breakfast, 'data-act="opt" data-v="breakfast"') + chip('Snack', st.snack, 'data-act="opt" data-v="snack"') + chip('Rest als Mittag', st.leftover, 'data-act="opt" data-v="leftover"') + '</div>' +
      '<span class="note">Das warme Gericht ist immer dabei. Portionsgrößen kommen aus den Einstellungen jeder Person.</span></div>' +
      '<button class="btn wide" data-act="apply">Eintragen</button>',
    onChange: el => { if (el.value) st.start = el.value; },
    actions: {
      weeks: el => { st.weeks = +el.dataset.v; drawSheet(); },
      who: el => { const id = +el.dataset.id; if (st.who.has(id)) st.who.delete(id); else st.who.add(id); drawSheet(); },
      opt: el => { st[el.dataset.v] = !st[el.dataset.v]; drawSheet(); },
      apply: async () => {
        if (!st.who.size) return toast('Mindestens eine Person auswählen.', true);
        const r = await post('/api/plan/template', { start: st.start, weeks: st.weeks, eaters: [...st.who], breakfast: st.breakfast, snack: st.snack, leftover: st.leftover });
        closeSheet(); S.date = st.start;
        toast(r.created ? r.created + ' Mahlzeiten eingetragen' : 'Alles war schon belegt');
        await S.refresh();
      }
    }
  });
}
function openClearSheet() {
  const from = weekStart();
  openSheet({
    title: 'Plan leeren?',
    render: () => '<p>Alle geplanten Mahlzeiten ab <b>' + WD[0] + ', ' + dateLabel(from) + '</b> werden für den ganzen Haushalt entfernt. Was schon als gegessen abgehakt ist, bleibt.</p>' +
      '<div class="actions"><button class="linkbtn danger" data-act="yes">Ja, leeren</button><button class="linkbtn" data-act="closeSheet">Abbrechen</button></div>',
    actions: { yes: async () => { const r = await post('/api/plan/clear', { from }); closeSheet(); toast(r.deleted + ' Mahlzeiten entfernt'); await S.refresh(); } }
  });
}

const actions = {
  week: el => { S.date = el.dataset.d === '0' ? todayISO() : addDays(S.date, +el.dataset.d); S.render(); S.refresh(); },
  template: () => openTemplateSheet(),
  clear: () => openClearSheet()
};
export default { load, render, actions };
