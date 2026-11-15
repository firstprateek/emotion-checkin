#!/bin/sh
# Copy the app out of ~/Documents (macOS blocks background services from reading it)
# into ~/apps/checkin and (re)start the launchd service. Data lives in ~/apps/checkin-data.
set -eu
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/apps/checkin"
DATA="$HOME/apps/checkin-data"
PLIST="$HOME/Library/LaunchAgents/local.checkin.server.plist"
mkdir -p "$DEST" "$DATA"
rsync -a --delete --exclude .git --exclude data --exclude test --exclude deploy --exclude '*.html.bak' \
  "$SRC/package.json" "$SRC/package-lock.json" "$SRC/server" "$SRC/public" "$SRC/node_modules" "$DEST/"
# The app's origin, used as the VAPID contact URL. Override with VAPID_SUBJECT=...
if [ -z "${VAPID_SUBJECT:-}" ]; then
  DNS="$(tailscale status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).Self.DNSName.replace(/\.$/,"")))')"
  [ -n "$DNS" ] || { echo "Could not read the tailnet name; set VAPID_SUBJECT." >&2; exit 1; }
  VAPID_SUBJECT="https://$DNS:8443"
fi
sed -e "s#__HOME__#$HOME#g" -e "s#__VAPID_SUBJECT__#$VAPID_SUBJECT#g" \
  "$SRC/deploy/local.checkin.server.plist" > "$PLIST"
launchctl bootout "gui/$(id -u)/local.checkin.server" 2>/dev/null || true
# bootout returns before the old service is fully gone, so bootstrap can fail at first; retry.
for i in 1 2 3 4 5; do
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null && break
  [ "$i" = 5 ] && { echo "launchctl bootstrap failed." >&2; exit 1; }
  sleep 1
done
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:8790/api/health >/dev/null 2>&1; then echo "Server is up."; exit 0; fi
  sleep 1
done
echo "Server did not answer. See ~/Library/Logs/checkin-server.log" >&2
exit 1
