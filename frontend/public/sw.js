/* Minimal service worker: enables "Add to Home Screen", caches the app shell and shows Web Push notifications (N4).
   API calls are never cached (network only) so data is always fresh. */
const CACHE = 'look-within-shell-v6';
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

/* ── Web Push (plan/OPERATIONS.md, N4) ──
   Payload from backend/src/services/push.service.ts: { title, body, url, tag, badge? }. The url is always a same-origin
   path; anything else opens the home page. The server never puts post, comment, answer or letter text in a push. */

/** A same-origin path ("/stories/abc"), or "/" for anything else (full URLs, "//host", backslashes). */
function safePath(url) {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//') || url.includes('\\')) return '/';
  try {
    const u = new URL(url, self.location.origin);
    return u.origin === self.location.origin ? u.pathname + u.search + u.hash : '/';
  } catch {
    return '/';
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  // A delayed capture invitation must never appear after its session closes.
  // Invalid explicit expiry fails closed; ordinary notifications have no expiry.
  if (data.expiresAt !== undefined && (typeof data.expiresAt !== 'string' || !Number.isFinite(Date.parse(data.expiresAt)) || Date.now() >= Date.parse(data.expiresAt))) return;
  const title = typeof data.title === 'string' && data.title ? data.title.slice(0, 80) : 'Love Within';
  const body = typeof data.body === 'string' ? data.body.slice(0, 300) : 'Bạn có thông báo mới';
  const tag = typeof data.tag === 'string' && data.tag ? data.tag.slice(0, 100) : undefined;
  const options = {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    lang: 'vi',
    data: { url: safePath(data.url) },
  };
  // Same tag = replaces the older notification on the device (and still alerts once more).
  if (tag) {
    options.tag = tag;
    options.renotify = true;
  }
  const work = [self.registration.showNotification(title, options)];
  if (typeof data.badge === 'number' && self.navigator.setAppBadge) {
    work.push((data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge()).catch(() => undefined));
  }
  event.waitUntil(Promise.all(work));
});

/** Tap: focus an open app window and move it there (the app routes on the message), or open a new window. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = safePath(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const win = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (win) {
        try {
          await win.focus();
        } catch {
          // focus can be refused; the message still moves the page
        }
        win.postMessage({ type: 'lw:navigate', url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
