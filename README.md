# Check-in

A private iPhone home-screen web app for logging feelings through the day. The Mac mini serves
it and sends the reminders. Tailscale makes it reachable from your tailnet only.

- `server/`: a Node HTTP server with no framework. It serves `public/`, runs the JSON API under
  `/api` and sends reminders with Web Push.
- `public/`: the app (vanilla JS modules plus a service worker). There is no build step.
- `data/`: your entries, settings and push keys. Git ignores this folder. Back it up.

`SPEC.md` is the full contract. `design.html` has the screens and copy.

## Requirements

- Node 22 or newer. The Mac mini runs Node 26 at `/opt/homebrew/bin/node`.
- The only runtime dependency is `web-push@4.0.0`. Install it with `npm install`.

## Run

```sh
npm install
npm start                      # http://127.0.0.1:8790
```

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Interface to listen on. Keep it on loopback; Tailscale Serve proxies to it. |
| `PORT` | `8790` | Port to listen on. `0` picks a free port. |
| `DATA_DIR` | `./data` (next to `package.json`) | Where the JSON files live. |
| `VAPID_SUBJECT` | `https://example.com/checkin` (placeholder) | Contact URL sent to push services. A URL, not an email address. `scripts/deploy.sh` sets it to the app's origin, `https://<machine>.<tailnet>.ts.net:8443`, read from `tailscale status`. |

On first start the server creates `data/vapid.json` (the Web Push key pair). If you delete it,
every existing push subscription stops working. Each phone then has to turn reminders off and on.

## Test

```sh
npm test
```

This runs every `test/*.test.mjs` file with Node's built-in test runner:

- `test/schedule.test.mjs`: the pure reminder rules in `server/schedule.mjs`. It covers interval
  alignment, active-hour edges, pause, the night review and its 30-minute repeat, skipping when
  you logged something recently, notification copy and time zones across DST.
- `test/api.test.mjs`: boots the real server on a random port with a temporary `DATA_DIR`. It calls
  every endpoint, runs scheduler ticks with a fake clock and checks static files and path traversal.
  Push sending is mocked, so no test touches the network.
- `test/logic.test.mjs`: the client's pure functions in `public/logic.js`.
- `test/sw.test.mjs`: runs `public/sw.js` with fake service-worker globals and checks its fetch
  fallbacks (slow network, proxy error pages, offline) and asset refresh.

The script is `node --test 'test/**/*.test.mjs'` rather than `node --test test/`, because Node 26
does not accept a directory there.

## Data files (`DATA_DIR`)

| File | Contents |
|---|---|
| `vapid.json` | Web Push key pair, generated once. |
| `settings.json` | Reminder settings. The server is the source of truth. |
| `subscriptions.json` | Push subscriptions, one per installed phone, keyed by endpoint. |
| `records.json` | Every check-in, skip, night review and weekly review. |
| `state.json` | Reminder bookkeeping: the sent log from the last 2 days, send count and last push time. |

Every write goes to a temp file first, then the server renames it over the old one, so a crash
can't leave a half-written file. If a file isn't valid JSON at startup, the server moves it aside
as `<name>.corrupt-<time>` and starts fresh. It doesn't overwrite the bad file.

`GET /api/export` downloads everything as one JSON file.

## How reminders work

iPhone web apps can't schedule notifications themselves, so the server pushes every reminder.

- A loop wakes at the start of each minute. It works out the local date and time in
  `settings.timeZone`, which the phone reports each time the app opens.
- **Check-in** reminders go out every `intervalMin` minutes from `activeStart`, until just before
  `activeEnd`. One is skipped when a check-in or skip was logged within half an interval.
- **Night review** goes out at `reviewTime`, and again 30 minutes later if the night still isn't
  closed. A review time after 23:29 gets no repeat.
- **Pause until tomorrow** stops every reminder for that local date.
- If the Mac was asleep or busy, the next tick catches up on up to 10 missed minutes. It still
  sends at most one check-in. The sent log stops the same reminder going out twice, including in
  the hour that repeats when clocks fall back.
- If a push service answers 404 or 410, the server removes that subscription. For any other error
  it logs the error and keeps the subscription. The app re-sends its subscription every time it
  opens, which repairs a lost server copy.

`GET /api/status` shows the subscription count, last push time, next check-in, next review and
whether reminders are paused.

## Deploy on the Mac mini

1. Install dependencies:
   ```sh
   cd ~/Documents/emotion-checkin && npm install
   ```
2. Deploy and keep the server running with launchd:
   ```sh
   ./scripts/deploy.sh
   ```
   macOS blocks background services from reading `~/Documents`, so the script copies the app to
   `~/apps/checkin` and runs it from there with `DATA_DIR=~/apps/checkin-data`. It fills in
   `deploy/local.checkin.server.plist` (your home folder and `VAPID_SUBJECT`), installs it (`HOST=127.0.0.1`, `PORT=8790`, restarts on exit, logs to
   `~/Library/Logs/checkin-server.log`) and waits for `/api/health`. Run it again after any change.
3. Expose it to your tailnet only (not Funnel) with Tailscale Serve:
   ```sh
   tailscale serve --bg --https=8443 http://127.0.0.1:8790
   ```
   The app's origin is `https://<machine>.<tailnet>.ts.net:8443`. Every client URL is
   relative, so a different origin also works. But a phone's push subscription belongs to the
   origin the app was installed from, so pick the origin once.
4. Check it:
   ```sh
   curl -s http://127.0.0.1:8790/api/health
   curl -s http://127.0.0.1:8790/api/status
   ```

### Updating the app

1. Edit the files in `public/`.
2. Bump `CACHE_VERSION` in `public/sw.js` (for example `checkin-v2` to `checkin-v3`). Do this for
   every change in `public/`. The new `sw.js` makes the phone download a fresh copy of every file
   in one step, so the page and its scripts stay in step.
3. Run `./scripts/deploy.sh` to copy the change to `~/apps/checkin` and restart the server.
4. On the iPhone, open Check-in, close it, then open it again. The first open installs the new
   service worker and the second runs on it.

If you forget step 2, the service worker still refreshes `app.js`, `logic.js`, `styles.css` and
the icons in the background, so the phone catches up one open later. The page and its scripts
can be one version apart for that one open.

### Install on the iPhone

1. With Tailscale connected, open the origin above in Safari.
2. Tap Share, then Add to Home Screen. Keep Open as Web App on, then tap Add.
3. Open Check-in from your Home Screen. Choose your hours, tap Start, then tap Turn on reminders.
   Then tap Send a test reminder.

Reminders only work in the Home Screen app, not in a Safari tab.

### Troubleshooting

- **No reminders arrive.** Check that `/api/status` shows at least one subscription, then send a
  test reminder from Settings. If the count is 0, open the app; it re-sends its subscription.
  If that doesn't help, turn reminders off and on.
- **Reminders arrive at the wrong time.** Check `timeZone` in `GET /api/settings`. Opening the app
  updates it.
- **Entries aren't backing up.** The phone keeps everything in IndexedDB and syncs when the server
  is reachable. Open Tailscale on the phone, then open the app.
- **Logs.** See `~/Library/Logs/checkin-server.log`.

## API

All routes are under `/api` and use JSON. The body limit is 1 MB. Errors look like
`{ "error": "<sentence>" }`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | `{ ok: true }` |
| GET | `/api/vapid-public-key` | `{ key }` (base64url) |
| POST | `/api/subscriptions` | `{ subscription }`. Adds or updates by endpoint. |
| DELETE | `/api/subscriptions` | `{ endpoint }` |
| GET | `/api/settings` | Full settings. |
| PUT | `/api/settings` | Partial settings. Returns the full settings, or 400 with a reason. |
| GET | `/api/records?since=ISO` | `{ records, serverTime }`. Returns records updated after `since`, plus any the server received after it. |
| POST | `/api/records` | `{ records: [...] }`. Last write wins by `updatedAt`. One invalid record rejects the whole batch with 400. Returns `{ ok, accepted, applied }`. |
| POST | `/api/test-push` | `{ sent }` |
| GET | `/api/status` | `{ subscriptions, lastPushAt, nextCheckinAt, nextReviewAt, paused }` |
| GET | `/api/export` | Downloads `checkins-<date>.json` (all records and settings). |

Every other path serves a file from `public/`. Unknown paths get `index.html`, so the app handles
routing. Paths containing `..`, encoded slashes, backslashes or NUL bytes get a 400.
