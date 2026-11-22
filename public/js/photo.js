// Fotos zu Gerichten (Opt-in unter Einstellungen › Optionen): Anzeige, Auswahl, Verkleinern und Hochladen.
import { S, api, del, esc, ico, toast, loadDishes } from './core.js';

const FULL = { side: 1280, bytes: 480_000 }, THUMB = { side: 168, bytes: 36_000 }; // 168 = 56 px bei dreifacher Dichte
const MAX_FILE = 30e6;
const uploading = new Set();
let confirmId = null;

export const photosOn = () => !!S.me?.user.settings.photos;
export const hasPhoto = d => photosOn() && !!d?.photo;
export const resetPhotoConfirm = () => { confirmId = null; };
const src = (d, query = '') => esc('/api/dishes/' + d.id + '/photo/' + d.photo + query);

export const thumbHtml = d => (hasPhoto(d) ? '<img class="thumb" data-photo src="' + src(d, '?size=thumb') + '" alt="" width="56" height="56" loading="lazy">' : '');

export const pickHtml = (label, id = '', busy = false) =>
  '<label class="linkbtn pick' + (busy ? ' busy' : '') + '">' + ico.photo + '<span>' + (busy ? 'Moment …' : label) + '</span>' +
  '<input type="file" accept="image/*" data-change="photo" data-id="' + id + '"' + (busy ? ' disabled' : '') + '></label>';

export const figureHtml = (url, alt, tools = '') =>
  '<figure class="photo"><img data-photo src="' + url + '" alt="' + esc(alt) + '" width="1280" height="720">' +
  (tools ? '<div class="photo-tools">' + tools + '</div>' : '') + '</figure>';

// Banner. Werkzeuge gibt es nur, solange das Gericht noch im Fundus des Haushalts ist.
export function bannerHtml(d, { edit = false } = {}) {
  if (!hasPhoto(d)) return '';
  let tools = '';
  if (edit && S.dishById.has(d.id)) {
    const sure = confirmId === d.id;
    tools = pickHtml('Foto ändern', d.id, uploading.has(d.id)) +
      '<button class="linkbtn danger" data-act="photoDel" data-id="' + d.id + '"' + (sure ? '>Wirklich entfernen' : ' aria-label="Foto entfernen">' + ico.trash) + '</button>';
  }
  return figureHtml(src(d), 'Foto: ' + d.name, tools);
}
export const addPhotoHtml = d => (photosOn() && d && !d.photo && S.dishById.has(d.id) ? pickHtml('Foto hinzufügen', d.id, uploading.has(d.id)) : '');

// ---------- Verkleinern ----------
function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); // JPEG kann keine Transparenz
  g.imageSmoothingQuality = 'high';
  return [c, g];
}
// In Halbierungsschritten, sonst werden große Kamerabilder als Miniatur körnig
function scaled(img, sx, sy, sw, sh, w, h) {
  let from = img;
  while (sw > w * 2 && sh > h * 2) {
    const nw = Math.ceil(sw / 2), nh = Math.ceil(sh / 2), [c, g] = canvasOf(nw, nh);
    g.drawImage(from, sx, sy, sw, sh, 0, 0, nw, nh);
    from = c; sx = sy = 0; sw = nw; sh = nh;
  }
  const [c, g] = canvasOf(w, h);
  g.drawImage(from, sx, sy, sw, sh, 0, 0, w, h);
  return c;
}
async function encode(make, limit) {
  for (const size of [1, 0.8, 0.64, 0.5]) {
    const c = make(size);
    for (const q of [0.82, 0.7, 0.58, 0.46]) {
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q));
      if (!blob || blob.type !== 'image/jpeg') throw new Error('Dieser Browser kann das Foto nicht umwandeln.');
      if (blob.size > limit) continue;
      const url = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(blob); });
      return url.slice(url.indexOf(',') + 1);
    }
  }
  throw new Error('Das Foto lässt sich nicht klein genug machen.');
}
export async function compressPhoto(file) {
  if (file.size > MAX_FILE) throw new Error('Das Foto ist größer als 30 MB.');
  let img;
  try { img = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { throw new Error('Dieses Bildformat kann der Browser nicht lesen. Nimm ein JPEG oder PNG.'); }
  try {
    const { width: w, height: h } = img, fit = Math.min(1, FULL.side / Math.max(w, h)), square = Math.min(w, h);
    const full = await encode(size => scaled(img, 0, 0, w, h, Math.max(1, Math.round(w * fit * size)), Math.max(1, Math.round(h * fit * size))), FULL.bytes);
    const thumb = await encode(size => {
      const side = Math.round(THUMB.side * size);
      return scaled(img, (w - square) / 2, (h - square) / 2, square, square, side, side);
    }, THUMB.bytes);
    return { full, thumb };
  } finally { img.close(); }
}

// ---------- Hochladen und Entfernen ----------
export const savePhoto = (dishId, body) => api('PUT', '/api/dishes/' + dishId + '/photo', body);

// draw: neu zeichnen. done(rev): das neue Foto übernehmen.
export async function changePhoto(el, draw, done) {
  const file = el.files && el.files[0], id = +el.dataset.id;
  if (!file || uploading.has(id)) return;
  el.blur(); // ein fokussiertes Feld hält die Hintergrund-Aktualisierung an
  confirmId = null;
  uploading.add(id); draw();
  let photo;
  try {
    photo = (await savePhoto(id, await compressPhoto(file))).photo;
    await loadDishes();
  } finally {
    uploading.delete(id);
    if (photo === undefined) draw();
  }
  await done(photo);
  toast('Foto gespeichert');
}
export async function removePhoto(el, draw, done) {
  const id = +el.dataset.id;
  if (confirmId !== id) { confirmId = id; return draw(); }
  confirmId = null;
  await del('/api/dishes/' + id + '/photo');
  await loadDishes();
  await done(null);
  toast('Foto entfernt');
}

// Nicht ladbare Bilder (z. B. eben von jemand anderem ersetzt) ausblenden. Inline-onerror verbietet die CSP.
document.addEventListener('error', e => {
  if (!e.target.matches?.('img[data-photo]')) return;
  e.target.hidden = true;
  e.target.closest('figure')?.classList.add('broken');
}, true);
