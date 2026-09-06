#!/bin/bash
# Serves the email-classifier model over an OpenAI-compatible API for
# inbox-manager. Managed by launchd — see host/install-service.sh.
#
# Every flag below exists because of a specific failure. Do not drop them.
#
# caffeinate: a Mac left to itself idle-sleeps (often after a minute). Without
# this the machine sleeps mid-run while sockets stay open via TCPKeepAlive, so
# the client sees hangs and timeouts against an apparently healthy server
# rather than a clean connection refused.
#
# --host 0.0.0.0: mlx binds IPv4 only. Clients must connect by IP, not the
# .local name, which intermittently resolves to IPv6-only records.
#
# --chat-template-args enable_thinking=false: gemma-4 builds otherwise emit a
# reasoning block before the answer, costing ~255 completion tokens per
# classification instead of ~7. That overruns the classifier's max_tokens
# budget (200 single / 750 per 15-email batch) and truncates the JSON
# mid-object. Leaving the arg unset is NOT equivalent to passing false --
# it must be explicit.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/config.sh"

if [ ! -x "$VENV_DIR/bin/python" ]; then
  echo "No Python venv at $VENV_DIR. Run host/setup-host.sh first." >&2
  exit 1
fi

exec /usr/bin/caffeinate -dimsu "$VENV_DIR/bin/python" -m mlx_lm server \
  --model "$MODEL_ID" \
  --host 0.0.0.0 \
  --port "$PORT" \
  --chat-template-args '{"enable_thinking": false}' \
  --log-level INFO
