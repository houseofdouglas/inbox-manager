#!/bin/bash
# Stops the model server and removes its launchd job. Leaves the venv, the
# downloaded model, and the log in place.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/config.sh"

PLIST="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
WATCHDOG_PLIST="$HOME/Library/LaunchAgents/$WATCHDOG_LABEL.plist"

# Watchdog first — otherwise it would notice the server going away and try to
# restart the job we are in the middle of removing.
launchctl bootout "gui/$(id -u)/$WATCHDOG_LABEL" 2>/dev/null || true
rm -f "$WATCHDOG_PLIST"
echo "Removed $WATCHDOG_LABEL"

launchctl bootout "gui/$(id -u)/$SERVICE_LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "Removed $SERVICE_LABEL. The venv ($VENV_DIR) and model cache are untouched."
