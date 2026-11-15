// Boots the real server on a random port with a temp DATA_DIR and a fixture public/ folder.
// web-push sending is replaced with a mock, so no test touches the network.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/server.mjs';
import { localParts } from '../server/schedule.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const silent = { info() {}, warn() {}, error() {}, log() {} };

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makePublic() {
  const dir = tmpDir('checkin-public-');
  fs.mkdirSync(path.join(dir, 'icons'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Check-in</title><p>shell</p>');
  fs.writeFileSync(path.join(dir, 'sw.js'), 'self.addEventListener("push", () => {});');
  fs.writeFileSync(path.join(dir, 'app.js'), 'export const app = 1;');
  fs.writeFileSync(path.join(dir, 'logic.mjs'), 'export const x = 1;');
  fs.writeFileSync(path.join(dir, 'styles.css'), 'body { color: black; }');
  fs.writeFileSync(path.join(dir, 'manifest.webmanifest'), JSON.stringify({ name: 'Check-in' }));
  fs.writeFileSync(path.join(dir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(dir, 'icons', 'icon-192.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  fs.writeFileSync(path.join(dir, '.secret'), 'hidden');
  return dir;
}

/** Raw HTTP request, so paths like /../x reach the server unnormalized. */
function request(port, method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: {
        ...(data !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

/** Mock web-push sender. Endpoint text decides the outcome. */
function makeSender() {
  const calls = [];
  const send = async (subscription, payload, options) => {
    calls.push({ subscription, payload: JSON.parse(payload), options });
    const e = subscription.endpoint;
    const fail = (statusCode) => Object.assign(new Error(`Received unexpected response code ${statusCode}`), { statusCode });
    if (e.includes('gone410')) throw fail(410);
    if (e.includes('missing404')) throw fail(404);
    if (e.includes('broken500')) throw fail(500);
    return { statusCode: 201, body: '', headers: {} };
  };
  return { send, calls };
}

const sub = (name) => ({
  endpoint: `https://web.push.apple.com/${name}`,
  expirationTime: null,
  keys: { p256dh: `p256-${name}`, auth: `auth-${name}` },
});

const iso = (ms) => new Date(ms).toISOString();

function checkin(id, at, over = {}) {
  return {
    id, kind: 'checkin', at, date: '2026-11-09', hour: 9, feeling: 'restless', body: 'chest',
    shouldBe: 'Q4 report', actually: 'YouTube', status: 'escaping', updatedAt: at, ...over,
  };
}

// ---------------------------------------------------------------------------
describe('API', () => {
  let app;
  let port;
  let dataDir;
  let publicDir;
  let sender;
  let clock;

  before(async () => {
    dataDir = tmpDir('checkin-data-');
    publicDir = makePublic();
    sender = makeSender();
    clock = Date.parse('2026-11-10T12:00:00Z'); // after every fixture timestamp below
    app = await startServer({
      host: '127.0.0.1', port: 0, dataDir, publicDir, send: sender.send, scheduler: false,
      now: () => clock, log: silent, vapidSubject: 'https://example-tailnet.ts.net:8443',
    });
    port = app.port;
  });

  after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(publicDir, { recursive: true, force: true });
  });

  const api = (method, p, opts) => request(port, method, p, opts);
  const readData = (name) => JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));

  // ----- basics -----
  test('GET /api/health', async () => {
    const r = await api('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  test('GET /api/vapid-public-key returns the generated, persisted key', async () => {
    const r = await api('GET', '/api/vapid-public-key');
    assert.equal(r.status, 200);
    assert.match(r.json.key, /^[A-Za-z0-9_-]{87}$/);
    const saved = readData('vapid.json');
    assert.equal(saved.publicKey, r.json.key);
    assert.ok(saved.privateKey);
  });

  test('unknown API path is a JSON 404, wrong method is a 405', async () => {
    const r = await api('GET', '/api/nope');
    assert.equal(r.status, 404);
    assert.deepEqual(r.json, { error: 'Not found.' });
    const m = await api('DELETE', '/api/settings');
    assert.equal(m.status, 405);
    assert.ok(m.json.error);
  });

  test('invalid JSON, empty body and oversized body are rejected', async () => {
    const bad = await api('PUT', '/api/settings', { body: '{not json' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'Request body must be valid JSON.');
    const empty = await api('POST', '/api/records', { body: '' });
    assert.equal(empty.status, 400);
    const big = await api('POST', '/api/records', { body: JSON.stringify({ records: [], pad: 'x'.repeat(1024 * 1024 + 10) }) });
    assert.equal(big.status, 413);
    assert.equal(big.json.error, 'Request body is too large.');
  });

  // ----- settings -----
  test('GET /api/settings returns defaults with the server time zone', async () => {
    const r = await api('GET', '/api/settings');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {
      intervalMin: 30, activeStart: '09:00', activeEnd: '21:00', reviewTime: '21:30',
      weeklyDay: 0, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, pausedDate: null, streakHours: 5,
    });
  });

  test('PUT /api/settings merges a partial update and persists it', async () => {
    const r = await api('PUT', '/api/settings', { body: { intervalMin: 60, timeZone: 'America/Los_Angeles', unknownKey: 1 } });
    assert.equal(r.status, 200);
    assert.equal(r.json.intervalMin, 60);
    assert.equal(r.json.timeZone, 'America/Los_Angeles');
    assert.equal(r.json.activeStart, '09:00');
    assert.ok(!('unknownKey' in r.json));
    assert.deepEqual(readData('settings.json'), r.json);
    assert.deepEqual((await api('GET', '/api/settings')).json, r.json);
  });

  test('PUT /api/settings validation errors', async () => {
    const before = (await api('GET', '/api/settings')).json;
    const cases = [
      [{ activeStart: '10:00', activeEnd: '09:00' }, 'Active hours must end after they start.'],
      [{ activeStart: '09:00', activeEnd: '09:00' }, 'Active hours must end after they start.'],
      [{ activeEnd: '08:00' }, 'Active hours must end after they start.'],
      [{ intervalMin: 10 }, 'Interval must be a whole number of minutes from 15 to 480.'],
      [{ intervalMin: 481 }, 'Interval must be a whole number of minutes from 15 to 480.'],
      [{ intervalMin: 30.5 }, 'Interval must be a whole number of minutes from 15 to 480.'],
      [{ intervalMin: '30' }, 'Interval must be a whole number of minutes from 15 to 480.'],
      [{ activeStart: '9:00' }, 'Active hours must be times like 09:00.'],
      [{ activeEnd: '24:00' }, 'Active hours must be times like 09:00.'],
      [{ reviewTime: 'night' }, 'Night review time must be a time like 21:30.'],
      [{ weeklyDay: 7 }, 'Weekly review day must be 0 (Sunday) to 6 (Saturday).'],
      [{ timeZone: 'Mars/Olympus' }, "That time zone isn't recognized."],
      [{ pausedDate: '2026-13-01' }, 'Pause date must be a date like 2026-11-08, or null.'],
      [{ streakHours: 0 }, 'Streak hours must be a whole number from 1 to 24.'],
      [[1, 2], 'Send settings as an object.'],
    ];
    for (const [body, error] of cases) {
      const r = await api('PUT', '/api/settings', { body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.deepEqual(r.json, { error }, JSON.stringify(body));
    }
    assert.deepEqual((await api('GET', '/api/settings')).json, before);
  });

  test('PUT /api/settings accepts the boundaries', async () => {
    for (const intervalMin of [15, 480]) {
      assert.equal((await api('PUT', '/api/settings', { body: { intervalMin } })).json.intervalMin, intervalMin);
    }
    const r = await api('PUT', '/api/settings', { body: { activeStart: '00:00', activeEnd: '23:59', pausedDate: '2026-11-09', weeklyDay: 6 } });
    assert.equal(r.status, 200);
    const reset = await api('PUT', '/api/settings', {
      body: { intervalMin: 30, activeStart: '09:00', activeEnd: '21:00', pausedDate: null, weeklyDay: 0 },
    });
    assert.equal(reset.json.pausedDate, null);
  });

  // ----- subscriptions -----
  test('POST /api/subscriptions upserts by endpoint', async () => {
    const r = await api('POST', '/api/subscriptions', { body: { subscription: sub('good') } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    const again = await api('POST', '/api/subscriptions', {
      body: { subscription: { ...sub('good'), keys: { p256dh: 'new-p256', auth: 'new-auth' } } },
    });
    assert.equal(again.status, 200);
    const saved = readData('subscriptions.json');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].keys.p256dh, 'new-p256');
  });

  test('POST /api/subscriptions validation', async () => {
    const cases = [
      [{}, 'Send a subscription object.'],
      [{ subscription: { endpoint: 'http://insecure.example/x', keys: { p256dh: 'a', auth: 'b' } } }, 'The subscription needs an https endpoint.'],
      [{ subscription: { endpoint: 'not a url', keys: { p256dh: 'a', auth: 'b' } } }, 'The subscription needs an https endpoint.'],
      [{ subscription: { endpoint: 'https://push.example/x' } }, 'The subscription is missing its keys.'],
      [{ subscription: { endpoint: 'https://push.example/x', keys: { p256dh: '', auth: 'b' } } }, 'The subscription is missing its keys.'],
    ];
    for (const [body, error] of cases) {
      const r = await api('POST', '/api/subscriptions', { body });
      assert.equal(r.status, 400);
      assert.deepEqual(r.json, { error });
    }
    assert.equal(readData('subscriptions.json').length, 1);
  });

  test('DELETE /api/subscriptions removes by endpoint', async () => {
    await api('POST', '/api/subscriptions', { body: { subscription: sub('temp') } });
    assert.equal(readData('subscriptions.json').length, 2);
    const r = await api('DELETE', '/api/subscriptions', { body: { endpoint: sub('temp').endpoint } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    assert.deepEqual(readData('subscriptions.json').map((s) => s.endpoint), [sub('good').endpoint]);
    const unknown = await api('DELETE', '/api/subscriptions', { body: { endpoint: 'https://push.example/none' } });
    assert.equal(unknown.status, 200);
    const missing = await api('DELETE', '/api/subscriptions', { body: {} });
    assert.equal(missing.status, 400);
    assert.deepEqual(missing.json, { error: 'Send the endpoint to remove.' });
  });

  // ----- records -----
  describe('records', () => {
    const t0 = Date.parse('2026-11-09T17:00:00.000Z');
    const records = [
      { ...checkin('c1', iso(t0)), synced: false },
      { id: 's1', kind: 'skip', at: iso(t0 + 1800_000), date: '2026-11-09', hour: 9, updatedAt: iso(t0 + 1800_000) },
      { id: 'night-2026-11-08', kind: 'night', date: '2026-11-08', yesterdayResult: null, wentWell: 'Walked', improve: 'Phone away', closedAt: iso(t0 - 3600_000), updatedAt: iso(t0 - 3600_000) },
      { id: 'week-2026-11-02', kind: 'week', weekStart: '2026-11-02', weekEnd: '2026-11-08', pattern: 'YouTube after lunch', change: 'Walk at 1', closedAt: iso(t0 - 7200_000), updatedAt: iso(t0 - 7200_000) },
    ];

    test('POST /api/records stores a valid batch; GET returns them without internal fields', async () => {
      clock = t0 - 3 * 3600_000; // the server receives these before any `since` used below
      const r = await api('POST', '/api/records', { body: { records } });
      assert.equal(r.status, 200);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.accepted, 4);
      const all = await api('GET', '/api/records');
      assert.equal(all.status, 200);
      assert.equal(all.json.records.length, 4);
      assert.ok(Number.isFinite(Date.parse(all.json.serverTime)));
      for (const rec of all.json.records) {
        assert.ok(!('synced' in rec), 'synced is stripped');
        assert.ok(!('_receivedAt' in rec), 'internal fields are hidden');
      }
      const c1 = all.json.records.find((x) => x.id === 'c1');
      const { synced, ...expected } = records[0];
      void synced;
      assert.deepEqual(c1, expected);
      assert.equal(readData('records.json').length, 4);
    });

    test('last write wins by updatedAt', async () => {
      const older = checkin('c1', iso(t0), { feeling: 'older', updatedAt: iso(t0 - 1000) });
      const same = checkin('c1', iso(t0), { feeling: 'same time' });
      const newer = checkin('c1', iso(t0), { feeling: 'calm', status: 'on', updatedAt: iso(t0 + 60_000) });
      const r1 = await api('POST', '/api/records', { body: { records: [older, same] } });
      assert.equal(r1.status, 200);
      assert.equal(r1.json.accepted, 2);
      let c1 = (await api('GET', '/api/records')).json.records.find((x) => x.id === 'c1');
      assert.equal(c1.feeling, 'restless');
      const r2 = await api('POST', '/api/records', { body: { records: [newer] } });
      assert.equal(r2.json.accepted, 1);
      c1 = (await api('GET', '/api/records')).json.records.find((x) => x.id === 'c1');
      assert.equal(c1.feeling, 'calm');
      assert.equal(c1.status, 'on');
      // An older copy arriving later does not overwrite.
      await api('POST', '/api/records', { body: { records: [older] } });
      c1 = (await api('GET', '/api/records')).json.records.find((x) => x.id === 'c1');
      assert.equal(c1.feeling, 'calm');
    });

    test('GET /api/records?since filters by updatedAt', async () => {
      const r = await api('GET', `/api/records?since=${encodeURIComponent(iso(t0 - 1))}`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.records.map((x) => x.id).sort(), ['c1', 's1']);
      // c1 was last updated at t0 + 60 s, s1 at t0 + 30 min.
      const mid = await api('GET', `/api/records?since=${encodeURIComponent(iso(t0 + 30_000))}`);
      assert.deepEqual(mid.json.records.map((x) => x.id), ['c1', 's1']);
      const later = await api('GET', `/api/records?since=${encodeURIComponent(iso(t0 + 60_000))}`);
      assert.deepEqual(later.json.records.map((x) => x.id), ['s1']);
      const exact = await api('GET', `/api/records?since=${encodeURIComponent(iso(t0 + 1800_000))}`);
      assert.deepEqual(exact.json.records, [], 'strictly greater than since');
    });

    test('since also returns records the server received after it, even with an older updatedAt', async () => {
      clock = Date.parse('2026-11-10T12:00:00Z');
      const first = await api('GET', '/api/records');
      const since = first.json.serverTime;
      clock += 5000;
      const late = checkin('late-offline', iso(t0 - 86400_000), { date: '2026-11-08' });
      await api('POST', '/api/records', { body: { records: [late] } });
      const r = await api('GET', `/api/records?since=${encodeURIComponent(since)}`);
      assert.deepEqual(r.json.records.map((x) => x.id), ['late-offline']);
      clock += 5000;
      const none = await api('GET', `/api/records?since=${encodeURIComponent(r.json.serverTime)}`);
      assert.deepEqual(none.json.records, []);
    });

    test('GET /api/records rejects a bad since', async () => {
      const r = await api('GET', '/api/records?since=yesterday');
      assert.equal(r.status, 400);
      assert.deepEqual(r.json, { error: 'since must be an ISO date.' });
    });

    test('POST /api/records validation rejects the whole batch', async () => {
      const ok = checkin('fresh', iso(t0));
      const cases = [
        [{}, 'Send records as a list.'],
        [{ records: 'nope' }, 'Send records as a list.'],
        [{ records: [ok, { ...ok, id: '' }] }, 'Record 2 needs an id.'],
        [{ records: [{ ...ok, id: 5 }] }, 'Record 1 needs an id.'],
        [{ records: [{ ...ok, kind: 'mood' }] }, 'Record 1 has an unknown kind.'],
        [{ records: [{ ...ok, updatedAt: 'later' }] }, 'Record 1 needs a valid updatedAt time.'],
        [{ records: [{ ...ok, at: undefined }] }, 'Record 1 needs a valid at time.'],
        [{ records: [{ ...ok, date: '2026-02-30' }] }, 'Record 1 needs a date like 2026-11-08.'],
        [{ records: [{ ...ok, hour: 24 }] }, 'Record 1 needs an hour from 0 to 23.'],
        [{ records: [{ ...ok, feeling: '   ' }] }, 'Record 1 needs a feeling.'],
        [{ records: [{ ...ok, status: 'meh' }] }, 'Record 1 has an unknown status.'],
        [{ records: [{ ...ok, shouldBe: 5 }] }, 'Record 1 has a field that should be text.'],
        [{ records: ['x'] }, 'Record 1 must be an object.'],
        [{ records: [{ id: 'night-x', kind: 'night', date: '2026-11-09', updatedAt: iso(t0) }] }, 'Record 1 should have the id night-2026-11-09.'],
        [{ records: [{ id: 'night-2026-11-09', kind: 'night', date: '2026-11-09', yesterdayResult: 'maybe', updatedAt: iso(t0) }] }, 'Record 1 has an unknown yesterdayResult.'],
        [{ records: [{ id: 'week-1', kind: 'week', weekStart: '2026-11-02', updatedAt: iso(t0) }] }, 'Record 1 should have the id week-2026-11-02.'],
      ];
      for (const [body, error] of cases) {
        const r = await api('POST', '/api/records', { body });
        assert.equal(r.status, 400, error);
        assert.deepEqual(r.json, { error });
      }
      const all = (await api('GET', '/api/records')).json.records;
      assert.ok(!all.some((x) => x.id === 'fresh'), 'nothing from a rejected batch is stored');
    });
  });

  // ----- push -----
  test('POST /api/test-push sends to every subscription and removes 404/410 ones', async () => {
    for (const name of ['gone410', 'missing404', 'broken500']) {
      await api('POST', '/api/subscriptions', { body: { subscription: sub(name) } });
    }
    sender.calls.length = 0;
    const r = await api('POST', '/api/test-push');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { sent: 1 });
    assert.equal(sender.calls.length, 4);
    const call = sender.calls.find((c) => c.subscription.endpoint.endsWith('/good'));
    assert.equal(call.payload.body, "Test reminder. You're all set.");
    assert.equal(call.options.vapidDetails.subject, 'https://example-tailnet.ts.net:8443');
    assert.equal(call.options.vapidDetails.publicKey, readData('vapid.json').publicKey);
    assert.deepEqual(call.subscription.keys, { p256dh: 'new-p256', auth: 'new-auth' });
    const remaining = readData('subscriptions.json').map((s) => s.endpoint.split('/').pop()).sort();
    assert.deepEqual(remaining, ['broken500', 'good']);
  });

  test('GET /api/status', async () => {
    const r = await api('GET', '/api/status');
    assert.equal(r.status, 200);
    assert.equal(r.json.subscriptions, 2);
    assert.equal(r.json.lastPushAt, iso(clock));
    assert.equal(r.json.paused, false);
    assert.ok(Number.isFinite(Date.parse(r.json.nextCheckinAt)));
    assert.ok(Date.parse(r.json.nextCheckinAt) > clock);
    assert.ok(Date.parse(r.json.nextReviewAt) > clock);
    const today = localParts(clock, 'America/Los_Angeles').date;
    await api('PUT', '/api/settings', { body: { pausedDate: today } });
    const paused = await api('GET', '/api/status');
    assert.equal(paused.json.paused, true);
    await api('PUT', '/api/settings', { body: { pausedDate: null } });
  });

  test('GET /api/export downloads records and settings', async () => {
    const r = await api('GET', '/api/export');
    assert.equal(r.status, 200);
    const date = localParts(clock, 'America/Los_Angeles').date;
    assert.equal(r.headers['content-disposition'], `attachment; filename="checkins-${date}.json"`);
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.equal(r.json.settings.timeZone, 'America/Los_Angeles');
    assert.ok(r.json.records.length >= 5);
    assert.ok(r.json.records.every((x) => !('_receivedAt' in x)));
    assert.ok(r.json.exportedAt);
  });

  // ----- scheduler tick -----
  test('scheduler tick sends a check-in once, logs it, and uses the push options', async () => {
    await api('PUT', '/api/settings', { body: { timeZone: 'America/Los_Angeles', intervalMin: 30, activeStart: '09:00', activeEnd: '21:00' } });
    sender.calls.length = 0;
    clock = Date.parse('2026-11-12T18:00:10Z'); // Thursday 10:00 in LA, no entries that day
    await app.tick();
    assert.equal(sender.calls.length, 2); // good + broken500
    const call = sender.calls[0];
    assert.equal(call.payload.title, 'Check in');
    assert.equal(call.payload.url, '/?go=checkin');
    assert.equal(call.payload.tag, 'checkin');
    assert.equal(call.options.TTL, 600);
    assert.equal(call.options.topic, 'checkin');
    assert.equal(call.options.urgency, 'high');
    const state = readData('state.json');
    assert.deepEqual(state.sent.map((s) => [s.kind, s.date, s.minute, s.delivered]), [['checkin', '2026-11-12', 600, 1]]);
    assert.equal(state.checkinSendCount, 1);
    assert.equal(state.lastPushAt, iso(clock));

    // Same minute again: nothing new.
    sender.calls.length = 0;
    clock += 20_000;
    await app.tick();
    assert.equal(sender.calls.length, 0);

    // Rotation advances on the next aligned minute.
    clock = Date.parse('2026-11-12T18:30:05Z');
    await app.tick();
    assert.equal(sender.calls[0].payload.body, "Pause. What's here?");
  });

  test('scheduler tick sends the night review and its repeat with night options', async () => {
    sender.calls.length = 0;
    clock = Date.parse('2026-11-13T05:30:00Z'); // 21:30 Thursday in LA
    await app.tick();
    assert.equal(sender.calls.length, 2);
    assert.equal(sender.calls[0].payload.title, 'Close the day');
    assert.equal(sender.calls[0].payload.body, 'Logged 0 of 5 hours today. 2 minutes to close it.');
    assert.equal(sender.calls[0].options.TTL, 3600);
    assert.equal(sender.calls[0].options.topic, 'night');

    // Closing the night before the repeat stops it.
    await api('POST', '/api/records', {
      body: { records: [{ id: 'night-2026-11-12', kind: 'night', date: '2026-11-12', yesterdayResult: null, wentWell: 'ok', improve: '', closedAt: iso(clock), updatedAt: iso(clock) }] },
    });
    sender.calls.length = 0;
    clock = Date.parse('2026-11-13T06:00:00Z');
    await app.tick();
    assert.equal(sender.calls.length, 0);
  });

  test('scheduler tick removes a subscription that answers 410', async () => {
    await api('POST', '/api/subscriptions', { body: { subscription: sub('gone410-later') } });
    sender.calls.length = 0;
    clock = Date.parse('2026-11-13T17:00:00Z'); // Friday 09:00 in LA
    await app.tick();
    assert.equal(sender.calls.length, 3);
    assert.ok(!readData('subscriptions.json').some((s) => s.endpoint.includes('gone410')));
  });

  // ----- static -----
  describe('static files', () => {
    const cases = [
      ['/', 'text/html; charset=utf-8', 'no-cache'],
      ['/index.html', 'text/html; charset=utf-8', 'no-cache'],
      ['/sw.js', 'text/javascript; charset=utf-8', 'no-cache'],
      ['/app.js', 'text/javascript; charset=utf-8'],
      ['/logic.mjs', 'text/javascript; charset=utf-8'],
      ['/styles.css', 'text/css; charset=utf-8'],
      ['/manifest.webmanifest', 'application/manifest+json'],
      ['/logo.svg', 'image/svg+xml'],
      ['/icons/icon-192.png', 'image/png'],
    ];
    for (const [p, type, cache] of cases) {
      test(`GET ${p} -> ${type}`, async () => {
        const r = await api('GET', p);
        assert.equal(r.status, 200);
        assert.equal(r.headers['content-type'], type);
        if (cache) assert.equal(r.headers['cache-control'], cache);
      });
    }

    test('served bytes match the file', async () => {
      const r = await api('GET', '/manifest.webmanifest');
      assert.deepEqual(r.json, { name: 'Check-in' });
    });

    test('HEAD and conditional GET', async () => {
      const head = await api('HEAD', '/app.js');
      assert.equal(head.status, 200);
      assert.equal(head.text, '');
      const etag = head.headers.etag;
      assert.ok(etag);
      const cond = await api('GET', '/app.js', { headers: { 'If-None-Match': etag } });
      assert.equal(cond.status, 304);
    });

    test('unknown non-API paths fall back to index.html', async () => {
      for (const p of ['/today', '/settings/deep/link', '/missing.png', '/?go=checkin', '/.secret']) {
        const r = await api('GET', p);
        assert.equal(r.status, 200, p);
        assert.equal(r.headers['content-type'], 'text/html; charset=utf-8', p);
        assert.match(r.text, /shell/, p);
      }
    });

    test('path traversal is rejected', async () => {
      for (const p of [
        '/../package.json',
        '/icons/../../package.json',
        '/%2e%2e/package.json',
        '/%2E%2E/%2E%2E/etc/passwd',
        '/icons/..%2f..%2fpackage.json',
        '/..%5cpackage.json',
        '/foo%00.html',
        '/%E0%A4%A',
        '/api/../package.json',
      ]) {
        const r = await api('GET', p);
        assert.equal(r.status, 400, p);
        assert.deepEqual(r.json, { error: 'Bad path.' }, p);
        assert.ok(!r.text.includes('emotion-checkin'), p);
      }
    });

    test('non-GET on a static path is a 405', async () => {
      const r = await api('POST', '/index.html', { body: {} });
      assert.equal(r.status, 405);
    });
  });
});

// ---------------------------------------------------------------------------
describe('persistence across restarts', () => {
  test('VAPID key, settings, subscriptions and records survive a restart', async () => {
    const dataDir = tmpDir('checkin-data-');
    const publicDir = makePublic();
    const opts = { host: '127.0.0.1', port: 0, dataDir, publicDir, send: makeSender().send, scheduler: false, log: silent };
    let app = await startServer(opts);
    const key = (await request(app.port, 'GET', '/api/vapid-public-key')).json.key;
    await request(app.port, 'PUT', '/api/settings', { body: { intervalMin: 120 } });
    await request(app.port, 'POST', '/api/subscriptions', { body: { subscription: sub('keep') } });
    await request(app.port, 'POST', '/api/records', { body: { records: [checkin('p1', '2026-11-09T17:00:00.000Z')] } });
    await app.close();
    assert.deepEqual(fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp')), [], 'no temp files left behind');

    app = await startServer(opts);
    assert.equal((await request(app.port, 'GET', '/api/vapid-public-key')).json.key, key);
    assert.equal((await request(app.port, 'GET', '/api/settings')).json.intervalMin, 120);
    assert.equal((await request(app.port, 'GET', '/api/status')).json.subscriptions, 1);
    assert.deepEqual((await request(app.port, 'GET', '/api/records')).json.records.map((r) => r.id), ['p1']);
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(publicDir, { recursive: true, force: true });
  });
});

describe('entry point', () => {
  test('node server/server.mjs starts with env HOST, PORT and DATA_DIR and stops on SIGTERM', async () => {
    const dataDir = tmpDir('checkin-data-');
    const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.mjs')], {
      env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const port = await new Promise((resolve, reject) => {
        let out = '';
        const timer = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 10_000);
        child.stdout.on('data', (d) => {
          out += d;
          const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
          if (m) {
            clearTimeout(timer);
            resolve(Number(m[1]));
          }
        });
        child.stderr.on('data', (d) => { out += d; });
        child.on('exit', (code) => reject(new Error(`server exited with ${code}: ${out}`)));
      });
      const r = await request(port, 'GET', '/api/health');
      assert.deepEqual(r.json, { ok: true });
      for (const f of ['vapid.json', 'settings.json']) assert.ok(fs.existsSync(path.join(dataDir, f)), f);
      const code = await new Promise((resolve) => {
        child.removeAllListeners('exit');
        child.on('exit', resolve);
        child.kill('SIGTERM');
      });
      assert.equal(code, 0);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
