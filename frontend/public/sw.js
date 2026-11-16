/* Minimal service worker: enables "Add to Home Screen", caches the app shell and shows Web Push notifications (N4).
   API calls are never cached (network only) so data is always fresh. */
const CACHE = 'look-within-shell-v7';
const SHELL = [
  '/',
  '/index.html',
  '/app-lock-bootstrap.js',
  '/app-lock-bootstrap.css',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
  '/icons/apple-touch-icon.png',
  '/icons/badge-96.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

/** Only store complete same-origin responses, and never an HTML page under a non-page URL. */
function cacheable(res) {
  return res.ok && res.type === 'basic' && !(res.headers.get('content-type') || '').includes('text/html');
}

function store(request, res) {
  const copy = res.clone();
  caches.open(CACHE).then((c) => c.put(request, copy));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (
    req.method !== 'GET' ||
    url.pathname.startsWith('/api/') ||
    url.origin !== self.location.origin ||
    req.headers.has('Authorization')
  ) {
    return; // network only
  }
  // Navigation requests: network first, fall back to cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/index.html')));
    return;
  }
  // Hashed build output (/assets/*) never changes under the same URL: cache first.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (cacheable(res)) store(req, res);
            return res;
          }),
      ),
    );
    return;
  }
  // Other static files (manifest, icons) can change between deploys: network first, cache as offline copy.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (cacheable(res)) store(req, res);
        return res;
      })
      .catch(() => caches.match(req)),
  );
});

/* Web Push is always a neutral public hint, including old or malformed payloads.
   Only expiresAt is consumed; names, content, spaces and destinations never reach the notification surface. */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    const payload = event.data ? event.data.json() : null;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) data = payload;
  } catch {
    // An unreadable payload still gets the same generic notification.
  }
  // A delayed capture invitation must never appear after its session closes.
  // Invalid explicit expiry fails closed; ordinary notifications have no expiry.
  if (data.expiresAt !== undefined && (typeof data.expiresAt !== 'string' || !Number.isFinite(Date.parse(data.expiresAt)) || Date.now() >= Date.parse(data.expiresAt))) return;
  event.waitUntil(self.registration.showNotification('Love Within', {
    body: 'Bạn có một thông báo mới',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    lang: 'vi',
    data: { url: '/' },
  }));
});

/** Taps never reuse a payload destination, even for notifications displayed by an older worker. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const win = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (win) {
        // Ask the app to apply its existing PIN guard before bringing private content to the foreground.
        win.postMessage({ type: 'lw:notification-open' });
        try {
          await win.focus();
        } catch {
          // Focus can be refused; the neutral message still reaches the app.
        }
        return;
      }
      await self.clients.openWindow('/');
    })(),
  );
});
