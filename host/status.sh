#!/bin/bash
# Is the model host healthy? Answers the three questions in order:
# is the job loaded, is the port answering, and what model is loaded.
set -uo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/config.sh"

if launchctl print "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1; then
  echo "launchd job:  loaded ($SERVICE_LABEL)"
else
  echo "launchd job:  NOT loaded — run host/install-service.sh"
fi

if models=$(curl -fsS -m 5 "http://127.0.0.1:$PORT/v1/models" 2>/dev/null); then
  echo "port $PORT:    answering"
  echo "model:        $(echo "$models" | sed -n 's/.*"id": *"\([^"]*\)".*/\1/p')"

  # /v1/models is served by the HTTP thread and keeps returning 200 even when
  # the generation thread has died (a Metal OOM kills that thread but leaves
  # the process running, so launchd KeepAlive never fires). Only an actual
  # completion proves the server can do its job.
  echo -n "generation:   "
  if curl -fsS -m 120 -X POST "http://127.0.0.1:$PORT/v1/chat/completions" \
       -H 'content-type: application/json' \
       -d "{\"model\":\"$MODEL_ID\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: OK\"}],\"max_tokens\":10}" \
       >/dev/null 2>&1; then
    echo "working"
  else
    echo "NOT WORKING — the server answers /v1/models but cannot generate."
    echo "              Its generation thread has probably died. Check for a"
    echo "              traceback, then restart:"
    echo "                tail -50 $LOG_PATH"
    echo "                ./host/install-service.sh"
  fi
else
  echo "port $PORT:    no response — tail $LOG_PATH"
fi

if launchctl print "gui/$(id -u)/$WATCHDOG_LABEL" >/dev/null 2>&1; then
  echo "watchdog:     active (every $((WATCHDOG_INTERVAL / 60))m)"
else
  echo "watchdog:     NOT installed — run host/install-service.sh"
fi

ip=$(ipconfig getifaddr en0 2>/dev/null || true)
[ -n "$ip" ] && echo "LAN address:  http://$ip:$PORT"
echo "log:          $LOG_PATH"
echo "watchdog log: $WATCHDOG_LOG"
