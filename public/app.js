// Check-in: UI, routing, IndexedDB storage, sync with the Mac mini, push subscription.
import * as L from './logic.js';

const ROUTES = new Set(['today', 'checkin', 'night', 'week', 'settings', 'install']);
const PRESETS = [15, 30, 60, 120, 240];
const tz = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; }
};
const DEFAULT_SETTINGS = {
  intervalMin: 30, activeStart: '09:00', activeEnd: '21:00', reviewTime: '21:30',
  weeklyDay: 0, timeZone: tz(), pausedDate: null, streakHours: 5,
};

const app = document.getElementById('app');

// ---------- small helpers ----------

function lsGet(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function lsSet(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage can be unavailable */ }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = app) => root.querySelector(sel);
const $$ = (sel, root = app) => [...root.querySelectorAll(sel)];
const byAt = (a, b) => Date.parse(a.at) - Date.parse(b.at);
const newer = (a, b) => (Date.parse(a) || 0) > (Date.parse(b) || 0);

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function isStandalone() {
  return navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

function urlB64ToUint8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function api(path, { method = 'GET', body } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
      cache: 'no-store',
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status}).`);
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- state ----------

const state = {
  records: [],
  settings: { ...DEFAULT_SETTINGS, ...lsGet('settings', {}) },
  lastSyncAt: null,
  reg: null,
  vapidKey: lsGet('vapidKey') ? urlB64ToUint8(lsGet('vapidKey')) : null,
  sub: undefined, // undefined = not known yet, null = none
  pushNote: '',
  nextReminder: null,
  firstRunTouched: false,
  exportFile: null,
  timer: 0,
  lastRouteKey: '',
};

// ---------- IndexedDB ----------

// iOS can drop the IndexedDB connection while a Home Screen app is suspended ("Connection to
// Indexed Database server lost"). Forget a dead or failed connection so the next call reopens it,
// and retry each operation once on a fresh connection.
let dbPromise = null;
function openDB() {
  if (!dbPromise) {
    const p = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB is unavailable.')); return; }
      const req = indexedDB.open('checkin', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onclose = () => { if (dbPromise === p) dbPromise = null; };
        db.onversionchange = () => { try { db.close(); } catch { /* already closed */ } if (dbPromise === p) dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB is blocked.'));
    });
    dbPromise = p;
    p.catch(() => { if (dbPromise === p) dbPromise = null; });
  }
  return dbPromise;
}

function runTx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode); // throws InvalidStateError on a lost connection
    const req = fn(tx.objectStore(store));
    let result;
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed.'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted.'));
  });
}

async function idb(store, mode, fn) {
  let db = null;
  try {
    db = await openDB();
    return await runTx(db, store, mode, fn);
  } catch {
    // Drop the connection and try once more on a fresh one. Puts and reads are safe to repeat.
    if (db) { try { db.close(); } catch { /* ignore */ } }
    dbPromise = null;
    return runTx(await openDB(), store, mode, fn);
  }
}

/** Resolves true when the records reached IndexedDB, false when storage failed. */
const putRecords = (recs) => (recs.length
  ? idb('records', 'readwrite', (os) => { recs.forEach((r) => os.put(r)); }).then(() => true, () => false)
  : Promise.resolve(true));
const getAllRecords = () => idb('records', 'readonly', (os) => os.getAll()).catch(() => []);
const getMeta = (key) => idb('meta', 'readonly', (os) => os.get(key)).catch(() => undefined);
const setMeta = (key, value) => idb('meta', 'readwrite', (os) => { os.put(value, key); }).catch(() => {});

// Fallback when IndexedDB won't take a write: keep unsynced records in localStorage so an
// offline entry survives iOS killing the app. Cleared once IndexedDB holds everything again.
const PENDING_KEY = 'pendingRecords';
const mirrorPending = () => lsSet(PENDING_KEY, state.records.filter((r) => !r.synced));

async function flushPending() {
  if (!lsGet(PENDING_KEY)) return;
  if (await putRecords(state.records)) lsSet(PENDING_KEY, null);
  else mirrorPending();
}

function upsertMem(rec) {
  const i = state.records.findIndex((r) => r.id === rec.id);
  if (i === -1) state.records.push(rec);
  else state.records[i] = rec;
}

async function saveRecord(rec) {
  const { synced, syncError, ...fields } = rec;
  const full = { ...fields, updatedAt: new Date().toISOString(), synced: false };
  upsertMem(full);
  if (!(await putRecords([full]))) mirrorPending();
  sync();
  return full;
}

// ---------- sync ----------

let syncing = null;
let syncAgain = false;

function sync() {
  if (syncing) { syncAgain = true; return syncing; }
  syncing = doSync()
    .catch(() => { /* offline or unreachable: the backup line says so */ })
    .then(flushPending)
    .finally(() => {
      syncing = null;
      updateBackupLine();
      if (syncAgain) { syncAgain = false; sync(); }
    });
  return syncing;
}

const strip = ({ synced, syncError, ...rest }) => rest;

// Mark records that the server took (or refused) — only if they weren't edited meanwhile.
async function markSent(sent, patch) {
  const changed = [];
  for (const s of sent) {
    const cur = state.records.find((r) => r.id === s.id);
    if (cur && cur.updatedAt === s.updatedAt && !cur.synced) {
      Object.assign(cur, patch(s));
      changed.push(cur);
    }
  }
  await putRecords(changed);
}

async function pushBatch(recs) {
  const res = await L.pushRecords(recs, (batch) => api('/api/records', { method: 'POST', body: { records: batch.map(strip) } }));
  await markSent(res.synced, () => ({ synced: true, syncError: undefined }));
  // Refused records stay unsynced (the backup line counts them) but stop retrying until the next launch.
  const errors = new Map(res.rejected.map((x) => [x.record.id, x.error]));
  await markSent(res.rejected.map((x) => x.record), (s) => ({ syncError: errors.get(s.id) }));
  if (res.error) throw res.error;
}

async function doSync() {
  const unsynced = L.pendingPush(state.records);
  let pushError = null;
  try {
    for (let i = 0; i < unsynced.length; i += 500) await pushBatch(unsynced.slice(i, i + 500));
  } catch (err) {
    pushError = err; // still pull: a failed push shouldn't stop this phone from getting updates
  }

  const since = state.records.length ? await getMeta('lastPullAt') : null;
  const data = await api(`/api/records${since ? `?since=${encodeURIComponent(since)}` : ''}`);
  const changed = [];
  for (const r of data.records || []) {
    const cur = state.records.find((x) => x.id === r.id);
    if (!cur || newer(r.updatedAt, cur.updatedAt)) {
      const rec = { ...r, synced: true };
      upsertMem(rec);
      changed.push(rec);
    }
  }
  await putRecords(changed);
  if (data.serverTime) await setMeta('lastPullAt', data.serverTime);
  if (!pushError) {
    state.lastSyncAt = Date.now();
    await setMeta('lastSyncAt', state.lastSyncAt);
  }
  if (changed.length && currentRoute().name === 'today') render();
  if (pushError) throw pushError;
}

function backupText() {
  return L.backupLine(state.records, state.lastSyncAt, Date.now());
}

function updateBackupLine() {
  const el = document.getElementById('backup');
  if (el) el.textContent = backupText();
}

// ---------- settings ----------

function cacheSettings() { lsSet('settings', state.settings); }

function applyServerSettings(s) {
  state.settings = { ...DEFAULT_SETTINGS, ...s, ...(lsGet('settingsDirty') || {}) };
  cacheSettings();
}

function clearSentDirty(sent) {
  const dirty = lsGet('settingsDirty') || {};
  for (const [k, v] of Object.entries(sent)) if (dirty[k] === v) delete dirty[k];
  lsSet('settingsDirty', Object.keys(dirty).length ? dirty : null);
}

function showSaveError(msg) {
  const el = document.getElementById('e-save');
  if (!el) return;
  el.textContent = msg;
  el.hidden = !msg;
}

async function pushSettings(partial) {
  const body = { ...(lsGet('settingsDirty') || {}), ...partial };
  lsSet('settingsDirty', body);
  try {
    const s = await api('/api/settings', { method: 'PUT', body });
    clearSentDirty(body);
    applyServerSettings(s);
    showSaveError('');
    refreshStatus();
  } catch (err) {
    if (err.status === 400) {
      clearSentDirty(body);
      showSaveError(err.message);
      refreshSettings();
    }
    // Offline: the change stays in settingsDirty and goes up on the next open.
  }
}

function updateSetting(partial) {
  state.settings = { ...state.settings, ...partial };
  cacheSettings();
  if (!lsGet('onboarded')) { state.firstRunTouched = true; return; }
  pushSettings(partial);
}

// On every open: send the time zone (and any change made offline), take the server's copy.
async function refreshSettings() {
  const onboarded = lsGet('onboarded');
  const body = { ...(onboarded ? lsGet('settingsDirty') || {} : {}), timeZone: tz() };
  try {
    const s = await api('/api/settings', { method: 'PUT', body });
    clearSentDirty(body);
    const route = currentRoute().name;
    if (!onboarded && state.firstRunTouched) {
      state.settings.timeZone = s.timeZone;
      cacheSettings();
    } else {
      applyServerSettings(s);
      if (route === 'today' || (!onboarded && route === 'settings')) render();
    }
  } catch (err) {
    if (err.status === 400) lsSet('settingsDirty', null);
  }
}

// ---------- push ----------

let pushPrefetch = null;
function prefetchPush() {
  if (pushPrefetch) return pushPrefetch;
  if (!('serviceWorker' in navigator)) { state.sub = null; return Promise.resolve(); }
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000));
  pushPrefetch = (async () => {
    const reg = await Promise.race([navigator.serviceWorker.ready, timeout]);
    state.reg = reg;
    state.sub = reg.pushManager ? await reg.pushManager.getSubscription() : null;
    const { key } = await api('/api/vapid-public-key');
    lsSet('vapidKey', key);
    state.vapidKey = urlB64ToUint8(key);
  })()
    .catch(() => { if (state.sub === undefined) state.sub = null; })
    .finally(() => {
      pushPrefetch = null;
      updateRemindersCard();
      if (state.sub) refreshStatus();
    });
  return pushPrefetch;
}

const postSubscription = (sub) => api('/api/subscriptions', { method: 'POST', body: { subscription: sub.toJSON() } });

// Heals a lost server copy. Runs on every open.
async function healSubscription() {
  try {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = reg.pushManager && (await reg.pushManager.getSubscription());
    state.reg = reg;
    state.sub = sub || null;
    if (sub) await postSubscription(sub);
  } catch { /* try again next open */ }
}

async function refreshStatus() {
  try {
    const s = await api('/api/status');
    state.nextReminder = s.paused ? 'Paused today.' : s.nextCheckinAt ? `Next reminder at ${L.formatTime(s.nextCheckinAt)}.` : null;
  } catch { state.nextReminder = null; }
  const el = document.getElementById('next-reminder');
  if (el) el.textContent = state.nextReminder || '';
}

function setPushNote(text) {
  state.pushNote = text;
  const el = document.getElementById('push-note');
  if (el) el.textContent = text;
}

// iOS requires subscribe() to run inside the tap, before any await.
function onTurnOn() {
  const reg = state.reg;
  const key = state.vapidKey;
  if (!reg || !reg.pushManager || !key) {
    setPushNote(isStandalone() ? 'Still getting ready. Try again in a moment.' : 'Reminders only work from the Home Screen app.');
    prefetchPush();
    return;
  }
  let pending;
  try {
    pending = reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  } catch (err) {
    pending = Promise.reject(err);
  }
  setPushNote('');
  pending
    .then(async (sub) => {
      state.sub = sub;
      updateRemindersCard();
      try {
        await postSubscription(sub);
        refreshStatus();
      } catch {
        setPushNote("Couldn't reach the Mac mini. It will try again next time you open the app.");
      }
    })
    .catch(() => {
      updateRemindersCard();
      if (!('Notification' in window) || Notification.permission !== 'denied') {
        setPushNote("Couldn't turn on reminders. Try again.");
      }
    });
}

async function onTurnOff() {
  const sub = state.sub;
  if (!sub) return;
  try { await sub.unsubscribe(); } catch { /* already gone */ }
  state.sub = null;
  updateRemindersCard();
  try { await api('/api/subscriptions', { method: 'DELETE', body: { endpoint: sub.endpoint } }); } catch { /* server cleans up on 410 */ }
}

async function onTestPush(e) {
  const btn = e.currentTarget;
  btn.disabled = true;
  setPushNote('Sending.');
  try {
    const { sent } = await api('/api/test-push', { method: 'POST' });
    setPushNote(sent > 0 ? 'Sent. It should arrive in a few seconds.' : 'Nothing was sent. Turn reminders off and on again.');
  } catch {
    setPushNote("Couldn't reach the Mac mini. Check that Tailscale is on.");
  } finally {
    btn.disabled = false;
  }
}

function remindersHTML() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window;
  const perm = 'Notification' in window ? Notification.permission : 'default';
  if (!supported) {
    return `<p class="card-title">Reminders are off</p>
      <p class="muted">Reminders only work from the Home Screen app.</p>`;
  }
  if (perm === 'denied') {
    return `<p class="card-title">Notifications are blocked.</p>
      <p class="muted">Turn them on in iPhone Settings &gt; Notifications &gt; Check-in.</p>`;
  }
  if (state.sub === undefined) {
    return `<p class="card-title">Reminders</p><p class="muted">Checking.</p>`;
  }
  if (state.sub) {
    return `<p class="card-title"><span class="dot-on" aria-hidden="true"></span>Reminders are on</p>
      <p class="muted" id="next-reminder">${esc(state.nextReminder || '')}</p>
      <button type="button" class="btn secondary" id="push-test">Send a test reminder</button>
      <p class="muted" id="push-note" role="status">${esc(state.pushNote)}</p>
      <button type="button" class="link small" id="push-off">Turn off reminders</button>`;
  }
  const note = state.pushNote || (isStandalone() ? '' : 'Reminders only work from the Home Screen app.');
  return `<p class="card-title">Reminders are off</p>
    <button type="button" class="btn" id="push-on">Turn on reminders</button>
    <p class="muted" id="push-note" role="status">${esc(note)}</p>`;
}

function updateRemindersCard() {
  const card = document.getElementById('reminders');
  if (!card) return;
  card.innerHTML = remindersHTML();
  $('#push-on', card)?.addEventListener('click', onTurnOn);
  $('#push-off', card)?.addEventListener('click', onTurnOff);
  $('#push-test', card)?.addEventListener('click', onTestPush);
}

// ---------- routing ----------

function currentRoute() {
  const raw = location.hash.slice(1);
  const [name, qs] = raw.split('?');
  return { name: ROUTES.has(name) ? name : 'today', params: new URLSearchParams(qs || '') };
}

function go(target) {
  const name = String(target || 'today').split('?')[0];
  const hash = `#${ROUTES.has(name) ? target : 'today'}`;
  if (location.hash === hash) render();
  else location.hash = hash;
}

// "/?go=checkin" from a notification: route, then clean the URL.
function takeGoFromQuery() {
  const goParam = new URLSearchParams(location.search).get('go');
  if (!goParam) return;
  const name = goParam.split('?')[0];
  const hash = ROUTES.has(name) ? `#${goParam}` : location.hash;
  history.replaceState(null, '', `${location.pathname}${hash}`);
}

function render() {
  clearTimeout(state.timer);
  let { name, params } = currentRoute();
  if (!isStandalone() && !lsGet('browserOk')) name = 'install';
  else if (!lsGet('onboarded')) name = 'settings';
  else if (name === 'install') name = 'today';
  const screens = { today: renderToday, checkin: renderCheckin, night: renderNight, week: renderWeek, settings: renderSettings, install: renderInstall };
  screens[name](params);
  const key = `${name}?${params}`;
  if (key !== state.lastRouteKey) {
    window.scrollTo(0, 0);
    state.lastRouteKey = key;
  }
}

function showDone(html, { autoMs = 0, to = 'today' } = {}) {
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  app.innerHTML = `<main class="screen done" aria-live="polite">${html}</main>`;
  if (autoMs) state.timer = setTimeout(() => go(to), autoMs);
}

const nowInfo = () => {
  const now = new Date();
  return { now, today: L.localDate(now), nowMin: L.minutesOf(now) };
};

function streakPill(n) {
  return n > 0 ? `<span class="streak">${n}-day streak</span>` : '<span class="muted small">Start a streak today</span>';
}

function tallyHTML(title, list) {
  if (!list.length) return '';
  return `<p class="sub">${esc(title)}</p>
    <div class="tally">${list.map((t) => `<span>${esc(t.label)}</span><span>${t.count}</span>`).join('')}</div>`;
}

// ---------- Today ----------

function renderToday() {
  const s = state.settings;
  const recs = state.records;
  const { today, nowMin } = nowInfo();
  const hours = L.hoursLogged(recs, today);
  const hourSet = new Set(hours);
  const nightClosed = L.hasNight(recs, today);
  const streak = L.streak(recs, today, s.streakHours, nowMin);
  const banners = L.todayBanners({ records: recs, settings: s, today, nowMinutes: nowMin });
  const active = L.activeHours(s);
  const startMin = L.parseHM(s.activeStart);
  const endMin = L.parseHM(s.activeEnd);
  const midMin = Math.round((startMin + endMin) / 2 / 60) * 60;
  const entries = recs.filter((r) => (r.kind === 'checkin' || r.kind === 'skip') && r.date === today).sort(byAt);
  const last = [...entries].reverse().find((r) => r.kind === 'checkin');
  const yNight = L.nightFor(recs, L.addDays(today, -1));
  const working = yNight && yNight.improve && yNight.improve.trim();
  const weekRec = recs.filter((r) => r.kind === 'week' && r.change && r.change.trim()).sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1))[0];

  const dotClass = (r) => (r.kind === 'skip' || r.status === 'break' ? 'm' : r.status === 'escaping' ? 'esc' : 'on2');
  const dotLabel = (r) => `${L.formatTime(r.at)}: ${r.kind === 'skip' ? 'skipped' : r.status === 'break' ? 'break' : r.status === 'escaping' ? 'escaping' : 'on it'}`;

  let lastLine = '';
  if (last) {
    const a = (last.actually || '').trim();
    const b = (last.shouldBe || '').trim();
    const what = last.status === 'escaping' && a && b && a.toLowerCase() !== b.toLowerCase() ? `${a} instead of ${b}` : a || b;
    lastLine = `Last: ${last.feeling}${what ? ` · ${what}` : ''}, ${L.formatTime(last.at)}`;
  }

  app.innerHTML = `
  <main class="screen today">
    ${banners.map((b) => (b.href
      ? `<a class="banner" href="${esc(b.href)}">${esc(b.text)}</a>`
      : `<p class="banner plain">${esc(b.text)}</p>`)).join('')}
    <header class="top">
      <h1>${esc(L.dayLabel(today))}</h1>
      ${streakPill(streak)}
    </header>
    <section class="group">
      <p class="lbl">Hours logged today · ${hours.length} of ${s.streakHours}</p>
      <div class="slots" style="--n:${Math.max(active.length, 1)}" role="img" aria-label="${hours.length} of ${s.streakHours} hours logged">
        ${active.map((h) => `<i class="${hourSet.has(h) ? 'y' : ''}"></i>`).join('')}
      </div>
      <div class="slotlbl" aria-hidden="true"><span>${L.shortTime(startMin)}</span><span>${L.shortTime(midMin)}</span><span>${L.shortTime(endMin)}</span></div>
      <p class="muted">${esc(L.todayLine(hours.length, s.streakHours, nightClosed))}</p>
    </section>
    <section class="group">
      <p class="lbl">Check-ins · every ${esc(L.intervalLabel(s.intervalMin))}</p>
      ${entries.length
        ? `<div class="dots">${entries.map((r) => `<span class="d ${dotClass(r)}" role="img" aria-label="${esc(dotLabel(r))}"></span>`).join('')}</div>
           <div class="legend" aria-hidden="true"><span><span class="d on2"></span> on it</span><span><span class="d esc"></span> escaping</span><span><span class="d m"></span> skipped or break</span></div>`
        : '<p class="muted">No check-ins yet today.</p>'}
    </section>
    ${lastLine ? `<p class="muted">${esc(lastLine)}</p>` : ''}
    ${working ? `<p class="muted">Working on today: ${esc(working)}</p>` : ''}
    ${weekRec ? `<p class="muted">This week: ${esc(weekRec.change.trim())}</p>` : ''}
    <a class="btn" href="#checkin">Check in now</a>
    <nav class="foot"><a href="#week">This week</a><a href="#settings">Settings</a></nav>
  </main>`;
}

// ---------- Check-in ----------

function chipRow(field, labels, mode) {
  if (!labels.length) return '';
  return `<div class="chips" data-for="${field}" data-mode="${mode}">${labels
    .map((l) => `<button type="button" class="c" data-v="${esc(l)}">${esc(l)}</button>`).join('')}</div>`;
}

function renderCheckin() {
  const recs = state.records;
  const last = L.latestCheckin(recs);
  const prefill = last && last.shouldBe ? last.shouldBe.trim() : '';
  const { now } = nowInfo();

  app.innerHTML = `
  <main class="screen checkin">
    <header class="bar">
      <b>${esc(L.formatTime(now.toISOString()))} · Check in</b>
      <button type="button" class="link" id="skip">Skip</button>
    </header>
    <form id="ci" novalidate autocomplete="off">
      <div class="q">
        <label class="lbl" for="f-feeling">What am I feeling?</label>
        <input id="f-feeling" class="fld" type="text" maxlength="500" autocapitalize="none" enterkeyhint="next" aria-describedby="e-feeling">
        <p class="err" id="e-feeling" role="alert" hidden>Write what you're feeling first.</p>
        ${chipRow('feeling', L.chipsFor(recs, 'feeling'), 'append')}
      </div>
      <div class="q">
        <label class="lbl" for="f-body">Where in my body? <span class="opt">(optional)</span></label>
        <input id="f-body" class="fld" type="text" maxlength="500" autocapitalize="none" enterkeyhint="next">
        ${chipRow('body', L.chipsFor(recs, 'body'), 'append')}
      </div>
      <div class="q">
        <label class="lbl" for="f-should">What should I be doing?</label>
        <input id="f-should" class="fld" type="text" maxlength="500" enterkeyhint="next" value="${esc(prefill)}" aria-describedby="h-should">
        <p class="hint" id="h-should" ${prefill ? '' : 'hidden'}>same as last check-in</p>
      </div>
      <div class="q">
        <label class="lbl" for="f-actually">What am I actually doing?</label>
        <input id="f-actually" class="fld" type="text" maxlength="500" enterkeyhint="done">
        ${chipRow('actually', L.chipsFor(recs, 'actually'), 'replace')}
      </div>
      <div class="pick">
        <button type="button" class="ok" data-status="on">On it</button>
        <button type="button" class="esc" data-status="escaping">Escaping</button>
      </div>
      <button type="button" class="brk" data-status="break">Planned break</button>
    </form>
  </main>`;

  const fields = { feeling: $('#f-feeling'), body: $('#f-body'), actually: $('#f-actually') };
  const should = $('#f-should');
  const hint = $('#h-should');

  const syncChips = () => {
    for (const row of $$('.chips')) {
      const input = fields[row.dataset.for];
      const present = row.dataset.mode === 'append'
        ? new Set(L.tokens(input.value))
        : new Set([input.value.trim().toLowerCase()]);
      for (const c of $$('.c', row)) {
        const on = present.has(c.dataset.v.toLowerCase());
        c.classList.toggle('on', on);
        c.setAttribute('aria-pressed', String(on));
      }
    }
  };

  for (const row of $$('.chips')) {
    row.addEventListener('click', (e) => {
      const chip = e.target.closest('.c');
      if (!chip) return;
      const input = fields[row.dataset.for];
      const v = chip.dataset.v;
      if (row.dataset.mode === 'replace') {
        input.value = v;
      } else if (L.tokens(input.value).includes(v.toLowerCase())) {
        input.value = input.value.split(/[,;]/).map((p) => p.trim()).filter((p) => p && p.toLowerCase() !== v.toLowerCase()).join(', ');
      } else {
        const cur = input.value.trim().replace(/[,;]\s*$/, '');
        input.value = cur ? `${cur}, ${v}` : v;
      }
      if (row.dataset.for === 'feeling') $('#e-feeling').hidden = true;
      syncChips();
    });
  }
  Object.values(fields).forEach((f) => f.addEventListener('input', syncChips));
  fields.feeling.addEventListener('input', () => { if (fields.feeling.value.trim()) $('#e-feeling').hidden = true; });
  should.addEventListener('input', () => { hint.hidden = !prefill || should.value.trim() !== prefill; });

  const order = [fields.feeling, fields.body, should, fields.actually];
  $('#ci').addEventListener('submit', (e) => e.preventDefault());
  order.forEach((el, i) => el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (order[i + 1]) order[i + 1].focus();
    else el.blur();
  }));

  $('#skip').addEventListener('click', async () => {
    const t = new Date();
    await saveRecord({ id: uuid(), kind: 'skip', at: t.toISOString(), date: L.localDate(t), hour: t.getHours() });
    go('today');
  });

  let saving = false;
  for (const btn of $$('[data-status]')) {
    btn.addEventListener('click', async () => {
      if (saving) return;
      const feeling = fields.feeling.value.trim();
      if (!feeling) {
        $('#e-feeling').hidden = false;
        fields.feeling.focus();
        return;
      }
      saving = true;
      const status = btn.dataset.status;
      const t = new Date();
      const shouldBe = should.value.trim();
      await saveRecord({
        id: uuid(), kind: 'checkin', at: t.toISOString(), date: L.localDate(t), hour: t.getHours(),
        feeling, body: fields.body.value.trim(), shouldBe, actually: fields.actually.value.trim(), status,
      });
      const msg = status === 'escaping'
        ? (shouldBe ? `Noted. Back to: ${shouldBe}` : 'Noted. Back to it.')
        : status === 'on' ? 'Saved. Keep going.' : 'Enjoy the break.';
      showDone(`<p class="done-text">${esc(msg)}</p>`, { autoMs: 1500 });
    });
  }
  syncChips();
}

// ---------- Night review ----------

function renderNight(params) {
  const s = state.settings;
  const recs = state.records;
  const { today } = nowInfo();
  let date = params.get('date');
  if (!L.isDate(date) || date > today) date = today;
  const isToday = date === today;
  const existing = L.nightFor(recs, date);
  const prev = L.nightFor(recs, L.addDays(date, -1));
  const prevImprove = prev && prev.improve ? prev.improve.trim() : '';
  const st = L.dayStats(recs, date);
  let result = existing ? existing.yesterdayResult || null : null;

  const counts = `On it ${st.on} · Escaping ${st.escaping} · Skipped ${st.skipped}${st.breaks > 0 ? ` · Breaks ${st.breaks}` : ''}`;
  const results = [['did', 'Did it'], ['partly', 'Partly'], ['not', 'Not yet']];

  app.innerHTML = `
  <main class="screen night">
    <header class="bar">
      <b>${esc(L.dayLabel(date))} · Closing the day</b>
      <a class="link" href="#today">Later</a>
    </header>
    <p class="muted">${esc(L.nightStreakLine(recs, date, s.streakHours))}</p>
    ${prevImprove ? `
    <div class="q">
      <p class="muted">Yesterday I wanted to improve: ${esc(prevImprove)}</p>
      <div class="chips" id="result" role="group" aria-label="How did it go?">
        ${results.map(([v, l]) => `<button type="button" class="c${result === v ? ' on' : ''}" data-v="${v}" aria-pressed="${result === v}">${l}</button>`).join('')}
      </div>
    </div>` : ''}
    <section class="group">
      <p class="lbl">${isToday ? 'Today' : 'That day'}</p>
      <p class="count-line">${esc(counts)}</p>
    </section>
    <section class="group">
      <p class="lbl">When I escaped</p>
      ${st.escaping ? `
        ${tallyHTML('I was avoiding', st.avoided)}
        ${tallyHTML('I felt just before', st.feltBefore)}
        ${tallyHTML('I went to', st.wentTo)}
        ${st.peakWindow ? `<p class="muted">Most escapes were between ${esc(st.peakWindow.replace(' to ', ' and '))}.</p>` : ''}
      ` : `<p class="muted">No escapes logged ${isToday ? 'today' : 'that day'}.</p>`}
    </section>
    <div class="q">
      <label class="lbl" for="n-well">What went well ${isToday ? 'today' : 'that day'}?</label>
      <textarea id="n-well" class="fld" rows="3" maxlength="5000">${esc(existing ? existing.wentWell : '')}</textarea>
    </div>
    <div class="q">
      <label class="lbl" for="n-improve">What should I improve tomorrow?</label>
      <textarea id="n-improve" class="fld" rows="3" maxlength="5000">${esc(existing ? existing.improve : '')}</textarea>
    </div>
    <p class="err" id="e-night" role="alert" hidden>Write at least one line.</p>
    <button type="button" class="btn" id="close-day">Close the day</button>
  </main>`;

  const well = $('#n-well');
  const improve = $('#n-improve');
  const closeBtn = $('#close-day');
  const refresh = () => {
    const has = well.value.trim() || improve.value.trim();
    closeBtn.classList.toggle('dim', !has);
    if (has) $('#e-night').hidden = true;
  };
  well.addEventListener('input', refresh);
  improve.addEventListener('input', refresh);
  refresh();

  $('#result')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.c');
    if (!chip) return;
    result = result === chip.dataset.v ? null : chip.dataset.v;
    for (const c of $$('#result .c')) {
      c.classList.toggle('on', c.dataset.v === result);
      c.setAttribute('aria-pressed', String(c.dataset.v === result));
    }
  });

  closeBtn.addEventListener('click', async () => {
    const wentWell = well.value.trim();
    const imp = improve.value.trim();
    if (!wentWell && !imp) {
      $('#e-night').hidden = false;
      return;
    }
    closeBtn.disabled = true;
    await saveRecord({
      id: `night-${date}`, kind: 'night', date,
      yesterdayResult: prevImprove ? result : null,
      wentWell, improve: imp, closedAt: new Date().toISOString(),
    });
    const n = L.dayQualifies(state.records, date, s.streakHours) ? L.runEndingAt(state.records, date, s.streakHours) : 0;
    const msg = n > 0 ? `Day closed. ${n}-day streak.` : 'Day closed.';
    const { weekStart } = L.weekRange(date, Number(s.weeklyDay));
    const weekOpen = !state.records.some((r) => r.kind === 'week' && r.weekStart === weekStart);
    const weekly = isToday && L.weekdayOf(date) === Number(s.weeklyDay) && weekOpen;
    showDone(`<p class="done-text">${esc(msg)}</p>
      ${weekly ? '<a class="btn" href="#week">Now the week</a>' : ''}
      <a class="link" href="#today">Done</a>`, { autoMs: weekly ? 0 : 2000 });
  });
}

// ---------- Weekly review ----------

function renderWeek() {
  const s = state.settings;
  const recs = state.records;
  const { today, nowMin } = nowInfo();
  const { weekStart, weekEnd } = L.weekRange(today, Number(s.weeklyDay));
  const w = L.weekStats(recs, weekStart);
  const existing = recs.find((r) => r.kind === 'week' && r.weekStart === weekStart);
  const streak = L.streak(recs, today, s.streakHours, nowMin);
  const max = Math.max(1, ...w.perDay.map((d) => d.on + d.escaping));
  const initials = w.perDay.map((d) => L.dayName(L.weekdayOf(d.date))[0]);

  let pctLine = 'No check-ins this week yet.';
  if (w.onPct != null) {
    const pct = `<span class="good">${w.onPct}%</span>`;
    let cmp = '.';
    if (w.prevOnPct != null) {
      cmp = w.onPct > w.prevOnPct ? `, up from ${w.prevOnPct}% last week.`
        : w.onPct < w.prevOnPct ? `, down from ${w.prevOnPct}% last week.` : ', same as last week.';
    }
    pctLine = `On it ${pct} of check-ins${cmp}`;
  }
  const hasEsc = w.avoided.length || w.feltBefore.length || w.wentTo.length;

  app.innerHTML = `
  <main class="screen week">
    <header class="bar">
      <b>Week of ${esc(L.weekLabel(weekStart, weekEnd))}</b>
      ${streakPill(streak)}
    </header>
    <p class="count-line">${pctLine}</p>
    <div class="chart" role="img" aria-label="On it and escaping check-ins per day">
      <div class="bars">
        ${w.perDay.map((d) => `<div title="${esc(L.dayLabel(d.date))}: on it ${d.on}, escaping ${d.escaping}">
          <span class="b" style="height:${(d.escaping / max) * 100}%"></span><span class="a" style="height:${(d.on / max) * 100}%"></span>
        </div>`).join('')}
      </div>
      <div class="days">${initials.map((i) => `<span>${i}</span>`).join('')}</div>
    </div>
    <div class="legend" aria-hidden="true"><span><span class="d on2"></span> on it</span><span><span class="d esc"></span> escaping</span></div>
    <section class="group">
      ${hasEsc ? `
        ${tallyHTML('What I avoided most', w.avoided)}
        ${tallyHTML('Feelings right before escaping', w.feltBefore)}
        ${tallyHTML('Where I escaped to', w.wentTo)}
      ` : '<p class="muted">No escapes logged this week.</p>'}
      ${w.pattern ? `<p class="muted">${esc(w.pattern)}</p>` : ''}
    </section>
    <div class="q">
      <label class="lbl" for="w-pattern">What pattern do I see?</label>
      <textarea id="w-pattern" class="fld" rows="3" maxlength="5000">${esc(existing ? existing.pattern : '')}</textarea>
    </div>
    <div class="q">
      <label class="lbl" for="w-change">One change for next week</label>
      <textarea id="w-change" class="fld" rows="3" maxlength="5000">${esc(existing ? existing.change : '')}</textarea>
    </div>
    <p class="err" id="e-week" role="alert" hidden>Write at least one line.</p>
    <button type="button" class="btn" id="close-week">Close the week</button>
    <nav class="foot"><a href="#today">Today</a></nav>
  </main>`;

  const pattern = $('#w-pattern');
  const change = $('#w-change');
  const btn = $('#close-week');
  const refresh = () => {
    const has = pattern.value.trim() || change.value.trim();
    btn.classList.toggle('dim', !has);
    if (has) $('#e-week').hidden = true;
  };
  pattern.addEventListener('input', refresh);
  change.addEventListener('input', refresh);
  refresh();

  btn.addEventListener('click', async () => {
    const p = pattern.value.trim();
    const c = change.value.trim();
    if (!p && !c) {
      $('#e-week').hidden = false;
      return;
    }
    btn.disabled = true;
    await saveRecord({ id: `week-${weekStart}`, kind: 'week', weekStart, weekEnd, pattern: p, change: c, closedAt: new Date().toISOString() });
    showDone('<p class="done-text">Week closed.</p><a class="link" href="#today">Done</a>', { autoMs: 2000 });
  });
}

// ---------- Settings ----------

const DAYS = [0, 1, 2, 3, 4, 5, 6];

function prefetchExport() {
  state.exportFile = null;
  fetch('/api/export', { cache: 'no-store' })
    .then((res) => (res.ok ? res.blob() : null))
    .then((blob) => {
      if (blob) state.exportFile = new File([blob], `checkins-${L.localDate()}.json`, { type: 'application/json' });
    })
    .catch(() => {});
}

function onExport() {
  const file = state.exportFile;
  const openUrl = () => { window.location.href = '/api/export'; };
  // share() needs the tap's user activation, so the file is fetched ahead of time.
  if (file && navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file] }).catch((err) => {
      if (err && err.name === 'AbortError') return;
      openUrl();
    });
    return;
  }
  openUrl();
}

function renderSettings() {
  const firstRun = !lsGet('onboarded');
  const s = state.settings;
  const custom = !PRESETS.includes(Number(s.intervalMin));
  const { today } = nowInfo();
  const paused = s.pausedDate === today;

  app.innerHTML = `
  <main class="screen settings">
    <header class="bar">
      <h1>${firstRun ? 'Check-in' : 'Settings'}</h1>
      ${firstRun ? '' : '<a class="link" href="#today">Done</a>'}
    </header>
    ${firstRun ? '<p class="lead">Choose when to be reminded. You can change this anytime.</p>' : ''}
    <section class="card" id="reminders" aria-live="polite"></section>
    <div class="q">
      <p class="lbl" id="l-int">Remind me every</p>
      <div class="chips" id="intervals" role="group" aria-labelledby="l-int">
        ${PRESETS.map((m) => `<button type="button" class="c${!custom && Number(s.intervalMin) === m ? ' on' : ''}" data-int="${m}">${L.intervalLabel(m)}</button>`).join('')}
        <button type="button" class="c${custom ? ' on' : ''}" data-int="custom">Custom</button>
      </div>
      <div class="custom" id="custom-wrap" ${custom ? '' : 'hidden'}>
        <input id="s-custom" class="fld num" type="number" inputmode="numeric" min="15" max="480" step="1" value="${esc(s.intervalMin)}" aria-label="Minutes between reminders">
        <span class="muted">minutes</span>
      </div>
      <p class="err" id="e-int" role="alert" hidden>Choose 15 to 480 minutes.</p>
      <p class="hint warn" id="pace"></p>
    </div>
    <div class="rows">
      <div class="row">
        <span id="l-active">Active hours</span>
        <span class="pair" role="group" aria-labelledby="l-active">
          <input type="time" id="s-start" value="${esc(s.activeStart)}" aria-label="Start">
          <span class="muted">to</span>
          <input type="time" id="s-end" value="${esc(s.activeEnd)}" aria-label="End">
        </span>
      </div>
      <p class="err" id="e-active" role="alert" hidden>Active hours must end after they start.</p>
      <div class="row"><label for="s-review">Night review at</label><input type="time" id="s-review" value="${esc(s.reviewTime)}"></div>
      <div class="row"><label for="s-day">Weekly review</label>
        <select id="s-day">${DAYS.map((d) => `<option value="${d}"${Number(s.weeklyDay) === d ? ' selected' : ''}>${L.dayName(d)}</option>`).join('')}</select>
      </div>
      <div class="row"><span>Streak needs</span><span class="muted">${s.streakHours} hours + night review</span></div>
      <div class="row"><label for="s-pause">Pause until tomorrow</label><input type="checkbox" role="switch" class="switch" id="s-pause"${paused ? ' checked' : ''}></div>
      <button type="button" class="row rowbtn" id="export"><span>Export my data</span><span class="muted" aria-hidden="true">↓</span></button>
    </div>
    <p class="err" id="e-save" role="alert" hidden></p>
    <p class="muted" id="backup">${esc(backupText())}</p>
    <p class="muted">Everything stays on your phone and your Mac mini.</p>
    ${firstRun ? '<button type="button" class="btn" id="start">Start</button>' : ''}
  </main>`;

  updateRemindersCard();
  prefetchPush();
  if (!firstRun) prefetchExport();

  const pace = $('#pace');
  const updatePace = () => {
    const w = L.paceWarning(state.settings);
    pace.textContent = w || '';
    pace.hidden = !w;
  };
  updatePace();

  const customWrap = $('#custom-wrap');
  const customInput = $('#s-custom');
  const markInterval = (val) => {
    for (const c of $$('#intervals .c')) c.classList.toggle('on', c.dataset.int === String(val));
  };
  $('#intervals').addEventListener('click', (e) => {
    const chip = e.target.closest('.c');
    if (!chip) return;
    $('#e-int').hidden = true;
    if (chip.dataset.int === 'custom') {
      markInterval('custom');
      customWrap.hidden = false;
      customInput.focus();
      return;
    }
    customWrap.hidden = true;
    markInterval(chip.dataset.int);
    customInput.value = chip.dataset.int;
    updateSetting({ intervalMin: Number(chip.dataset.int) });
    updatePace();
  });
  customInput.addEventListener('change', () => {
    const v = Number(customInput.value);
    if (!Number.isInteger(v) || v < 15 || v > 480) {
      $('#e-int').hidden = false;
      return;
    }
    $('#e-int').hidden = true;
    updateSetting({ intervalMin: v });
    updatePace();
  });

  const start = $('#s-start');
  const end = $('#s-end');
  const onActive = () => {
    const next = { activeStart: start.value, activeEnd: end.value };
    if (!start.value || !end.value || !L.activeRangeValid(next)) {
      $('#e-active').hidden = false;
      return;
    }
    $('#e-active').hidden = true;
    updateSetting(next);
    updatePace();
  };
  start.addEventListener('change', onActive);
  end.addEventListener('change', onActive);

  $('#s-review').addEventListener('change', (e) => { if (e.target.value) updateSetting({ reviewTime: e.target.value }); });
  $('#s-day').addEventListener('change', (e) => updateSetting({ weeklyDay: Number(e.target.value) }));
  $('#s-pause').addEventListener('change', (e) => updateSetting({ pausedDate: e.target.checked ? L.localDate() : null }));
  $('#export').addEventListener('click', onExport);

  $('#start')?.addEventListener('click', () => {
    if (!$('#e-active').hidden || !$('#e-int').hidden) return;
    lsSet('onboarded', true);
    state.settings.timeZone = tz() || state.settings.timeZone;
    cacheSettings();
    const { intervalMin, activeStart, activeEnd, reviewTime, weeklyDay, timeZone, pausedDate } = state.settings;
    pushSettings({ intervalMin, activeStart, activeEnd, reviewTime, weeklyDay, timeZone, pausedDate });
    go('today');
  });
}

// ---------- Install gate ----------

function renderInstall() {
  app.innerHTML = `
  <main class="screen install">
    <img class="appicon" src="icons/apple-touch-icon.png" alt="" width="72" height="72">
    <h1>Add Check-in to your Home Screen</h1>
    <ol class="steps">
      <li>Tap Share <svg class="share" viewBox="0 0 20 24" aria-hidden="true"><path d="M10 15V2M5.5 6.5 10 2l4.5 4.5M6 10H3.5v12h13V10H14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg> in Safari.</li>
      <li>Tap Add to Home Screen.</li>
      <li>Keep Open as Web App on.</li>
      <li>Tap Add.</li>
      <li>Open Check-in from your Home Screen.</li>
    </ol>
    <p class="muted">Reminders only work from the Home Screen app.</p>
    <button type="button" class="link small" id="browser">Continue in the browser</button>
  </main>`;
  $('#browser').addEventListener('click', () => {
    lsSet('browserOk', true);
    render();
  });
}

// ---------- boot ----------

async function boot() {
  takeGoFromQuery();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => {
      const target = e.data && e.data.go;
      if (typeof target === 'string') go(target);
    });
  }

  if (!lsGet('persistAsked')) {
    lsSet('persistAsked', true);
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist().catch(() => {}); } catch { /* ignore */ }
  }

  // Merge any entries that only made it to the localStorage fallback, and give records the
  // server refused one more try per launch (the server may have been fixed since).
  state.records = L.mergeRecords(await getAllRecords(), lsGet(PENDING_KEY) || [])
    .map((r) => (r.syncError ? { ...strip(r), synced: false } : r));
  state.lastSyncAt = (await getMeta('lastSyncAt')) || null;
  flushPending();
  render();

  window.addEventListener('hashchange', render);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    sync();
    refreshSettings();
    healSubscription();
    if (currentRoute().name === 'today') render();
  });

  sync();
  refreshSettings();
  healSubscription();
  prefetchPush();
}

boot();
