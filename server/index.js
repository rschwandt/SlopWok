// HTTP-Server: liefert die Web-App aus public/ und bedient /api. Start: node server/index.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createApi, HttpError } from './api.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Datenbank heißt slopwok.db; eine vorhandene kochrunde.db (vor der Umbenennung) wird weiterbenutzt.
function dbPath(dir) {
  const legacy = path.join(dir, 'kochrunde.db');
  return fs.existsSync(legacy) ? legacy : path.join(dir, 'slopwok.db');
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon'
};
const COOKIE = 'kr_session';
const SECURITY = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin'
};

export function createServer(opts = {}) {
  const db = opts.db || openDb(opts.dbFile || dbPath(opts.dataDir || path.join(root, 'data')));
  const api = createApi(db, opts);
  const trustProxy = !!opts.trustProxy;

  // Einfache Bremse gegen Passwort-Raten: höchstens 20 Anmeldeversuche je Adresse in 10 Minuten.
  const attempts = new Map();
  function limited(ip) {
    const now = Date.now(), list = (attempts.get(ip) || []).filter(t => now - t < 600000);
    list.push(now); attempts.set(ip, list);
    if (attempts.size > 5000) attempts.clear();
    return list.length > (opts.loginLimit || 20);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', ch => { size += ch.length; if (size > 1e6) { reject(new HttpError(413, 'Zu viele Daten.')); req.destroy(); } else chunks.push(ch); });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Ungültiges JSON.')); }
      });
      req.on('error', reject);
    });
  }

  async function handleApi(req, res, url) {
    const secure = trustProxy ? req.headers['x-forwarded-proto'] === 'https' : !!req.socket.encrypted;
    const send = (status, obj, session) => {
      const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY };
      if (session !== undefined) headers['Set-Cookie'] = COOKIE + '=' + session + '; Path=/; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : '') + '; Max-Age=' + (session ? 31536000 : 0);
      res.writeHead(status, headers);
      res.end(JSON.stringify(obj));
    };
    try {
      let body = {};
      if (req.method !== 'GET') {
        // Schutz vor fremden Seiten: nur JSON-Anfragen vom eigenen Ursprung
        if (!/^application\/json/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Nur JSON.');
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Fremder Ursprung.');
        body = await readBody(req);
      }
      if (/^\/api\/(login|register)$/.test(url.pathname)) {
        // Der Proxy hängt die echte Adresse hinten an; alles davor kann der Aufrufer selbst mitschicken.
        const ip = (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',').pop().trim()) || req.socket.remoteAddress;
        if (limited(ip)) throw new HttpError(429, 'Zu viele Versuche. Bitte warte ein paar Minuten.');
      }
      const token = (req.headers.cookie || '').split(/;\s*/).map(c => c.split('=')).find(c => c[0] === COOKIE)?.[1] || '';
      const out = await api({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, token });
      const { _session, _jpeg, ...rest } = out || {};
      if (_jpeg) {
        // Die Adresse enthält die Version des Fotos, darum darf der Browser es behalten – aber kein Proxy
        res.writeHead(200, { ...SECURITY, 'Content-Type': 'image/jpeg', 'Content-Length': _jpeg.length, 'Cache-Control': 'private, max-age=31536000, immutable', 'Cross-Origin-Resource-Policy': 'same-origin' });
        return res.end(_jpeg);
      }
      send(200, rest, _session);
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      console.error(e);
      send(500, { error: 'Da ist etwas schiefgegangen.' });
    }
  }

  function serveFile(res, file, method) {
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Nicht gefunden'); }
      const ext = path.extname(file);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.woff2' || ext === '.png' ? 'public, max-age=604800' : 'no-cache',
        ...(path.basename(file) === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : {}), ...SECURITY
      });
      res.end(method === 'HEAD' ? undefined : data);
    });
  }

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    let p;
    try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
    // Ausgeliefert wird nur aus public/ und shared/. Der Pfad wird erst nach dem Dekodieren zusammengesetzt und
    // dann geprüft – sonst käme „/shared/..%2fdata%2f…" aus dem Ordner heraus (Datenbank, secrets.env, .git).
    const shared = p.startsWith('/shared/');
    const base = path.join(root, shared ? 'shared' : 'public');
    const rel = shared ? p.slice('/shared'.length) : p === '/' ? '/index.html' : p;
    if (rel.includes('\0')) { res.writeHead(400); return res.end(); }
    const file = path.normalize(path.join(base, rel));
    if (!file.startsWith(base + path.sep)) { res.writeHead(403); return res.end(); }
    serveFile(res, path.extname(file) ? file : path.join(root, 'public', 'index.html'), req.method);
  });
  server.db = db;
  server.remind = now => api.remind(now); // Woki-Erinnerungen, siehe api.js
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8787;
  const server = createServer({
    dataDir: process.env.DATA_DIR, registrationCode: process.env.REGISTRATION_CODE || '',
    vapidSubject: process.env.VAPID_SUBJECT, trustProxy: process.env.TRUST_PROXY === '1'
  });
  server.listen(port, process.env.HOST || '0.0.0.0', () => console.log('SlopWok läuft auf http://localhost:' + port));
  setInterval(() => { try { server.remind(); } catch (e) { console.error('Erinnerungen:', e.message); } }, 60000);
  const stop = () => server.close(() => { server.db.close(); process.exit(0); });
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
