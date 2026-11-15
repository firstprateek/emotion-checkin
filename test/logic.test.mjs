import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../public/logic.js';

// Build ISO timestamps from local time so results don't depend on the machine's time zone.
const iso = (date, hour, minute = 0) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, hour, minute).toISOString();
};
let seq = 0;
const ci = (date, hour, fields = {}, minute = 0) => ({
  id: `c${++seq}`, kind: 'checkin', at: iso(date, hour, minute), date, hour,
  feeling: 'ok', body: '', shouldBe: '', actually: '', status: 'on',
  updatedAt: iso(date, hour, minute), ...fields,
});
const skip = (date, hour) => ({ id: `s${++seq}`, kind: 'skip', at: iso(date, hour), date, hour, updatedAt: iso(date, hour) });
const night = (date, fields = {}) => ({
  id: `night-${date}`, kind: 'night', date, yesterdayResult: null, wentWell: 'x', improve: '',
  closedAt: iso(date, 22), updatedAt: iso(date, 22), ...fields,
});
// A day with `n` distinct hours logged starting at 9.
const fullDay = (date, n = 5) => Array.from({ length: n }, (_, i) => ci(date, 9 + i));
const qualifyingDay = (date, n = 5) => [...fullDay(date, n), night(date)];

test('localDate, addDays, weekdayOf', () => {
  assert.equal(L.localDate(new Date(2026, 10, 8, 23, 59)), '2026-11-08');
  assert.equal(L.localDate(new Date(2026, 0, 3)), '2026-01-03');
  assert.equal(L.addDays('2026-11-08', 1), '2026-11-09');
  assert.equal(L.addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(L.addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(L.addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(L.addDays('2026-03-08', 1), '2026-03-09'); // DST change in the US
  assert.equal(L.weekdayOf('2026-11-08'), 0); // Sunday
  assert.equal(L.weekdayOf('2026-11-14'), 6);
});

test('dayLabel and weekLabel', () => {
  assert.equal(L.dayLabel('2026-11-08'), 'Sunday, Nov 8');
  assert.equal(L.weekLabel('2026-11-02', '2026-11-08'), 'Nov 2 to 8');
  assert.equal(L.weekLabel('2026-10-30', '2026-11-05'), 'Oct 30 to Nov 5');
});

test('tokens splits, trims, lowercases, drops empties and dedupes', () => {
  assert.deepEqual(L.tokens('Bored, a bit  Nervous; ;bored,, '), ['bored', 'a bit nervous']);
  assert.deepEqual(L.tokens(''), []);
  assert.deepEqual(L.tokens(undefined), []);
  assert.deepEqual(L.tokens('chest;Jaw;CHEST'), ['chest', 'jaw']);
});

test('chipsFor ranks by count, then most recent use, and only uses checkins', () => {
  const recs = [
    ci('2026-11-01', 9, { feeling: 'bored, nervous' }),
    ci('2026-11-01', 10, { feeling: 'restless' }),
    ci('2026-11-02', 9, { feeling: 'Bored' }),
    ci('2026-11-02', 11, { feeling: 'calm' }),
    skip('2026-11-03', 9),
    { ...night('2026-11-03'), feeling: 'ignored' },
  ];
  // bored: 2 uses. calm is the most recent single use, then restless, then nervous.
  assert.deepEqual(L.chipsFor(recs, 'feeling'), ['bored', 'calm', 'restless', 'nervous']);
  assert.deepEqual(L.chipsFor(recs, 'feeling', 2), ['bored', 'calm']);
  assert.deepEqual(L.chipsFor([], 'feeling'), []);
});

test('chipsFor counts a token once per check-in', () => {
  const recs = [ci('2026-11-01', 9, { feeling: 'tired, tired, tired' }), ci('2026-11-01', 10, { feeling: 'sad' }), ci('2026-11-01', 11, { feeling: 'sad' })];
  assert.deepEqual(L.chipsFor(recs, 'feeling'), ['sad', 'tired']);
});

test('chipsFor body uses tokens', () => {
  const recs = [ci('2026-11-01', 9, { body: 'Chest; jaw' }), ci('2026-11-01', 10, { body: 'chest' }), ci('2026-11-01', 11, { body: '' })];
  assert.deepEqual(L.chipsFor(recs, 'body'), ['chest', 'jaw']);
});

test('chipsFor shouldBe and actually use whole values with the most recent casing', () => {
  const recs = [
    ci('2026-11-01', 9, { actually: 'youtube', shouldBe: 'q4 report' }),
    ci('2026-11-01', 10, { actually: 'Scrolling X, again', shouldBe: 'Q4 Report' }),
    ci('2026-11-01', 11, { actually: '  YouTube ', shouldBe: 'email' }),
    ci('2026-11-01', 12, { actually: '', shouldBe: 'Q4 report' }),
  ];
  assert.deepEqual(L.chipsFor(recs, 'actually'), ['YouTube', 'Scrolling X, again']);
  assert.deepEqual(L.chipsFor(recs, 'shouldBe'), ['Q4 report', 'email']);
});

test('hoursLogged returns sorted distinct hours of checkins only', () => {
  const d = '2026-11-08';
  const recs = [ci(d, 14), ci(d, 9), ci(d, 9, {}, 30), ci(d, 11, { status: 'escaping' }), ci(d, 12, { status: 'break' }), skip(d, 15), ci('2026-11-07', 10)];
  assert.deepEqual(L.hoursLogged(recs, d), [9, 11, 12, 14]);
  assert.deepEqual(L.hoursLogged(recs, '2026-11-01'), []);
});

test('dayQualifies needs enough hours and a night record', () => {
  const d = '2026-11-08';
  assert.equal(L.dayQualifies(qualifyingDay(d), d, 5), true);
  assert.equal(L.dayQualifies(fullDay(d), d, 5), false);
  assert.equal(L.dayQualifies([...fullDay(d, 4), night(d)], d, 5), false);
  assert.equal(L.dayQualifies([...fullDay(d, 4), night(d)], d, 4), true);
  const sameHour = [ci(d, 9), ci(d, 9, {}, 15), ci(d, 9, {}, 30), ci(d, 9, {}, 45), ci(d, 10), night(d)];
  assert.equal(L.dayQualifies(sameHour, d, 5), false);
});

test('streak: counts consecutive days ending today when today qualifies', () => {
  const recs = [...qualifyingDay('2026-11-06'), ...qualifyingDay('2026-11-07'), ...qualifyingDay('2026-11-08')];
  assert.equal(L.streak(recs, '2026-11-08', 5, 22 * 60), 3);
});

test('streak: ends at yesterday when today does not qualify yet', () => {
  const recs = [...qualifyingDay('2026-11-06'), ...qualifyingDay('2026-11-07'), ...fullDay('2026-11-08', 2)];
  assert.equal(L.streak(recs, '2026-11-08', 5, 15 * 60), 2);
  assert.equal(L.streak(recs, '2026-11-08', 5, 8 * 60), 2);
});

test('streak: before noon, yesterday with enough hours but no night keeps the streak', () => {
  const recs = [...qualifyingDay('2026-11-05'), ...qualifyingDay('2026-11-06'), ...fullDay('2026-11-07')];
  assert.equal(L.streak(recs, '2026-11-08', 5, 11 * 60 + 59), 2);
});

test('streak: at or after noon the grace ends', () => {
  const recs = [...qualifyingDay('2026-11-05'), ...qualifyingDay('2026-11-06'), ...fullDay('2026-11-07')];
  assert.equal(L.streak(recs, '2026-11-08', 5, 12 * 60), 0);
});

test('streak: grace needs enough hours yesterday', () => {
  const recs = [...qualifyingDay('2026-11-06'), ...fullDay('2026-11-07', 4)];
  assert.equal(L.streak(recs, '2026-11-08', 5, 9 * 60), 0);
});

test('streak: a missed day ends it', () => {
  const recs = [...qualifyingDay('2026-11-03'), ...qualifyingDay('2026-11-04'), ...qualifyingDay('2026-11-06'), ...qualifyingDay('2026-11-07')];
  assert.equal(L.streak(recs, '2026-11-08', 5, 15 * 60), 2);
  // A day with hours but no night review is a missed day.
  const recs2 = [...qualifyingDay('2026-11-05'), ...fullDay('2026-11-06'), ...qualifyingDay('2026-11-07')];
  assert.equal(L.streak(recs2, '2026-11-08', 5, 15 * 60), 1);
});

test('streak: zero when nothing qualifies, and when the last qualifying day is two days ago', () => {
  assert.equal(L.streak([], '2026-11-08', 5, 600), 0);
  assert.equal(L.streak(qualifyingDay('2026-11-06'), '2026-11-08', 5, 15 * 60), 0);
});

test('runEndingAt', () => {
  const recs = [...qualifyingDay('2026-11-06'), ...qualifyingDay('2026-11-07')];
  assert.equal(L.runEndingAt(recs, '2026-11-07', 5), 2);
  assert.equal(L.runEndingAt(recs, '2026-11-08', 5), 0);
});

test('dayStats tallies, top 3 sorted desc, and peak window', () => {
  const d = '2026-11-08';
  const recs = [
    ci(d, 9),
    ci(d, 10),
    ci(d, 11, { status: 'break' }),
    skip(d, 12),
    skip(d, 16),
    ci(d, 13, { status: 'escaping', feeling: 'bored, nervous', shouldBe: 'Q4 report', actually: 'YouTube' }),
    ci(d, 14, { status: 'escaping', feeling: 'Bored', shouldBe: 'q4 report', actually: 'scrolling X' }),
    ci(d, 15, { status: 'escaping', feeling: 'restless', shouldBe: 'Q4 report', actually: 'YouTube' }, 30),
    ci(d, 19, { status: 'escaping', feeling: 'tired', shouldBe: 'email replies', actually: 'news' }),
    ci(d, 20, { status: 'escaping', feeling: 'hungry', shouldBe: 'workout', actually: 'snacks' }),
    ci(d, 20, { status: 'on', feeling: 'great', shouldBe: 'ignored', actually: 'ignored' }, 30),
    ci('2026-11-07', 14, { status: 'escaping', shouldBe: 'other day' }),
  ];
  const s = L.dayStats(recs, d);
  assert.equal(s.on, 3);
  assert.equal(s.escaping, 5);
  assert.equal(s.breaks, 1);
  assert.equal(s.skipped, 2);
  assert.deepEqual(s.avoided, [
    { label: 'Q4 report', count: 3 },
    { label: 'workout', count: 1 },
    { label: 'email replies', count: 1 },
  ]);
  assert.deepEqual(s.feltBefore[0], { label: 'bored', count: 2 });
  assert.equal(s.feltBefore.length, 3);
  assert.deepEqual(s.wentTo.slice(0, 2), [{ label: 'YouTube', count: 2 }, { label: 'snacks', count: 1 }]);
  assert.equal(s.peakWindow, '1 to 4 PM');
});

test('dayStats: no peak window with fewer than 2 escapes; empty day', () => {
  const d = '2026-11-08';
  const one = L.dayStats([ci(d, 13, { status: 'escaping' })], d);
  assert.equal(one.escaping, 1);
  assert.equal(one.peakWindow, null);
  const empty = L.dayStats([], d);
  assert.deepEqual(empty, { on: 0, escaping: 0, breaks: 0, skipped: 0, avoided: [], feltBefore: [], wentTo: [], peakWindow: null });
});

test('peakWindowStart prefers the busiest window, earliest on ties', () => {
  assert.equal(L.peakWindowStart([]), null);
  assert.equal(L.peakWindowStart([14, 14]), 14);
  assert.equal(L.peakWindowStart([9, 14]), 9);
  assert.equal(L.peakWindowStart([9, 14, 15, 16, 20]), 14);
  assert.equal(L.peakWindowStart([23, 23]), 23);
});

test('weekRange for every weeklyDay', () => {
  // 2026-11-08 is a Sunday.
  const today = '2026-11-08';
  const expected = {
    0: ['2026-11-02', '2026-11-08'],
    1: ['2026-11-03', '2026-11-09'],
    2: ['2026-11-04', '2026-11-10'],
    3: ['2026-11-05', '2026-11-11'],
    4: ['2026-11-06', '2026-11-12'],
    5: ['2026-11-07', '2026-11-13'],
    6: ['2026-11-08', '2026-11-14'],
  };
  for (let wd = 0; wd < 7; wd++) {
    const r = L.weekRange(today, wd);
    assert.deepEqual([r.weekStart, r.weekEnd], expected[wd], `weeklyDay ${wd}`);
    assert.equal(L.weekdayOf(r.weekEnd), wd);
    assert.ok(r.weekStart <= today && today <= r.weekEnd);
  }
  // Mid-week, ending Sunday.
  assert.deepEqual(L.weekRange('2026-11-04', 0), { weekStart: '2026-11-02', weekEnd: '2026-11-08' });
  // Across a month boundary.
  assert.deepEqual(L.weekRange('2026-12-01', 3), { weekStart: '2026-11-26', weekEnd: '2026-12-02' });
});

test('weekStats: onPct, prevOnPct, perDay, tallies and pattern', () => {
  const ws = '2026-11-02';
  const esc = (date, hour, feeling, shouldBe, actually) => ci(date, hour, { status: 'escaping', feeling, shouldBe, actually });
  const recs = [
    // previous week: 3 on, 2 escaping -> 60%
    ci('2026-10-27', 9), ci('2026-10-28', 9), ci('2026-10-29', 9),
    esc('2026-10-30', 10, 'x', 'a', 'b'), esc('2026-10-31', 10, 'x', 'a', 'b'),
    // this week
    ci('2026-11-02', 9), ci('2026-11-02', 10), ci('2026-11-03', 9), ci('2026-11-04', 9),
    ci('2026-11-05', 9), ci('2026-11-06', 9), ci('2026-11-08', 9), ci('2026-11-08', 11, { status: 'break' }),
    esc('2026-11-02', 13, 'bored', 'Q4 report', 'YouTube'),
    esc('2026-11-03', 14, 'bored, nervous', 'q4 report', 'youtube'),
    esc('2026-11-04', 15, 'nervous', 'Q4 report', 'YouTube'),
    esc('2026-11-05', 10, 'restless', 'workout', 'scrolling X'),
    // next week, ignored
    ci('2026-11-09', 9, { status: 'escaping' }),
  ];
  const w = L.weekStats(recs, ws);
  assert.equal(w.onPct, 64); // 7 on / 11 (break excluded)
  assert.equal(w.prevOnPct, 60);
  assert.equal(w.perDay.length, 7);
  assert.deepEqual(w.perDay[0], { date: '2026-11-02', on: 2, escaping: 1 });
  assert.deepEqual(w.perDay[6], { date: '2026-11-08', on: 1, escaping: 0 });
  assert.deepEqual(w.perDay.map((d) => d.date), ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
  assert.deepEqual(w.avoided, [{ label: 'Q4 report', count: 3 }, { label: 'workout', count: 1 }]);
  assert.deepEqual(w.feltBefore.slice(0, 2), [{ label: 'nervous', count: 2 }, { label: 'bored', count: 2 }]);
  assert.deepEqual(w.wentTo[0], { label: 'YouTube', count: 3 });
  assert.equal(w.pattern, 'Pattern: nervous on Q4 report, then YouTube, 1 to 4 PM. It happened 3 times.');
});

test('weekStats: nulls when there is no data, and no pattern with fewer than 2 escapes', () => {
  const w = L.weekStats([], '2026-11-02');
  assert.equal(w.onPct, null);
  assert.equal(w.prevOnPct, null);
  assert.equal(w.pattern, null);
  assert.ok(w.perDay.every((d) => d.on === 0 && d.escaping === 0));
  const one = L.weekStats([ci('2026-11-03', 9, { status: 'escaping', shouldBe: 'a', actually: 'b' })], '2026-11-02');
  assert.equal(one.onPct, 0);
  assert.equal(one.pattern, null);
});

test('weekStats pattern: single pair, no feeling, singular count', () => {
  const recs = [
    ci('2026-11-03', 9, { status: 'escaping', feeling: '', shouldBe: 'taxes', actually: 'news' }),
    ci('2026-11-04', 9, { status: 'escaping', feeling: '', shouldBe: 'dishes', actually: '' }),
  ];
  assert.equal(L.weekStats(recs, '2026-11-02').pattern, 'Pattern: avoiding taxes, then news. It happened once.');
  const none = [ci('2026-11-03', 9, { status: 'escaping', shouldBe: '' }), ci('2026-11-04', 9, { status: 'escaping', actually: '' })];
  assert.equal(L.weekStats(none, '2026-11-02').pattern, null);
});

test('formatTime, formatHM, shortTime, parseHM', () => {
  assert.equal(L.formatTime(iso('2026-11-08', 14, 15)), '2:15 PM');
  assert.equal(L.formatTime(iso('2026-11-08', 0, 5)), '12:05 AM');
  assert.equal(L.formatTime(iso('2026-11-08', 12, 0)), '12:00 PM');
  assert.equal(L.formatTime(iso('2026-11-08', 9, 0)), '9:00 AM');
  assert.equal(L.parseHM('09:30'), 570);
  assert.equal(L.parseHM('21:00'), 1260);
  assert.equal(L.formatHM(570), '9:30 AM');
  assert.equal(L.shortTime(540), '9 AM');
  assert.equal(L.shortTime(900), '3 PM');
  assert.equal(L.shortTime(1290), '9:30 PM');
});

test('windowLabel, including AM/PM crossing', () => {
  assert.equal(L.windowLabel(13), '1 to 4 PM');
  assert.equal(L.windowLabel(8), '8 to 11 AM');
  assert.equal(L.windowLabel(11), '11 AM to 2 PM');
  assert.equal(L.windowLabel(9), '9 AM to 12 PM');
  assert.equal(L.windowLabel(10), '10 AM to 1 PM');
  assert.equal(L.windowLabel(22), '10 PM to 1 AM');
  assert.equal(L.windowLabel(0), '12 to 3 AM');
  assert.equal(L.windowLabel(null), null);
});

test('relativeTime', () => {
  const now = Date.UTC(2026, 10, 8, 12);
  assert.equal(L.relativeTime(now - 10e3, now), 'just now');
  assert.equal(L.relativeTime(now - 60e3, now), '1 minute ago');
  assert.equal(L.relativeTime(now - 5 * 60e3, now), '5 minutes ago');
  assert.equal(L.relativeTime(now - 3600e3, now), '1 hour ago');
  assert.equal(L.relativeTime(now - 30 * 3600e3, now), 'yesterday');
  assert.equal(L.relativeTime(now - 72 * 3600e3, now), '3 days ago');
});

test('settings helpers', () => {
  const s = { intervalMin: 30, activeStart: '09:00', activeEnd: '21:00', streakHours: 5 };
  assert.deepEqual(L.activeHours(s), [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.deepEqual(L.activeHours({ ...s, activeStart: '08:30', activeEnd: '11:15' }), [8, 9, 10, 11]);
  assert.equal(L.remindersPerDay(s), 24);
  assert.equal(L.remindersPerDay({ ...s, intervalMin: 240 }), 3);
  assert.equal(L.remindersPerDay({ ...s, intervalMin: 300 }), 3); // 9:00, 14:00, 19:00
  assert.equal(L.paceWarning(s), null);
  assert.equal(L.paceWarning({ ...s, intervalMin: 240 }),
    "At this pace you'd get 3 reminders a day. The streak needs 5 hours, so add check-ins yourself.");
  assert.equal(L.activeRangeValid(s), true);
  assert.equal(L.activeRangeValid({ ...s, activeEnd: '09:00' }), false);
  assert.equal(L.intervalLabel(15), '15 min');
  assert.equal(L.intervalLabel(60), '1 hr');
  assert.equal(L.intervalLabel(240), '4 hr');
  assert.equal(L.intervalLabel(90), '90 min');
});

test('todayLine', () => {
  assert.equal(L.todayLine(4, 5, false), 'One more hour, then the night review, keeps the streak.');
  assert.equal(L.todayLine(2, 5, false), '3 more hours, then the night review, keeps the streak.');
  assert.equal(L.todayLine(5, 5, false), 'Close the night review to keep the streak.');
  assert.equal(L.todayLine(6, 5, true), 'Today counts.');
});

test('nightStreakLine', () => {
  const recs = [...qualifyingDay('2026-11-06'), ...qualifyingDay('2026-11-07'), ...fullDay('2026-11-08')];
  assert.equal(L.nightStreakLine(recs, '2026-11-08', 5), '5 of 5 hours logged. Close the day to make it 3.');
  const short = [...qualifyingDay('2026-11-07'), ...fullDay('2026-11-08', 3)];
  assert.equal(L.nightStreakLine(short, '2026-11-08', 5), '3 of 5 hours logged. The streak needs 5.');
});

test('todayBanners', () => {
  const settings = { reviewTime: '21:30', weeklyDay: 0, pausedDate: null };
  const today = '2026-11-08'; // Sunday
  const y = '2026-11-07';
  // Morning, yesterday has check-ins and no night.
  let b = L.todayBanners({ records: [ci(y, 10)], settings, today, nowMinutes: 9 * 60 });
  assert.deepEqual(b, [{ text: 'Close yesterday?', href: '#night?date=2026-11-07' }]);
  // After noon the yesterday banner is gone.
  b = L.todayBanners({ records: [ci(y, 10)], settings, today, nowMinutes: 12 * 60 });
  assert.deepEqual(b, []);
  // Yesterday closed: no banner.
  b = L.todayBanners({ records: [ci(y, 10), night(y)], settings, today, nowMinutes: 9 * 60 });
  assert.deepEqual(b, []);
  // Paused and after review time.
  b = L.todayBanners({ records: [], settings: { ...settings, pausedDate: today }, today, nowMinutes: 21 * 60 + 30 });
  assert.deepEqual(b.map((x) => x.text), ['Paused today.', 'Ready to close the day? About 2 minutes.']);
  // Weekly day, night closed, week open.
  b = L.todayBanners({ records: [night(today)], settings, today, nowMinutes: 22 * 60 });
  assert.deepEqual(b, [{ text: 'Close the week. About 5 minutes.', href: '#week' }]);
  // Week closed.
  const week = { id: 'week-2026-11-02', kind: 'week', weekStart: '2026-11-02', weekEnd: today, updatedAt: iso(today, 22) };
  b = L.todayBanners({ records: [night(today), week], settings, today, nowMinutes: 22 * 60 });
  assert.deepEqual(b, []);
  // Not the weekly day.
  b = L.todayBanners({ records: [night(today)], settings: { ...settings, weeklyDay: 5 }, today, nowMinutes: 22 * 60 });
  assert.deepEqual(b, []);
});

test('latestCheckin and nightFor', () => {
  const a = ci('2026-11-07', 9, { shouldBe: 'old' });
  const b = ci('2026-11-08', 9, { shouldBe: 'new' });
  assert.equal(L.latestCheckin([b, a, skip('2026-11-08', 10)]).shouldBe, 'new');
  assert.equal(L.latestCheckin([]), null);
  assert.equal(L.nightFor([night('2026-11-07', { improve: 'walk' })], '2026-11-07').improve, 'walk');
  assert.equal(L.nightFor([], '2026-11-07'), null);
});

test('isDate accepts real calendar dates only', () => {
  assert.equal(L.isDate('2026-11-08'), true);
  assert.equal(L.isDate('2028-02-29'), true);
  assert.equal(L.isDate('2026-02-30'), false);
  assert.equal(L.isDate('2026-13-01'), false);
  assert.equal(L.isDate('2026-1-01'), false);
  assert.equal(L.isDate(null), false);
});

const httpErr = (status, message = `HTTP ${status}`) => Object.assign(new Error(message), { status });

test('pushRecords sends the batch in one request when it is accepted', async () => {
  const calls = [];
  const recs = [{ id: 'a' }, { id: 'b' }];
  const out = await L.pushRecords(recs, async (batch) => { calls.push(batch.map((r) => r.id)); });
  assert.deepEqual(calls, [['a', 'b']]);
  assert.deepEqual(out.synced.map((r) => r.id), ['a', 'b']);
  assert.deepEqual(out.rejected, []);
  assert.equal(out.error, null);
});

for (const status of [400, 413]) {
  test(`pushRecords falls back to one at a time on ${status} and isolates the bad record`, async () => {
    const recs = [{ id: 'a' }, { id: 'bad' }, { id: 'c' }];
    const out = await L.pushRecords(recs, async (batch) => {
      if (batch.length > 1 || batch[0].id === 'bad') throw httpErr(status, 'Request body is too large.');
    });
    assert.deepEqual(out.synced.map((r) => r.id), ['a', 'c']);
    assert.deepEqual(out.rejected.map((x) => [x.record.id, x.error]), [['bad', 'Request body is too large.']]);
    assert.equal(out.error, null);
  });
}

test('pushRecords stops and reports a network or server error', async () => {
  const out = await L.pushRecords([{ id: 'a' }], async () => { throw httpErr(500); });
  assert.equal(out.error.status, 500);
  assert.deepEqual(out.synced, []);
  const out2 = await L.pushRecords([{ id: 'a' }, { id: 'b' }], async (batch) => {
    if (batch.length > 1) throw httpErr(400);
    if (batch[0].id === 'b') throw new TypeError('offline');
  });
  assert.deepEqual(out2.synced.map((r) => r.id), ['a']);
  assert.ok(out2.error instanceof TypeError);
});

test('pendingPush skips synced and refused records', () => {
  const recs = [{ id: 'a', synced: false }, { id: 'b', synced: true }, { id: 'c', synced: false, syncError: 'bad' }];
  assert.deepEqual(L.pendingPush(recs).map((r) => r.id), ['a']);
});

test('mergeRecords keeps the newest copy of each id', () => {
  const merged = L.mergeRecords(
    [{ id: 'a', updatedAt: '2026-11-08T10:00:00Z', v: 1 }, { id: 'b', updatedAt: '2026-11-08T10:00:00Z', v: 1 }],
    [{ id: 'a', updatedAt: '2026-11-08T11:00:00Z', v: 2 }, { id: 'b', updatedAt: '2026-11-08T09:00:00Z', v: 0 }, { id: 'c', updatedAt: '2026-11-08T09:00:00Z', v: 3 }],
  );
  assert.deepEqual(Object.fromEntries(merged.map((r) => [r.id, r.v])), { a: 2, b: 1, c: 3 });
});

test('backupLine counts waiting and refused entries', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  assert.equal(L.backupLine([], null, now), 'Not backed up yet.');
  assert.equal(L.backupLine([{ id: 'a', synced: true }], now - 5 * 60_000, now), 'Backed up to the Mac mini 5 minutes ago.');
  assert.equal(L.backupLine([{ id: 'a', synced: false }, { id: 'b', synced: false }], now, now), '2 entries waiting to back up. Open Tailscale to sync.');
  assert.equal(L.backupLine([{ id: 'a', synced: false, syncError: 'x' }], now, now), "1 entry couldn't be backed up. It stays on your phone.");
  assert.equal(
    L.backupLine([{ id: 'a', synced: false }, { id: 'b', synced: false, syncError: 'x' }, { id: 'c', synced: false, syncError: 'y' }], now, now),
    "1 entry waiting to back up. Open Tailscale to sync. 2 entries couldn't be backed up. They stay on your phone.",
  );
});
