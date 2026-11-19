// Gemeinsame Basis für alle Ansichten: Zustand, Server-Aufrufe, Datum, Formatierung, Symbole, Blatt und Hinweis.
import { sourceHref, sourceLabel } from '/shared/dish.js';

export const S = {
  me: null,          // { user, household, unread, vapidKey }
  view: 'today',
  date: null,        // aktuell betrachteter Tag (ISO)
  dishes: [], dishById: new Map(), basicInfo: {},
  config: { registrationCode: false }
};

// ---------- Datum ----------
const DAY = 86400000;
export const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
export const WDL = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const MON = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sep.', 'Okt.', 'Nov.', 'Dez.'];
const pad = n => String(n).padStart(2, '0');
export const parseD = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
export const isoOf = t => new Date(t).toISOString().slice(0, 10);
export const addDays = (iso, n) => isoOf(parseD(iso) + n * DAY);
export const wdOf = iso => (new Date(parseD(iso)).getUTCDay() + 6) % 7;
export const todayISO = () => { const n = new Date(); return n.getFullYear() + '-' + pad(n.getMonth() + 1) + '-' + pad(n.getDate()); };
export const mondayOf = iso => addDays(iso, -wdOf(iso));
export const dateLabel = iso => { const d = new Date(parseD(iso)); return d.getUTCDate() + '. ' + MON[d.getUTCMonth()]; };
export const diffDays = (a, b) => Math.round((parseD(b) - parseD(a)) / DAY);

// ---------- Server ----------
export class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
let onUnauthorized = () => {};
export const setUnauthorized = fn => { onUnauthorized = fn; };
export async function api(method, path, body) {
  const today = todayISO();
  const url = method === 'GET' ? path + (path.includes('?') ? '&' : '?') + 'today=' + today : path;
  let res;
  try {
    res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify({ today, ...(body || {}) })
    });
  } catch { throw new ApiError(0, 'Keine Verbindung zum Server.'); }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    if (res.status === 401 && S.me) onUnauthorized();
    throw new ApiError(res.status, data.error || 'Da ist etwas schiefgegangen.');
  }
  return data;
}
export const get = p => api('GET', p);
export const post = (p, b) => api('POST', p, b);
export const patch = (p, b) => api('PATCH', p, b);
export const del = p => api('DELETE', p);

export async function loadDishes() {
  const r = await get('/api/dishes');
  S.dishes = r.dishes;
  S.dishById = new Map(r.dishes.map(d => [d.id, d]));
  S.basicInfo = r.basicInfo;
}
export const members = () => S.me.household.members;
export const memberName = id => { const m = members().find(x => x.id === id); return m ? (m.id === S.me.user.id ? 'du' : m.display) : 'jemand'; };
export const solo = () => members().length < 2;

// ---------- Formatierung ----------
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const nf = (x, d = 0) => Number(x).toLocaleString('de-DE', { maximumFractionDigits: d });
export const euro = c => (c / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const FR = { 0.25: '¼', 0.33: '⅓', 0.5: '½', 0.67: '⅔', 0.75: '¾' };
export function fmtCount(q) {
  const r = Math.round(q * 100) / 100, w = Math.floor(r + 1e-6), f = Math.round((r - w) * 100) / 100;
  if (f < 0.01) return String(w);
  const fs = FR[f] || FR[Object.keys(FR).reduce((a, b) => (Math.abs(b - f) < Math.abs(a - f) ? b : a))];
  return (w ? w : '') + fs;
}
export function fmtQ(q, u) {
  if (u === 'g') return q >= 1000 ? nf(q / 1000, 2) + ' kg' : Math.round(q) + ' g';
  if (u === 'ml') return q >= 1000 ? nf(q / 1000, 2) + ' l' : Math.round(q) + ' ml';
  const many = q > 1.01;
  const lab = { Zehe: many ? 'Zehen' : 'Zehe', Scheibe: many ? 'Scheiben' : 'Scheibe', Stange: many ? 'Stangen' : 'Stange', Dose: many ? 'Dosen' : 'Dose', Prise: many ? 'Prisen' : 'Prise' }[u] || u;
  return fmtCount(q) + ' ' + lab;
}
// Alltagstaugliche Mengen: Gramm auf 5, Stückzahlen auf halbe
export function nice(q, u) {
  if (u === 'g' || u === 'ml') return q < 20 ? Math.max(1, Math.round(q)) : Math.round(q / 5) * 5;
  if (u === 'Zehe' || u === 'Scheibe') return Math.max(1, Math.round(q));
  return Math.max(0.5, Math.round(q * 2) / 2);
}
export const fmtNice = (q, u) => fmtQ(nice(q, u), u);
export const portions = f => fmtCount(f) + (f <= 1 ? ' Portion' : ' Portionen');
export const shortName = n => n.split(/ mit | vom /)[0];
export function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'gerade eben';
  if (m < 60) return 'vor ' + m + ' Min.';
  if (m < 60 * 24) return 'vor ' + Math.round(m / 60) + ' Std.';
  return 'vor ' + Math.round(m / 1440) + (Math.round(m / 1440) === 1 ? ' Tag' : ' Tagen');
}

// ---------- Symbole ----------
const svg = (d, w = 2) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + w + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
export const ico = {
  prev: svg('<path d="M15 5l-7 7 7 7"/>', 2.2), next: svg('<path d="M9 5l7 7-7 7"/>', 2.2),
  tick: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 3), plus: svg('<path d="M12 5v14M5 12h14"/>', 2.4), close: svg('<path d="M6 6l12 12M18 6L6 18"/>', 2.2),
  book: svg('<path d="M5 4h10a4 4 0 014 4v12H9a4 4 0 01-4-4z"/><path d="M5 16a4 4 0 014-4h10"/>'),
  pot: svg('<path d="M4 10h16v5a5 5 0 01-5 5H9a5 5 0 01-5-5z"/><path d="M2 10h20M9 6c0-1 1-2 1-3M14 6c0-1 1-2 1-3"/>'),
  swap: svg('<path d="M4 8h13l-3-3M20 16H7l3 3"/>'),
  edit: svg('<path d="M4 20h4l10-10-4-4L4 16z"/><path d="M13 7l4 4"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>'),
  trash: svg('<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>'),
  flame: svg('<path d="M12 3c1 4 5 5.5 5 10a5 5 0 01-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 1-9z"/>'),
  bell: svg('<path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 004 0"/>'),
  ext: svg('<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/>'),
  copy: svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>'),
  gear: svg('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>', 1.9),
  hand: svg('<path d="M8 13V5.5a1.5 1.5 0 013 0V11m0-5.5V4a1.5 1.5 0 013 0v7m0-5a1.5 1.5 0 013 0v8a6 6 0 01-6 6h-1a6 6 0 01-5-3l-2.5-4.5a1.5 1.5 0 012.5-1.5L8 13"/>', 1.8),
  t_today: svg('<circle cx="12" cy="13" r="7"/><path d="M12 13V9.5M9 3h6"/>', 1.9),
  t_shop: svg('<path d="M3 5h2.5l2.2 10.5h10.6L20.5 8H7"/><circle cx="9.5" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/>', 1.9),
  t_plan: svg('<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>', 1.9),
  t_dishes: svg('<path d="M4 11h16a8 8 0 01-16 0z"/><path d="M12 4v3M8 5v2M16 5v2M9 20h6"/>', 1.9),
  t_people: svg('<circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0112 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.5a5 5 0 015 5"/>', 1.9)
};
export const avatar = (u, cls = '') => '<span class="avatar ' + cls + '" aria-hidden="true">' + esc((u.display || u.name || '?').trim()[0] || '?') + '</span>';
export const pills = (p, k, t) => '<div class="pills"><span class="pill">' + nf(p) + ' g Protein</span><span class="pill k">' + nf(k) + ' kcal</span>' + (t ? '<span class="pill t">' + t + ' Min.</span>' : '') + '</div>';
export const head = (eyebrow, title, right = '') => '<header class="head"><div><span class="eyebrow">' + eyebrow + '</span><h1>' + title + '</h1></div><div class="daynav">' + right + '</div></header>';
export const settingsBtn = () => '<button class="avatar" data-act="nav" data-v="settings" aria-label="Einstellungen und Profil">' + esc(S.me.user.display[0]) + '</button>';
export const chip = (label, pressed, attrs) => '<button type="button" class="chip-btn" aria-pressed="' + !!pressed + '" ' + attrs + '>' + label + '</button>';

// ---------- Hinweis ----------
let toastTimer;
export function toast(msg, bad) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'toast' + (bad ? ' bad' : ''); el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 4500 : 2500);
}
export const fail = e => toast(e && e.message ? e.message : 'Da ist etwas schiefgegangen.', true);
export async function copyText(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg || 'Kopiert'); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast(okMsg || 'Kopiert'); } catch { toast('Kopieren hat nicht geklappt.', true); }
    ta.remove();
  }
}

// ---------- Blatt von unten ----------
// sheet = { title, render(): html, actions: { name(el, ev) }, onInput?(el), onSubmit?(form) }
let sheet = null;
export const currentSheet = () => sheet;
export function openSheet(def) { sheet = def; drawSheet(); document.body.style.overflow = 'hidden'; }
export function closeSheet() { sheet = null; const el = document.getElementById('sheet'); el.hidden = true; el.innerHTML = ''; document.body.style.overflow = ''; }
export function drawSheet() {
  if (!sheet) return;
  const el = document.getElementById('sheet');
  const old = el.querySelector('.sheet'), top = old ? old.scrollTop : 0;
  el.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" aria-label="' + esc(sheet.title) + '"' + (old ? ' style="animation:none"' : '') + '>' +
    '<div class="sheet-head"><h2>' + esc(sheet.title) + '</h2><button class="iconbtn" data-act="closeSheet" aria-label="Schließen">' + ico.close + '</button></div>' + sheet.render() + '</div>';
  el.hidden = false;
  el.querySelector('.sheet').scrollTop = top;
}

// Verweis auf die Herkunft eines importierten Gerichts: Link zur Originalseite (Bilder usw.) oder Hinweistext
export function sourceHtml(source) {
  const href = sourceHref(source);
  if (href) return '<div class="actions"><a class="linkbtn" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + ico.ext + 'Original ansehen · ' + esc(sourceLabel(source)) + '</a></div>';
  return source ? '<div class="note">Quelle: ' + esc(source) + '</div>' : '';
}
