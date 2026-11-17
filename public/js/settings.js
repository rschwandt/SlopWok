// Ansicht „Einstellungen": Profil, Ziele, Privatsphäre, Benachrichtigungen, Einkaufstage, Konto.
import { S, get, post, patch, esc, ico, head, chip, toast, solo, WD, fmtCount } from './core.js';
import { SLOTS, SLOT_LABEL } from '/shared/dish.js';
import { openGoalSheet, GOALS } from './goals.js';

let push = { supported: false, state: 'unknown', busy: false }, pwMsg = '';
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

async function pushStatus() {
  push.supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!push.supported) return;
  try {
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, no) => setTimeout(no, 2500))]);
    const sub = await reg.pushManager.getSubscription();
    push.state = Notification.permission === 'denied' ? 'denied' : sub ? 'on' : 'off';
  } catch { push.state = 'off'; }
}
const keyBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { push.state = perm === 'denied' ? 'denied' : 'off'; return; }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(S.me.vapidKey) });
  await post('/api/push/subscribe', sub.toJSON());
  push.state = 'on';
}
async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) { await post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
  push.state = 'off';
}

async function load() { S.me = await get('/api/me'); await pushStatus(); }

const seg = (act, value, options) => '<div class="seg">' + options.map(([v, t, d]) => '<button data-act="' + act + '" data-v="' + v + '" aria-pressed="' + (value === v) + '"><b>' + t + '</b><small>' + d + '</small></button>').join('') + '</div>';

function render() {
  const u = S.me.user, s = u.settings, hh = S.me.household;
  let h = head('@' + esc(u.name), 'Einstellungen', '<button class="iconbtn" data-act="nav" data-v="today" aria-label="Zurück">' + ico.close + '</button>');
  h += '<div class="card"><h2>Profil</h2><form class="field" data-form="display"><label for="s-display">Anzeigename</label><div class="inline"><input class="input" id="s-display" name="display" maxlength="40" required value="' + esc(u.display) + '"><button class="linkbtn">Speichern</button></div></form></div>';

  const prof = s.profile;
  h += '<div class="card"><h2>Deine Ziele</h2>' +
    (prof ? '<p class="note">Berechnet für <b>' + esc((GOALS.find(x => x[0] === prof.goal) || [])[1] || '') + '</b> bei ' + prof.weight + ' kg und ' + prof.height + ' cm. Ändert sich dein Gewicht oder Ziel, rechne neu.</p>'
      : '<p class="note">Die Werte unten sind ein allgemeiner Startwert. Lass sie für dich ausrechnen oder trag eigene ein.</p>') +
    '<div class="actions"><button class="btn" data-act="calc">' + (prof ? 'Neu berechnen' : 'Ziele berechnen lassen') + '</button></div><div class="row2"><div class="field"><label for="pGoal">Protein pro Tag (g)</label><input type="number" id="pGoal" data-change="pGoal" inputmode="numeric" min="20" max="400" value="' + s.pGoal + '"></div>' +
    '<div class="field"><label for="kGoal">Kalorien pro Tag</label><input type="number" id="kGoal" data-change="kGoal" inputmode="numeric" min="800" max="8000" step="50" value="' + s.kGoal + '"></div></div>' +
    '<div class="field"><span class="lbl">Deine übliche Portion beim warmen Gericht</span><div class="chips">' + [1, 1.5, 2, 2.5].map(v => chip(fmtCount(v) + '×', s.portion === v, 'data-act="portion" data-v="' + v + '"')).join('') + '</div>' +
    '<span class="note">Wird vorausgefüllt, wenn du oder jemand im Haushalt ein Essen mit dir plant. Pro Mahlzeit änderbar.</span></div></div>';

  h += '<div class="card"><h2>Planung</h2>' + seg('mode', s.mode, [
    ['auto', 'Vorschläge bekommen', 'Freie Mahlzeiten der kommenden Wochen füllt die App aus dem Fundus. Tauschen und ändern geht immer.'],
    ['manual', 'Selbst planen', 'Nichts passiert automatisch. Du wählst jede Mahlzeit selbst oder trägst den Monatsplan ein.']]) +
    (s.mode === 'auto' ? '<div class="field"><span class="lbl">Vorschläge für</span><div class="chips">' + SLOTS.map(x => chip(SLOT_LABEL[x], s.autoSlots.includes(x), 'data-act="autoSlot" data-v="' + x + '"')).join('') + '</div></div>' +
      '<div class="seg"><button data-act="autoLeftover" aria-pressed="' + s.autoLeftover + '"><b>Mittag ist der Rest vom Vorabend</b><small>Abends wird eine Portion mehr gekocht. Ausgeschaltet bekommst du ein eigenes Mittagsgericht.</small></button></div>' +
      '<p class="note">Bereits geplante Mahlzeiten bleiben stehen. Entfernst du einen Vorschlag, bleibt der Platz frei.' + (solo() ? '' : ' Das warme Gericht wird für alle im Haushalt vorgeschlagen, die Vorschläge eingeschaltet haben; gibt es an einem Tag schon eins, kommt kein zweites dazu.') + '</p>' : '') + '</div>';

  h += '<div class="card"><h2>Privatsphäre</h2><div class="field"><span class="lbl">Wer darf deinen Fortschritt sehen?</span>' + seg('share', s.share, [
    ['none', 'Niemand', 'Nur du siehst, was du gegessen und geschafft hast.'],
    ['household', 'Mein Haushalt', 'Mitbewohner sehen Tagesstand, Wochenübersicht und Serie.'],
    ['all', 'Alle', 'Zusätzlich können dich andere Nutzer über deinen Benutzernamen finden und dir folgen.']]) +
    '<span class="note">Geteilt werden nur Zahlen: Protein, Kalorien, abgehakte Mahlzeiten und deine Serie. Gemeinsam geplante Mahlzeiten sieht dein Haushalt immer.</span></div>' +
    '<div class="seg"><button data-act="nudge" aria-pressed="' + s.nudge + '"><b>Anstupsen erlauben</b><small>Wer deinen Fortschritt sehen darf, kann dir alle paar Stunden eine Erinnerung schicken.</small></button></div></div>';

  let p;
  if (!push.supported) p = '<p class="note">' + (isIos() && !isStandalone()
    ? 'Auf dem iPhone gehen Benachrichtigungen erst, wenn SlopWok auf dem Home-Bildschirm liegt: Teilen-Symbol, dann <b>Zum Home-Bildschirm</b>. Danach die App von dort öffnen und hier einschalten.'
    : 'Dieser Browser unterstützt keine Push-Benachrichtigungen. Anstupser siehst du trotzdem unter <b>Leute</b>.') + '</p>';
  else if (push.state === 'denied') p = '<p class="note">Benachrichtigungen sind für diese Seite im Browser blockiert. Erlaube sie in den Website-Einstellungen und lade neu.</p>';
  else if (push.state === 'on') p = '<p class="okmsg">Auf diesem Gerät eingeschaltet.</p><div class="actions"><button class="linkbtn" data-act="pushTest">' + ico.bell + 'Test schicken</button><button class="linkbtn" data-act="pushOff">Ausschalten</button></div>';
  else p = '<p class="note">Lass dich benachrichtigen, wenn dich jemand anstupst oder für den Einkauf einträgt.</p><button class="btn" data-act="pushOn"' + (push.busy ? ' disabled' : '') + '>' + ico.bell + 'Auf diesem Gerät einschalten</button>';
  h += '<div class="card"><h2>Benachrichtigungen</h2>' + p + '</div>';

  h += '<div class="card"><h2>Einkauf' + (solo() ? '' : ' im Haushalt') + '</h2><div class="field"><span class="lbl">Einkaufstage</span><div class="chips">' +
    WD.map((w, k) => chip(w, hh.settings.shopDays.includes(k), 'data-act="shopday" data-k="' + k + '"')).join('') + '</div>' +
    '<span class="note">Jeder Einkauf deckt die Tage bis zum nächsten Einkaufstag ab.' + (solo() ? '' : ' Gilt für alle im Haushalt.') + '</span></div>' +
    (solo() ? '' : '<div class="field"><span class="lbl">Kosten üblicherweise aufteilen</span>' + seg('split', hh.settings.split, [
      ['equal', 'Gleichmäßig', 'Alle zahlen gleich viel, egal wer wie oft mitisst.'],
      ['usage', 'Nach Verbrauch', 'Anteil nach geplanten Kalorien in den Tagen, für die eingekauft wurde.']]) + '</div>') + '</div>';

  h += '<div class="card"><h2>Aufs Handy</h2><ol class="steps"><li>Diese Seite im Browser öffnen (iPhone: Safari).</li><li>Teilen-Symbol bzw. Menü <b>•••</b> antippen.</li><li><b>Zum Home-Bildschirm</b> wählen. Danach startet SlopWok wie eine App.</li></ol></div>';

  h += '<div class="card"><h2>Konto</h2><form class="stack" data-form="password"><div class="field"><label for="pw-old">Bisheriges Passwort</label><input id="pw-old" name="oldPassword" type="password" required autocomplete="current-password"></div>' +
    '<div class="field"><label for="pw-new">Neues Passwort</label><input id="pw-new" name="password" type="password" required minlength="8" autocomplete="new-password"></div>' +
    (pwMsg ? '<p class="okmsg">' + esc(pwMsg) + '</p>' : '') + '<div class="actions"><button class="linkbtn">Passwort ändern</button></div></form>' +
    '<div class="actions"><button class="linkbtn danger" data-act="logout">Abmelden</button></div></div>';
  return h;
}

const saveUser = async settings => { S.me = await patch('/api/me', { settings }); S.render(); };
const saveHh = async settings => { S.me = await patch('/api/household', { settings }); S.render(); };
const actions = {
  portion: el => saveUser({ portion: +el.dataset.v }),
  calc: () => openGoalSheet(),
  mode: el => saveUser({ mode: el.dataset.v }),
  autoLeftover: () => saveUser({ autoLeftover: !S.me.user.settings.autoLeftover }),
  autoSlot: el => {
    const cur = S.me.user.settings.autoSlots, v = el.dataset.v;
    return saveUser({ autoSlots: cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v] });
  },
  share: el => saveUser({ share: el.dataset.v }),
  nudge: () => saveUser({ nudge: !S.me.user.settings.nudge }),
  split: el => saveHh({ split: el.dataset.v }),
  shopday: el => {
    const k = +el.dataset.k, cur = S.me.household.settings.shopDays;
    const next = cur.includes(k) ? cur.filter(x => x !== k) : [...cur, k];
    if (!next.length) return toast('Mindestens ein Einkaufstag muss bleiben.', true);
    return saveHh({ shopDays: next });
  },
  pushOn: async () => { push.busy = true; S.render(); try { await enablePush(); if (push.state === 'on') toast('Benachrichtigungen sind an'); } finally { push.busy = false; S.render(); } },
  pushOff: async () => { await disablePush(); S.render(); },
  pushTest: async () => { const r = await post('/api/push/test'); toast(r.sent ? 'Test ist unterwegs' : 'Der Push-Dienst hat den Test nicht angenommen.', !r.sent); },
  logout: async () => { await post('/api/logout'); location.hash = ''; location.reload(); }
};
const onChange = async el => {
  const v = Math.round(+el.value);
  if (el.dataset.change === 'pGoal' && v >= 20) await saveUser({ pGoal: v });
  if (el.dataset.change === 'kGoal' && v >= 800) await saveUser({ kGoal: v });
};
const submit = {
  display: async d => { S.me = await patch('/api/me', { display: d.display }); toast('Gespeichert'); S.render(); },
  password: async (d, form) => { await patch('/api/me', d); pwMsg = 'Passwort geändert. Andere Geräte wurden abgemeldet.'; form.reset(); S.render(); }
};
export default { load, render, actions, submit, onChange, enter: () => { pwMsg = ''; } };
