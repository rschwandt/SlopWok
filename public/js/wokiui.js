// Woki als Begleiter: Karte auf „Heute“, Blatt mit den letzten Tagen, Hüpfen und Zusammensacken bei Änderungen.
// Die Verfassung rechnet der Server (shared/woki-state.js) und liefert sie in /api/me, /api/woki und beim Abhaken.
import { S, esc, toast, openSheet, closeSheet, WD, wdOf } from './core.js';
import { wokiLive } from './woki.js';
import { wokiLine, wokiTip } from '/shared/woki-state.js';

let fx = '', fxAt = 0;
const FX_MS = 1200;
const fxClass = () => (fx && Date.now() - fxAt < FX_MS ? ' ' + fx : '');
function play(kind) { fx = kind; fxAt = Date.now(); }

// Neue Verfassung übernehmen. Steigt Woki eine Stufe auf, gibt es eine kleine Feier, fällt er ab, sackt er
// zusammen (auch beim Öffnen der App, wenn es ihm seit dem letzten Mal schlechter geht). ate: gerade abgehakt.
export function setWoki(st, { ate = false } = {}) {
  S.me.woki = st;
  if (!st) return;
  let seen = 0;
  try { seen = +localStorage.getItem('wokiStage') || 0; } catch {}
  if (seen && st.stage > seen) { play('cheer'); toast('Woki geht es besser: ' + st.title + '!'); }
  else if (seen && st.stage < seen) play('sink');
  else if (ate) play('cheer');
  try { localStorage.setItem('wokiStage', String(st.stage)); } catch {}
}

const pips = n => '<span class="pips" aria-hidden="true">' + [1, 2, 3, 4, 5].map(i => '<i' + (i <= n ? ' class="on"' : '') + '></i>').join('') + '</span>';

// Karte oben auf „Heute“
export function wokiHero(st) {
  return '<button class="woki-hero st-' + st.key + '" data-act="woki" aria-label="Woki ist ' + esc(st.title) + '. Mehr dazu">' +
    wokiLive(st, { cls: 'woki live' + fxClass() }) +
    '<div><span class="eyebrow">Woki · ' + esc(st.title) + pips(st.stage) + '</span><p class="bubble">' + esc(wokiLine(st, new Date().getHours())) + '</p></div></button>';
}

function renderSheet() {
  const st = S.me.woki;
  if (!st) return '<p class="note">Woki zeigt gerade nicht, wie du isst. Einschalten kannst du das unter Einstellungen › Optionen.</p>';
  const c = st.counts, of = n => n + ' von ' + c.days;
  const bars = st.bars.map(b => '<span' + (b.today ? ' class="today"' : '') + '>' +
    (b.score == null ? '<i class="none" title="vor deiner Anmeldung"></i>' : '<i' + (b.score < 40 ? ' class="low"' : '') + ' style="height:' + Math.max(3, b.score) + '%"></i>') +
    (b.today ? 'Heute' : WD[wdOf(b.date)]) + '</span>').join('');
  return '<div class="woki-sheet">' + wokiLive(st, { cls: 'woki live', label: 'Woki: ' + esc(st.title) }) +
    '<h3>' + esc(st.title) + '</h3>' + pips(st.stage) + '<p class="bubble">' + esc(wokiLine(st, new Date().getHours())) + '</p></div>' +
    '<div class="card"><span class="eyebrow">Die letzten Tage</span><div class="woki-bars" role="img" aria-label="Wertung der letzten acht Tage">' + bars + '</div>' +
    (c.days ? '<div class="woki-facts">' +
      '<div><span>Etwas eingetragen</span><b>' + of(c.logged) + ' Tagen</b></div>' +
      '<div><span>Proteinziel geschafft</span><b>' + of(c.protein) + ' Tagen</b></div>' +
      '<div><span>Kalorien im Rahmen</span><b>' + of(c.kcal) + ' Tagen</b></div></div>' : '') + '</div>' +
    '<div class="hint">' + esc(wokiTip(st)) + '</div>' +
    '<p class="note">Woki zeigt, wie du in den letzten 7 Tagen gegessen hast: ob du eingetragen hast, wie viel vom Proteinziel du geschafft hast und ob die Kalorien gepasst haben. ' +
    'Neuere Tage zählen mehr. Heute zählt mit, sobald es Woki hilft. Isst du oft zu wenig, wird er dünn, isst du oft zu viel, wird er breit. In Topform sieht er aus wie dein Ziel.</p>' +
    '<div class="actions"><button class="linkbtn" data-act="wokiSettings">Woki und Erinnerungen einstellen</button></div>';
}

export function openWokiSheet() {
  openSheet({
    title: 'Woki',
    render: renderSheet,
    actions: { wokiSettings: () => { closeSheet(); S.settingsTab = 'options'; S.go('settings'); } }
  });
}
