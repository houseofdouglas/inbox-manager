# The model host

This directory turns a Mac into the classifier's brain: an OpenAI-compatible
API serving a local model, so your email never leaves your machines and each
run costs nothing.

It is self-contained. On a **two-Mac setup** you copy only this `host/`
directory to the machine that will run the model — that machine does not need
the rest of inbox-manager. On a **one-Mac setup** both live on the same Mac and
nothing else changes.

## What you need

- Apple Silicon (M-series). MLX does not run on Intel Macs.
- At least 24 GB of unified memory — the base configuration of current
  MacBooks, so any recent machine qualifies. Memory is the whole reason the
  model gets its own machine: ~15 GB of weights plus a prompt cache that grows
  while it works. More memory buys bigger batches rather than immunity, though:
  the reference host has 32 GB and still hit a Metal out-of-memory at
  `BATCH_SIZE=500`. On an older 16 GB Mac, use a smaller model (see *Using a
  different model*).
- ~25 GB of free disk (the reference model is about 15 GB).
- [uv](https://docs.astral.sh/uv/): `brew install uv`

## Setup

```bash
./host/setup-host.sh        # checks hardware, builds the venv, downloads the model
./host/install-service.sh   # starts the server and keeps it running
```

`setup-host.sh` is safe to re-run and resumes an interrupted download.
`install-service.sh` waits until the server actually answers before returning,
so when it exits successfully the host is ready. It also installs the
[watchdog](#the-watchdog).

Then, on the Mac running inbox-manager, put that address in `.env`:

```
LLAMA_BASE_URL=http://192.168.1.50:8080
```

and prove it is reachable *from that Mac*, not from the host:

```bash
curl http://192.168.1.50:8080/v1/models
```

**Use the IP address, not a `.local` name.** `mlx_lm` binds IPv4 only, and
`.local` names intermittently resolve to IPv6-only records — which looks like
a dead server for no visible reason.

## Day-to-day

```bash
./host/status.sh                # job loaded? port answering? generating?
tail -f ~/logs/mlx-server.log   # what the server is doing
tail -f ~/logs/mlx-watchdog.log # what the watchdog has noticed
./host/uninstall-service.sh     # stop it; leaves the venv and model in place
```

## The watchdog

`KeepAlive` only restarts a process that **exits**. The failure this host
actually hits does not exit.

On 2026-09-04 a Metal out-of-memory killed `mlx_lm`'s generation thread while
the process kept running. `GET /v1/models` answered `200` the whole time, so
every health check said the server was fine. Every completion hung forever.
launchd saw a healthy process and did nothing. It stayed that way for 22 hours
and classified no mail.

So `watchdog.sh` asks for an actual completion, on a timer, and restarts the
service when generation is genuinely gone. It is installed automatically by
`install-service.sh` and is deliberately cautious:

| Behaviour | Why |
|---|---|
| Requires 3 consecutive failures (~15 min) | A server working through a large batch is busy, not broken. Restarting mid-batch would throw away real work. |
| 120s probe timeout | Same reason — a loaded server can be slow without being dead. |
| 15-minute grace period after a restart | The model needs to load back into memory. Probing during that window would just trigger another restart. |
| Stops after 3 restarts in an hour | If restarting is not fixing it, thrashing the machine will not either. It logs what to look at instead. |
| Silent when healthy | The log records state changes only: failures, restarts, recoveries. An empty log is good news. |

Tune any of it in `config.sh` (or `config.local.sh`): `WATCHDOG_INTERVAL`,
`WATCHDOG_TIMEOUT`, `WATCHDOG_STRIKES`, `WATCHDOG_GRACE`,
`WATCHDOG_MAX_RESTARTS`.

The watchdog treats the symptom. If it fires regularly, the cause is memory
pressure — the prompt cache grows across requests until Metal cannot allocate.
Lower `BATCH_SIZE` on the inbox-manager side, or move to a smaller model.

The launchd job has `RunAtLoad` and `KeepAlive`, so the server survives a
reboot and restarts itself if it crashes. After changing `config.sh`, re-run
`install-service.sh` to pick it up.

## Why the launch flags are what they are

`mlx-server.sh` passes three things that look optional and are not. Each one is
here because of a failure that is hard to diagnose from the client side:

| Flag | Without it |
|------|-----------|
| `caffeinate -dimsu` | The Mac idle-sleeps mid-run. Sockets stay open via TCPKeepAlive, so the client **hangs** instead of getting a clean connection refused. |
| `--host 0.0.0.0` | The server binds loopback only and is invisible from the other Mac, while working perfectly when tested locally. |
| `--chat-template-args '{"enable_thinking": false}'` | gemma-4 emits a reasoning block first — ~255 tokens instead of ~7 — overrunning the classifier's token budget and truncating its JSON mid-object. Omitting the flag is **not** the same as setting it false. |

## Naming the launchd jobs

Both jobs live under one prefix, set in one place:

```bash
echo 'LABEL_PREFIX="com.yourname"' > host/config.local.sh
./host/install-service.sh
```

giving `com.yourname.mlx-server` and `com.yourname.mlx-watchdog`. Use
reverse-DNS form — that is what launchd expects, and it keeps your jobs
distinct from everyone else's in `launchctl list`.

`config.local.sh` is git-ignored and is read *before* everything in
`config.sh`, so anything it sets — including values other settings are derived
from — takes effect.

If you set a prefix here, set the matching `LAUNCHD_LABEL_PREFIX` in
inbox-manager's `.env` on the driving Mac. A run that finds the server wedged
restarts it *by label*, so the two machines have to agree.

Renaming an already-installed job means removing the old one first:

```bash
launchctl bootout gui/$(id -u)/<old-label>
rm ~/Library/LaunchAgents/<old-label>.plist
./host/install-service.sh
```

## Using a different model

`config.sh` holds the model id in one place. Override it without editing a
tracked file:

```bash
echo 'MODEL_ID="mlx-community/some-smaller-model"' > host/config.local.sh
./host/setup-host.sh && ./host/install-service.sh
```

`setup-host.sh` installs `mlx-lm>=0.31.3` — a floor rather than a pin, so fixes
arrive on their own. 0.31.3 is the version this setup was verified against; if
a newer release ever misbehaves, pin it exactly:

```bash
echo 'MLX_LM_SPEC="mlx-lm==0.31.3"' >> host/config.local.sh
```

Then set `LLAMA_MODEL` in inbox-manager's `.env` to match, since the classifier
sends the model id with every request.

Be aware that the classifier's prompt has only been validated against
`mlx-community/gemma-4-26B-A4B-it-qat-4bit`. Smaller models tend to fail in one
specific way: they return prose or malformed JSON instead of the object the
classifier expects. Run `npm run classify` with `DRY_RUN=true` and read the
output before trusting a substitution.

## Troubleshooting

| Symptom | Cause |
|---------|-------|
| `curl` works on the host, fails from the other Mac | Server bound to loopback, or a `.local` name resolving to IPv6. Use `--host 0.0.0.0` and the IP. |
| Client hangs rather than erroring | Host went to sleep. Confirm `caffeinate` is in the process list: `pgrep -fl caffeinate`. |
| Truncated or unparseable classifications | `enable_thinking` not set to false. |
| `[METAL] Command buffer execution failed: Insufficient Memory` in the log | The GPU ran out of memory on a large batch. Lower `BATCH_SIZE` in inbox-manager's `.env`, close other GPU-heavy apps, or use a smaller model. The server stays up and keeps answering `/v1/models`, so this failure does *not* show up as an outage. |
| Server not running after reboot | `./host/status.sh`; if the job is not loaded, re-run `install-service.sh`. |
| `generation: NOT WORKING` from `status.sh` | The server answers but cannot generate — its generation thread died. The watchdog restarts this within ~15 minutes; to fix it now, run `./host/install-service.sh`. |
| Watchdog log says "NOT restarting" | It restarted 3 times in an hour without success. Read `mlx-server.log` — this is almost always memory pressure, not a transient fault. |

## The contract

If you would rather run something else — LM Studio, llama.cpp, vLLM — anything
that answers these two endpoints on the configured port will work:

- `GET /v1/models` → `{ "data": [{ "id": "..." }] }`
- `POST /v1/chat/completions` → `{ "choices": [{ "message": { "content": "..." } }] }`

No auth header is sent, so expose the port on a trusted LAN only.
