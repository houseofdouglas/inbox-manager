# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

An AI-powered Gmail organizer. It classifies mail as marketing, transactional,
or personal and files it into Gmail labels. Built for inboxes of tens of
thousands of messages; designed to run unattended on a schedule.

It modifies a real mailbox. `DRY_RUN=true` is the default and must stay the
default. When helping someone set this up, do not flip it to `false` on their
behalf — that is their decision to make after they have seen classifications
they trust.

## Helping someone set this up

Start with `npm run setup`. It is interactive and must be run by the user in a
real terminal — it will refuse politely if stdin is not a TTY, so do not try to
drive it with piped input.

Then `npm run doctor`. It is read-only, exits 0 only when everything passes, and
every failure prints the command that fixes it. **Prefer reading doctor's output
over reasoning about the configuration yourself** — it probes the live system.

If they are stuck, the usual causes in order:

1. **Google Cloud.** They need their own project, Gmail API enabled, a Desktop
   app OAuth client saved as `credentials.json`, and the consent screen set to
   **"In production"**. A project left in "Testing" has its refresh token
   expired by Google every 7 days. The "Google hasn't verified this app"
   interstitial is expected — Advanced → Go to (unsafe).
2. **Model server not reachable from the driving machine.** Almost always bound
   to loopback, or a firewall. Test from the Mac running inbox-manager, never
   from the host.
3. **Model emits a reasoning block.** Classifications come back as truncated
   JSON. Doctor detects this by token count and says so.

## The model server

Any OpenAI-compatible server, on any OS, satisfying:

- `GET /v1/models` → `{ "data": [{ "id": "..." }] }`
- `POST /v1/chat/completions` → `{ "choices": [{ "message": { "content": … } }] }`

`LLAMA_BASE_URL` points at it; `LLAMA_MODEL` must match an id it reports.
Common defaults: Ollama `:11434/v1`, LM Studio `:1234/v1`, llama.cpp `:8080`,
vLLM `:8000/v1`.

The `host/` directory is an optional kit for standing up an Apple Silicon MLX
host. **It is not required.** If the user already runs a model anywhere on their
network, skip `host/` entirely and set `LLAMA_BASE_URL`. The watchdog and
automatic restart in `host/` are macOS/launchd-only.

### Liveness is not health

`GET /v1/models` is served by the HTTP thread and keeps returning 200 after the
generation thread dies — a Metal OOM does exactly this, and launchd's
`KeepAlive` never fires because the process never exits. A server in this state
looks perfectly healthy and hangs every completion.

So: **never treat `/v1/models` as a health check.** `LlamaClassifier.isHealthy()`
answers "is anything listening"; `canGenerate()` answers "can it work". Recovery
paths, doctor and `host/status.sh` all use the latter. Preserve that distinction
in any code you add.

## Architecture

- `src/index.ts` — command dispatch and all the orchestration
- `src/services/gmail.ts` — Gmail API; labels, fetching, modification
- `src/services/{classifier,gemini-classifier,llama-classifier,claude-cli-classifier}.ts`
  — interchangeable classifiers behind one interface
- `src/services/database.ts` — SQLite record of every classification
- `scripts/` — `setup`, `doctor`, `auth`, `schedule` (run via tsx, not built)
- `host/` — optional MLX model-host kit (shell, macOS)
- `templates/` — launchd plist for the scheduled job

## Invariants

**Marketing mail is always marked read.** Every path that puts a message under a
`marketing/` label must also strip `UNREAD`: `organizeEmail`, `applyLabelOnly`
(both honour `shouldMarkAsRead` from `labelFor`), the `merge-labels` batch move,
and the `fix-unknown` batch move. `npm run dev fix-unread` backfills anything an
older path missed.

**The tool never files its own mail.** Digests and failure alerts are tagged
`inbox-manager` (`SELF_LABEL` in `src/services/gmail.ts`) at send time, and every
inbox fetch excludes that label. Without it a digest is classified as marketing,
marked read and archived, and the user stops seeing their own reports. Exclusion
is by label and not by sender on purpose — notes a user mails themselves are
ordinary mail and should still be filed.

**Requests to the model must stay bounded.** `llama-classifier.ts` sets 120s
timeouts and passes `chat_template_kwargs: { enable_thinking: false }` on every
call. Without the timeout a wedged host hangs a scheduled run while it holds
`.bulk.lock`. Keep both.

**Nothing personal in the repo.** No email addresses, LAN IPs, home directory
paths, host names, or keys in tracked files. Per-user values live in `.env`,
`host/config.local.sh`, and `token.json` / `credentials.json` — all git-ignored.
Check before committing.

## Configuration

Everything is in `.env` (see `.env.example`, which documents every key the code
reads). `AI_PROVIDER` selects `llama` (default, local), `gemini`, `claude`, or
`claude-cli`. `LAUNCHD_LABEL_PREFIX` names every launchd job the project
installs and must match `LABEL_PREFIX` in `host/config.sh` on the model host —
in-run recovery addresses the server by label.

## Commands

```bash
npm run setup              # guided first run (interactive, needs a TTY)
npm run doctor             # read-only checks; exit 0 = all pass
npm run auth               # re-run Gmail OAuth
npm run dev stats          # mailbox counts (read-only)
npm run classify           # classify a batch, print results, change nothing
npm run organize           # classify and file (honours DRY_RUN)
npm run dev daily          # what the scheduler runs: fix-ups, bulk, digest
npm run schedule:install   # install the launchd job
npm run type-check         # tsc over src/ and scripts/
npm run lint
```

`npm run build` compiles `src/` only; `scripts/` runs through tsx and is
excluded from the build but included in type-checking via `tsconfig.check.json`.

## Testing changes

There is no test suite. Verify against the real thing instead:

- `npm run doctor` after any change to configuration or the classifier.
- `BATCH_SIZE=5 DRY_RUN=true npm run classify` exercises the whole chain
  without touching the mailbox.
- For host scripts, `bash -n` for syntax and `plutil -lint` on any rendered
  plist before loading it.
- Never test by installing over a user's existing launchd job — render to a
  temp path and lint it there.

## Reference

`specs/001-shareable-distribution.md` records the requirements and, more
usefully, the incidents behind them — why particular flags, timeouts and checks
exist. Read it before changing the host kit or the recovery paths.
