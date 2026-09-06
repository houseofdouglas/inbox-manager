#!/bin/bash
# Provisions this Mac as the model host for inbox-manager: checks the hardware,
# builds a pinned Python venv with mlx-lm, and downloads the model.
# Safe to re-run — each step is skipped if already done.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/config.sh"

say()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

say "1/5  Hardware"

[ "$(uname -s)" = "Darwin" ] || die "This host kit is macOS-only (found $(uname -s))."
[ "$(uname -m)" = "arm64" ] || die "Apple Silicon required — MLX does not run on Intel Macs."
ok "$(sysctl -n hw.model), $(uname -m)"

ram_gb=$(( $(sysctl -n hw.memsize) / 1073741824 ))
if [ "$ram_gb" -lt "$MIN_RAM_GB" ]; then
  warn "$ram_gb GB of RAM; $MODEL_ID was validated on ${MIN_RAM_GB} GB."
  warn "It may still run, but expect Metal out-of-memory errors under load."
  warn "Consider a smaller model — see host/README.md — then re-run with:"
  warn "    echo 'MODEL_ID=\"...\"' > host/config.local.sh"
  printf '  Continue anyway? [y/N] '
  read -r reply
  [ "$reply" = "y" ] || [ "$reply" = "Y" ] || die "Stopped."
else
  ok "$ram_gb GB unified memory"
fi

free_gb=$(df -g "$HOME" | awk 'NR==2 {print $4}')
[ "$free_gb" -ge "$MIN_FREE_DISK_GB" ] \
  || die "$free_gb GB free in $HOME; the model needs about $MIN_FREE_DISK_GB GB."
ok "$free_gb GB free disk"

say "2/5  uv"

# The astral installer drops uv in ~/.local/bin, which is not on a
# non-interactive PATH — look there before concluding it is missing.
UV="$(command -v uv 2>/dev/null || true)"
[ -n "$UV" ] || [ ! -x "$HOME/.local/bin/uv" ] || UV="$HOME/.local/bin/uv"
if [ -z "$UV" ]; then
  cat >&2 <<'MSG'
  uv is not installed. Install it, then re-run this script:

      brew install uv

  or follow the official instructions at https://docs.astral.sh/uv/
MSG
  exit 1
fi
ok "uv $("$UV" --version | awk '{print $2}') ($UV)"

say "3/5  Python environment"

if [ -x "$VENV_DIR/bin/python" ]; then
  ok "venv exists at $VENV_DIR ($("$VENV_DIR/bin/python" --version))"
else
  "$UV" venv --python "$PYTHON_VERSION" "$VENV_DIR"
  ok "created venv at $VENV_DIR"
fi

"$UV" pip install --quiet --python "$VENV_DIR/bin/python" \
  "mlx-lm==$MLX_LM_VERSION" "huggingface_hub[hf_transfer]"
ok "mlx-lm $MLX_LM_VERSION installed"

say "4/5  Model"

# hf caches by repo id; a second run re-verifies rather than re-downloading.
echo "  Downloading $MODEL_ID (about 15 GB for the reference model)."
echo "  This is the slow step. It resumes if interrupted."
HF_HUB_ENABLE_HF_TRANSFER=1 "$VENV_DIR/bin/hf" download "$MODEL_ID"
ok "model available locally"

say "5/5  Smoke test"

"$VENV_DIR/bin/python" - <<'PY'
import sys
try:
    import mlx.core as mx, mlx_lm
    print(f"  mlx {mx.__version__} / mlx-lm {mlx_lm.__version__}")
except Exception as e:
    print(f"  import failed: {e}", file=sys.stderr)
    sys.exit(1)
PY
ok "mlx imports cleanly"

cat <<EOM

Host provisioned. Next:

  ./host/install-service.sh      start the server and keep it running

Then, from the Mac running inbox-manager:

  curl http://$(ipconfig getifaddr en0 2>/dev/null || echo '<this-mac-ip>'):$PORT/v1/models

and set that same URL as LLAMA_BASE_URL in your .env.
EOM
