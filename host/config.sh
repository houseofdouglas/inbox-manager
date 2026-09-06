#!/bin/bash
# Single source of truth for the model host. Both mlx-server.sh and
# setup-host.sh read this, so changing a model means changing one line.
#
# Override without editing this file (it is tracked in git) by creating
# host/config.local.sh, which is git-ignored:
#     echo 'MODEL_ID="mlx-community/some-smaller-model"' > host/config.local.sh

# Local overrides are read FIRST, so they act as inputs to everything below.
# Every setting here uses ${VAR:-default}, which means anything config.local.sh
# defines survives — including values other settings are derived from. Sourcing
# it last would silently ignore an override like LABEL_PREFIX, because the
# labels built from it would already have been computed.
_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$_here/config.local.sh" ]; then
  . "$_here/config.local.sh"
fi

# The model served to inbox-manager. The classifier prompt has only been
# validated against this one — see host/README.md before substituting.
MODEL_ID="${MODEL_ID:-mlx-community/gemma-4-26B-A4B-it-qat-4bit}"

# Port the OpenAI-compatible API listens on. Must match LLAMA_BASE_URL in .env.
PORT="${PORT:-8080}"

# Python virtualenv holding mlx-lm.
VENV_DIR="${VENV_DIR:-$HOME/mlx-env}"

# Pinned so a fresh install reproduces the verified stack. To move forward,
# bump this and re-run setup-host.sh.
MLX_LM_VERSION="${MLX_LM_VERSION:-0.31.3}"
PYTHON_VERSION="${PYTHON_VERSION:-3.12}"

# launchd labels. One prefix drives every job this project installs, so
# renaming them is a single line in config.local.sh:
#     LABEL_PREFIX="com.yourname"
# Keep it in reverse-DNS form — that is the convention launchd expects, and it
# keeps your jobs distinguishable from everyone else's in `launchctl list`.
LABEL_PREFIX="${LABEL_PREFIX:-com.inbox-manager}"
SERVICE_LABEL="${SERVICE_LABEL:-$LABEL_PREFIX.mlx-server}"
LOG_DIR="${LOG_DIR:-$HOME/logs}"
LOG_PATH="${LOG_PATH:-$LOG_DIR/mlx-server.log}"

# Rough floor for the reference model: ~15 GB of weights plus working memory.
MIN_RAM_GB="${MIN_RAM_GB:-32}"
MIN_FREE_DISK_GB="${MIN_FREE_DISK_GB:-25}"

# --- Watchdog -----------------------------------------------------------
# launchd's KeepAlive only restarts a process that EXITS. A Metal OOM kills
# mlx_lm's generation thread and leaves the process running, so the server
# keeps answering /v1/models while every completion hangs forever. The
# watchdog is what catches that: it asks for an actual completion.
WATCHDOG_LABEL="${WATCHDOG_LABEL:-$LABEL_PREFIX.mlx-watchdog}"
WATCHDOG_LOG="${WATCHDOG_LOG:-$LOG_DIR/mlx-watchdog.log}"
WATCHDOG_STATE_DIR="${WATCHDOG_STATE_DIR:-$LOG_DIR/.mlx-watchdog}"

# How often to probe, in seconds.
WATCHDOG_INTERVAL="${WATCHDOG_INTERVAL:-300}"

# How long a single probe may take. Generous on purpose: a server working
# through a large classification batch is busy, not broken, and restarting it
# mid-batch would throw away real work.
WATCHDOG_TIMEOUT="${WATCHDOG_TIMEOUT:-120}"

# Consecutive failures before restarting. At the defaults that is ~15 minutes
# of a genuinely unresponsive server before anything drastic happens.
WATCHDOG_STRIKES="${WATCHDOG_STRIKES:-3}"

# Quiet period after a restart while the model loads back into memory —
# probing during that window would just trigger another restart.
WATCHDOG_GRACE="${WATCHDOG_GRACE:-900}"

# Circuit breaker: if restarting is not helping, stop restarting and leave a
# loud log entry rather than thrashing the machine.
WATCHDOG_MAX_RESTARTS="${WATCHDOG_MAX_RESTARTS:-3}"
WATCHDOG_RESTART_WINDOW="${WATCHDOG_RESTART_WINDOW:-3600}"
