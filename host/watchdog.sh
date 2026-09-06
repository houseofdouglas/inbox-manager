#!/bin/bash
# Detects the failure mode launchd cannot see: the model server process alive
# and answering /v1/models while its generation thread is dead, so every
# completion hangs forever. KeepAlive never fires because nothing exited.
#
# Observed 2026-09-04: a Metal OOM killed mlx_lm's Thread-1 (_generate). The
# server looked healthy for 22 hours and classified nothing.
#
# Run periodically by launchd. Silent when healthy; every state change is
# logged. Deliberately not `set -e` — a failing probe is the normal path.
set -uo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/config.sh"

mkdir -p "$WATCHDOG_STATE_DIR" "$(dirname "$WATCHDOG_LOG")"
STRIKES_FILE="$WATCHDOG_STATE_DIR/strikes"
LAST_RESTART_FILE="$WATCHDOG_STATE_DIR/last_restart"
RESTART_LOG="$WATCHDOG_STATE_DIR/restarts"

now=$(date +%s)
log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$WATCHDOG_LOG"; }
read_num() { [ -f "$1" ] && cat "$1" 2>/dev/null || echo 0; }

# --- Grace period ---------------------------------------------------------
# After a restart the model has to load back into memory. Probing during that
# window would fail and trigger another restart, and another.
last_restart=$(read_num "$LAST_RESTART_FILE")
if [ "$last_restart" -gt 0 ] && [ $((now - last_restart)) -lt "$WATCHDOG_GRACE" ]; then
  exit 0
fi

# --- Probe ----------------------------------------------------------------
# A completion, not /v1/models: liveness is exactly what lies here.
if curl -fsS -m "$WATCHDOG_TIMEOUT" -X POST "http://127.0.0.1:$PORT/v1/chat/completions" \
     -H 'content-type: application/json' \
     -d "{\"model\":\"$MODEL_ID\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: OK\"}],\"max_tokens\":10}" \
     >/dev/null 2>&1; then
  # Recovered after visible trouble? Say so. Otherwise stay quiet.
  if [ "$(read_num "$STRIKES_FILE")" -gt 0 ]; then
    log "recovered — generation responding again"
  fi
  echo 0 > "$STRIKES_FILE"
  exit 0
fi

strikes=$(( $(read_num "$STRIKES_FILE") + 1 ))
echo "$strikes" > "$STRIKES_FILE"

if [ "$strikes" -lt "$WATCHDOG_STRIKES" ]; then
  log "generation probe failed ($strikes/$WATCHDOG_STRIKES) — server may just be busy"
  exit 0
fi

# --- Circuit breaker ------------------------------------------------------
# If restarts are not fixing it, stop thrashing and make the log say why.
cutoff=$((now - WATCHDOG_RESTART_WINDOW))
recent=0
if [ -f "$RESTART_LOG" ]; then
  awk -v c="$cutoff" '$1 >= c' "$RESTART_LOG" > "$RESTART_LOG.tmp" 2>/dev/null
  mv "$RESTART_LOG.tmp" "$RESTART_LOG" 2>/dev/null
  recent=$(wc -l < "$RESTART_LOG" | tr -d ' ')
fi

if [ "$recent" -ge "$WATCHDOG_MAX_RESTARTS" ]; then
  log "NOT restarting: already restarted $recent times in the last $((WATCHDOG_RESTART_WINDOW / 60))m."
  log "  Restarting is not fixing this. Look at the server log yourself:"
  log "    tail -50 $LOG_PATH"
  log "  Common cause: the model is too large for this machine's memory under"
  log "  the current BATCH_SIZE. Lower BATCH_SIZE or use a smaller model."
  exit 1
fi

# --- Restart --------------------------------------------------------------
log "generation dead after $strikes probes — restarting $SERVICE_LABEL"
if launchctl kickstart -k "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1; then
  log "restart issued"
else
  log "kickstart FAILED — is the service loaded? try: ./host/install-service.sh"
fi

echo "$now" >> "$RESTART_LOG"
echo "$now" > "$LAST_RESTART_FILE"
echo 0 > "$STRIKES_FILE"
