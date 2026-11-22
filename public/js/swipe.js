// Ansicht „Swipen": warme Gerichte für die kommende Woche wählen und sehen, wer was zusammen kocht.
import { S, get, post, esc, ico, pills, head, chip, members, memberName, solo, toast, fail, shortName, fmtNice, sourceHtml,
  addDays, WD, dateLabel, loadDishes, openSheet, currentSheet, drawSheet } from './core.js';
import { bannerHtml } from './photo.js';
import { woki } from './woki.js';

const THROW_PX = 96;    // so weit ziehen zählt als Stimme
const FLICK = 0.55;     // px/ms: ein schneller Wisch zählt auch früher
const FLICK_MS = 110;   // gemessen über die letzten Millisekunden, einzelne Ereignisse zittern zu sehr
const START_PX = 8;     // darunter ist es ein Tippen
const FLY_MS = 190;

let data = null, owner = '';
let history = [];       // für „Zurück": [{ id, was }]
let pending = 0, version = 0, queue = Promise.resolve();
let drag = null, flying = false, stale = false;

// Der Zustand gehört zu Konto und Haushalt
const scope = () => S.me.user.id + ':' + S.me.household.id;
const current = () => (data && S.me && owner === scope() ? data : null);
const myId = () => S.me.user.id;
const busy = () => !!drag?.active || flying;
const remaining = () => data.deck.filter(id => !(id in data.votes) && S.dishById.has(id));

function draw() {
  if (S.view !== 'swipe' || !S.me) return;
  if (busy()) { stale = true; return; }
  stale = false;
  const focused = document.activeElement?.closest?.('.swipe-buttons [data-act]')?.dataset.act;
  S.render();
  if (focused) document.querySelector('.swipe-buttons [data-act="' + focused + '"]:not(:disabled)')?.focus({ preventScroll: true });
}

// Die Reihenfolge bleibt, solange man swipet, auch wenn jemand nebenher den Plan ändert. Neues kommt hinten dran.
function accept(r) {
  if (current() && data.week === r.week) {
    const now = new Set(r.deck), old = new Set(data.deck);
    r.deck = [...data.deck.filter(id => now.has(id)), ...r.deck.filter(id => !old.has(id))];
  } else history = [];
  data = r; owner = scope();
}

async function load() {
  if (pending) return; // die Antworten auf die eigenen Stimmen sind neuer
  const at = version, who = scope();
  const r = await get('/api/swipe');
  if (r.deck.some(id => !S.dishById.has(id))) await loadDishes();
  if (at !== version || who !== scope()) return;
  accept(r);
}

// ---------- Anzeige ----------
function cardHtml(d, back) {
  const names = (d.ingredients || []).map(i => i.name);
  return '<article class="card swipe-card' + (back ? ' back" aria-hidden="true" inert' : '" id="swipe-card" data-id="' + d.id + '"') + '>' +
    bannerHtml(d) +
    (back ? '' : '<span class="stamp yes" aria-hidden="true">Mag ich</span><span class="stamp no" aria-hidden="true">Nein</span>') +
    '<div class="swipe-body">' + (data.again.includes(d.id) ? '<span class="eyebrow again">Aus deiner letzten Runde</span>' : '') + '<h2' + (back ? '' : ' aria-live="polite"') + '>' + esc(d.name) + '</h2>' + pills(d.protein, d.kcal, d.minutes) +
    (names.length ? '<p class="swipe-ing">' + esc(names.join(', ')) + '</p>' : '') + '</div>' +
    '<div class="actions"><button class="linkbtn" data-act="info" data-id="' + d.id + '">' + ico.book + 'Rezept ansehen</button></div></article>';
}

function deckHtml() {
  const left = remaining(), likes = Object.values(data.votes).filter(Boolean).length;
  let h = '<div class="split"><span class="note num">' + (left.length ? 'Noch ' + left.length + ' von ' + data.deck.length : 'Alle durch') + ' · ' + likes + '× ja</span>' +
    '<button class="linkbtn" data-act="choices"' + (Object.keys(data.votes).length ? '' : ' disabled') + '>Meine Auswahl</button></div>';
  h += left.length
    ? '<div class="deck">' + (left[1] ? cardHtml(S.dishById.get(left[1]), true) : '') + cardHtml(S.dishById.get(left[0]), false) + '</div>'
    : '<div class="woki-card">' + woki('happy') + '<div><h3>Fertig geswipet</h3><p class="muted">Unten siehst du deine Woche. Bis Sonntag kannst du deine Auswahl noch ändern.</p></div></div>';
  return h + '<div class="swipe-buttons">' +
    '<button class="vote no" data-act="no" aria-label="Nein"' + (left.length ? '' : ' disabled') + '>' + ico.close + '</button>' +
    '<button class="iconbtn" data-act="undo" aria-label="Letzte Stimme zurücknehmen"' + (history.length ? '' : ' disabled') + '>' + ico.undo + '</button>' +
    '<button class="vote yes" data-act="yes" aria-label="Mag ich"' + (left.length ? '' : ' disabled') + '>' + ico.tick + '</button></div>';
}

function votersHtml() {
  if (solo()) return '';
  const waiting = members().filter(m => !data.voters.includes(m.id));
  return '<p class="note">' + (waiting.length
    ? 'Noch nicht geswipet: ' + waiting.map(m => esc(memberName(m.id))).join(', ') + '. Bis dahin kann sich noch einiges verschieben.'
    : 'Alle im Haushalt sind dabei.') + '</p>';
}

// Gemocht, aber (noch) nicht in der eigenen Woche
function waitingHtml() {
  const planned = new Set(data.meals.filter(m => m.eaters.some(e => e.userId === myId())).map(m => m.dishId));
  const n = data.deck.filter(id => data.votes[id] === true && !planned.has(id)).length;
  if (!n || pending) return '';
  return '<p class="hint">' + ico.info + '<span><b>' + n + (n === 1 ? ' Gericht, das du magst, ist' : ' Gerichte, die du magst, sind') + ' noch nicht im Plan.</b> ' +
    'Bleibt es dabei, ' + (n === 1 ? 'kommt es' : 'kommen sie') + ' in der nächsten Runde nach vorne.</span></p>';
}

function dayHtml(date, i) {
  const day = data.meals.filter(m => m.date === date), bought = data.bought.includes(date);
  const eats = m => m.eaters.some(e => e.userId === myId());
  const mine = day.filter(eats), others = day.filter(m => !eats(m));
  const who = m => (m.eaters.length === members().length ? 'alle' : m.eaters.map(e => esc(memberName(e.userId))).join(', '));
  const kind = m => (bought ? 'eingekauft' : m.pinned || (!m.auto && !m.swiped) ? 'fest geplant' : !m.swiped ? 'Vorschlag' : m.eaters.length > 1 ? 'Match' : 'deine Wahl');
  const lines = mine.map(m => esc(m.name) + '<small>' + kind(m) + (solo() ? '' : ' · ' + who(m)) + '</small>');
  if (!lines.length) lines.push('<span class="muted">Noch offen</span>');
  for (const m of others) lines.push('<small>Ohne dich: ' + esc(shortName(m.name)) + ' (' + who(m) + ')</small>');
  return '<div class="dayrow' + (mine.some(m => m.swiped && m.eaters.length > 1) ? ' match' : '') + '">' +
    '<span class="wd">' + WD[i] + '<small>' + dateLabel(date) + '</small></span><span class="dn">' + lines.join('') + '</span></div>';
}

function render() {
  const d = current();
  const back = '<button class="iconbtn" data-act="nav" data-v="plan" aria-label="Zurück zum Plan">' + ico.close + '</button>';
  let h = head(d ? dateLabel(d.week) + ' – ' + dateLabel(d.to) : 'Kommende Woche', 'Swipen', back);
  if (!d) return h + '<p class="note">Lädt …</p>';
  h += '<section class="swipe">' + deckHtml() + '</section>';
  h += '<section class="card"><h2>So sieht die Woche aus</h2>' + votersHtml() + waitingHtml() +
    '<div class="week swipe-week">' + Array.from({ length: 7 }, (_, i) => dayHtml(addDays(d.week, i), i)).join('') + '</div>' +
    '<p class="note">' + (solo() ? 'Was du magst, landet in deiner Woche. ' : 'Zuerst kommt, was alle mögen. Danach kocht zusammen, wer dasselbe mag. Für ein Match braucht es mindestens zwei. ') +
    'Für den Rest gibt es wie gewohnt Vorschläge, wenn du sie eingeschaltet hast. Selbst Geplantes und schon Eingekauftes bleibt stehen. Ab Montag steht die Woche fest und die nächste Runde beginnt.</p></section>';
  return h;
}

// ---------- Stimmen ----------
function send(id, like) {
  const week = data.week, who = owner;
  if (like === null) delete data.votes[id]; else data.votes[id] = like;
  data.voters = data.voters.filter(u => u !== myId());
  const any = Object.keys(data.votes).length > 0;
  if (any) data.voters.push(myId());
  S.me.swipeWeek = any ? week : null;
  pending++; version++;
  draw();
  // Nacheinander, damit die letzte Antwort auch den letzten Stand zeigt
  queue = queue.then(async () => {
    let r = null, error = null;
    try { r = await post('/api/swipe', { week, dishId: id, like }); } catch (e) { error = e; }
    pending--; version++;
    if (!S.me || scope() !== who) return;
    if (error) {
      history = [];
      fail(error);
      if (!pending && S.view === 'swipe') await S.refresh(true);
      return;
    }
    const match = like && r.meals.find(m => m.swiped && m.dishId === id && m.eaters.length > 1 && m.eaters.some(e => e.userId === myId()));
    if (match && S.view === 'swipe') toast('Match! ' + shortName(match.name) + ' mit ' + match.eaters.filter(e => e.userId !== myId()).map(e => memberName(e.userId)).join(', '));
    if (pending) return;
    accept(r);
    draw();
    if (currentSheet()?.choices) drawSheet();
  }).catch(fail);
}

function decide(like) {
  if (flying || !current()) return;
  const id = remaining()[0], el = document.getElementById('swipe-card');
  if (id === undefined) return;
  const commit = () => {
    flying = false;
    if (!current()) return;
    history.push({ id, was: null });
    send(id, like);
  };
  if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return commit();
  flying = true;
  el.style.setProperty(like ? '--yes' : '--no', 1);
  el.style.transition = 'transform ' + FLY_MS + 'ms ease-in, opacity ' + FLY_MS + 'ms ease-in';
  el.style.transform = 'translateX(' + (like ? 115 : -115) + '%) rotate(' + (like ? 14 : -14) + 'deg)';
  el.style.opacity = 0;
  setTimeout(commit, FLY_MS);
}

// ---------- Ziehen ----------
document.addEventListener('pointerdown', e => {
  if (flying || drag || !e.isPrimary || e.button !== 0) return;
  const el = e.target.closest('#swipe-card');
  if (el) drag = { el, id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, active: false, trail: [[e.timeStamp, e.clientX]] };
});
document.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.active) {
    if (Math.abs(dy) > START_PX && Math.abs(dy) >= Math.abs(dx)) { drag = null; return; } // senkrecht: scrollen
    if (Math.abs(dx) <= START_PX || !drag.el.isConnected) return;
    drag.active = true;
    drag.el.setPointerCapture(e.pointerId);
    drag.el.style.transition = 'none';
  }
  drag.trail.push([e.timeStamp, e.clientX]);
  drag.dx = dx;
  drag.el.style.transform = 'translateX(' + dx + 'px) rotate(' + dx / 22 + 'deg)';
  drag.el.style.setProperty('--yes', Math.min(1, Math.max(0, dx / THROW_PX)));
  drag.el.style.setProperty('--no', Math.min(1, Math.max(0, -dx / THROW_PX)));
});
function release(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const { el, active, dx, trail } = drag;
  drag = null;
  if (!active) return;
  const from = trail.find(([t]) => e.timeStamp - t <= FLICK_MS);
  const speed = from ? (e.clientX - from[1]) / Math.max(16, e.timeStamp - from[0]) : 0;
  const flick = Math.abs(speed) > FLICK && Math.sign(speed) === Math.sign(dx) && Math.abs(dx) > 30;
  if (e.type === 'pointerup' && S.view === 'swipe' && el.isConnected && (Math.abs(dx) >= THROW_PX || flick)) return decide(dx > 0);
  el.style.transition = el.style.transform = '';
  el.style.setProperty('--yes', 0); el.style.setProperty('--no', 0);
  if (stale) draw();
}
document.addEventListener('pointerup', release);
document.addEventListener('pointercancel', release);
document.addEventListener('keydown', e => {
  if (S.view !== 'swipe' || !S.me || !current() || currentSheet() || e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  decide(e.key === 'ArrowRight');
});

// ---------- Blätter ----------
function openInfo(id) {
  const d = S.dishById.get(id);
  if (!d) return;
  openSheet({
    title: d.name,
    render: () => bannerHtml(d) + pills(d.protein, d.kcal, d.minutes) + '<span class="note">Mengen für eine Portion</span>' +
      '<ul class="ing">' + d.ingredients.map(i => '<li><span>' + esc(i.name) + '</span><span>' + fmtNice(i.amount, i.unit) + '</span></li>').join('') + '</ul>' +
      (d.basics.length ? '<div class="basics"><b>Aus dem Vorrat:</b> ' + esc(d.basics.join(', ')) + '</div>' : '') +
      (d.steps.length ? '<ol class="steps">' + d.steps.map(s => '<li>' + esc(s) + '</li>').join('') + '</ol>' : '') + sourceHtml(d.source)
  });
}
function openChoices() {
  const row = id => '<div class="row"><span class="grow"><span class="nm">' + esc(S.dishById.get(id).name) + '</span></span><span class="chips choice">' +
    chip('Ja', data.votes[id], 'data-act="set" data-v="1" data-id="' + id + '"') +
    chip('Nein', !data.votes[id], 'data-act="set" data-v="0" data-id="' + id + '"') + '</span></div>';
  openSheet({
    title: 'Meine Auswahl',
    choices: true,
    render: () => {
      const voted = data.deck.filter(id => id in data.votes && S.dishById.has(id));
      return '<p class="note">Die anderen sehen deine Stimmen nicht. Was daraus gekocht wird, sehen alle. Was übrig bleibt, rückt in der nächsten Runde für alle nach vorne, ohne Namen.</p>' +
        '<div class="card"><div class="rows">' + voted.map(row).join('') + '</div></div>';
    },
    actions: {
      set: el => {
        const id = +el.dataset.id, like = el.dataset.v === '1';
        if (data.votes[id] === like) return;
        history.push({ id, was: data.votes[id] ?? null });
        send(id, like);
        drawSheet();
      }
    }
  });
}

const actions = {
  yes: () => decide(true),
  no: () => decide(false),
  undo: () => {
    if (flying || !current()) return;
    const last = history.pop();
    if (last) send(last.id, last.was);
  },
  info: el => openInfo(+el.dataset.id),
  choices: () => openChoices()
};
export default { load, render, actions, busy };
