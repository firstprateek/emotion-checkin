// Runs public/sw.js in a VM with fake service-worker globals to check its fetch handling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ORIGIN = 'https://checkin.test';
const SRC = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

function loadSW({ fetchImpl }) {
  const listeners = {};
  const stores = new Map();
  const keyOf = (k, ignoreSearch) => {
    const u = new URL(typeof k === 'string' ? k : k.url, `${ORIGIN}/`);
    if (ignoreSearch) u.search = '';
    return u.href;
  };
  const makeCache = () => {
    const m = new Map();
    return {
      m,
      async put(k, res) { m.set(keyOf(k), res); },
      async match(k, opts = {}) {
        const want = keyOf(k, opts.ignoreSearch);
        for (const [key, res] of m) if (keyOf(key, opts.ignoreSearch) === want) return res.clone();
        return undefined;
      },
      async addAll() {},
    };
  };
  const caches = {
    async open(name) { if (!stores.has(name)) stores.set(name, makeCache()); return stores.get(name); },
    async match(k, opts) {
      for (const c of stores.values()) { const hit = await c.match(k, opts); if (hit) return hit; }
      return undefined;
    },
    async keys() { return [...stores.keys()]; },
    async delete(n) { return stores.delete(n); },
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    registration: {},
  };
  const ctx = {
    self, caches, URL, Response, Promise, Error,
    fetch: (req) => fetchImpl(req),
    // Shrink timers so the 3 s navigation timeout takes 30 ms in tests.
    setTimeout: (fn, ms) => setTimeout(fn, Math.ceil(ms / 100)),
    clearTimeout: (t) => clearTimeout(t),
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const version = vm.runInContext('CACHE_VERSION', ctx);

  async function dispatchFetch(path, mode = 'no-cors') {
    let response = null;
    const waits = [];
    const event = {
      request: { method: 'GET', url: `${ORIGIN}${path}`, mode },
      respondWith(p) { response = Promise.resolve(p); },
      waitUntil(p) { waits.push(p); },
    };
    listeners.fetch(event);
    const res = response ? await response : null;
    return { res, settle: () => Promise.all(waits) };
  }
  const seed = async (path, body) => (await caches.open(version)).put(path, new Response(body, { status: 200 }));
  const cached = async (path) => {
    const hit = await (await caches.open(version)).match(path);
    return hit ? hit.text() : undefined;
  };
  return { dispatchFetch, seed, cached };
}

const ok = (body) => new Response(body, { status: 200 });
Object.defineProperty(Response.prototype, 'type', { get() { return 'basic'; }, configurable: true });

test('navigation: a 502 from the proxy falls back to the cached shell', async () => {
  const sw = loadSW({ fetchImpl: async () => new Response('Bad Gateway', { status: 502 }) });
  await sw.seed('index.html', 'shell');
  const { res, settle } = await sw.dispatchFetch('/?go=checkin', 'navigate');
  assert.equal(await res.text(), 'shell');
  await settle();
  assert.equal(await sw.cached('index.html'), 'shell', 'an error page must not replace the shell');
});

test('navigation: a slow network falls back to the shell after the timeout', async () => {
  const sw = loadSW({ fetchImpl: () => new Promise(() => {}) });
  await sw.seed('index.html', 'shell');
  const started = Date.now();
  const { res } = await sw.dispatchFetch('/', 'navigate');
  assert.equal(await res.text(), 'shell');
  assert.ok(Date.now() - started < 1000);
});

test('navigation: a network failure falls back to the shell', async () => {
  const sw = loadSW({ fetchImpl: async () => { throw new TypeError('offline'); } });
  await sw.seed('index.html', 'shell');
  const { res } = await sw.dispatchFetch('/?go=night', 'navigate');
  assert.equal(await res.text(), 'shell');
});

test('navigation: a good response is used and refreshes the cached shell', async () => {
  const sw = loadSW({ fetchImpl: async () => ok('fresh') });
  await sw.seed('index.html', 'old');
  const { res, settle } = await sw.dispatchFetch('/', 'navigate');
  assert.equal(await res.text(), 'fresh');
  await settle();
  assert.equal(await sw.cached('index.html'), 'fresh');
});

test('navigation: an error page passes through when there is no cached shell', async () => {
  const sw = loadSW({ fetchImpl: async () => new Response('Bad Gateway', { status: 502 }) });
  const { res } = await sw.dispatchFetch('/', 'navigate');
  assert.equal(res.status, 502);
});

test('assets: served from cache at once, then refreshed for the next open', async () => {
  const sw = loadSW({ fetchImpl: async () => ok('new app') });
  await sw.seed('app.js', 'old app');
  const first = await sw.dispatchFetch('/app.js');
  assert.equal(await first.res.text(), 'old app');
  await first.settle();
  assert.equal(await sw.cached('app.js'), 'new app');
  const second = await sw.dispatchFetch('/app.js');
  assert.equal(await second.res.text(), 'new app');
});

test('assets: offline with a cached copy still works', async () => {
  const sw = loadSW({ fetchImpl: async () => { throw new TypeError('offline'); } });
  await sw.seed('styles.css', 'css');
  const { res, settle } = await sw.dispatchFetch('/styles.css');
  assert.equal(await res.text(), 'css');
  await settle();
});

test('api calls are left to the network', async () => {
  const sw = loadSW({ fetchImpl: async () => ok('x') });
  const { res } = await sw.dispatchFetch('/api/health');
  assert.equal(res, null);
});
