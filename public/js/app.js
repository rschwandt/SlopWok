// Start, Anmeldung, Navigation und zentrale Ereignisbehandlung.
import { S, get, post, esc, ico, toast, fail, todayISO, loadDishes, setUnauthorized, currentSheet, closeSheet, drawSheet, openSheet } from './core.js';
import { woki } from './woki.js';
import today from './today.js';
import plan from './plan.js';
import swipe from './swipe.js';
import shop from './shop.js';
import dishes from './dishes.js';
import people from './people.js';
import settings, { syncPush } from './settings.js';
import { openGoalSheet, openModeSheet } from './goals.js';

const VIEWS = { today, plan, swipe, shop, dishes, people, settings };
const TABS = [['today', 'Heute', ico.t_today], ['plan', 'Plan', ico.t_plan], ['shop', 'Einkauf', ico.t_shop], ['dishes', 'Gerichte', ico.t_dishes], ['people', 'Leute', ico.t_people]];
const main = document.getElementById('main');
let authMode = 'login', authError = '', pendingJoin = '';

// ---------- Anmeldung ----------
function renderAuth() {
  const reg = authMode === 'register';
  return '<div class="auth">' + woki('happy', { label: 'Woki, der SlopWok-Wok' }) +
    '<div><h1>SlopWok</h1><p class="muted">Gemeinsam Essen planen, einkaufen und dranbleiben.</p></div>' +
    '<div class="seg-tabs"><button data-act="authMode" data-v="login" aria-pressed="' + !reg + '">Anmelden</button><button data-act="authMode" data-v="register" aria-pressed="' + reg + '">Neu hier</button></div>' +
    '<form class="card" data-form="auth" autocomplete="on">' +
    '<div class="field"><label for="a-name">Benutzername</label><input id="a-name" name="name" required minlength="3" maxlength="24" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="username"></div>' +
    (reg ? '<div class="field"><label for="a-display">Anzeigename</label><input id="a-display" name="display" maxlength="40" placeholder="So sehen dich die anderen" autocomplete="nickname"></div>' : '') +
    '<div class="field"><label for="a-pass">Passwort</label><input id="a-pass" name="password" type="password" required minlength="8" autocomplete="' + (reg ? 'new-password' : 'current-password') + '">' + (reg ? '<span class="note">Mindestens 8 Zeichen.</span>' : '') + '</div>' +
    (reg ? '<div class="field"><label for="a-invite">Einladungscode (optional)</label><input id="a-invite" name="invite" maxlength="16" value="' + esc(pendingJoin) + '" autocapitalize="characters" autocomplete="off"><span class="note">Hast du einen Code von jemandem aus deinem Haushalt? Dann landest du direkt dort. Ohne Code startest du allein und kannst später beitreten.</span></div>' : '') +
    (reg && S.config.registrationCode ? '<div class="field"><label for="a-code">Registrierungscode</label><input id="a-code" name="code" required autocomplete="off"><span class="note">Den bekommst du von der Person, die diese SlopWok betreibt.</span></div>' : '') +
    (authError ? '<p class="err" role="alert">' + esc(authError) + '</p>' : '') +
    '<button class="btn wide">' + (reg ? 'Konto anlegen' : 'Anmelden') + '</button></form></div>';
}

// ---------- Zeichnen ----------
function renderTabs() {
  document.getElementById('tabbar').hidden = !S.me;
  if (!S.me) return;
  document.getElementById('tabs').innerHTML = TABS.map(([v, l, ic]) =>
    '<button class="tab" data-act="nav" data-v="' + v + '"' + ((S.view === 'swipe' ? 'plan' : S.view) === v ? ' aria-current="page"' : '') + '>' + ic + '<span>' + l + '</span>' +
    (v === 'people' && S.me.unread ? '<span class="badge" aria-label="' + S.me.unread + ' neue Nachrichten">' + S.me.unread + '</span>' : '') + '</button>').join('');
}
S.render = () => {
  main.innerHTML = S.me ? VIEWS[S.view].render() : renderAuth();
  renderTabs();
};
let loadSeq = 0;
S.refresh = async (quiet) => {
  if (!S.me) return S.render();
  const seq = ++loadSeq, view = S.view;
  try { await VIEWS[view].load(); } catch (e) { if (!quiet) fail(e); }
  // Nicht unter dem Finger neu zeichnen, die Ansicht holt es nach
  if (seq === loadSeq && view === S.view && !VIEWS[view].busy?.()) S.render();
};
S.go = (view, opts = {}) => {
  if (!VIEWS[view]) view = 'today';
  S.view = view;
  if (opts.date) S.date = opts.date;
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
  if (VIEWS[view].enter) VIEWS[view].enter();
  S.render();
  window.scrollTo(0, 0);
  S.refresh();
};

async function enter(me, fresh) {
  S.me = me;
  S.date = todayISO();
  await loadDishes().catch(fail);
  const h = location.hash.slice(1);
  S.go(VIEWS[h] ? h : 'today');
  if (pendingJoin && pendingJoin !== me.household.invite) askJoin(pendingJoin);
  else if (fresh) openGoalSheet({ intro: 'Willkommen! Damit die App weiß, wie viel du am Tag brauchst, rechnen wir kurz deine Ziele aus.', onDone: openModeSheet });
  pendingJoin = '';
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').then(syncPush).catch(() => {});
}
function askJoin(code) {
  openSheet({
    title: 'Haushalt beitreten?',
    render: () => '<p>Du hast einen Einladungslink geöffnet. Wenn du beitrittst, planst und kaufst du ab jetzt mit diesem Haushalt.' +
      (S.me.household.members.length > 1 ? ' Deinen jetzigen Haushalt verlässt du dabei.' : ' Dein bisheriger Plan zieht mit um.') + '</p>' +
      '<button class="btn wide" data-act="joinYes">Beitreten</button>',
    actions: {
      joinYes: async () => {
        try { S.me = await post('/api/household/join', { code }); closeSheet(); await loadDishes(); toast('Willkommen im Haushalt „' + S.me.household.name + '“'); S.go('people'); } catch (e) { fail(e); }
      }
    }
  });
}
setUnauthorized(() => { S.me = null; closeSheet(); S.render(); });

// ---------- Ereignisse ----------
const globalActions = {
  nav: el => S.go(el.dataset.v, el.dataset.date ? { date: el.dataset.date } : {}),
  closeSheet: () => closeSheet(),
  authMode: el => { authMode = el.dataset.v; authError = ''; S.render(); }
};
document.addEventListener('click', e => {
  const sheetEl = document.getElementById('sheet');
  if (e.target === sheetEl) return closeSheet();
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const a = el.dataset.act, sh = currentSheet();
  const fn = (sh && sheetEl.contains(el) && sh.actions && sh.actions[a]) || globalActions[a] || (S.me && VIEWS[S.view].actions[a]);
  if (!fn) return;
  // Dieselbe Aktion läuft schon (z. B. mehrfach auf „Einplanen" getippt, während das Netz hängt): nicht noch einmal senden
  const key = a + '|' + (el.dataset.id || '');
  if (running.has(key)) return;
  running.add(key);
  Promise.resolve().then(() => fn(el, e)).catch(fail).finally(() => running.delete(key));
});
const running = new Set();
document.addEventListener('submit', async e => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form)), name = form.dataset.form;
  try {
    if (name === 'auth') {
      authError = '';
      try { await enter(await post(authMode === 'register' ? '/api/register' : '/api/login', data), authMode === 'register'); }
      catch (err) { authError = err.message; S.render(); }
      return;
    }
    const sh = currentSheet();
    const fn = (sh && sh.submit && sh.submit[name]) || (VIEWS[S.view].submit && VIEWS[S.view].submit[name]);
    if (fn) await fn(data, form);
  } catch (err) { fail(err); }
});
document.addEventListener('input', e => {
  const el = e.target.closest('[data-input]');
  if (!el) return;
  const sh = currentSheet();
  const fn = (sh && sh.onInput) || (S.me && VIEWS[S.view].onInput);
  if (fn) fn(el);
});
document.addEventListener('change', e => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  const sh = currentSheet();
  const fn = (sh && sh.onChange) || (S.me && VIEWS[S.view].onChange);
  if (fn) Promise.resolve(fn(el)).catch(fail);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && currentSheet()) closeSheet(); });
window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (S.me && VIEWS[h] && h !== S.view) S.go(h); });

// Still im Hintergrund aktualisieren, solange niemand tippt oder ein Blatt offen ist.
const busy = () => currentSheet() || VIEWS[S.view].busy?.() || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
async function background() {
  if (!S.me || document.visibilityState !== 'visible' || busy()) return;
  try {
    const me = await get('/api/me');
    if (!S.me) return;
    const changedHh = me.household.id !== S.me.household.id || me.household.members.length !== S.me.household.members.length;
    S.me = me;
    if (changedHh) await loadDishes();
    if (!busy()) await S.refresh(true);
  } catch {}
}
setInterval(background, 30000);
let lastDay = todayISO();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (lastDay !== todayISO()) { lastDay = todayISO(); S.date = lastDay; } // am nächsten Tag automatisch auf „heute"
  background();
});

// ---------- Start ----------
(async () => {
  const join = location.hash.match(/^#join=([A-Za-z0-9]{4,16})$/);
  if (join) { pendingJoin = join[1].toUpperCase(); authMode = 'register'; history.replaceState(null, '', '#today'); }
  try { S.config = await get('/api/config'); } catch {}
  try { await enter(await get('/api/me')); }
  catch (e) { S.me = null; if (e.status !== 401) authError = e.message; S.render(); }
})();
export { drawSheet };
