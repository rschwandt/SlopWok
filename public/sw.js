// Service Worker: zeigt Push-Benachrichtigungen an (Anstupser mit dem angestupsten Woki) und öffnet die App beim Antippen.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data.json(); } catch { data = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(data.title || 'SlopWok', {
    body: data.body || '', tag: data.tag || 'slopwok', icon: data.tag === 'nudge' ? '/icons/woki-nudge-192.png' : '/icons/icon-192.png', badge: '/icons/badge-96.png', data: { url: data.url || '/' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  // Nur Seiten der App öffnen – eine untergeschobene Benachrichtigung darf nicht auf fremde Seiten führen
  let url = '/';
  try { const u = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin); if (u.origin === self.location.origin) url = u.pathname + u.hash; } catch {}
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) { c.navigate(url).catch(() => {}); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
