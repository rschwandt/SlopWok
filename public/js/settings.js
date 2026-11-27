// Ansicht „Einstellungen": Profil, Ziele, Privatsphäre, Benachrichtigungen, Einkaufstage, Konto.
import { S, get, post, patch, esc, ico, head, chip, toast, solo, loadDishes, WD, fmtCount } from './core.js';
import { SLOTS, SLOT_LABEL } from '/shared/dish.js';
import { openGoalSheet, GOALS } from './goals.js';

let push = { supported: false, state: 'unknown', busy: false }, pwMsg = '', tab = 'general';
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
  rememberKey(S.me.vapidKey);
  push.state = 'on';
}
// Mit welchem Server-Schlüssel das Abo dieses Geräts angelegt wurde (nicht jeder Browser verrät es selbst)
const rememberKey = k => { try { localStorage.setItem('pushKey', k); } catch {} };
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// Beim Start: Hat der Server einen neuen Push-Schlüssel (z. B. nach einem Schlüsseltausch), wird das alte Abo
// gekündigt und ein neues angelegt. Sonst wird das Abo nur erneut gemeldet, falls der Server es verworfen hat.
export async function syncPush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const own = sub.options && sub.options.applicationServerKey;
    let stored = null; try { stored = localStorage.getItem('pushKey'); } catch {}
    const used = own ? b64u(own) : stored;
    if (used === S.me.vapidKey) { await post('/api/push/subscribe', sub.toJSON()); rememberKey(used); return; }
    await sub.unsubscribe();
    const fresh = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(S.me.vapidKey) });
    await post('/api/push/subscribe', fresh.toJSON());
    rememberKey(S.me.vapidKey);
  } catch {}
}
async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) { await post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
  push.state = 'off';
}

async function load() { S.me = await get('/api/me'); await pushStatus(); }

const seg = (act, value, options) => '<div class="seg">' + options.map(([v, t, d]) => '<button data-act="' + act + '" data-v="' + v + '" aria-pressed="' + (value === v) + '"><b>' + t + '</b><small>' + d + '</small></button>').join('') + '</div>';

const sw = (act, on, title, text) => '<button class="opt" role="switch" aria-checked="' + on + '" data-act="' + act + '">' +
  '<span class="opt-text"><b>' + title + '</b><small>' + text + '</small></span><span class="switch" aria-hidden="true"></span></button>';

// Woki als Begleiter: Verfassung zeigen und tägliche Erinnerung per Push
function renderWoki(s) {
  const remindOn = !!s.remind;
  return '<div class="card"><h2>Woki</h2>' +
    sw('wokiOn', s.woki, 'Woki zeigt, wie du isst', 'Isst du nach deinem Ziel, ist Woki in Topform. Lässt du es schleifen, wird er dünn oder breit, traurig und fängt irgendwann an zu rauchen.') +
    (s.woki ? '' : '<p class="note">Ausgeschaltet bleibt Woki immer fröhlich. Das kann sinnvoll sein, wenn dir so ein Spiegel nicht guttut.</p>') +
    sw('remindOn', remindOn, 'Tägliche Erinnerung', 'Woki meldet sich per Push, wenn du heute noch nichts eingetragen hast, Protein fehlt oder deine Serie reißt. Sonst bleibt er still.') +
    (remindOn ? '<div class="field"><label for="s-remind">Uhrzeit</label><input id="s-remind" type="time" data-change="remind" value="' + esc(s.remind) + '"></div>' : '') +
    (remindOn && push.state !== 'on' ? '<p class="note">Erinnerungen kommen als Push-Benachrichtigung. Schalte sie unter <b>Allgemein › Benachrichtigungen</b> auf diesem Gerät ein.</p>' : '') + '</div>';
}

// Zusatzfunktionen, die man bewusst einschaltet
function renderOptions(s) {
  return renderWoki(s) + '<div class="card">' + sw('photos', s.photos, 'Fotos zu Gerichten', 'Fotos hinzufügen, ändern und bei den Gerichten sehen.') +
    '<p class="note">Standardmäßig ausgeschaltet, gilt nur für dein Konto. ' + (solo() ? 'Deine Fotos sieht niemand außerhalb deines Haushalts.' : 'Ein Foto gehört eurem Haushalt: Alle dort, die Fotos eingeschaltet haben, sehen es und können es ändern. Andere Haushalte sehen es nicht.') +
    ' Standort und andere Metadaten werden beim Hochladen entfernt.</p></div>';
}

function render() {
  const u = S.me.user, s = u.settings, hh = S.me.household;
  let h = head('@' + esc(u.name), 'Einstellungen', '<button class="iconbtn" data-act="nav" data-v="today" aria-label="Zurück">' + ico.close + '</button>');
  h += '<div class="seg-tabs">' + [['general', 'Allgemein'], ['options', 'Optionen']].map(([v, l]) => '<button data-act="settingsTab" data-v="' + v + '" aria-pressed="' + (tab === v) + '">' + l + '</button>').join('') + '</div>';
  if (tab === 'options') return h + renderOptions(s);
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
  settingsTab: el => { tab = el.dataset.v; S.render(); },
  photos: async () => {
    await saveUser({ photos: !S.me.user.settings.photos });
    document.querySelector('[data-act="photos"]')?.focus(); // neu gezeichnet, Tastaturfokus zurückgeben
    if (S.me.user.settings.photos) await loadDishes();
  },
  nudge: () => saveUser({ nudge: !S.me.user.settings.nudge }),
  wokiOn: async () => { await saveUser({ woki: !S.me.user.settings.woki }); document.querySelector('[data-act="wokiOn"]')?.focus(); },
  remindOn: async () => { await saveUser({ remind: S.me.user.settings.remind ? null : '19:00' }); document.querySelector('[data-act="remindOn"]')?.focus(); },
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
  if (el.dataset.change === 'remind' && /^\d{2}:\d{2}$/.test(el.value)) { await saveUser({ remind: el.value }); toast('Woki meldet sich ab ' + el.value + ' Uhr'); }
};
const submit = {
  display: async d => { S.me = await patch('/api/me', { display: d.display }); toast('Gespeichert'); S.render(); },
  password: async (d, form) => { await patch('/api/me', d); pwMsg = 'Passwort geändert. Andere Geräte wurden abgemeldet.'; form.reset(); S.render(); }
};
export default { load, render, actions, submit, onChange, enter: () => { pwMsg = ''; tab = S.settingsTab || 'general'; S.settingsTab = null; } };
