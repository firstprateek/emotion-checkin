// Check-in service worker. Bump CACHE_VERSION whenever a file in public/ changes.
const CACHE_VERSION = 'checkin-v2';
const NAV_TIMEOUT_MS = 3000;
const PRECACHE = [
  './',
  'index.html',
  'app.js',
  'logic.js',
  'styles.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API: network only.
  if (url.pathname.startsWith('/api/')) return;

  // Pages: network first, fall back to the cached shell. Fall back too when the network is slow
  // (an asleep Mac mini would otherwise leave a blank screen until TCP gives up) or answers with
  // an error page (Tailscale Serve returns 502 while the node server is down).
  if (req.mode === 'navigate') {
    const network = fetch(req);
    event.waitUntil(network.then((res) => {
      if (!res.ok) return undefined;
      const copy = res.clone();
      return caches.open(CACHE_VERSION).then((cache) => cache.put('index.html', copy));
    }).catch(() => {}));
    event.respondWith(navigationResponse(network));
    return;
  }

  // Everything else: serve the cached copy at once and refresh it in the background
  // (stale-while-revalidate), so a deploy reaches the phone by the next open even if
  // CACHE_VERSION wasn't bumped. Uncached files come from the network and are kept.
  const refresh = fetch(req).then((res) => {
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      return caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy)).then(() => res);
    }
    return res;
  });
  event.waitUntil(refresh.then(() => undefined, () => undefined));
  event.respondWith(caches.match(req).then((hit) => hit || refresh));
});

async function navigationResponse(network) {
  const shell = () => caches.match('index.html', { ignoreSearch: true });
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), NAV_TIMEOUT_MS); });
  try {
    const res = await Promise.race([network, timeout]);
    if (res === null) return (await shell()) || network; // slow: use the shell, else keep waiting
    if (res.ok) return res;
    return (await shell()) || res; // error page from the proxy
  } catch {
    const cached = await shell();
    if (cached) return cached;
    throw new Error('Offline and no cached shell.');
  } finally {
    clearTimeout(timer);
  }
}

// iOS revokes the subscription if a push doesn't show a notification, so always show one.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    const parsed = event.data ? event.data.json() : {};
    if (parsed && typeof parsed === 'object') data = parsed;
  } catch {
    data = {};
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Check in';
  const body = typeof data.body === 'string' && data.body ? data.body : 'What am I feeling right now?';
  const url = typeof data.url === 'string' && data.url ? data.url : '/?go=checkin';
  const tag = typeof data.tag === 'string' && data.tag ? data.tag : 'checkin';
  event.waitUntil(self.registration.showNotification(title, { body, tag, data: { url } }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || '/?go=checkin';
  let url;
  try {
    url = new URL(raw, self.location.origin);
    if (url.origin !== self.location.origin) url = new URL('/?go=checkin', self.location.origin);
  } catch {
    url = new URL('/?go=checkin', self.location.origin);
  }
  const go = url.searchParams.get('go') || 'today';

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows.find((c) => new URL(c.url).origin === self.location.origin);
    if (client) {
      try { await client.focus(); } catch { /* not allowed */ }
      client.postMessage({ go });
      if ('navigate' in client) {
        try { await client.navigate(url.href); } catch { /* uncontrolled client */ }
      }
      return;
    }
    await self.clients.openWindow(url.href);
  })());
});
