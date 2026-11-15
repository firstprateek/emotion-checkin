import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHECKIN_ROTATION, NUDGE_BODY, MAX_CATCHUP_MINUTES,
  localParts, weekdayOf, addDays, parseHM, isValidTimeZone, zonedTimeToUtc,
  dueReminders, buildContext, latestEntryMs, countUnanswered,
  checkinCopy, nightCopy, pushOptions, sentKey, pruneSentLog,
  planTick, nextCheckinAt, nextReviewAt,
} from '../server/schedule.mjs';

const LA = 'America/Los_Angeles';
const MIN = 60_000;
const at = (iso) => Date.parse(iso);

const settings = (over = {}) => ({
  intervalMin: 30,
  activeStart: '09:00',
  activeEnd: '21:00',
  reviewTime: '21:30',
  weeklyDay: 0,
  timeZone: LA,
  pausedDate: null,
  streakHours: 5,
  ...over,
});
const hm = (s) => parseHM(s);
const local = (date, time) => ({ date, minutes: hm(time), weekday: weekdayOf(date) });
const noCtx = { nightClosedToday: false, minutesSinceLastEntry: null };

const checkin = (id, iso, date, hour, over = {}) => ({
  id, kind: 'checkin', at: iso, date, hour, feeling: 'ok', body: '', shouldBe: '', actually: '',
  status: 'on', updatedAt: iso, ...over,
});

// ---------------------------------------------------------------------------
describe('time helpers', () => {
  test('parseHM accepts HH:MM and rejects everything else', () => {
    assert.equal(parseHM('00:00'), 0);
    assert.equal(parseHM('09:30'), 570);
    assert.equal(parseHM('23:59'), 1439);
    for (const bad of ['24:00', '9:30', '09:60', '0930', '', null, undefined, 930, '09:30:00']) {
      assert.ok(Number.isNaN(parseHM(bad)), `expected NaN for ${bad}`);
    }
  });

  test('weekdayOf and addDays use calendar dates, not local time', () => {
    assert.equal(weekdayOf('2026-11-08'), 0);
    assert.equal(weekdayOf('2026-11-14'), 6);
    assert.equal(addDays('2026-11-08', 1), '2026-11-09');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(addDays('2028-03-01', -1), '2028-02-29');
    assert.equal(addDays('2026-11-08', 0), '2026-11-08');
  });

  test('isValidTimeZone', () => {
    assert.ok(isValidTimeZone('America/Los_Angeles'));
    assert.ok(isValidTimeZone('UTC'));
    assert.ok(isValidTimeZone('Asia/Kolkata'));
    assert.ok(!isValidTimeZone('Mars/Olympus'));
    assert.ok(!isValidTimeZone(''));
    assert.ok(!isValidTimeZone(null));
  });

  test('localParts converts one instant into different zones', () => {
    const t = at('2026-11-09T17:00:00Z');
    assert.deepEqual(localParts(t, 'UTC'), { date: '2026-11-09', minutes: 17 * 60, weekday: 1 });
    assert.deepEqual(localParts(t, LA), { date: '2026-11-09', minutes: 9 * 60, weekday: 1 });
    assert.deepEqual(localParts(t, 'Asia/Tokyo'), { date: '2026-11-10', minutes: 2 * 60, weekday: 2 });
    assert.deepEqual(localParts(t, 'Asia/Kolkata'), { date: '2026-11-09', minutes: 22 * 60 + 30, weekday: 1 });
  });

  test('localParts reports midnight as minute 0, not 1440', () => {
    assert.deepEqual(localParts(at('2026-11-09T08:00:00Z'), LA), { date: '2026-11-09', minutes: 0, weekday: 1 });
  });

  test('localParts across the fall-back DST change repeats 01:30', () => {
    assert.deepEqual(localParts(at('2026-11-01T08:30:00Z'), LA), { date: '2026-11-01', minutes: 90, weekday: 0 });
    assert.deepEqual(localParts(at('2026-11-01T09:30:00Z'), LA), { date: '2026-11-01', minutes: 90, weekday: 0 });
  });

  test('localParts across the spring-forward DST change skips 02:xx', () => {
    assert.equal(localParts(at('2026-03-08T09:59:00Z'), LA).minutes, 60 + 59);
    assert.equal(localParts(at('2026-03-08T10:00:00Z'), LA).minutes, 180);
  });

  test('zonedTimeToUtc round-trips ordinary times', () => {
    assert.equal(zonedTimeToUtc('2026-11-09', 540, LA), at('2026-11-09T17:00:00Z'));
    assert.equal(zonedTimeToUtc('2026-07-01', 540, LA), at('2026-07-01T16:00:00Z'));
    assert.equal(zonedTimeToUtc('2026-11-09', 0, 'UTC'), at('2026-11-09T00:00:00Z'));
    assert.equal(zonedTimeToUtc('2026-11-09', 22 * 60 + 30, 'Asia/Kolkata'), at('2026-11-09T17:00:00Z'));
    assert.equal(zonedTimeToUtc('2026-11-10', 120, 'Asia/Tokyo'), at('2026-11-09T17:00:00Z'));
  });

  test('zonedTimeToUtc returns null inside the spring-forward gap', () => {
    assert.equal(zonedTimeToUtc('2026-03-08', 150, LA), null);
    assert.equal(zonedTimeToUtc('2026-03-08', 120, LA), null);
    assert.equal(zonedTimeToUtc('2026-03-08', 180, LA), at('2026-03-08T10:00:00Z'));
    assert.equal(zonedTimeToUtc('2026-03-08', 90, LA), at('2026-03-08T09:30:00Z'));
  });

  test('zonedTimeToUtc picks a real instant in the repeated fall-back hour', () => {
    const t = zonedTimeToUtc('2026-11-01', 90, LA);
    assert.ok([at('2026-11-01T08:30:00Z'), at('2026-11-01T09:30:00Z')].includes(t));
    assert.equal(zonedTimeToUtc('2026-11-01', 180, LA), at('2026-11-01T11:00:00Z'));
  });
});

// ---------------------------------------------------------------------------
describe('dueReminders: check-in interval alignment', () => {
  test('due on every interval step from the start of active hours', () => {
    const s = settings();
    for (const t of ['09:00', '09:30', '10:00', '13:30', '20:30']) {
      assert.deepEqual(dueReminders(local('2026-11-09', t), s, noCtx), [{ kind: 'checkin' }], t);
    }
    for (const t of ['09:01', '09:15', '09:29', '10:45', '20:59']) {
      assert.deepEqual(dueReminders(local('2026-11-09', t), s, noCtx), [], t);
    }
  });

  test('alignment is relative to activeStart, not the top of the hour', () => {
    const s = settings({ activeStart: '09:15', intervalMin: 60 });
    assert.deepEqual(dueReminders(local('2026-11-09', '09:15'), s, noCtx), [{ kind: 'checkin' }]);
    assert.deepEqual(dueReminders(local('2026-11-09', '10:15'), s, noCtx), [{ kind: 'checkin' }]);
    assert.deepEqual(dueReminders(local('2026-11-09', '10:00'), s, noCtx), []);
  });

  test('odd custom intervals step from the start', () => {
    const s = settings({ intervalMin: 45 });
    assert.deepEqual(dueReminders(local('2026-11-09', '09:45'), s, noCtx), [{ kind: 'checkin' }]);
    assert.deepEqual(dueReminders(local('2026-11-09', '10:30'), s, noCtx), [{ kind: 'checkin' }]);
    assert.deepEqual(dueReminders(local('2026-11-09', '10:00'), s, noCtx), []);
  });

  test('a long interval gives few reminders', () => {
    const s = settings({ intervalMin: 240 });
    const due = [];
    for (let m = 0; m < 1440; m++) {
      if (dueReminders({ date: '2026-11-09', minutes: m, weekday: 1 }, s, noCtx).some((r) => r.kind === 'checkin')) due.push(m);
    }
    assert.deepEqual(due, [540, 780, 1020]);
  });
});

describe('dueReminders: active window edges', () => {
  test('start is inclusive, end is exclusive', () => {
    const s = settings({ activeStart: '09:00', activeEnd: '21:00', intervalMin: 60 });
    assert.deepEqual(dueReminders(local('2026-11-09', '09:00'), s, noCtx), [{ kind: 'checkin' }]);
    assert.deepEqual(dueReminders(local('2026-11-09', '20:00'), s, noCtx), [{ kind: 'checkin' }]);
    assert.deepEqual(dueReminders(local('2026-11-09', '21:00'), s, noCtx), []);
    assert.deepEqual(dueReminders(local('2026-11-09', '08:00'), s, noCtx), []);
    assert.deepEqual(dueReminders(local('2026-11-09', '00:00'), s, noCtx), []);
  });

  test('counts the reminders in a full day', () => {
    const s = settings();
    let n = 0;
    for (let m = 0; m < 1440; m++) {
      n += dueReminders({ date: '2026-11-09', minutes: m, weekday: 1 }, s, { nightClosedToday: true, minutesSinceLastEntry: null }).length;
    }
    assert.equal(n, 24); // 09:00 through 20:30 every 30 minutes
  });
});

describe('dueReminders: pause', () => {
  test('paused today: nothing at all, not even the night review', () => {
    const s = settings({ pausedDate: '2026-11-09' });
    assert.deepEqual(dueReminders(local('2026-11-09', '09:00'), s, noCtx), []);
    assert.deepEqual(dueReminders(local('2026-11-09', '21:30'), s, noCtx), []);
    assert.deepEqual(dueReminders(local('2026-11-09', '22:00'), s, noCtx), []);
  });

  test('a pause from another day has no effect', () => {
    const s = settings({ pausedDate: '2026-11-08' });
    assert.deepEqual(dueReminders(local('2026-11-09', '09:00'), s, noCtx), [{ kind: 'checkin' }]);
    assert.deepEqual(dueReminders(local('2026-11-09', '21:30'), s, noCtx), [{ kind: 'night' }]);
  });
});

describe('dueReminders: night review', () => {
  test('due at reviewTime and repeated 30 minutes later', () => {
    const s = settings();
    assert.deepEqual(dueReminders(local('2026-11-09', '21:30'), s, noCtx), [{ kind: 'night' }]);
    assert.deepEqual(dueReminders(local('2026-11-09', '22:00'), s, noCtx), [{ kind: 'night', repeat: true }]);
    for (const t of ['21:29', '21:31', '21:45', '22:30', '23:00']) {
      assert.deepEqual(dueReminders(local('2026-11-09', t), s, noCtx), [], t);
    }
  });

  test('not sent once the night is closed', () => {
    const ctx = { nightClosedToday: true, minutesSinceLastEntry: null };
    assert.deepEqual(dueReminders(local('2026-11-09', '21:30'), settings(), ctx), []);
    assert.deepEqual(dueReminders(local('2026-11-09', '22:00'), settings(), ctx), []);
  });

  test('closing the night does not stop check-ins', () => {
    const ctx = { nightClosedToday: true, minutesSinceLastEntry: null };
    assert.deepEqual(dueReminders(local('2026-11-09', '10:00'), settings(), ctx), [{ kind: 'checkin' }]);
  });

  test('check-in and night can be due in the same minute', () => {
    const s = settings({ activeEnd: '22:00', reviewTime: '21:30' });
    assert.deepEqual(dueReminders(local('2026-11-09', '21:30'), s, noCtx), [{ kind: 'checkin' }, { kind: 'night' }]);
  });

  test('a late review time gets no repeat past midnight', () => {
    const s = settings({ reviewTime: '23:45' });
    assert.deepEqual(dueReminders(local('2026-11-09', '23:45'), s, noCtx), [{ kind: 'night' }]);
    assert.deepEqual(dueReminders(local('2026-11-10', '00:15'), s, noCtx), []);
  });

  test('a review time at midnight repeats at 00:30', () => {
    const s = settings({ reviewTime: '00:00' });
    assert.deepEqual(dueReminders(local('2026-11-09', '00:00'), s, noCtx), [{ kind: 'night' }]);
    assert.deepEqual(dueReminders(local('2026-11-09', '00:30'), s, noCtx), [{ kind: 'night', repeat: true }]);
  });
});

describe('dueReminders: skip if a recent entry', () => {
  const at9 = local('2026-11-09', '09:30');
  test('skipped within floor(interval / 2) minutes, inclusive', () => {
    const s = settings({ intervalMin: 30 });
    assert.deepEqual(dueReminders(at9, s, { minutesSinceLastEntry: 0 }), []);
    assert.deepEqual(dueReminders(at9, s, { minutesSinceLastEntry: 14.5 }), []);
    assert.deepEqual(dueReminders(at9, s, { minutesSinceLastEntry: 15 }), []);
    assert.deepEqual(dueReminders(at9, s, { minutesSinceLastEntry: 15.01 }), [{ kind: 'checkin' }]);
    assert.deepEqual(dueReminders(at9, s, { minutesSinceLastEntry: 120 }), [{ kind: 'checkin' }]);
    assert.deepEqual(dueReminders(at9, s, { minutesSinceLastEntry: null }), [{ kind: 'checkin' }]);
  });

  test('odd intervals round the half down', () => {
    const s = settings({ intervalMin: 45, activeStart: '08:45' });
    assert.deepEqual(dueReminders(at9, s, { minutesSinceLastEntry: 22 }), []);
    assert.deepEqual(dueReminders(at9, s, { minutesSinceLastEntry: 23 }), [{ kind: 'checkin' }]);
  });

  test('a recent entry does not suppress the night review', () => {
    assert.deepEqual(dueReminders(local('2026-11-09', '21:30'), settings(), { minutesSinceLastEntry: 1 }), [{ kind: 'night' }]);
  });
});

// ---------------------------------------------------------------------------
describe('buildContext', () => {
  const now = at('2026-11-09T18:00:00Z'); // 10:00 in LA
  test('latest entry counts both checkins and skips', () => {
    const records = [
      checkin('a', '2026-11-09T17:00:00Z', '2026-11-09', 9),
      { id: 's', kind: 'skip', at: '2026-11-09T17:40:00Z', date: '2026-11-09', hour: 9, updatedAt: '2026-11-09T17:40:00Z' },
      { id: 'night-2026-11-08', kind: 'night', date: '2026-11-08', updatedAt: '2026-11-09T17:50:00Z' },
    ];
    const ctx = buildContext(records, now, '2026-11-09');
    assert.equal(ctx.minutesSinceLastEntry, 20);
    assert.equal(ctx.latestEntryAt, at('2026-11-09T17:40:00Z'));
    assert.equal(ctx.nightClosedToday, false);
    assert.equal(ctx.latestCheckinToday.id, 'a');
    assert.equal(ctx.hoursLoggedToday, 1);
  });

  test('no entries means null minutesSinceLastEntry', () => {
    const ctx = buildContext([], now, '2026-11-09');
    assert.equal(ctx.minutesSinceLastEntry, null);
    assert.equal(ctx.latestCheckinToday, null);
    assert.equal(ctx.hoursLoggedToday, 0);
  });

  test('entries stamped far in the future are ignored; slight skew clamps to 0', () => {
    assert.equal(latestEntryMs([checkin('f', '2026-11-09T20:00:00Z', '2026-11-09', 12)], now), null);
    const ctx = buildContext([checkin('g', '2026-11-09T18:02:00Z', '2026-11-09', 10)], now, '2026-11-09');
    assert.equal(ctx.minutesSinceLastEntry, 0);
  });

  test('night closed only for a night record with the same date', () => {
    const records = [{ id: 'night-2026-11-09', kind: 'night', date: '2026-11-09', updatedAt: '2026-11-09T18:00:00Z' }];
    assert.equal(buildContext(records, now, '2026-11-09').nightClosedToday, true);
    assert.equal(buildContext(records, now, '2026-11-10').nightClosedToday, false);
  });

  test('hours logged are distinct hours of checkins today; skips do not count', () => {
    const records = [
      checkin('a', '2026-11-09T17:00:00Z', '2026-11-09', 9),
      checkin('b', '2026-11-09T17:30:00Z', '2026-11-09', 9),
      checkin('c', '2026-11-09T18:00:00Z', '2026-11-09', 10, { status: 'escaping' }),
      checkin('d', '2026-11-08T18:00:00Z', '2026-11-08', 11),
      { id: 's', kind: 'skip', at: '2026-11-09T19:00:00Z', date: '2026-11-09', hour: 11, updatedAt: '2026-11-09T19:00:00Z' },
    ];
    const ctx = buildContext(records, at('2026-11-09T19:10:00Z'), '2026-11-09');
    assert.equal(ctx.hoursLoggedToday, 2);
    assert.equal(ctx.latestCheckinToday.id, 'c');
  });
});

describe('countUnanswered', () => {
  const sent = [
    { kind: 'checkin', at: 100, delivered: 1 },
    { kind: 'checkin', at: 200, delivered: 1 },
    { kind: 'checkin', at: 300, delivered: 0 },
    { kind: 'checkin', at: 400, delivered: 1, skipped: true },
    { kind: 'night', at: 500, delivered: 1 },
    { kind: 'checkin', at: 600, delivered: 2 },
  ];
  test('counts delivered, unskipped check-ins after the latest entry', () => {
    assert.equal(countUnanswered(sent, null), 3);
    assert.equal(countUnanswered(sent, 150), 2);
    assert.equal(countUnanswered(sent, 600), 0);
    assert.equal(countUnanswered([], null), 0);
  });
});

// ---------------------------------------------------------------------------
describe('checkinCopy', () => {
  test('uses the latest shouldBe when present', () => {
    const p = checkinCopy({ latestCheckinToday: { shouldBe: 'Q4 report' }, sendCount: 2, unanswered: 0 });
    assert.deepEqual(p, { title: 'Check in', body: 'Should be: Q4 report. Are you on it?', url: '/?go=checkin', tag: 'checkin' });
  });

  test('cleans whitespace and trailing punctuation from shouldBe', () => {
    assert.equal(checkinCopy({ latestCheckinToday: { shouldBe: '  Finish   the deck.  ' } }).body, 'Should be: Finish the deck. Are you on it?');
    assert.equal(checkinCopy({ latestCheckinToday: { shouldBe: 'Call mom!?' } }).body, 'Should be: Call mom. Are you on it?');
  });

  test('truncates a very long shouldBe', () => {
    const body = checkinCopy({ latestCheckinToday: { shouldBe: 'x'.repeat(300) } }).body;
    assert.ok(body.length < 140);
    assert.match(body, /…\. Are you on it\?$/);
  });

  test('rotates through the five prompts by send count when there is no shouldBe', () => {
    const bodies = [0, 1, 2, 3, 4, 5, 6].map((n) => checkinCopy({ latestCheckinToday: null, sendCount: n }).body);
    assert.deepEqual(bodies, [
      'What am I feeling right now?',
      "Pause. What's here?",
      'Before the next tab: check in.',
      "Ten seconds. What's going on?",
      'Feeling, should, actually.',
      'What am I feeling right now?',
      "Pause. What's here?",
    ]);
    assert.equal(CHECKIN_ROTATION.length, 5);
  });

  test('an empty or whitespace shouldBe falls back to the rotation', () => {
    assert.equal(checkinCopy({ latestCheckinToday: { shouldBe: '' }, sendCount: 1 }).body, "Pause. What's here?");
    assert.equal(checkinCopy({ latestCheckinToday: { shouldBe: '   ' }, sendCount: 1 }).body, "Pause. What's here?");
  });

  test('three or more unanswered reminders switch to the gentle nudge, over everything else', () => {
    assert.equal(checkinCopy({ latestCheckinToday: { shouldBe: 'Q4 report' }, unanswered: 2 }).body, 'Should be: Q4 report. Are you on it?');
    assert.equal(checkinCopy({ latestCheckinToday: { shouldBe: 'Q4 report' }, unanswered: 3 }).body, NUDGE_BODY);
    assert.equal(checkinCopy({ latestCheckinToday: null, sendCount: 3, unanswered: 7 }).body, 'One tap counts. Just the feeling is fine.');
  });
});

describe('nightCopy', () => {
  test('enough hours logged', () => {
    assert.deepEqual(nightCopy({ weekday: 1, weeklyDay: 0, hoursLogged: 5, streakHours: 5 }), {
      title: 'Close the day', body: "Day's done. 2 minutes to close it.", url: '/?go=night', tag: 'night',
    });
  });

  test('fewer hours than the streak needs', () => {
    assert.equal(nightCopy({ weekday: 1, weeklyDay: 0, hoursLogged: 3, streakHours: 5 }).body,
      'Logged 3 of 5 hours today. 2 minutes to close it.');
    assert.equal(nightCopy({ weekday: 1, weeklyDay: 0, hoursLogged: 0, streakHours: 4 }).body,
      'Logged 0 of 4 hours today. 2 minutes to close it.');
  });

  test('weekly suffix on the weekly review day, for both variants', () => {
    assert.equal(nightCopy({ weekday: 0, weeklyDay: 0, hoursLogged: 6, streakHours: 5 }).body,
      "Day's done. 2 minutes to close it. Then the week.");
    assert.equal(nightCopy({ weekday: 5, weeklyDay: 5, hoursLogged: 2, streakHours: 5 }).body,
      'Logged 2 of 5 hours today. 2 minutes to close it. Then the week.');
    assert.ok(!nightCopy({ weekday: 6, weeklyDay: 0, hoursLogged: 6, streakHours: 5 }).body.includes('week'));
  });
});

describe('pushOptions', () => {
  test('per-kind TTL, topic and urgency', () => {
    assert.deepEqual(pushOptions('checkin'), { TTL: 600, topic: 'checkin', urgency: 'high' });
    assert.deepEqual(pushOptions('night'), { TTL: 3600, topic: 'night' });
  });
});

describe('pruneSentLog', () => {
  test('keeps the last two days', () => {
    const now = at('2026-11-09T18:00:00Z');
    const log = [
      { kind: 'checkin', at: now - 3 * 86400_000 },
      { kind: 'checkin', at: now - 2 * 86400_000 + 1000 },
      { kind: 'night', at: now - 1000 },
    ];
    assert.deepEqual(pruneSentLog(log, now).map((e) => e.kind), ['checkin', 'night']);
  });
});

// ---------------------------------------------------------------------------
describe('planTick', () => {
  const minuteOf = (iso) => Math.floor(at(iso) / MIN);

  test('sends a check-in on an aligned minute with payload and options', () => {
    const plan = planTick({ nowMs: at('2026-11-09T17:00:05Z'), settings: settings(), records: [], state: {} });
    assert.equal(plan.processedMinute, minuteOf('2026-11-09T17:00:00Z'));
    assert.equal(plan.sends.length, 1);
    const s = plan.sends[0];
    assert.equal(s.kind, 'checkin');
    assert.equal(s.date, '2026-11-09');
    assert.equal(s.minute, 540);
    assert.equal(s.key, sentKey('checkin', '2026-11-09', 540));
    assert.deepEqual(s.payload, { title: 'Check in', body: 'What am I feeling right now?', url: '/?go=checkin', tag: 'checkin' });
    assert.deepEqual(s.options, { TTL: 600, topic: 'checkin', urgency: 'high' });
  });

  test('nothing between steps', () => {
    const plan = planTick({ nowMs: at('2026-11-09T17:07:00Z'), settings: settings(), records: [], state: {} });
    assert.deepEqual(plan.sends, []);
  });

  test('uses settings.timeZone to decide the local minute', () => {
    const nowMs = at('2026-11-09T17:00:00Z');
    assert.equal(planTick({ nowMs, settings: settings({ timeZone: LA }) }).sends.length, 1);
    assert.equal(planTick({ nowMs, settings: settings({ timeZone: 'Asia/Tokyo' }) }).sends.length, 0); // 02:00 there
    assert.equal(planTick({ nowMs, settings: settings({ timeZone: 'UTC', activeStart: '17:00', activeEnd: '18:00' }) }).sends.length, 1);
  });

  test('never sends the same (kind, date, minute) twice', () => {
    const state = { sent: [{ kind: 'checkin', date: '2026-11-09', minute: 540, at: at('2026-11-09T17:00:00Z'), delivered: 1 }] };
    const plan = planTick({ nowMs: at('2026-11-09T17:00:30Z'), settings: settings(), records: [], state });
    assert.deepEqual(plan.sends, []);
  });

  test('does nothing when the minute was already processed', () => {
    const nowMs = at('2026-11-09T17:00:30Z');
    const plan = planTick({ nowMs, lastProcessedMinute: Math.floor(nowMs / MIN), settings: settings() });
    assert.deepEqual(plan.sends, []);
  });

  test('a late tick catches up missed minutes', () => {
    const plan = planTick({
      nowMs: at('2026-11-09T17:04:00Z'),
      lastProcessedMinute: minuteOf('2026-11-09T16:58:00Z'),
      settings: settings(),
    });
    assert.equal(plan.sends.length, 1);
    assert.equal(plan.sends[0].minute, 540);
  });

  test('catch-up looks back at most 10 minutes', () => {
    const plan = planTick({
      nowMs: at('2026-11-09T17:11:00Z'),
      lastProcessedMinute: minuteOf('2026-11-09T16:30:00Z'),
      settings: settings(),
    });
    assert.deepEqual(plan.sends, []);
    const plan2 = planTick({
      nowMs: at('2026-11-09T17:10:00Z'),
      lastProcessedMinute: minuteOf('2026-11-09T16:30:00Z'),
      settings: settings(),
    });
    assert.equal(plan2.sends.length, 1);
    assert.equal(MAX_CATCHUP_MINUTES, 10);
  });

  test('the first tick after start processes only the current minute', () => {
    const plan = planTick({ nowMs: at('2026-11-09T17:01:00Z'), lastProcessedMinute: null, settings: settings() });
    assert.deepEqual(plan.sends, []);
  });

  test('at most one check-in per tick; older missed ones are marked skipped', () => {
    const s = settings({ intervalMin: 5 }); // below the API minimum, used only to force two in the window
    const plan = planTick({
      nowMs: at('2026-11-09T17:10:00Z'),
      lastProcessedMinute: minuteOf('2026-11-09T17:00:00Z'),
      settings: s,
    });
    assert.equal(plan.sends.length, 1);
    assert.equal(plan.sends[0].minute, 550);
    assert.deepEqual(plan.skipped.map((x) => x.minute), [545]);
  });

  test('skips the check-in if an entry was logged recently', () => {
    const records = [checkin('a', '2026-11-09T16:50:00Z', '2026-11-09', 8)];
    assert.deepEqual(planTick({ nowMs: at('2026-11-09T17:00:00Z'), settings: settings(), records }).sends, []);
    const skip = [{ id: 's', kind: 'skip', at: '2026-11-09T16:46:00Z', date: '2026-11-09', hour: 8, updatedAt: '2026-11-09T16:46:00Z' }];
    assert.deepEqual(planTick({ nowMs: at('2026-11-09T17:00:00Z'), settings: settings(), records: skip }).sends, []);
    const old = [checkin('b', '2026-11-09T16:40:00Z', '2026-11-09', 8)];
    assert.equal(planTick({ nowMs: at('2026-11-09T17:00:00Z'), settings: settings(), records: old }).sends.length, 1);
  });

  test('a late catch-up does not send a check-in the user already answered', () => {
    // 09:00 slot missed; the user checked in at 09:07; the tick catches up at 09:08.
    const records = [checkin('a', '2026-11-09T17:07:00Z', '2026-11-09', 9)];
    const plan = planTick({
      nowMs: at('2026-11-09T17:08:00Z'),
      lastProcessedMinute: minuteOf('2026-11-09T16:59:00Z'),
      settings: settings(),
      records,
    });
    assert.deepEqual(plan.sends, []);
    // A skip logged after the slot counts too.
    const skipRec = [{ id: 's', kind: 'skip', at: '2026-11-09T17:06:00Z', date: '2026-11-09', hour: 9, updatedAt: '2026-11-09T17:06:00Z' }];
    const plan2 = planTick({
      nowMs: at('2026-11-09T17:08:00Z'),
      lastProcessedMinute: minuteOf('2026-11-09T16:59:00Z'),
      settings: settings(),
      records: skipRec,
    });
    assert.deepEqual(plan2.sends, []);
  });

  test('a late catch-up still sends when the latest entry is old', () => {
    const records = [checkin('a', '2026-11-09T16:20:00Z', '2026-11-09', 8)];
    const plan = planTick({
      nowMs: at('2026-11-09T17:08:00Z'),
      lastProcessedMinute: minuteOf('2026-11-09T16:59:00Z'),
      settings: settings(),
      records,
    });
    assert.equal(plan.sends.length, 1);
    assert.equal(plan.sends[0].minute, 540);
  });

  test('check-in copy: shouldBe from the latest check-in today', () => {
    const records = [
      checkin('a', '2026-11-09T17:05:00Z', '2026-11-09', 9, { shouldBe: 'Old task' }),
      checkin('b', '2026-11-09T17:20:00Z', '2026-11-09', 9, { shouldBe: 'Q4 report' }),
    ];
    const plan = planTick({ nowMs: at('2026-11-09T18:00:00Z'), settings: settings(), records });
    assert.equal(plan.sends[0].payload.body, 'Should be: Q4 report. Are you on it?');
  });

  test("check-in copy: yesterday's shouldBe is not used", () => {
    const records = [checkin('a', '2026-11-09T05:00:00Z', '2026-11-08', 21, { shouldBe: 'Sleep' })];
    const plan = planTick({ nowMs: at('2026-11-09T17:00:00Z'), settings: settings(), records, state: { checkinSendCount: 3 } });
    assert.equal(plan.sends[0].payload.body, "Ten seconds. What's going on?");
  });

  test('check-in copy: 3 unanswered reminders since the latest entry', () => {
    const records = [checkin('a', '2026-11-09T16:00:00Z', '2026-11-09', 8, { shouldBe: 'Q4 report' })];
    const sent = ['16:30', '17:00', '17:30'].map((t, i) => ({
      kind: 'checkin', date: '2026-11-09', minute: 510 + i * 30, at: at(`2026-11-09T${t}:00Z`), delivered: 1,
    }));
    const nudge = planTick({ nowMs: at('2026-11-09T18:00:00Z'), settings: settings(), records, state: { sent } });
    assert.equal(nudge.sends[0].payload.body, NUDGE_BODY);
    const two = planTick({ nowMs: at('2026-11-09T18:00:00Z'), settings: settings(), records, state: { sent: sent.slice(1) } });
    assert.equal(two.sends[0].payload.body, 'Should be: Q4 report. Are you on it?');
  });

  test('night review with hours logged and the weekly suffix', () => {
    // 2026-11-08 is a Sunday; 21:30 in LA is 05:30Z the next day.
    const records = [9, 10, 11].map((h, i) => checkin(`c${i}`, `2026-11-08T${17 + i}:00:00Z`, '2026-11-08', h));
    const plan = planTick({ nowMs: at('2026-11-09T05:30:00Z'), settings: settings({ weeklyDay: 0 }), records });
    assert.equal(plan.sends.length, 1);
    assert.equal(plan.sends[0].kind, 'night');
    assert.equal(plan.sends[0].date, '2026-11-08');
    assert.deepEqual(plan.sends[0].payload, {
      title: 'Close the day', body: 'Logged 3 of 5 hours today. 2 minutes to close it. Then the week.', url: '/?go=night', tag: 'night',
    });
    assert.deepEqual(plan.sends[0].options, { TTL: 3600, topic: 'night' });
  });

  test('night repeat 30 minutes later unless closed', () => {
    const nowMs = at('2026-11-10T06:00:00Z'); // 22:00 LA on Monday 2026-11-09
    const open = planTick({ nowMs, settings: settings(), records: [] });
    assert.equal(open.sends.length, 1);
    assert.equal(open.sends[0].repeat, true);
    assert.equal(open.sends[0].payload.body, 'Logged 0 of 5 hours today. 2 minutes to close it.');
    const closed = planTick({ nowMs, settings: settings(), records: [{ id: 'night-2026-11-09', kind: 'night', date: '2026-11-09', updatedAt: '2026-11-10T05:45:00Z' }] });
    assert.deepEqual(closed.sends, []);
  });

  test('paused day sends nothing', () => {
    const s = settings({ pausedDate: '2026-11-09' });
    assert.deepEqual(planTick({ nowMs: at('2026-11-09T17:00:00Z'), settings: s }).sends, []);
    assert.deepEqual(planTick({ nowMs: at('2026-11-10T05:30:00Z'), settings: s }).sends, []);
  });

  test('fall-back DST: the repeated 01:30 is sent only once', () => {
    const s = settings({ activeStart: '01:00', activeEnd: '04:00' });
    const first = planTick({ nowMs: at('2026-11-01T08:30:00Z'), settings: s });
    assert.equal(first.sends.length, 1);
    assert.equal(first.sends[0].minute, 90);
    const state = { sent: [{ kind: 'checkin', date: '2026-11-01', minute: 90, at: at('2026-11-01T08:30:00Z'), delivered: 1 }] };
    const second = planTick({ nowMs: at('2026-11-01T09:30:00Z'), settings: s, state });
    assert.deepEqual(second.sends, []);
  });

  test('spring-forward DST: 02:xx never happens, 03:00 still fires', () => {
    const s = settings({ activeStart: '01:00', activeEnd: '04:00' });
    const sentMinutes = [];
    let last = null;
    for (let t = at('2026-03-08T08:55:00Z'); t <= at('2026-03-08T11:05:00Z'); t += MIN) {
      const plan = planTick({ nowMs: t, lastProcessedMinute: last, settings: s });
      last = plan.processedMinute;
      for (const x of plan.sends) sentMinutes.push(x.minute);
    }
    assert.deepEqual(sentMinutes, [60, 90, 180, 210]);
  });

  test('a full simulated day sends 24 check-ins and 2 night reminders', () => {
    const s = settings();
    let last = null;
    const state = { sent: [], checkinSendCount: 0 };
    const kinds = { checkin: 0, night: 0 };
    for (let t = at('2026-11-09T08:00:00Z'); t < at('2026-11-10T08:00:00Z'); t += MIN) {
      const plan = planTick({ nowMs: t, lastProcessedMinute: last, settings: s, records: [], state });
      last = plan.processedMinute;
      for (const x of plan.sends) {
        kinds[x.kind]++;
        state.sent.push({ kind: x.kind, date: x.date, minute: x.minute, at: t, delivered: 1 });
        if (x.kind === 'checkin') state.checkinSendCount++;
      }
    }
    assert.deepEqual(kinds, { checkin: 24, night: 2 });
  });
});

// ---------------------------------------------------------------------------
describe('nextCheckinAt / nextReviewAt', () => {
  test('next check-in later today', () => {
    assert.equal(nextCheckinAt(at('2026-11-09T17:10:00Z'), settings()), '2026-11-09T17:30:00.000Z');
    assert.equal(nextCheckinAt(at('2026-11-09T17:00:00Z'), settings()), '2026-11-09T17:30:00.000Z');
  });

  test('after active hours, next is tomorrow morning; before, it is the start', () => {
    assert.equal(nextCheckinAt(at('2026-11-10T05:00:00Z'), settings()), '2026-11-10T17:00:00.000Z'); // 21:00 LA
    assert.equal(nextCheckinAt(at('2026-11-09T15:00:00Z'), settings()), '2026-11-09T17:00:00.000Z'); // 07:00 LA
  });

  test('a paused day is skipped', () => {
    assert.equal(nextCheckinAt(at('2026-11-09T17:10:00Z'), settings({ pausedDate: '2026-11-09' })), '2026-11-10T17:00:00.000Z');
  });

  test('crosses DST with the right UTC offset', () => {
    // Saturday 2026-10-31 at 22:00 PDT; next is Sunday 09:00 PST = 17:00Z.
    assert.equal(nextCheckinAt(at('2026-11-01T05:00:00Z'), settings()), '2026-11-01T17:00:00.000Z');
    // Saturday 2026-03-07 at 22:00 PST; next is Sunday 09:00 PDT = 16:00Z.
    assert.equal(nextCheckinAt(at('2026-03-08T06:00:00Z'), settings()), '2026-03-08T16:00:00.000Z');
  });

  test('skips minutes that do not exist on the spring-forward day', () => {
    const s = settings({ activeStart: '02:00', activeEnd: '04:00', intervalMin: 30 });
    assert.equal(nextCheckinAt(at('2026-03-08T09:00:00Z'), s), '2026-03-08T10:00:00.000Z'); // 03:00 PDT
  });

  test('next review: today, the repeat, then tomorrow when closed', () => {
    const s = settings();
    assert.equal(nextReviewAt(at('2026-11-09T18:00:00Z'), s), '2026-11-10T05:30:00.000Z');
    assert.equal(nextReviewAt(at('2026-11-10T05:40:00Z'), s), '2026-11-10T06:00:00.000Z');
    assert.equal(nextReviewAt(at('2026-11-10T05:40:00Z'), s, new Set(['2026-11-09'])), '2026-11-11T05:30:00.000Z');
    assert.equal(nextReviewAt(at('2026-11-09T18:00:00Z'), settings({ pausedDate: '2026-11-09' })), '2026-11-11T05:30:00.000Z');
  });
});
