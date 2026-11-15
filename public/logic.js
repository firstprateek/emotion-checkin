// Pure functions shared by the app and the tests. No DOM, no storage, no network.
// Dates are local "YYYY-MM-DD" strings; hours are local 0-23.

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n) => String(n).padStart(2, '0');

// ---------- dates and times ----------

export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function splitDate(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  return { y, m, d };
}

function utcDate(date, plusDays = 0) {
  const { y, m, d } = splitDate(date);
  return new Date(Date.UTC(y, m - 1, d + plusDays));
}

export function addDays(date, n) {
  const t = utcDate(date, n);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** True for a real calendar date "YYYY-MM-DD" (rejects 2026-02-30). */
export function isDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s;
}

export function weekdayOf(date) {
  return utcDate(date).getUTCDay();
}

export function dayName(weekday) {
  return DAY_NAMES[weekday];
}

// "Sunday, Nov 8"
export function dayLabel(date) {
  const { m, d } = splitDate(date);
  return `${DAY_NAMES[weekdayOf(date)]}, ${MONTHS[m - 1]} ${d}`;
}

// "Nov 2 to 8" or "Oct 30 to Nov 5"
export function weekLabel(weekStart, weekEnd) {
  const a = splitDate(weekStart);
  const b = splitDate(weekEnd);
  if (a.m === b.m) return `${MONTHS[a.m - 1]} ${a.d} to ${b.d}`;
  return `${MONTHS[a.m - 1]} ${a.d} to ${MONTHS[b.m - 1]} ${b.d}`;
}

export function minutesOf(d = new Date()) {
  return d.getHours() * 60 + d.getMinutes();
}

// "09:30" -> 570
export function parseHM(hm) {
  const [h, m] = String(hm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function hour12(h) {
  const hh = ((h % 24) + 24) % 24;
  return { n: hh % 12 === 0 ? 12 : hh % 12, ap: hh < 12 ? 'AM' : 'PM' };
}

// 570 -> "9:30 AM"
export function formatHM(minutes) {
  const { n, ap } = hour12(Math.floor(minutes / 60));
  return `${n}:${pad(minutes % 60)} ${ap}`;
}

// 540 -> "9 AM", 570 -> "9:30 AM"
export function shortTime(minutes) {
  const { n, ap } = hour12(Math.floor(minutes / 60));
  return minutes % 60 ? `${n}:${pad(minutes % 60)} ${ap}` : `${n} ${ap}`;
}

// ISO -> "2:15 PM" in device local time
export function formatTime(iso) {
  const d = new Date(iso);
  return formatHM(d.getHours() * 60 + d.getMinutes());
}

// 13 -> "1 to 4 PM", 11 -> "11 AM to 2 PM"
export function windowLabel(startHour) {
  if (startHour == null) return null;
  const a = hour12(startHour);
  const b = hour12(startHour + 3);
  return a.ap === b.ap ? `${a.n} to ${b.n} ${b.ap}` : `${a.n} ${a.ap} to ${b.n} ${b.ap}`;
}

export function relativeTime(thenMs, nowMs = Date.now()) {
  const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} ${m === 1 ? 'minute' : 'minutes'} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  if (h < 48) return 'yesterday';
  return `${Math.floor(h / 24)} days ago`;
}

// ---------- text ----------

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

export function tokens(text) {
  const out = [];
  const seen = new Set();
  for (const part of String(text ?? '').split(/[,;]/)) {
    const t = clean(part).toLowerCase();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

const whole = (v) => {
  const t = clean(v);
  return t ? [t] : [];
};

const timeOf = (r) => Date.parse(r.at || r.updatedAt || '') || 0;

// Count values case-insensitively. Label uses the most recent casing.
// Sorted by count, then by most recent use.
function tally(records, valuesOf) {
  const map = new Map();
  for (const r of records) {
    const t = timeOf(r);
    for (const v of valuesOf(r)) {
      const key = v.toLowerCase();
      const e = map.get(key);
      if (!e) map.set(key, { label: v, count: 1, last: t });
      else {
        e.count += 1;
        if (t >= e.last) {
          e.last = t;
          e.label = v;
        }
      }
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || b.last - a.last);
}

const top3 = (list) => list.slice(0, 3).map(({ label, count }) => ({ label, count }));

const fieldValues = (field) =>
  field === 'feeling' || field === 'body' ? (r) => tokens(r[field]) : (r) => whole(r[field]);

export function chipsFor(records, field, limit = 8) {
  const cs = records.filter((r) => r.kind === 'checkin');
  return tally(cs, fieldValues(field)).slice(0, limit).map((e) => e.label);
}

// ---------- days and streaks ----------

const checkinsOn = (records, date) => records.filter((r) => r.kind === 'checkin' && r.date === date);

export function hasNight(records, date) {
  return records.some((r) => r.kind === 'night' && r.date === date);
}

export function nightFor(records, date) {
  return records.find((r) => r.kind === 'night' && r.date === date) || null;
}

export function latestCheckin(records) {
  let best = null;
  for (const r of records) if (r.kind === 'checkin' && (!best || timeOf(r) >= timeOf(best))) best = r;
  return best;
}

export function hoursLogged(records, date) {
  const set = new Set(checkinsOn(records, date).map((r) => Number(r.hour)));
  return [...set].sort((a, b) => a - b);
}

export function dayQualifies(records, date, streakHours) {
  return hoursLogged(records, date).length >= streakHours && hasNight(records, date);
}

function indexDays(records) {
  const hours = new Map();
  const nights = new Set();
  for (const r of records) {
    if (r.kind === 'checkin' && r.date) {
      if (!hours.has(r.date)) hours.set(r.date, new Set());
      hours.get(r.date).add(Number(r.hour));
    } else if (r.kind === 'night' && r.date) nights.add(r.date);
  }
  const hoursOn = (d) => (hours.get(d) ? hours.get(d).size : 0);
  return { hoursOn, nights, qualifies: (d, k) => hoursOn(d) >= k && nights.has(d) };
}

function run(idx, date, streakHours) {
  let n = 0;
  let d = date;
  while (idx.qualifies(d, streakHours)) {
    n += 1;
    d = addDays(d, -1);
  }
  return n;
}

// Consecutive qualifying days ending on `date` (0 if `date` doesn't qualify).
export function runEndingAt(records, date, streakHours) {
  return run(indexDays(records), date, streakHours);
}

export function streak(records, today, streakHours, nowMinutes) {
  const idx = indexDays(records);
  const yesterday = addDays(today, -1);
  if (idx.qualifies(today, streakHours)) return run(idx, today, streakHours);
  if (idx.qualifies(yesterday, streakHours)) return run(idx, yesterday, streakHours);
  // Before noon, yesterday can still be closed: don't break the streak yet.
  if (nowMinutes < 720 && idx.hoursOn(yesterday) >= streakHours && !idx.nights.has(yesterday)) {
    return run(idx, addDays(today, -2), streakHours);
  }
  return 0;
}

// ---------- stats ----------

export function peakWindowStart(hours) {
  if (!hours.length) return null;
  const counts = new Array(27).fill(0);
  for (const h of hours) counts[Number(h)] += 1;
  let best = null;
  let bestN = 0;
  for (let s = 0; s < 24; s++) {
    if (!counts[s]) continue;
    const n = counts[s] + counts[s + 1] + counts[s + 2];
    if (n > bestN) {
      bestN = n;
      best = s;
    }
  }
  return best;
}

function escapeTallies(esc) {
  return {
    avoided: top3(tally(esc, (r) => whole(r.shouldBe))),
    feltBefore: top3(tally(esc, (r) => tokens(r.feeling))),
    wentTo: top3(tally(esc, (r) => whole(r.actually))),
  };
}

const peakOf = (esc) => (esc.length >= 2 ? windowLabel(peakWindowStart(esc.map((r) => r.hour))) : null);

export function dayStats(records, date) {
  const cs = checkinsOn(records, date);
  const esc = cs.filter((r) => r.status === 'escaping');
  return {
    on: cs.filter((r) => r.status === 'on').length,
    escaping: esc.length,
    breaks: cs.filter((r) => r.status === 'break').length,
    skipped: records.filter((r) => r.kind === 'skip' && r.date === date).length,
    ...escapeTallies(esc),
    peakWindow: peakOf(esc),
  };
}

export function weekRange(today, weeklyDay) {
  const weekEnd = addDays(today, (weeklyDay - weekdayOf(today) + 7) % 7);
  return { weekStart: addDays(weekEnd, -6), weekEnd };
}

function onPctFor(records, weekStart) {
  let on = 0;
  let escaping = 0;
  for (let i = 0; i < 7; i++) {
    for (const r of checkinsOn(records, addDays(weekStart, i))) {
      if (r.status === 'on') on += 1;
      else if (r.status === 'escaping') escaping += 1;
    }
  }
  return on + escaping ? Math.round((on / (on + escaping)) * 100) : null;
}

function patternSentence(esc) {
  if (esc.length < 2) return null;
  const pairs = new Map();
  for (const r of esc) {
    const a = clean(r.shouldBe);
    const w = clean(r.actually);
    if (!a || !w) continue;
    const key = `${a.toLowerCase()}\u0000${w.toLowerCase()}`;
    if (!pairs.has(key)) pairs.set(key, []);
    pairs.get(key).push(r);
  }
  if (!pairs.size) return null;
  const last = (list) => Math.max(...list.map(timeOf));
  const group = [...pairs.values()].sort((x, y) => y.length - x.length || last(y) - last(x))[0];
  const newest = group.reduce((b, r) => (timeOf(r) >= timeOf(b) ? r : b));
  const avoided = clean(newest.shouldBe);
  const wentTo = clean(newest.actually);
  const feeling = tally(group, (r) => tokens(r.feeling))[0]?.label;
  const win = peakOf(group);
  const n = group.length;
  const lead = feeling ? `${feeling} on ${avoided}` : `avoiding ${avoided}`;
  return `Pattern: ${lead}, then ${wentTo}${win ? `, ${win}` : ''}. It happened ${n === 1 ? 'once' : `${n} times`}.`;
}

export function weekStats(records, weekStart) {
  const perDay = [];
  const esc = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const cs = checkinsOn(records, date);
    const e = cs.filter((r) => r.status === 'escaping');
    esc.push(...e);
    perDay.push({ date, on: cs.filter((r) => r.status === 'on').length, escaping: e.length });
  }
  return {
    onPct: onPctFor(records, weekStart),
    prevOnPct: onPctFor(records, addDays(weekStart, -7)),
    perDay,
    ...escapeTallies(esc),
    pattern: patternSentence(esc),
  };
}

// ---------- settings helpers ----------

export function intervalLabel(min) {
  return min % 60 === 0 ? `${min / 60} hr` : `${min} min`;
}

// Hours shown as cells on Today: every hour the active window touches.
export function activeHours(settings) {
  const start = parseHM(settings.activeStart);
  const end = parseHM(settings.activeEnd);
  const out = [];
  for (let h = Math.floor(start / 60); h * 60 < end; h++) out.push(h);
  return out;
}

export function remindersPerDay(settings) {
  const span = parseHM(settings.activeEnd) - parseHM(settings.activeStart);
  return span > 0 ? Math.ceil(span / settings.intervalMin) : 0;
}

export function paceWarning(settings) {
  const n = remindersPerDay(settings);
  if (n >= settings.streakHours) return null;
  return `At this pace you'd get ${n} ${n === 1 ? 'reminder' : 'reminders'} a day. The streak needs ${settings.streakHours} hours, so add check-ins yourself.`;
}

export function activeRangeValid(settings) {
  return parseHM(settings.activeEnd) > parseHM(settings.activeStart);
}

// ---------- screen copy ----------

export function todayLine(hoursCount, streakHours, nightClosed) {
  const k = streakHours - hoursCount;
  if (k > 0) {
    return k === 1
      ? 'One more hour, then the night review, keeps the streak.'
      : `${k} more hours, then the night review, keeps the streak.`;
  }
  return nightClosed ? 'Today counts.' : 'Close the night review to keep the streak.';
}

export function nightStreakLine(records, date, streakHours) {
  const n = hoursLogged(records, date).length;
  if (n >= streakHours) {
    const next = runEndingAt(records, addDays(date, -1), streakHours) + 1;
    return `${n} of ${streakHours} hours logged. Close the day to make it ${next}.`;
  }
  return `${n} of ${streakHours} hours logged. The streak needs ${streakHours}.`;
}

export function todayBanners({ records, settings, today, nowMinutes }) {
  const out = [];
  if (settings.pausedDate === today) out.push({ text: 'Paused today.' });
  const yesterday = addDays(today, -1);
  if (nowMinutes < 720 && !hasNight(records, yesterday) && checkinsOn(records, yesterday).length) {
    out.push({ text: 'Close yesterday?', href: `#night?date=${yesterday}` });
  }
  const nightClosed = hasNight(records, today);
  if (nowMinutes >= parseHM(settings.reviewTime) && !nightClosed) {
    out.push({ text: 'Ready to close the day? About 2 minutes.', href: '#night' });
  }
  if (weekdayOf(today) === Number(settings.weeklyDay) && nightClosed) {
    const { weekStart } = weekRange(today, Number(settings.weeklyDay));
    if (!records.some((r) => r.kind === 'week' && r.weekStart === weekStart)) {
      out.push({ text: 'Close the week. About 5 minutes.', href: '#week' });
    }
  }
  return out;
}

// ---------- sync helpers ----------

/** Statuses where the server refused the content itself; retrying the same batch won't help. */
const REJECTED = new Set([400, 413]);

/** Records that still need to go to the server: not synced, and not already refused. */
export function pendingPush(records) {
  return records.filter((r) => r && !r.synced && !r.syncError);
}

/**
 * Send records with post(batch), which resolves on success or throws an error with .status.
 * A 400 or 413 on the batch falls back to one record at a time, so one bad or oversized record
 * doesn't block the rest. Never throws: returns { synced, rejected: [{ record, error }], error }
 * where error is the first network or server failure (the rest stay unsent for the next sync).
 */
export async function pushRecords(records, post) {
  const out = { synced: [], rejected: [], error: null };
  if (!records.length) return out;
  try {
    await post(records);
    out.synced.push(...records);
    return out;
  } catch (err) {
    if (!REJECTED.has(err && err.status)) { out.error = err; return out; }
  }
  for (const r of records) {
    try {
      await post([r]);
      out.synced.push(r);
    } catch (e) {
      if (!REJECTED.has(e && e.status)) { out.error = e; return out; }
      out.rejected.push({ record: r, error: (e && e.message) || 'Rejected.' });
    }
  }
  return out;
}

/** Merge record lists by id, last write wins by updatedAt. */
export function mergeRecords(base, extra) {
  const byId = new Map();
  for (const r of [...base, ...extra]) {
    if (!r || typeof r.id !== 'string') continue;
    const cur = byId.get(r.id);
    if (!cur || (Date.parse(r.updatedAt) || 0) > (Date.parse(cur.updatedAt) || 0)) byId.set(r.id, r);
  }
  return [...byId.values()];
}

/** The Settings backup line. */
export function backupLine(records, lastSyncAt, nowMs = Date.now()) {
  const waiting = records.filter((r) => r && !r.synced && !r.syncError).length;
  const refused = records.filter((r) => r && !r.synced && r.syncError).length;
  const parts = [];
  if (waiting) parts.push(`${waiting} ${waiting === 1 ? 'entry' : 'entries'} waiting to back up. Open Tailscale to sync.`);
  if (refused) parts.push(`${refused} ${refused === 1 ? "entry couldn't" : "entries couldn't"} be backed up. ${refused === 1 ? 'It stays' : 'They stay'} on your phone.`);
  if (parts.length) return parts.join(' ');
  if (lastSyncAt) return `Backed up to the Mac mini ${relativeTime(lastSyncAt, nowMs)}.`;
  return 'Not backed up yet.';
}
