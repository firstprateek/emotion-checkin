// HTTP server: static files from public/, JSON API under /api, and the minute-by-minute reminder loop.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createStore } from './store.mjs';
import { createPusher, loadOrCreateVapid, subscriptionError, DEFAULT_VAPID_SUBJECT } from './push.mjs';
import {
  isValidTimeZone, localParts, parseHM, addDays, planTick, pruneSentLog,
  nextCheckinAt, nextReviewAt, pushOptions,
} from './schedule.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BODY_LIMIT = 1024 * 1024;
const MAX_RECORDS_PER_POST = 5000;
const KINDS = new Set(['checkin', 'skip', 'night', 'week']);
const STATUSES = new Set(['on', 'escaping', 'break']);
const NIGHT_RESULTS = new Set(['did', 'partly', 'not', null]);

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------- Settings ----------

export function serverTimeZone() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isValidTimeZone(tz) ? tz : 'UTC';
}

export function defaultSettings() {
  return {
    intervalMin: 30,
    activeStart: '09:00',
    activeEnd: '21:00',
    reviewTime: '21:30',
    weeklyDay: 0,
    timeZone: serverTimeZone(),
    pausedDate: null,
    streakHours: 5,
  };
}

const isWholeIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s;
const isIso = (s) => typeof s === 'string' && s.length <= 40 && Number.isFinite(Date.parse(s));

/** Apply a partial settings object. Returns { settings } or { error }. */
export function applySettingsPatch(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { error: 'Send settings as an object.' };
  const next = { ...current };
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has('intervalMin')) {
    if (!isWholeIn(patch.intervalMin, 15, 480)) return { error: 'Interval must be a whole number of minutes from 15 to 480.' };
    next.intervalMin = patch.intervalMin;
  }
  for (const k of ['activeStart', 'activeEnd']) {
    if (has(k)) {
      if (Number.isNaN(parseHM(patch[k]))) return { error: 'Active hours must be times like 09:00.' };
      next[k] = patch[k];
    }
  }
  if (has('reviewTime')) {
    if (Number.isNaN(parseHM(patch.reviewTime))) return { error: 'Night review time must be a time like 21:30.' };
    next.reviewTime = patch.reviewTime;
  }
  if (has('weeklyDay')) {
    if (!isWholeIn(patch.weeklyDay, 0, 6)) return { error: 'Weekly review day must be 0 (Sunday) to 6 (Saturday).' };
    next.weeklyDay = patch.weeklyDay;
  }
  if (has('timeZone')) {
    if (!isValidTimeZone(patch.timeZone)) return { error: "That time zone isn't recognized." };
    next.timeZone = patch.timeZone;
  }
  if (has('pausedDate')) {
    if (patch.pausedDate !== null && !isDate(patch.pausedDate)) return { error: 'Pause date must be a date like 2026-11-08, or null.' };
    next.pausedDate = patch.pausedDate;
  }
  if (has('streakHours')) {
    if (!isWholeIn(patch.streakHours, 1, 24)) return { error: 'Streak hours must be a whole number from 1 to 24.' };
    next.streakHours = patch.streakHours;
  }
  if (!(parseHM(next.activeEnd) > parseHM(next.activeStart))) return { error: 'Active hours must end after they start.' };
  return { settings: next };
}

/** Repair a settings object loaded from disk: keep valid fields, default the rest. */
export function normalizeSettings(stored) {
  const base = defaultSettings();
  if (!stored || typeof stored !== 'object') return base;
  let out = base;
  for (const [k, v] of Object.entries(stored)) {
    if (!(k in base)) continue;
    const r = applySettingsPatch(out, { [k]: v });
    if (r.settings) out = r.settings;
  }
  return out;
}

// ---------- Records ----------

/** Validate one record. Returns an error sentence or null. */
export function recordError(r, i) {
  const n = `Record ${i + 1}`;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return `${n} must be an object.`;
  if (typeof r.id !== 'string' || !r.id.trim() || r.id.length > 128) return `${n} needs an id.`;
  if (!KINDS.has(r.kind)) return `${n} has an unknown kind.`;
  if (!isIso(r.updatedAt)) return `${n} needs a valid updatedAt time.`;
  const optString = (k) => r[k] === undefined || typeof r[k] === 'string';
  switch (r.kind) {
    case 'checkin':
    case 'skip':
      if (!isIso(r.at)) return `${n} needs a valid at time.`;
      if (!isDate(r.date)) return `${n} needs a date like 2026-11-08.`;
      if (!isWholeIn(r.hour, 0, 23)) return `${n} needs an hour from 0 to 23.`;
      if (r.kind === 'checkin') {
        if (typeof r.feeling !== 'string' || !r.feeling.trim()) return `${n} needs a feeling.`;
        if (!['body', 'shouldBe', 'actually'].every(optString)) return `${n} has a field that should be text.`;
        if (!STATUSES.has(r.status)) return `${n} has an unknown status.`;
      }
      return null;
    case 'night':
      if (!isDate(r.date)) return `${n} needs a date like 2026-11-08.`;
      if (r.id !== `night-${r.date}`) return `${n} should have the id night-${r.date}.`;
      if (r.yesterdayResult !== undefined && !NIGHT_RESULTS.has(r.yesterdayResult)) return `${n} has an unknown yesterdayResult.`;
      if (!['wentWell', 'improve'].every(optString)) return `${n} has a field that should be text.`;
      return null;
    case 'week':
      if (!isDate(r.weekStart)) return `${n} needs a weekStart like 2026-11-02.`;
      if (r.weekEnd !== undefined && !isDate(r.weekEnd)) return `${n} needs a weekEnd like 2026-11-08.`;
      if (r.id !== `week-${r.weekStart}`) return `${n} should have the id week-${r.weekStart}.`;
      if (!['pattern', 'change'].every(optString)) return `${n} has a field that should be text.`;
      return null;
    default:
      return `${n} has an unknown kind.`;
  }
}

const publicRecord = (r) => {
  const { _receivedAt, synced, ...rest } = r;
  void _receivedAt; void synced;
  return rest;
};

// ---------- HTTP helpers ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > BODY_LIMIT) {
      req.resume();
      reject(new HttpError(413, 'Request body is too large.'));
      return;
    }
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) tooBig = true;
      if (!tooBig) chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) reject(new HttpError(413, 'Request body is too large.'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const text = await readBody(req);
  if (!text.trim()) throw new HttpError(400, 'Request body must be JSON.');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

/** Decode and check a URL path. Returns segments, or throws 400 for traversal and malformed paths. */
export function safeSegments(rawPath) {
  const segments = [];
  for (const raw of rawPath.split('/')) {
    let seg;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      throw new HttpError(400, 'Bad path.');
    }
    if (seg === '..' || seg.includes('/') || seg.includes('\\') || seg.includes('\0')) {
      throw new HttpError(400, 'Bad path.');
    }
    if (seg === '' || seg === '.') continue;
    segments.push(seg);
  }
  return segments;
}

// ---------- Server ----------

/**
 * startServer(options) -> Promise<{ server, port, url, tick(nowMs?), close() }>
 * options: host, port, dataDir, publicDir, vapidSubject, send (web-push sender, injectable),
 *          scheduler (start the minute loop, default true), now (clock), log.
 */
export async function startServer({
  host = '127.0.0.1',
  port = 8790,
  dataDir = path.join(ROOT, 'data'),
  publicDir = path.join(ROOT, 'public'),
  vapidSubject = DEFAULT_VAPID_SUBJECT,
  send,
  scheduler = true,
  now = () => Date.now(),
  log = console,
} = {}) {
  publicDir = path.resolve(publicDir);
  const store = createStore(path.resolve(dataDir));
  const vapid = loadOrCreateVapid(store);
  const pusher = createPusher({ store, vapid, subject: vapidSubject, log, ...(send ? { send } : {}) });

  // Settings: repair on load, persist the repaired copy so the file is always complete.
  let settings = normalizeSettings(store.get('settings', null));
  store.set('settings', settings);

  const recordMap = new Map();
  for (const r of store.get('records', [])) if (r && typeof r.id === 'string') recordMap.set(r.id, r);
  const allRecords = () => [...recordMap.values()];

  const getState = () => {
    const s = store.get('state', null) || {};
    return { sent: Array.isArray(s.sent) ? s.sent : [], checkinSendCount: s.checkinSendCount || 0, lastPushAt: s.lastPushAt || null };
  };
  const updateState = (fn) => store.set('state', fn(getState()));

  function notePush(result, nowMs) {
    if (result.sent > 0) updateState((s) => ({ ...s, lastPushAt: new Date(nowMs).toISOString() }));
  }

  // ----- Scheduler -----
  let lastProcessedMinute = null;
  let ticking = false;
  let timer = null;

  async function tick(nowMs = now()) {
    if (ticking) return null;
    ticking = true;
    try {
      const minute = Math.floor(nowMs / 60_000);
      if (lastProcessedMinute !== null && lastProcessedMinute > minute) lastProcessedMinute = null; // clock went back
      const plan = planTick({ nowMs, lastProcessedMinute, settings, records: allRecords(), state: getState() });
      lastProcessedMinute = plan.processedMinute;
      if (!plan.sends.length && !plan.skipped.length) return plan;

      const entries = plan.skipped.map((s) => ({ kind: s.kind, date: s.date, minute: s.minute, at: nowMs, delivered: 0, skipped: true }));
      let checkinsDelivered = 0;
      let delivered = 0;
      for (const s of plan.sends) {
        const result = pusher.list().length ? await pusher.sendToAll(s.payload, s.options) : { sent: 0 };
        entries.push({ kind: s.kind, date: s.date, minute: s.minute, at: nowMs, delivered: result.sent });
        if (result.sent > 0) {
          delivered++;
          if (s.kind === 'checkin') checkinsDelivered++;
        }
        log.info?.(`[remind] ${s.kind}${s.repeat ? ' (repeat)' : ''} ${s.date} ${s.minute}: sent to ${result.sent}.`);
      }
      updateState((st) => ({
        ...st,
        sent: pruneSentLog([...st.sent, ...entries], nowMs),
        checkinSendCount: st.checkinSendCount + checkinsDelivered,
        lastPushAt: delivered ? new Date(nowMs).toISOString() : st.lastPushAt,
      }));
      return plan;
    } finally {
      ticking = false;
    }
  }

  function arm() {
    const delay = 60_000 - (now() % 60_000) + 25;
    timer = setTimeout(() => {
      arm();
      tick().catch((err) => log.error?.(`[remind] Tick failed: ${err.stack || err}`));
    }, delay);
  }

  // ----- API -----
  async function handleApi(req, res, segments, url) {
    const route = `${req.method} /${segments.join('/')}`;
    switch (route) {
      case 'GET /api/health':
        return sendJson(res, 200, { ok: true });

      case 'GET /api/vapid-public-key':
        return sendJson(res, 200, { key: vapid.publicKey });

      case 'POST /api/subscriptions': {
        const body = await readJsonBody(req);
        const err = subscriptionError(body && body.subscription);
        if (err) throw new HttpError(400, err);
        pusher.upsert(body.subscription);
        return sendJson(res, 200, { ok: true });
      }

      case 'DELETE /api/subscriptions': {
        const body = await readJsonBody(req);
        if (!body || typeof body.endpoint !== 'string' || !body.endpoint) throw new HttpError(400, 'Send the endpoint to remove.');
        pusher.remove(body.endpoint);
        return sendJson(res, 200, { ok: true });
      }

      case 'GET /api/settings':
        return sendJson(res, 200, settings);

      case 'PUT /api/settings': {
        const body = await readJsonBody(req);
        const r = applySettingsPatch(settings, body);
        if (r.error) throw new HttpError(400, r.error);
        settings = store.set('settings', r.settings);
        return sendJson(res, 200, settings);
      }

      case 'GET /api/records': {
        const since = url.searchParams.get('since');
        let sinceMs = null;
        if (since) {
          sinceMs = Date.parse(since);
          if (!Number.isFinite(sinceMs)) throw new HttpError(400, 'since must be an ISO date.');
        }
        const records = allRecords()
          .filter((r) => sinceMs === null || Date.parse(r.updatedAt) > sinceMs || (r._receivedAt && Date.parse(r._receivedAt) > sinceMs))
          .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
          .map(publicRecord);
        return sendJson(res, 200, { records, serverTime: new Date(now()).toISOString() });
      }

      case 'POST /api/records': {
        const body = await readJsonBody(req);
        if (!body || !Array.isArray(body.records)) throw new HttpError(400, 'Send records as a list.');
        if (body.records.length > MAX_RECORDS_PER_POST) throw new HttpError(400, `Send at most ${MAX_RECORDS_PER_POST} records at a time.`);
        body.records.forEach((r, i) => {
          const err = recordError(r, i);
          if (err) throw new HttpError(400, err);
        });
        const receivedAt = new Date(now()).toISOString();
        let applied = 0;
        for (const incoming of body.records) {
          const existing = recordMap.get(incoming.id);
          if (existing && !(Date.parse(incoming.updatedAt) > Date.parse(existing.updatedAt))) continue;
          recordMap.set(incoming.id, { ...publicRecord(incoming), _receivedAt: receivedAt });
          applied++;
        }
        if (applied) store.set('records', allRecords());
        return sendJson(res, 200, { ok: true, accepted: body.records.length, applied });
      }

      case 'POST /api/test-push': {
        const result = await pusher.sendToAll(
          { title: 'Check-in', body: "Test reminder. You're all set.", url: '/', tag: 'test' },
          pushOptions('test'),
        );
        notePush(result, now());
        return sendJson(res, 200, { sent: result.sent });
      }

      case 'GET /api/status': {
        const nowMs = now();
        const today = localParts(nowMs, settings.timeZone).date;
        const closed = new Set(allRecords().filter((r) => r.kind === 'night').map((r) => r.date));
        return sendJson(res, 200, {
          subscriptions: pusher.list().length,
          lastPushAt: getState().lastPushAt,
          nextCheckinAt: nextCheckinAt(nowMs, settings),
          nextReviewAt: nextReviewAt(nowMs, settings, closed),
          paused: settings.pausedDate === today,
        });
      }

      case 'GET /api/export': {
        const nowMs = now();
        const date = localParts(nowMs, settings.timeZone).date;
        const records = allRecords()
          .sort((a, b) => String(a.at || a.closedAt || a.updatedAt).localeCompare(String(b.at || b.closedAt || b.updatedAt)))
          .map(publicRecord);
        return sendJson(res, 200, { exportedAt: new Date(nowMs).toISOString(), settings, records }, {
          'Content-Disposition': `attachment; filename="checkins-${date}.json"`,
        });
      }

      default: {
        const known = ['health', 'vapid-public-key', 'subscriptions', 'settings', 'records', 'test-push', 'status', 'export'];
        if (segments.length === 2 && known.includes(segments[1])) throw new HttpError(405, 'That method is not allowed here.');
        throw new HttpError(404, 'Not found.');
      }
    }
  }

  // ----- Static -----
  function serveFile(req, res, file, stat) {
    const ext = path.extname(file).toLowerCase();
    const name = path.basename(file);
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // The service worker does the caching; the HTTP cache must always revalidate so
      // a new service worker never precaches stale files.
      'Cache-Control': 'no-cache',
      ETag: etag,
      'Last-Modified': stat.mtime.toUTCString(),
      'X-Content-Type-Options': 'nosniff',
    };
    if (name === 'sw.js') headers['Service-Worker-Allowed'] = '/';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }

  function statFile(file) {
    try {
      const st = fs.statSync(file);
      return st.isFile() ? st : null;
    } catch {
      return null;
    }
  }

  function handleStatic(req, res, segments) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method not allowed.');
      return;
    }
    const hidden = segments.some((s) => s.startsWith('.'));
    let file = hidden ? null : path.join(publicDir, ...segments);
    if (file && file !== publicDir && !file.startsWith(publicDir + path.sep)) throw new HttpError(400, 'Bad path.');
    let stat = null;
    if (file) {
      let st = null;
      try {
        st = fs.statSync(file);
      } catch {
        st = null;
      }
      if (st && st.isDirectory()) {
        file = path.join(file, 'index.html');
        st = statFile(file);
      }
      stat = st && st.isFile() ? st : null;
    }
    if (!stat) {
      // SPA fallback: unknown non-API paths get the app shell.
      file = path.join(publicDir, 'index.html');
      stat = statFile(file);
    }
    if (!stat) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found.');
      return;
    }
    serveFile(req, res, file, stat);
  }

  async function handle(req, res) {
    try {
      const rawPath = (req.url || '/').split('?')[0];
      if (!rawPath.startsWith('/')) throw new HttpError(400, 'Bad path.');
      const segments = safeSegments(rawPath);
      const url = new URL(req.url, 'http://localhost');
      if (segments[0] === 'api') return await handleApi(req, res, segments, url);
      return handleStatic(req, res, segments);
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      log.error?.(`[http] ${req.method} ${req.url} failed: ${err.stack || err}`);
      return sendJson(res, 500, { error: 'Something went wrong on the server.' });
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res);
  });
  server.requestTimeout = 30_000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  if (scheduler) arm();

  const actualPort = server.address().port;
  return {
    server,
    port: actualPort,
    url: `http://${host.includes(':') ? `[${host}]` : host}:${actualPort}`,
    tick,
    store,
    close() {
      clearTimeout(timer);
      timer = null;
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

// ---------- Entry point ----------

function parsePort(value) {
  if (value === undefined || value === '') return 8790;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`PORT must be a whole number from 0 to 65535, got "${value}".`);
  return n;
}

async function main() {
  if (!process.env.VAPID_SUBJECT) {
    console.warn(`[server] VAPID_SUBJECT is not set; using the placeholder ${DEFAULT_VAPID_SUBJECT}. Set it to the app's origin.`);
  }
  const app = await startServer({
    host: process.env.HOST || '127.0.0.1',
    port: parsePort(process.env.PORT),
    dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data'),
    vapidSubject: process.env.VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT,
  });
  console.log(`[server] Check-in listening on ${app.url}`);
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[server] ${signal} received, shutting down.`);
    app.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`[server] Failed to start: ${err.stack || err}`);
    process.exit(1);
  });
}
