// Fotos zu Gerichten: JPEG prüfen und säubern, ohne Fremdbibliothek. Der Browser verkleinert vorher, verlassen
// darf sich der Server darauf nicht: Metadaten (EXIF mit Standort, Kommentare) und alles hinter dem Bildende
// (z. B. das Video eines „Live-Fotos") fallen hier weg.

export const LIMITS = { full: { bytes: 500_000, side: 1600 }, thumb: { bytes: 40_000, side: 240 } };

const SOI = 0xd8, EOI = 0xd9, SOS = 0xda, COM = 0xfe, APP0 = 0xe0, APP15 = 0xef;
const SOF = new Set([0xc0, 0xc1, 0xc2]);               // baseline, extended, progressiv
const KEEP = new Set([...SOF, 0xc4, 0xdb, 0xdd, SOS]); // dazu Huffman-, Quantisierungstabellen, Restart-Intervall
const MAX_SCANS = 32; // gegen Bilder, deren Dekodieren Handys lahmlegt

// Gibt das gesäuberte JPEG zurück, oder null, wenn es keins in den erlaubten Grenzen ist.
export function cleanJpeg(buf, limit) {
  if (buf.length < 4 || buf.length > limit.bytes || buf[0] !== 0xff || buf[1] !== SOI) return null;
  const out = [buf.subarray(0, 2)];
  let i = 2, frame = false, scans = 0;
  for (;;) {
    if (buf[i] !== 0xff) return null;
    while (buf[i + 1] === 0xff) i++;
    const marker = buf[i + 1];
    if (marker === EOI) return scans ? Buffer.concat([...out, Buffer.from([0xff, EOI])]) : null;
    if (i + 4 > buf.length) return null;
    const len = buf.readUInt16BE(i + 2), end = i + 2 + len;
    if (len < 2 || end > buf.length) return null;
    if ((marker >= APP0 && marker <= APP15) || marker === COM) { i = end; continue; }
    if (!KEEP.has(marker)) return null;
    if (SOF.has(marker)) {
      if (frame || len < 11) return null;
      const h = buf.readUInt16BE(i + 5), w = buf.readUInt16BE(i + 7), parts = buf[i + 9];
      if (!w || !h || w > limit.side || h > limit.side || (parts !== 1 && parts !== 3)) return null;
      frame = true;
    }
    out.push(buf.subarray(i, end));
    i = end;
    if (marker !== SOS) continue;
    if (!frame || ++scans > MAX_SCANS) return null;
    // Bilddaten laufen bis zum nächsten echten Marker; FF 00 und Restart-Marker gehören noch dazu
    let j = i;
    for (;;) {
      j = buf.indexOf(0xff, j);
      if (j < 0 || j + 1 >= buf.length) return null;
      const next = buf[j + 1];
      if (next === 0 || (next >= 0xd0 && next <= 0xd7)) j += 2;
      else if (next === 0xff) j++;
      else break;
    }
    out.push(buf.subarray(i, j));
    i = j;
  }
}

// Base64 aus der Anfrage zu einem sauberen JPEG
export function readPhoto(value, limit) {
  if (typeof value !== 'string' || value.length > Math.ceil(limit.bytes / 3) * 4) return null;
  return cleanJpeg(Buffer.from(value, 'base64'), limit);
}
