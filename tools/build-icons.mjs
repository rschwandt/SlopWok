// Erzeugt die App-Icons in public/icons/ aus Woki (public/js/woki.js).
// Aufruf: node tools/build-icons.mjs   (braucht rsvg-convert für die PNGs, z. B. aus librsvg)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { woki, PALETTE } from '../public/js/woki.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'public', 'icons');
const L = PALETTE.light;

// Woki mittig auf quadratischer Fläche. Das Motiv reicht etwa von x 4–116 und y 30–112.
const ICON = '-10 -2 140 140';      // App-Icon: Woki füllt den Großteil
const MASKABLE = '-35 -27 190 190'; // Android schneidet bis zu 20 % vom Rand ab
const svg = {
  'icon.svg': woki('happy', { cls: '', colors: L, viewBox: ICON, background: L.bg }),
  'icon-maskable.svg': woki('happy', { cls: '', colors: L, viewBox: MASKABLE, background: L.bg }),
  'woki-nudge.svg': woki('nudge', { cls: '', colors: L, viewBox: '-10 -8 140 140', background: L.bg }),
  // Android-Statusleiste: nur die Form zählt, Farbe kommt vom System
  'badge.svg': woki('happy', { cls: '', seal: false, viewBox: ICON, colors: { body: '#FFFFFF', face: 'none', cheek: 'none', steam: '#FFFFFF', seal: 'none', glyph: 'none' } })
};
const png = [
  ['icon.svg', 'icon-180.png', 180], ['icon.svg', 'icon-192.png', 192], ['icon.svg', 'icon-512.png', 512],
  ['icon-maskable.svg', 'icon-maskable-512.png', 512], ['woki-nudge.svg', 'woki-nudge-192.png', 192], ['badge.svg', 'badge-96.png', 96]
];

for (const [name, text] of Object.entries(svg)) fs.writeFileSync(path.join(out, name), text + '\n');
for (const [src, dst, size] of png) execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), '-o', path.join(out, dst), path.join(out, src)]);
// Die Hilfs-SVGs werden nur für die PNGs gebraucht; icon.svg bleibt als Favicon.
for (const name of ['icon-maskable.svg', 'woki-nudge.svg', 'badge.svg']) fs.unlinkSync(path.join(out, name));
console.log('Icons geschrieben:', ['icon.svg', ...png.map(p => p[1])].join(', '));
