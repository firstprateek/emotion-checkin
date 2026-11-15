// Pure scheduling functions. No I/O, no timers, no globals beyond a formatter cache.
// Everything here takes "now" and data as arguments so it can be unit-tested.

export const CHECKIN_ROTATION = [
  'What am I feeling right now?',
  "Pause. What's here?",
  'Before the next tab: check in.',
  "Ten seconds. What's going on?",
  'Feeling, should, actually.',
];
export const NUDGE_BODY = 'One tap counts. Just the feeling is fine.';
export const MAX_CATCHUP_MINUTES = 10;
export const SENT_LOG_KEEP_MS = 2 * 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;
// An entry stamped further than this into the future (clock skew) is ignored for "recent entry".
const FUTURE_TOLERANCE_MS = 5 * MINUTE_MS;

// ---------- Time helpers ----------

const formatters = new Map();
function formatterFor(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function wallClock(ms, timeZone) {
  const out = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  if (out.hour === 24) out.hour = 0; // some engines report midnight as 24 even with h23
  return out;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** Local `{ date: "YYYY-MM-DD", minutes: 0-1439, weekday: 0-6 }` for an instant in a time zone. */
export function localParts(ms, timeZone) {
  const w = wallClock(ms, timeZone);
  const date = `${w.year}-${pad2(w.month)}-${pad2(w.day)}`;
  return { date, minutes: w.hour * 60 + w.minute, weekday: weekdayOf(date) };
}

/** JS weekday (0 = Sunday) of a YYYY-MM-DD date. */
export function weekdayOf(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** "HH:MM" -> minutes after midnight, or NaN when malformed. */
export function parseHM(s) {
  const m = typeof s === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

function offsetMs(ms, timeZone) {
  const w = wallClock(ms, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The UTC instant (ms) of a local wall-clock minute, or null when that minute doesn't exist
 * (the hour skipped when clocks spring forward). For the repeated hour in the fall it returns
 * one of the two instants.
 */
export function zonedTimeToUtc(date, minutes, timeZone) {
  const [y, mo, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);
  const first = guess - offsetMs(guess, timeZone);
  const candidates = [first, guess - offsetMs(first, timeZone)];
  for (const t of candidates) {
    const p = localParts(t, timeZone);
    if (p.date === date && p.minutes === minutes) return t;
  }
  return null;
}

// ---------- Reminder rules ----------

/**
 * Which reminders are due at a local minute.
 * ctx = { nightClosedToday: bool, minutesSinceLastEntry: number | null }
 */
export function dueReminders({ date, minutes, weekday }, settings, ctx = {}) {
  void weekday;
  if (settings.pausedDate && settings.pausedDate === date) return [];
  const out = [];

  const startMin = parseHM(settings.activeStart);
  const endMin = parseHM(settings.activeEnd);
  const interval = settings.intervalMin;
  if (
    Number.isInteger(interval) && interval > 0 &&
    minutes >= startMin && minutes < endMin &&
    (minutes - startMin) % interval === 0
  ) {
    const since = ctx.minutesSinceLastEntry;
    const recent = since !== null && since !== undefined && since <= Math.floor(interval / 2);
    if (!recent) out.push({ kind: 'checkin' });
  }

  const reviewMin = parseHM(settings.reviewTime);
  if (!ctx.nightClosedToday && Number.isFinite(reviewMin)) {
    // The 30-minute repeat never crosses midnight: a review time after 23:29 gets no repeat.
    if (minutes === reviewMin) out.push({ kind: 'night' });
    else if (minutes === reviewMin + 30) out.push({ kind: 'night', repeat: true });
  }
  return out;
}

// ---------- Context from records ----------

const isEntry = (r) => r && (r.kind === 'checkin' || r.kind === 'skip');

/** Latest `at` (ms) among checkin/skip records, ignoring ones stamped well into the future. */
export function latestEntryMs(records, nowMs) {
  let latest = null;
  for (const r of records) {
    if (!isEntry(r)) continue;
    const t = Date.parse(r.at);
    if (!Number.isFinite(t) || t > nowMs + FUTURE_TOLERANCE_MS) continue;
    if (latest === null || t > latest) latest = t;
  }
  return latest;
}

/** Everything the rules and copy need to know about the records, for one local date. */
export function buildContext(records, nowMs, date) {
  const latest = latestEntryMs(records, nowMs);
  let latestCheckinToday = null;
  const hours = new Set();
  let nightClosedToday = false;
  for (const r of records) {
    if (!r) continue;
    if (r.kind === 'night' && r.date === date) nightClosedToday = true;
    if (r.kind === 'checkin' && r.date === date) {
      if (Number.isInteger(r.hour)) hours.add(r.hour);
      if (!latestCheckinToday || Date.parse(r.at) > Date.parse(latestCheckinToday.at)) latestCheckinToday = r;
    }
  }
  return {
    nightClosedToday,
    minutesSinceLastEntry: latest === null ? null : Math.max(0, (nowMs - latest) / MINUTE_MS),
    latestEntryAt: latest,
    latestCheckinToday,
    hoursLoggedToday: hours.size,
  };
}

/** Check-in reminders actually delivered after the latest checkin/skip (all of them if none). */
export function countUnanswered(sentLog, latestEntryAt) {
  let n = 0;
  for (const s of sentLog) {
    if (s.kind !== 'checkin' || s.skipped || !(s.delivered > 0)) continue;
    if (latestEntryAt === null || latestEntryAt === undefined || s.at > latestEntryAt) n++;
  }
  return n;
}

// ---------- Copy ----------

function cleanShouldBe(text) {
  let s = String(text).trim().replace(/\s+/g, ' ').replace(/[.!?…\s]+$/u, '');
  if (s.length > 100) s = s.slice(0, 99).trimEnd() + '…';
  return s;
}

/** { title, body, url, tag } for a check-in reminder. */
export function checkinCopy({ latestCheckinToday = null, sendCount = 0, unanswered = 0 } = {}) {
  let body;
  const shouldBe = latestCheckinToday && typeof latestCheckinToday.shouldBe === 'string'
    ? cleanShouldBe(latestCheckinToday.shouldBe) : '';
  if (unanswered >= 3) body = NUDGE_BODY;
  else if (shouldBe) body = `Should be: ${shouldBe}. Are you on it?`;
  else body = CHECKIN_ROTATION[((sendCount % CHECKIN_ROTATION.length) + CHECKIN_ROTATION.length) % CHECKIN_ROTATION.length];
  return { title: 'Check in', body, url: '/?go=checkin', tag: 'checkin' };
}

/** { title, body, url, tag } for the night review reminder. */
export function nightCopy({ weekday, weeklyDay, hoursLogged = 0, streakHours = 5 } = {}) {
  let body = hoursLogged < streakHours
    ? `Logged ${hoursLogged} of ${streakHours} hours today. 2 minutes to close it.`
    : "Day's done. 2 minutes to close it.";
  if (weekday === weeklyDay) body += ' Then the week.';
  return { title: 'Close the day', body, url: '/?go=night', tag: 'night' };
}

/** web-push options per reminder kind. */
export function pushOptions(kind) {
  if (kind === 'checkin') return { TTL: 600, topic: 'checkin', urgency: 'high' };
  if (kind === 'night') return { TTL: 3600, topic: 'night' };
  return { TTL: 600, topic: 'test' };
}

export const sentKey = (kind, date, minute) => `${kind}|${date}|${minute}`;

export function pruneSentLog(sentLog, nowMs) {
  return sentLog.filter((s) => Number.isFinite(s.at) && s.at >= nowMs - SENT_LOG_KEEP_MS);
}

// ---------- One scheduler tick ----------

/**
 * Plan what one scheduler tick should send.
 * state = { sent: [{ kind, date, minute, at, delivered, skipped? }], checkinSendCount }
 * Returns { processedMinute, sends: [{ kind, key, date, minute, payload, options }], skipped: [...] }.
 * Processes missed minutes (at most MAX_CATCHUP_MINUTES back) but sends at most one check-in.
 */
export function planTick({ nowMs, lastProcessedMinute = null, settings, records = [], state = {} }) {
  const currentMinute = Math.floor(nowMs / MINUTE_MS);
  const result = { processedMinute: currentMinute, sends: [], skipped: [] };
  if (lastProcessedMinute === currentMinute) return result;

  let first = currentMinute;
  if (lastProcessedMinute !== null && lastProcessedMinute < currentMinute) {
    first = Math.max(lastProcessedMinute + 1, currentMinute - MAX_CATCHUP_MINUTES);
  }

  const sentLog = state.sent || [];
  const already = new Set(sentLog.map((s) => sentKey(s.kind, s.date, s.minute)));
  const dueCheckins = [];
  const dueNights = [];
  for (let m = first; m <= currentMinute; m++) {
    const ms = m * MINUTE_MS;
    const local = localParts(ms, settings.timeZone);
    const ctx = buildContext(records, ms, local.date);
    for (const r of dueReminders(local, settings, ctx)) {
      const key = sentKey(r.kind, local.date, local.minutes);
      if (already.has(key)) continue;
      already.add(key);
      const item = { kind: r.kind, key, date: local.date, minute: local.minutes, weekday: local.weekday, ms, ctx };
      if (r.repeat) item.repeat = true;
      (r.kind === 'checkin' ? dueCheckins : dueNights).push(item);
    }
  }

  const strip = ({ kind, key, date, minute }) => ({ kind, key, date, minute });

  // A late tick judges "recent entry" per slot minute, but the reminder goes out now. Drop a due
  // check-in if an entry was logged at or after its slot, or within the last floor(interval / 2)
  // minutes as of now, so a catch-up never nags right after the user checked in.
  const nowLatest = latestEntryMs(records, nowMs);
  if (nowLatest !== null && dueCheckins.length) {
    const half = Number.isInteger(settings.intervalMin) ? Math.floor(settings.intervalMin / 2) : 0;
    const recentNow = Math.max(0, (nowMs - nowLatest) / MINUTE_MS) <= half;
    for (let i = dueCheckins.length - 1; i >= 0; i--) {
      if (recentNow || nowLatest >= dueCheckins[i].ms) dueCheckins.splice(i, 1);
    }
  }

  if (dueCheckins.length) {
    const chosen = dueCheckins[dueCheckins.length - 1];
    for (const c of dueCheckins.slice(0, -1)) result.skipped.push(strip(c));
    const payload = checkinCopy({
      latestCheckinToday: chosen.ctx.latestCheckinToday,
      sendCount: state.checkinSendCount || 0,
      unanswered: countUnanswered(sentLog, chosen.ctx.latestEntryAt),
    });
    result.sends.push({ ...strip(chosen), payload, options: pushOptions('checkin') });
  }

  // Night reminders for the same date collapse to the latest one.
  const byDate = new Map();
  for (const n of dueNights) byDate.set(n.date, n);
  for (const n of dueNights) if (byDate.get(n.date) !== n) result.skipped.push(strip(n));
  for (const n of byDate.values()) {
    const payload = nightCopy({
      weekday: n.weekday,
      weeklyDay: settings.weeklyDay,
      hoursLogged: n.ctx.hoursLoggedToday,
      streakHours: settings.streakHours,
    });
    const send = { ...strip(n), payload, options: pushOptions('night') };
    if (n.repeat) send.repeat = true;
    result.sends.push(send);
  }
  return result;
}

// ---------- Status ----------

const SEARCH_DAYS = 8;

/** ISO time of the next scheduled check-in reminder after now (ignores skip-if-recent), or null. */
export function nextCheckinAt(nowMs, settings) {
  const now = localParts(nowMs, settings.timeZone);
  const startMin = parseHM(settings.activeStart);
  const endMin = parseHM(settings.activeEnd);
  const interval = settings.intervalMin;
  if (!Number.isInteger(interval) || interval <= 0 || !(endMin > startMin)) return null;
  for (let i = 0; i < SEARCH_DAYS; i++) {
    const date = addDays(now.date, i);
    if (settings.pausedDate === date) continue;
    for (let m = startMin; m < endMin; m += interval) {
      if (i === 0 && m <= now.minutes) continue;
      const t = zonedTimeToUtc(date, m, settings.timeZone);
      if (t !== null && t > nowMs) return new Date(t).toISOString();
    }
  }
  return null;
}

/** ISO time of the next night review reminder after now, or null. closedDates: Set of dates with a night record. */
export function nextReviewAt(nowMs, settings, closedDates = new Set()) {
  const now = localParts(nowMs, settings.timeZone);
  const reviewMin = parseHM(settings.reviewTime);
  if (!Number.isFinite(reviewMin)) return null;
  for (let i = 0; i < SEARCH_DAYS; i++) {
    const date = addDays(now.date, i);
    if (settings.pausedDate === date || closedDates.has(date)) continue;
    for (const m of [reviewMin, reviewMin + 30]) {
      if (m >= 1440 || (i === 0 && m <= now.minutes)) continue;
      const t = zonedTimeToUtc(date, m, settings.timeZone);
      if (t !== null && t > nowMs) return new Date(t).toISOString();
    }
  }
  return null;
}
