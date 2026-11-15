# Check-in: build spec

A private iPhone home-screen web app for logging feelings through the day, served from the owner's
Mac mini over Tailscale. The visual design and copy come from `design.html` (third draft) in this
folder: read it and follow its screens, labels and tokens. Where this spec and `design.html` differ,
this spec wins (for example, lock-screen buttons and typed replies are NOT possible in a web app).

## Deployment facts

- Node 26 at `/opt/homebrew/bin/node`. ES modules only (`"type": "module"`). One runtime dependency:
  `web-push@4.0.0`. No frameworks, no build step, no bundler. Client is vanilla JS modules.
- Server listens on `HOST` (default `127.0.0.1`) and `PORT` (default `8790`).
- Tailscale Serve exposes it tailnet-only at `https://<machine>.<tailnet>.ts.net:8443`.
  That is the app's origin. All client URLs must be relative so the origin never matters.
- Data lives in `DATA_DIR` (default `./data`, gitignored): `vapid.json`, `settings.json`,
  `subscriptions.json`, `records.json`, `state.json`. Write each atomically (write temp, rename).
- VAPID keys are generated on first start if missing. VAPID subject: env `VAPID_SUBJECT` (a URL, no email address anywhere).
  `scripts/deploy.sh` sets it to the app's origin from `tailscale status`; the code's fallback is a placeholder.

## File layout and ownership

```
package.json            server builder   ("type":"module", scripts: start = node server/server.mjs, test = node --test test/)
server/server.mjs       server builder   HTTP server, static files, API routes
server/store.mjs        server builder   JSON file persistence
server/schedule.mjs     server builder   PURE scheduling functions (no I/O), unit-tested
server/push.mjs         server builder   web-push wrapper, subscription cleanup
test/schedule.test.mjs  server builder
test/api.test.mjs       server builder   starts the server on a random port with a temp DATA_DIR
public/index.html       client builder
public/app.js           client builder   UI, routing, IndexedDB, sync, push subscribe
public/logic.js         client builder   PURE functions (no DOM, no IndexedDB), importable from Node
public/styles.css       client builder
public/sw.js            client builder   service worker
public/manifest.webmanifest  client builder
public/icons/*.png      client builder   icon-192.png, icon-512.png, apple-touch-icon.png (180x180)
test/logic.test.mjs     client builder
README.md               server builder   run, test, deploy notes
```

## Data model

All records share `{ id, kind, updatedAt }` where `updatedAt` is an ISO timestamp. Merge rule everywhere:
last write wins by `updatedAt`. Dates are local `YYYY-MM-DD` strings; `hour` is the local hour 0–23.

- `checkin`: `{ id: uuid, kind:"checkin", at: ISO, date, hour, feeling, body, shouldBe, actually,
  status: "on" | "escaping" | "break", updatedAt }`. `feeling` is required (non-empty after trim).
  `body`, `shouldBe`, `actually` may be empty strings.
- `skip`: `{ id: uuid, kind:"skip", at, date, hour, updatedAt }`. Logged by the Skip link.
- `night`: `{ id: "night-<date>", kind:"night", date, yesterdayResult: "did" | "partly" | "not" | null,
  wentWell, improve, closedAt, updatedAt }`.
- `week`: `{ id: "week-<weekStart>", kind:"week", weekStart, weekEnd, pattern, change, closedAt, updatedAt }`.

Settings (server is the source of truth, client caches a copy):
```
{ intervalMin: 30, activeStart: "09:00", activeEnd: "21:00", reviewTime: "21:30",
  weeklyDay: 0, timeZone: "<IANA tz>", pausedDate: null, streakHours: 5 }
```
- `intervalMin`: integer 15–480. UI offers 15, 30, 60, 120, 240 and Custom (minutes).
- `activeEnd` must be later than `activeStart` on the same day (no crossing midnight). Reject otherwise
  with 400 and `{ error: "Active hours must end after they start." }`.
- `weeklyDay`: 0–6, JS weekday (0 = Sunday). The week ENDS on this day.
- `timeZone`: the client sends `Intl.DateTimeFormat().resolvedOptions().timeZone` on every app open.
  Server default before that: its own local zone.
- `pausedDate`: when equal to today's local date, no reminders of any kind are sent that day.

## API (JSON, under `/api`, body limit 1 MB, errors as `{ error: "<plain sentence>" }`)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | /api/health | | `{ ok: true }` |
| GET | /api/vapid-public-key | | `{ key }` (base64url) |
| POST | /api/subscriptions | `{ subscription }` (PushSubscription JSON) | `{ ok: true }` upsert by endpoint |
| DELETE | /api/subscriptions | `{ endpoint }` | `{ ok: true }` |
| GET | /api/settings | | settings |
| PUT | /api/settings | partial settings | full settings after validation |
| GET | /api/records?since=ISO | | `{ records: [...], serverTime }` records with `updatedAt > since` (all if absent) |
| POST | /api/records | `{ records: [...] }` | `{ ok: true, accepted: n }` validate kind and id; LWW merge |
| POST | /api/test-push | | `{ sent: n }` sends "Test reminder. You're all set." |
| GET | /api/status | | `{ subscriptions: n, lastPushAt, nextCheckinAt, nextReviewAt, paused }` |
| GET | /api/export | | all records + settings, `Content-Disposition: attachment; filename="checkins-<date>.json"` |

Static files from `public/`. MIME types must include `.webmanifest` → `application/manifest+json`,
`.js`/`.mjs` → `text/javascript`, `.png`, `.css`, `.html`, `.svg`. `index.html` and `sw.js`:
`Cache-Control: no-cache`. Unknown non-API paths return `index.html` (SPA fallback). Reject path traversal.

## Reminders (server/schedule.mjs + scheduler loop)

A loop wakes at each minute boundary (setTimeout to the next :00 second, re-armed every tick). Each tick
computes local `{ date, minutes (0–1439), weekday }` in `settings.timeZone` with `Intl.DateTimeFormat`
`formatToParts`. If a tick was late, process the missed minutes (at most 10 back) but send at most one
check-in reminder per tick. Never send the same `(kind, date, minute)` twice (keep a sent log in `state.json`,
pruned to the last 2 days).

Pure function to export and unit-test:
`dueReminders({ date, minutes, weekday }, settings, ctx) -> Array<{ kind: "checkin" | "night", repeat?: true }>`
where `ctx = { nightClosedToday: bool, minutesSinceLastEntry: number | null }`.

- **Check-in** is due when not paused, `startMin <= minutes < endMin`, and `(minutes - startMin) % intervalMin === 0`.
  Skip it if a `checkin` or `skip` record has `at` within the last `floor(intervalMin / 2)` minutes.
- **Night review** is due at `minutes === reviewMin` and again (`repeat: true`) at `reviewMin + 30`, only if
  not paused and there is no `night` record for today.

Payload (JSON string sent with web-push): `{ title, body, url, tag }`. Options: `TTL` 600 for check-in,
3600 for night; `topic` "checkin" / "night"; `urgency` "high" for check-in.

Check-in copy:
- If the latest `checkin` today has a non-empty `shouldBe`: body `Should be: <shouldBe>. Are you on it?`
- Else rotate by send count: `What am I feeling right now?`, `Pause. What's here?`,
  `Before the next tab: check in.`, `Ten seconds. What's going on?`, `Feeling, should, actually.`
- If 3 or more check-in reminders were sent since the latest `checkin`/`skip` record:
  body `One tap counts. Just the feeling is fine.`
- title `Check in`, url `/?go=checkin`, tag `checkin`.

Night copy: title `Close the day`, body `Day's done. 2 minutes to close it.`, plus ` Then the week.` when
today's weekday equals `weeklyDay`. If fewer than `streakHours` distinct hours were logged today, use
`Logged <n> of <streakHours> hours today. 2 minutes to close it.` url `/?go=night`, tag `night`.

Push failures: on HTTP 404 or 410 remove that subscription. Log other errors, keep the subscription.

## Client

### Shell
- `index.html`: `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`,
  `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style` = `default`, `apple-mobile-web-app-title` = `Check-in`,
  `theme-color` for light and dark, `<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">`,
  `<link rel="manifest" href="manifest.webmanifest">`, one `<script type="module" src="app.js">`.
- Manifest: `name` "Check-in", `short_name` "Check-in", `id` "/", `start_url` "/", `scope` "/",
  `display` "standalone", icons 192 and 512, background and theme colors from the design tokens.
- System font stack (`-apple-system, system-ui, sans-serif`); no web fonts, the app must work offline.
  Colors and tokens from `design.html`, light and dark via `prefers-color-scheme`. Inputs at 16px or
  larger (prevents iOS zoom). Tap targets at least 44px. Respect `env(safe-area-inset-*)`.
- Icons: generate the PNGs with a small Python stdlib script (zlib + struct), a simple shape in the
  design's accent color. Commit the PNGs. Delete the script or keep it as `scripts/make-icons.py`.

### Routes (hash based)
`#today` (default), `#checkin`, `#night`, `#week`, `#settings`, `#install`.
On load and whenever the service worker posts `{ go }`, read `go` from the query string or the message
and route to it, then clean the URL with `history.replaceState`.

### Install gate
If not standalone (`navigator.standalone !== true` and not `matchMedia('(display-mode: standalone)')`),
show `#install`: "Add Check-in to your Home Screen", steps: tap Share, tap Add to Home Screen, keep
Open as Web App on, tap Add, then open Check-in from your Home Screen. Include a small "Continue in the
browser" link that sets a localStorage flag (for testing on the Mac). Reminders only work from the Home
Screen app; say so.

### First run
If localStorage `onboarded` is not set, open `#settings` with the line "Choose when to be reminded. You
can change this anytime." and a primary button "Start" that saves settings, sets `onboarded`, and
goes to `#today`.

### Reminders on/off (Settings, top card)
- Prefetch the VAPID key and the service worker registration when Settings renders.
- Button "Turn on reminders": inside the click handler call `registration.pushManager.subscribe(
  { userVisibleOnly: true, applicationServerKey })` IMMEDIATELY with no `await` before it, then POST the
  subscription. States: "Reminders are on" (with "Send a test reminder" button), "Reminders are off",
  "Notifications are blocked. Turn them on in iPhone Settings > Notifications > Check-in."
- On every app open: if `getSubscription()` returns one, POST it (idempotent, heals a lost server copy).

### Check-in screen (`#checkin`)
Follow design.html screen 1. Header `<time> · Check in`, Skip link (records a `skip`, goes to Today).
1. "What am I feeling?" text input, autofocus is NOT used (iOS keyboard jump); chips below from
   `chipsFor(records, "feeling")`. Tapping a chip appends it (comma separated) to the input.
2. "Where in my body? (optional)" text input + chips from `chipsFor(records, "body")`.
3. "What should I be doing?" input prefilled with the latest checkin's `shouldBe` and a hint
   "same as last check-in" when prefilled.
4. "What am I actually doing?" input + chips from `chipsFor(records, "actually")`. Tapping a chip REPLACES the value.
5. Two large buttons "On it" and "Escaping", and a smaller dashed "Planned break". Each one saves the
   check-in with that status. If feeling is empty show inline error "Write what you're feeling first."
   next to the field and don't save.
After saving show a confirmation view for about 1.5 s then go to Today:
- escaping: "Noted. Back to: <shouldBe>" (or "Noted. Back to it." when empty)
- on: "Saved. Keep going."  · break: "Enjoy the break."

### Today (`#today`)
Design screen 2: date header, streak pill "<n>-day streak" (hide when 0, show "Start a streak today" muted),
"Hours logged today · <n> of <streakHours>" with one cell per active hour, the line under it
("<k> more hours, then the night review, keeps the streak." / "Close the night review to keep the streak." /
"Today counts."), the check-in dots (on = calm color, escaping = hard color, break/skip = hollow) with the
legend, "Last: <feeling> · <actually or shouldBe>, <time>", "Working on today: <yesterday's improve>",
"This week: <latest week change>" when present, primary "Check in now".
Banners at the top: "Paused today." when paused; after reviewTime and night not closed: "Ready to close the
day? About 2 minutes." → `#night`; before 12:00 when yesterday's night is not closed and yesterday had any
check-ins: "Close yesterday?" → `#night?date=<yesterday>` (the night screen works for a given date);
on weeklyDay after the night is closed and the week isn't: "Close the week. About 5 minutes." → `#week`.
Footer links: "This week" (→ `#week`), "Settings".

### Night review (`#night`, optional `date` param)
Design screen 3. Streak line ("<n> of <streakHours> hours logged. Close the day to make it <streak+1>." when
the day will qualify; otherwise "<n> of <streakHours> hours logged. The streak needs <streakHours>."),
yesterday's improve with Did it / Partly / Not yet (hidden when there was none), Today counts
"On it <a> · Escaping <b> · Skipped <c>" (breaks shown as "Breaks <d>" only when > 0), the "When I escaped"
section with three tallies (I was avoiding / I felt just before / I went to) and the peak window line,
or "No escapes logged today." The two text areas, "Close the day" button (enabled when at least one box
has text; if none, show inline error "Write at least one line."). After closing: "Day closed. <n>-day
streak." and, on weeklyDay, a button "Now the week" → `#week`.

### Weekly review (`#week`)
Design screen 4, for the week ending on the most recent `weeklyDay` on or after today... precisely: the
week containing today, ending on `weeklyDay`. Show on-it % with the previous week comparison, a 7-bar
stacked chart (on vs escaping counts per day, labeled by weekday initial), the three tallies, the pattern
sentence, two text areas "What pattern do I see?" and "One change for next week", "Close the week".

### Settings (`#settings`)
Design screen 5 plus: reminders card (above), interval chips + Custom (number input, minutes 15–480),
active hours (two `<input type="time">`), night review time, weekly review day (select), streak needs
(read-only line "5 hours + night review"), "Pause until tomorrow" switch, a warning line when
`(activeEnd - activeStart) / intervalMin` gives fewer reminders than `streakHours`:
"At this pace you'd get <n> reminders a day. The streak needs <streakHours> hours, so add check-ins yourself.",
backup line ("Backed up to the Mac mini <relative time>." / "<n> entries waiting to back up. Open Tailscale
to sync."), "Export my data" (fetch `/api/export`; on iPhone use `navigator.share({ files })` when
available, else open the URL), and "Everything stays on your phone and your Mac mini."
Settings changes save immediately with PUT (except first run, which saves on Start).

### Storage and sync (app.js)
- IndexedDB database `checkin`, store `records` (keyPath `id`), plus `meta` store for `lastPullAt`.
  Each local record carries `synced: boolean` (strip it before sending).
- Every save writes IndexedDB first (works offline), then `sync()`: POST unsynced records, mark synced on
  200; then GET `/api/records?since=<lastPullAt>` and merge by `updatedAt`. If the local store is empty,
  pull everything (restores after reinstall). Run `sync()` on app open and on `visibilitychange` to visible.
- Call `navigator.storage.persist()` once (ignore the result).
- Network failures never block the UI; show nothing alarming, just the Settings backup line.

### Service worker (sw.js)
- `CACHE_VERSION` constant. On install, precache: `/`, `index.html`, `app.js`, `logic.js`, `styles.css`,
  `manifest.webmanifest`, the icons; `skipWaiting()`. On activate, delete old caches, `clients.claim()`.
- Fetch: `/api/*` → network only. Navigations → network first, fall back to cached `index.html`.
  Other same-origin GETs → cache first, then network (and cache it).
- `push`: parse JSON (fallback title "Check in", body "What am I feeling right now?", url "/?go=checkin"),
  ALWAYS call `self.registration.showNotification(title, { body, tag, data: { url } })` inside
  `event.waitUntil`, even if parsing fails (iOS revokes subscriptions that skip notifications).
- `notificationclick`: close it; find a window client, `focus()` it and `postMessage({ go })` and
  `navigate(url)` if supported; otherwise `clients.openWindow(url)`.

### logic.js (pure, exported, unit-tested in test/logic.test.mjs)
- `localDate(d = new Date())` → `YYYY-MM-DD` in device local time; `addDays(date, n)`; `weekdayOf(date)`.
- `tokens(text)`: split on commas and semicolons, trim, lowercase, drop empties, dedupe.
- `chipsFor(records, field, limit = 8)`: for `feeling` and `body` use `tokens`; for `shouldBe` and
  `actually` use the whole trimmed value, merged case-insensitively, displayed with the most recent casing.
  Rank by count, then by most recent use. Only `checkin` records.
- `hoursLogged(records, date)` → sorted array of distinct hours that have a `checkin` (any status; skips don't count).
- `dayQualifies(records, date, streakHours)`: `hoursLogged.length >= streakHours` and a `night` record exists.
- `streak(records, today, streakHours, nowMinutes)`: consecutive qualifying days ending at today if today
  qualifies, else ending at yesterday if yesterday qualifies, else (when `nowMinutes < 720` and yesterday has
  enough hours but no night record yet) ending at the day before yesterday, else 0. A missed day ends it.
- `dayStats(records, date)` → `{ on, escaping, breaks, skipped, avoided, feltBefore, wentTo, peakWindow }`
  where the three tallies are `[{ label, count }]` sorted desc (top 3) over escaping check-ins: `avoided`
  from `shouldBe`, `feltBefore` from `tokens(feeling)`, `wentTo` from `actually`. `peakWindow` is the 3-hour
  window with the most escapes, as `"1 to 4 PM"` style text, only when there are at least 2 escapes, else null.
- `weekRange(today, weeklyDay)` → `{ weekStart, weekEnd }` (7 days, ending on weeklyDay, containing today).
- `weekStats(records, weekStart)` → `{ onPct, prevOnPct, perDay: [{ date, on, escaping }], avoided,
  feltBefore, wentTo, pattern }`; `onPct` = on / (on + escaping) rounded, null when no data. `pattern` is the
  most frequent (avoided, wentTo) pair among escapes with its count and peak window, as a sentence like
  "Pattern: bored on the Q4 report, then YouTube, 1 to 4 PM. It happened 6 times." (use the most common
  feeling token for that pair), or null when fewer than 2 escapes.
- `formatTime(iso)` → "2:15 PM"; `windowLabel(startHour)` → "1 to 4 PM" (handles AM/PM crossing: "11 AM to 2 PM").

## Copy rules
Plain, short, active voice, sentence case, no exclamation marks, no emoji, no "please", no "successfully".
The UI speaks to the user as "you" except the check-in and review prompts, which are in the user's own
voice ("What am I feeling?", "What should I improve tomorrow?").
