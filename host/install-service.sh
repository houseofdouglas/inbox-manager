#!/bin/bash
# Renders the launchd plist for this machine and starts the model server.
# Re-running replaces the existing job rather than duplicating it.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/config.sh"

TEMPLATE="$HERE/com.inbox-manager.mlx-server.plist.template"
PLIST="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
SCRIPT_PATH="$HERE/mlx-server.sh"
WATCHDOG_TEMPLATE="$HERE/com.inbox-manager.mlx-watchdog.plist.template"
WATCHDOG_PLIST="$HOME/Library/LaunchAgents/$WATCHDOG_LABEL.plist"
WATCHDOG_SCRIPT="$HERE/watchdog.sh"
DOMAIN="gui/$(id -u)"

[ -f "$TEMPLATE" ] || { echo "Missing $TEMPLATE" >&2; exit 1; }
[ -x "$VENV_DIR/bin/python" ] || { echo "No venv at $VENV_DIR — run host/setup-host.sh first." >&2; exit 1; }

# launchd cannot create the parent directory of its log path; it fails silently.
mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

sed -e "s|__LABEL__|$SERVICE_LABEL|g" \
    -e "s|__SCRIPT_PATH__|$SCRIPT_PATH|g" \
    -e "s|__LOG_PATH__|$LOG_PATH|g" \
    -e "s|__HOME__|$HOME|g" \
    "$TEMPLATE" > "$PLIST"
plutil -lint "$PLIST" >/dev/null || { echo "Rendered plist is malformed: $PLIST" >&2; exit 1; }
echo "Wrote $PLIST"

# Replace any running copy. bootout on a job that isn't loaded is not an error
# here — we only care that nothing is loaded when we bootstrap.
launchctl bootout "$DOMAIN/$SERVICE_LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Loaded $SERVICE_LABEL"

# The watchdog catches the failure launchd cannot: process alive, generation
# thread dead. Installed alongside the server so it is never forgotten.
if [ -f "$WATCHDOG_TEMPLATE" ]; then
  sed -e "s|__LABEL__|$WATCHDOG_LABEL|g" \
      -e "s|__SCRIPT_PATH__|$WATCHDOG_SCRIPT|g" \
      -e "s|__INTERVAL__|$WATCHDOG_INTERVAL|g" \
      -e "s|__LOG_PATH__|$WATCHDOG_LOG|g" \
      -e "s|__HOME__|$HOME|g" \
      "$WATCHDOG_TEMPLATE" > "$WATCHDOG_PLIST"
  plutil -lint "$WATCHDOG_PLIST" >/dev/null || { echo "Rendered watchdog plist is malformed" >&2; exit 1; }
  # Start the watchdog inside its own grace period: RunAtLoad fires it
  # immediately, and the model needs a minute or two to load. Without this it
  # records a spurious failure on every install.
  mkdir -p "$WATCHDOG_STATE_DIR"
  date +%s > "$WATCHDOG_STATE_DIR/last_restart"
  echo 0 > "$WATCHDOG_STATE_DIR/strikes"

  launchctl bootout "$DOMAIN/$WATCHDOG_LABEL" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$WATCHDOG_PLIST"
  echo "Loaded $WATCHDOG_LABEL — probes generation every $((WATCHDOG_INTERVAL / 60))m"
  echo "  log: $WATCHDOG_LOG"
fi

echo "Waiting for the server to answer on port $PORT (the model takes a while to load)..."
for i in $(seq 1 60); do
  if curl -fsS -m 2 "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1; then
    echo
    echo "Server is up. It reports:"
    curl -fsS "http://127.0.0.1:$PORT/v1/models"
    echo
    ip=$(ipconfig getifaddr en0 2>/dev/null || true)
    if [ -n "$ip" ]; then
      echo "From the Mac running inbox-manager, set in .env:"
      echo "    LLAMA_BASE_URL=http://$ip:$PORT"
      echo "and verify with:  curl http://$ip:$PORT/v1/models"
    fi
    exit 0
  fi
  sleep 5
done

echo
echo "Still no response after 5 minutes. Check the log:" >&2
echo "    tail -f $LOG_PATH" >&2
exit 1
