// Madovai service worker: offline-capable app shell + Web Push for the "Promemoria" tab.
// Bump VERSION when shipping new static files so installed PWAs pick them up.
const VERSION = 'madovai-v3';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/htm-preact.js',
  'js/main.js', 'js/lib.js', 'js/icons.js', 'js/icons-data.js', 'js/models.js', 'js/util.js', 'js/api.js', 'js/store.js',
  'js/favorites.js', 'js/reminders.js', 'js/push.js', 'js/services.js',
  'js/ui/Sheet.js', 'js/ui/components.js', 'js/ui/hooks.js', 'js/map/MapController.js',
  'js/screens/MapScreen.js', 'js/screens/SearchBar.js', 'js/screens/PoleSheet.js', 'js/screens/AtacSheets.js',
  'js/screens/LineeScreen.js', 'js/screens/FavoritesScreen.js', 'js/screens/RemindersScreen.js', 'js/screens/InfoSheet.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-64.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Live data and third-party tiles always go to the network — a cached bus time is worse than an error.
  if (url.origin !== self.location.origin || url.pathname.includes('/api/')) return;

  // Static files: stale-while-revalidate (instant load, refreshed in the background for next time).
  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    }),
  );
});

// ───── Web Push (reminders) ─────
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Madovai', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'Madovai';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    tag: data.tag || undefined,
    icon: 'icons/icon-192.png',
    badge: 'icons/favicon-64.png',
    data: { url: data.url || './' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.startsWith(self.registration.scope) && 'focus' in w) return w.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
