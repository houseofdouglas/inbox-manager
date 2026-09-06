# Spec: Shareable Distribution & Guided Setup

**Status**: IMPLEMENTED
**Created**: 2026-09-05
**Last Updated**: 2026-09-05 (all open questions resolved)
**Related Specs**: none

---

## Overview

**Summary**: Turn the current single-user working copy of Inbox Manager into a public GitHub repository that a second macOS user can clone and get running end-to-end via a guided `npm run setup`, on either two machines (one drives Gmail, one hosts the model) or one machine doing both.

**User Roles**:
- **Maintainer** — owns the GitHub repo, publishes changes, fields questions. (the repo owner)
- **New operator** — clones the repo onto their own Mac and runs it against their own Gmail account. (Anyone who clones the repo.)

**Why**: The project currently only runs because of undocumented local state: a hand-built `.env`, a `credentials.json` from the maintainer's Google Cloud project, a `token.json`, a 47 MB `inbox.db`, a hand-written launchd plist with absolute paths into one user's home directory, and a model server at a hardcoded LAN address. Three things are hardcoded to the maintainer's email address in [src/index.ts](../src/index.ts). None of this is discoverable from the README. A second person cannot get from `git clone` to a working daily run without a long screen-share. The work here is: make the repo safe to publish, remove per-user values from code into config, and replace the tribal knowledge with a setup command and a doctor command that tell the operator exactly what is wrong and how to fix it.

---

## User Stories

- As a **new operator**, I want to run one command after cloning and be walked through every prerequisite, so that I don't have to reverse-engineer `.env.example` or read source to find out what's required.
- As a **new operator**, I want the setup to work whether my model runs on this Mac or on another Mac on my LAN, so that I can start on one machine and move inference to a beefier one later without reinstalling.
- As a **new operator**, I want a `doctor` command that tells me which prerequisite is broken and the exact command to fix it, so that a failed run is self-diagnosing.
- As a **new operator**, I want the scheduled runs installed for me with correct paths for my machine, so that I get hands-off inbox processing without writing a launchd plist.
- As a **new operator**, I want the first real run to be reversible or preview-only by default, so that I can see what it would do to 30,000 emails before it does it.
- As a **maintainer**, I want to publish this repo without leaking my mailbox contents, OAuth client, tokens, or email address, so that going public is not a privacy event.
- As a **maintainer**, I want per-user values to live in config rather than source, so that their fixes and mine merge cleanly instead of conflicting on hardcoded constants.

---

## Functional Requirements

### A. Publishable repository

1. The repository shall be published to GitHub as a new public repo with a fresh commit history — the existing working copy is not a git repository, and no history from it is imported.
2. `.gitignore` shall exclude every file that contains mailbox data, credentials, or per-user state. At minimum, beyond what it excludes today (`node_modules/`, `dist/`, `.env`, `.env.local`, `credentials.json`, `token.json`, `*.log`, `.DS_Store`, `.bulk.lock`), it shall also exclude: `*.db`, `*.db-wal`, `*.db-shm`, `newsletter-state.json`, `.env.bak*`, `logs/`, `reports/`, `deal-database.json`, `action-dataset.json`, and `.claude/settings.local.json`.
3. No file in the published repo shall contain a real email address, a real LAN IP address, an API key, an OAuth client ID or secret, or an OAuth token. Placeholder values in `.env.example` and docs are permitted and shall be visibly fake (e.g. `you@example.com`, `192.168.1.50`).
4. The hardcoded recipient the maintainer's personal address at [src/index.ts:202](../src/index.ts#L202), [src/index.ts:320](../src/index.ts#L320) and [src/index.ts:1404](../src/index.ts#L1404) shall be replaced by a single configured value.
5. The example LAN address in the [src/benchmark.ts](../src/benchmark.ts) header comment shall be replaced with a placeholder.
6. The published repo shall include: `src/`, `package.json`, `package-lock.json`, `tsconfig.json`, `.env.example`, `.gitignore`, `README.md`, `CLAUDE.md`/`AGENTS.md`, `specs/`, `scripts/`, and `templates/`. It shall not include `src/deal-review.ts`, `src/benchmark.ts`, `deal-database.json`, or `action-dataset.json` (see Out of Scope), and the `deal-review*` and `benchmark` scripts shall be removed from `package.json`.
7. The repo shall carry a LICENSE file matching the `"license": "MIT"` already declared in `package.json`.
8. The README shall state plainly that the tool modifies the operator's real mailbox (moves mail out of the inbox, marks marketing mail read), that `DRY_RUN=true` is the shipped default, and that Gmail label changes are reversible but bulk-undo is manual.

### B. Configuration contract

9. The recipient for the daily digest and for failure notifications shall be resolved in this order: `DIGEST_RECIPIENT` from `.env` if set; otherwise the email address of the authenticated Gmail account, obtained from the Gmail API profile at startup. No fallback to a compiled-in address.
10. `.env.example` shall document every variable the code reads, including ones it documents today plus `DB_PATH`, `DIGEST_RECIPIENT`, and `OLLAMA_MODEL` if retained — with the default value and the effect of each.
11. `AI_PROVIDER` shall default to `llama` (a local OpenAI-compatible model server). API-backed providers (`gemini`, `claude`, `claude-cli`) remain selectable but require the operator to supply their own key.
11a. The OAuth client shall persist refreshed credentials: [src/services/gmail-auth.ts](../src/services/gmail-auth.ts) writes `token.json` only at initial authorization, so a refresh token rotated by Google would never be saved. The client shall write `token.json` on the `tokens` event.
12. `validateConfig()` in [src/config.ts](../src/config.ts) shall validate the `llama` provider path as strictly as it validates the API providers: a missing or malformed `LLAMA_BASE_URL` shall fail at startup with a named error, not at the first classification call.
13. The single-machine topology shall be expressed purely as `LLAMA_BASE_URL=http://localhost:8080`; the split topology purely as `LLAMA_BASE_URL=http://<host-lan-ip>:8080`. No other setting differs between the two topologies.

### C. `npm run setup` — guided first run

14. `npm run setup` shall run an interactive wizard that leaves behind a valid `.env`, a working `token.json`, and a printed summary of what it configured. It shall be safe to re-run.
15. The wizard shall check the Node.js major version against the minimum the project requires and stop with the required version if it is too old. `package.json` shall declare that minimum in `engines`.
16. The wizard shall detect an existing `.env` and offer to keep it, edit individual values, or start fresh. It shall never silently overwrite an existing `.env`; if it rewrites one, it shall first copy it to `.env.bak-<YYYYMMDD-HHMMSS>`.
17. The wizard shall walk the operator through obtaining `credentials.json` from their **own** Google Cloud project — create project, enable Gmail API, configure the OAuth consent screen, create a Desktop-app OAuth client, download the JSON — and shall wait until the file is present in the project root before continuing.
17a. The consent-screen step shall instruct the operator to set publishing status to **In production**, not leave it in Testing. A new project defaults to Testing, and Google expires refresh tokens for Testing-status apps after 7 days, which would force weekly re-auth. In production without Google verification is the correct choice here: the operator authorizes their own account, accepts the one-time "Google hasn't verified this app" interstitial via *Advanced → Go to (unsafe)*, and the resulting refresh token does not expire on a timer. The README shall state both the interstitial and the reason for it, so the warning screen does not read as a mistake.
17b. The wizard shall not silently accept a Testing-status project — since publishing status is not readable from `credentials.json`, it shall require an explicit confirmation that the operator set In production, and record the answer in the setup summary.
18. The wizard shall trigger the existing OAuth loopback flow ([src/services/gmail-auth.ts](../src/services/gmail-auth.ts)), confirm that `token.json` was written, and print the email address of the account that was authorized so a wrong-account authorization is caught immediately.
19. The wizard shall ask which topology applies — "the model runs on this Mac" or "the model runs on another Mac" — and for the second case prompt for the host address, defaulting the port to `8080`.
20. The wizard shall probe the configured model host before writing it to `.env`: `GET {LLAMA_BASE_URL}/v1/models` must return 200, and a single trial `POST {LLAMA_BASE_URL}/v1/chat/completions` must return a parseable completion. On failure it shall report which of the two checks failed and offer to retry, change the address, or continue anyway.
21. The wizard shall read back the model name reported by `/v1/models` and offer it as the default for `LLAMA_MODEL`, rather than making the operator transcribe a model identifier.
22. The wizard shall offer the API-backed providers as an alternative path; choosing one collects the API key, skips the host probe, and validates the key with a single trial classification.
23. The wizard shall set `DRY_RUN=true` and a conservative `BATCH_SIZE` for the initial `.env`, and shall tell the operator which command flips each one when they are ready.
24. The wizard shall offer to install the scheduled job (Requirement D) and shall default to not installing it.
25. On success the wizard shall print the exact next commands to run, in order: `npm run doctor`, `npm run dev stats`, `npm run classify`.

### D. Scheduling

26. `npm run schedule:install` shall generate `~/Library/LaunchAgents/com.inbox-manager.daily.plist` from a template in the repo, substituting the operator's absolute Node binary path, the repo's absolute working directory, and their `$HOME` — none of which may be hardcoded in the template.
27. The generated job shall run the `daily` command on the same three-times-daily calendar schedule in use today (08:00, 12:00, 19:00 local), with stdout and stderr to `logs/daily.log` and `logs/daily-error.log`, and `RunAtLoad` false.
28. The wizard/installer shall let the operator change or reduce those run times before the plist is written.
29. `npm run schedule:install` shall load the job with `launchctl` and report whether the job is loaded; `npm run schedule:uninstall` shall unload and remove it; `npm run schedule:status` shall report loaded/not-loaded and the timestamp of the last run from the log.
30. Re-running `schedule:install` shall replace an existing job rather than erroring or creating a duplicate.

### E. `npm run doctor` — diagnosis

31. `npm run doctor` shall run non-mutating checks and print each as pass/fail with a one-line remedy on failure. It shall exit 0 only if every check passes.
32. The checks shall be, in order: Node version; dependencies installed and `better-sqlite3` loadable; `.env` present and parseable; `AI_PROVIDER` valid and its required settings present; model host reachable and a trial completion succeeds (or API key valid, for API providers); `credentials.json` present; `token.json` present and a Gmail API call succeeds; database file present, writable, and its schema current; scheduled job loaded or not (informational, never a failure); `DRY_RUN` current value (informational).
31a. Doctor's model-host check shall include a real completion, and shall treat a timeout as a failure — not a warning — naming the dead-generation-thread cause and the restart command. Reporting a host as healthy because it answers `/v1/models` is the specific mistake this guards against.
32a. The Gmail check in doctor shall report the age of `token.json`. A working token older than ~7 days is positive evidence that the consent screen is correctly In production; a token that fails within a week of issue points straight at Testing status.
33. Doctor shall never create labels, modify messages, or write to the database.
34. Every failure message shall name the file to edit or the command to run — not just the condition that failed.

### F. Documentation

35. The README shall be rewritten around two paths — "one Mac" and "two Macs" — with the difference isolated to a single configuration line, and shall list what the operator needs before starting: a Mac, a Google account, ~15 minutes, and either a model host or an API key.
36. The README shall point at the shipped host kit (Section G) as the supported way to stand up the model host, and shall additionally state the generic contract for operators who prefer another server: any server answering `GET /v1/models` and `POST /v1/chat/completions` in OpenAI-compatible form on the configured port will work. It shall give a one-line `curl` the operator runs from the driving Mac to prove reachability.
37. The README shall document each CLI command that ships: `stats`, `classify`, `organize`, `bulk`, `daily`, `newsletters`, `db-stats`, `migrate-labels`, `merge-labels`, `relabel-missing`, `fix-unknown`, `fix-unread`, plus `setup`, `doctor`, and the `schedule:*` scripts — with a one-line description and whether it mutates the mailbox.
38. The README shall include a "first week" runbook: dry-run classify, review output, flip `DRY_RUN`, run `organize` on a small batch, verify in Gmail, then enable the schedule.
39. The README shall include a troubleshooting section covering, at minimum, every row in the Error States table below.
40. The README shall state where the operator's data lives (`inbox.db`, `token.json`, `.env`, `logs/`), that it never leaves their machines when using a local model, and how to remove it all.

### G. Model host kit (`host/`)

The reference host is a known-good, reproducible configuration, verified on the reference host (MacBook Pro, M2 Max, 32 GB, macOS 26.6.2): a uv-managed Python 3.12 venv running `mlx_lm server` with `mlx` 0.32.1 / `mlx-lm` 0.31.3, serving `mlx-community/gemma-4-26B-A4B-it-qat-4bit` (15 GB on disk) on `0.0.0.0:8080` under launchd with `KeepAlive`. It has served 2,000+ classification requests across a 2-day uptime. That configuration ships rather than being described in prose.

41. The repo shall contain a `host/` directory with everything needed to reproduce the reference host: a provisioning script, a server launch script, and a launchd plist template.
42. `host/setup-host.sh` shall be runnable on a clean Mac and shall: verify Apple Silicon and available RAM against the floor in Non-Functional Requirements; install `uv` if absent; create the venv with `uv venv --python 3.12`; install `mlx-lm` and `hf_transfer`; download the model with `HF_HUB_ENABLE_HF_TRANSFER=1 hf download <model>`; and report the download size before starting it.
43. `host/mlx-server.sh` shall ship as the launch script, preserving all three non-obvious flags below **with their explanatory comments intact**. Each has a real failure mode behind it and none may be dropped as noise:
    - `caffeinate -dimsu` — the host idle-sleeps (default `sleep 1` minute); without it the machine sleeps mid-run while sockets stay open via TCPKeepAlive, so the client sees hangs and timeouts against an apparently healthy server rather than a clean connection refused.
    - `--host 0.0.0.0` — mlx binds IPv4 only, so clients must connect by IP; the `.local` name intermittently resolves to IPv6-only records.
    - `--chat-template-args '{"enable_thinking": false}'` — this gemma-4 build otherwise emits a reasoning block before its answer, ~255 completion tokens per classification instead of ~7. That overruns the classifier's budget ([src/services/llama-classifier.ts](../src/services/llama-classifier.ts): 200 tokens single, `BATCH_SIZE * 50` = 750 per 15-email batch) and truncates the JSON mid-object. Leaving the arg unset is **not** equivalent to passing false — it must be explicit.
44. `host/com.inbox-manager.mlx-server.plist.template` shall carry `RunAtLoad=true`, `KeepAlive=true`, `ThrottleInterval=30`, and logging to a path under the operator's home — with `$HOME` and the script path substituted at install time, never hardcoded.
45. `host/install-service.sh` shall render and load the plist, and shall create the log directory first, since launchd cannot create the parent of its log path.
46. The host kit shall not require the inbox-manager repo itself to be checked out on the host machine — the host runs only the model server. In the single-machine topology both live on one Mac; in the split topology only `host/` is copied over.
47. The model choice shall be a documented variable, not a constant: the scripts shall read the model id from one place so an operator with less RAM can substitute a smaller MLX model, and the README shall say that the classifier prompt has only been validated against the reference model.
48. The README shall document the host's operational commands: check the service is loaded, tail `mlx-server.log`, restart after a model change, and the `curl http://<host>:8080/v1/models` reachability check run from the driving Mac.
48a. The host kit shall include a **watchdog** (`host/watchdog.sh` plus its own launchd job), installed automatically by `install-service.sh` and removed first by `uninstall-service.sh`. It exists because `KeepAlive` structurally cannot detect the 2026-09-04 failure: the process never exited. The watchdog shall probe an actual completion on a timer and restart the service when generation is gone, subject to four guards that keep it from doing harm:
    - **N consecutive failures before acting** (default 3, ~15 min) — a server working a large batch is busy, not broken, and a restart mid-batch discards real work.
    - **A generous per-probe timeout** (default 120s), for the same reason.
    - **A grace period after each restart** (default 15 min) while the model loads back into memory, or the watchdog would restart it repeatedly during its own recovery.
    - **A circuit breaker** (default 3 restarts/hour) after which it stops restarting and logs what to investigate, since repeated restarts that do not help indicate memory pressure rather than a transient fault.
    It shall be silent while healthy — logging state changes only (failures, restarts, recoveries) — so a quiet log is meaningful.
48b. The watchdog treats a symptom, and the docs shall say so: frequent firing means the prompt cache is outgrowing available GPU memory, and the real fix is a lower `BATCH_SIZE` or a smaller model.
49. `host/status.sh` shall probe generation, not just liveness: after confirming `/v1/models`, it shall issue a real completion and report `generation: NOT WORKING` with the restart command when that fails. `/v1/models` is served by the HTTP thread and keeps answering after the generation thread dies, so liveness alone reports a dead server as healthy.
49a. The app's own recovery path shall use a generation probe, not a liveness probe. [src/index.ts](../src/index.ts)'s `recoverClassifierEndpoint` originally returned early on `isHealthy()` (`GET /v1/models`), which meant the 2026-09-04 outage defeated the existing self-healing: the check said the server was fine while every classification timed out, and the run marked email after email as an error instead of stopping. `LlamaClassifier` shall expose `canGenerate()` alongside `isHealthy()`, with a comment on each saying which question it answers, and recovery shall use the former.
48c. Every launchd job the project installs shall derive its label from a single configurable prefix — `LABEL_PREFIX` in `host/config.sh` for the host jobs, `LAUNCHD_LABEL_PREFIX` in `.env` for the daily job — defaulting to `com.inbox-manager` in the published repo so no operator inherits another's namespace. Local overrides (`host/config.local.sh`) shall be sourced **before** the defaults, since labels are derived values and a late override would be silently ignored. The docs shall state that the two machines must agree, because in-run recovery addresses the server by label.
49b. The restart target shall be configuration, not source. `LLAMA_SSH_HOST` names an ssh alias for a model host on another machine; a loopback `LLAMA_BASE_URL` restarts locally with `launchctl`; neither configured means no automatic restart, reported plainly rather than silently skipped. `LLAMA_SERVICE_LABEL` shall default to the label `host/install-service.sh` creates.
50. The classifier's own request path must stay bounded so a wedged host cannot hang a scheduled run while it holds `.bulk.lock`. This is **already satisfied** — [src/services/llama-classifier.ts](../src/services/llama-classifier.ts) sets 120s `headersTimeout`/`bodyTimeout` on every call, and also passes `chat_template_kwargs: { enable_thinking: false }` per request as a second guard against reasoning preambles. Verified against the 2026-09-04 incident: the run errored per email rather than hanging. Preserve both when touching that file.

---

## Error States & Edge Cases

| Scenario | What Happens |
|----------|-------------|
| Node older than the declared minimum | Setup and doctor stop: `Node <found> detected; this project needs Node >= <min>. Install it with nvm, then re-run.` |
| `npm install` fails building `better-sqlite3` | Doctor reports the module is not loadable and points at the Xcode Command Line Tools remedy: `xcode-select --install`, then `npm rebuild better-sqlite3`. |
| `credentials.json` missing | Setup blocks at that step and re-prints the Google Cloud walkthrough; it polls for the file rather than requiring a restart. The existing runtime error in `gmail-auth.ts` remains as the backstop. |
| `credentials.json` is a Web-app client, not Desktop | Setup detects the absence of an `installed` key and reports: `This OAuth client is a Web application. Create a Desktop app client instead — the loopback flow on port 3000 requires it.` |
| Gmail API not enabled on the operator's project | The OAuth callback returns Google's `accessNotConfigured` error; setup surfaces the API-enable URL from the error rather than the raw JSON. |
| Port 3000 already in use during OAuth | Setup reports the port conflict and names the offending process if it can, rather than hanging on `listen`. |
| Operator authorizes the wrong Google account | Setup prints the authorized address and asks for confirmation; declining deletes `token.json` and restarts the flow. |
| `token.json` present but refresh fails (`invalid_grant`) | Any command exits with `Gmail authorization expired or revoked. Run: npm run auth` — never a raw stack trace. The message shall name the two likely causes in order: the consent screen was left in Testing status (7-day refresh-token expiry), or access was revoked from the Google account's security settings. |
| Model host unreachable at `LLAMA_BASE_URL` | Setup/doctor: `Cannot reach <url>. Check the host Mac is awake, the server is running, and it is bound to 0.0.0.0 rather than 127.0.0.1.` At runtime, the existing `LlamaConnectionError` path is used. |
| Model host reachable but no model loaded | `/v1/models` returns 200 with an empty list, or the trial completion errors. Reported distinctly from unreachable: `Server is up but returned no usable model.` |
| Host Mac sleeps mid-run | Symptom is a **hang, not a connection refused**: the host idle-sleeps while sockets stay open via TCPKeepAlive, so the client blocks against an apparently healthy server. Prevented by the `caffeinate -dimsu` wrapper in `host/mlx-server.sh`; troubleshooting names this symptom explicitly because it does not look like a sleep problem. |
| Host reachable by IP but not by `.local` name | `mlx_lm server` binds IPv4 only; the `.local` name intermittently resolves to IPv6-only records. Setup shall reject a `.local` hostname for `LLAMA_BASE_URL` and require an IP, with this as the reason. |
| Classifications return truncated or unparseable JSON | Most likely the host is running without `--chat-template-args '{"enable_thinking": false}'`, so the model emits ~255 reasoning tokens before its answer and overruns the 200/750-token budget. Troubleshooting names this first, and doctor's trial completion shall flag a response whose token count suggests a reasoning preamble. |
| Metal out-of-memory on the host | Observed once in 16k log lines against 2,000 successful completions on a 32 GB M2 Max host: `[METAL] Command buffer execution failed: Insufficient Memory`. The request fails while the server stays up and `/v1/models` keeps returning 200. Rare but real — the run reports the failed batch and continues; troubleshooting says to reduce `BATCH_SIZE`, close other GPU-heavy apps, or use a smaller model. |
| Model server process killed | launchd `KeepAlive=true` restarts it within `ThrottleInterval` (30s). |
| **Model server alive but unable to generate** | Observed on the reference host 2026-09-04 19:10:29: a Metal OOM killed `mlx_lm`'s `Thread-1 (_generate)` while the HTTP thread survived. `GET /v1/models` kept returning 200, every `POST /v1/chat/completions` hung forever, and `KeepAlive` never fired because the process never exited. The next scheduled run classified nothing. Liveness checks must therefore never be treated as health: both `host/status.sh` and doctor must probe an actual completion, and a completion timeout must be reported as a hard failure naming this cause and the restart command. |
| Two-Mac setup where the host binds loopback only | The `curl` check in the README fails from the driving Mac while succeeding on the host; troubleshooting section names this as the most common cause. |
| Scheduled run fires while the Mac is asleep | launchd runs the job at next wake; the digest window is anchored to the previous digest rather than the run start, so a skipped run is still reported next time. Documented, not changed. |
| Two runs overlap | Existing `.bulk.lock` PID lock skips the second run with a message. Documented. |
| Operator runs `organize` with `DRY_RUN=true` | Classification and output happen; no mailbox change. The summary line states explicitly that nothing was modified and how to change it. |
| Fresh install, empty database | `db-stats` reports zero rows with `No emails processed yet — run: npm run classify` rather than empty tables. |
| Gmail account has zero matching emails | `classify`/`organize` report `Nothing to process` and exit 0. |
| Labels already exist from a previous tool | Existing on-demand label creation reuses them; no error. |
| API quota exhausted (Gemini free tier) | Run stops with the provider's message plus `Reduce BATCH_SIZE or wait for the quota window to reset.` |
| Operator commits `.env` or `inbox.db` anyway | Not preventable by `.gitignore` alone if forced; README warns, and `npm run doctor` reports if any ignored-by-policy file is currently tracked by git. |
| `schedule:install` run from a non-repo directory | Fails with the reason rather than writing a plist with a wrong `WorkingDirectory`. |
| Operator has no `logs/` directory | The installer creates it; launchd cannot create the parent of its log path and would otherwise fail silently. |

---

## Data Model

No changes to the SQLite schema in [src/services/database.ts](../src/services/database.ts). Two configuration artifacts are the data model for this spec.

### Configuration — `.env`

| Key | Type | Required | Validation | Notes |
|-----|------|----------|------------|-------|
| `AI_PROVIDER` | `'llama' \| 'gemini' \| 'claude' \| 'claude-cli'` | Yes | One of the listed values | Default `llama` |
| `LLAMA_BASE_URL` | `string` | When `AI_PROVIDER=llama` | Absolute `http(s)://host:port` URL; trailing slash tolerated | `http://localhost:8080` single-machine; LAN IP for split |
| `LLAMA_MODEL` | `string` | When `AI_PROVIDER=llama` | Non-empty | Should match a name from `/v1/models` |
| `GEMINI_API_KEY` | `string` | When `AI_PROVIDER=gemini` | Non-empty | Operator's own key |
| `GEMINI_MODEL` | enum | No | One of the values enumerated in `config.ts` | Default `gemini-2.5-flash` |
| `ANTHROPIC_API_KEY` | `string` | When `AI_PROVIDER=claude` | Non-empty | Operator's own key |
| `CLAUDE_MODEL` | `'opus' \| 'sonnet' \| 'haiku'` | No | One of three | Default `sonnet` |
| `DIGEST_RECIPIENT` | `string` | No | Email address format | Defaults to the authenticated Gmail account |
| `BATCH_SIZE` | `integer` | No | `>= 1` | Default `50`; setup writes a conservative value |
| `DRY_RUN` | `boolean` | No | `true`/`false` | Ships `true` |
| `DB_PATH` | `string` | No | Writable path | Default `inbox.db` |

### Configuration — launchd job

| Field | Source | Notes |
|-------|--------|-------|
| `Label` | Constant `com.inbox-manager.daily` | Uninstall targets this label |
| `ProgramArguments` | Resolved `node` + `npx tsx src/index.ts daily` | Node path resolved at install time, never hardcoded |
| `WorkingDirectory` | Repo root at install time | |
| `StartCalendarInterval` | Operator-chosen, default 08:00 / 12:00 / 19:00 | |
| `StandardOutPath` / `StandardErrorPath` | `<repo>/logs/daily.log`, `<repo>/logs/daily-error.log` | Installer creates `logs/` |
| `EnvironmentVariables.PATH` | Node bin dir + system paths | nvm-installed Node is not on launchd's default PATH |

---

## Interface Contracts

This project exposes no HTTP API. Two contracts matter instead.

### CLI contract

```
npm run setup                  # interactive; writes .env + token.json; idempotent
npm run doctor                 # read-only checks; exit 0 = all pass, 1 = any fail
npm run auth                   # re-run OAuth only; replaces token.json
npm run schedule:install       # writes + loads launchd job
npm run schedule:uninstall     # unloads + removes launchd job
npm run schedule:status        # loaded? last run?
```

Exit codes for every command: `0` success, `1` handled failure (message printed, no stack trace), `2` misconfiguration (missing/invalid `.env`, missing credentials).

### Model host contract (consumed, not implemented)

The host machine runs any server satisfying:

**`GET {LLAMA_BASE_URL}/v1/models`**
- 200 with `{ data: [{ id: string, ... }] }` — treated as healthy; `data[0].id` is offered as `LLAMA_MODEL`.
- Any other status, or a connection error → treated as unreachable.

**`POST {LLAMA_BASE_URL}/v1/chat/completions`**
- Request: `{ model: string, messages: [{ role: 'user', content: string }], max_tokens: number }`
- Response: `{ choices: [{ message: { content: string } }], usage?: { prompt_tokens, completion_tokens, total_tokens } }`
- Non-2xx or unparseable body → `LlamaConnectionError`, already implemented in [src/services/llama-classifier.ts](../src/services/llama-classifier.ts).

No authentication header is sent. The README shall state that the host port must therefore be exposed only on a trusted LAN.

---

## Acceptance Criteria

### Happy path — two machines

- [ ] Given a Mac with Node installed and no prior checkout, when the operator follows the README from `git clone` through `npm run setup` with a model server already running on a second Mac, then setup completes without the operator reading any source file, and `npm run doctor` exits 0.
- [ ] Given a completed setup, when the operator runs `npm run dev stats`, then total/inbox/unread counts for their own mailbox print.
- [ ] Given a completed setup with `DRY_RUN=true`, when the operator runs `npm run classify`, then classifications print and the mailbox is unchanged (verified: no label added, no read-state change).
- [ ] Given `DRY_RUN=false` and `BATCH_SIZE=5`, when the operator runs `npm run organize`, then exactly the reported messages move to `marketing/{company}`, `transactional`, or `personal`, and every message labeled `marketing/*` is also marked read.

### Happy path — one machine

- [ ] Given a single Mac running both the model server and the CLI, when the operator picks "this Mac" in setup, then the only difference in the resulting `.env` versus the two-machine case is `LLAMA_BASE_URL=http://localhost:8080`.
- [ ] Given the one-machine topology, when the operator later moves the model to a second Mac, then changing `LLAMA_BASE_URL` alone is sufficient — no re-auth, no re-setup, no DB change.

### Model host

- [ ] Given a clean Apple Silicon Mac meeting the hardware floor, when the operator runs `host/setup-host.sh` and then `host/install-service.sh`, then `curl http://<host-ip>:8080/v1/models` from the driving Mac returns 200 with the model id in `data[0].id`.
- [ ] Given the installed service, when the host is rebooted, then the server comes back without manual intervention (`RunAtLoad=true`).
- [ ] Given the installed service, when the model server process is killed, then launchd restarts it within 30 seconds.
- [ ] Given the host has been idle past its sleep timer, when a classification request arrives, then it is answered rather than hanging — i.e. `caffeinate` is in force.
- [ ] Given the shipped `host/mlx-server.sh`, when a 15-email batch is classified, then the response parses as complete JSON — i.e. `enable_thinking: false` is in force.
- [ ] Searching `host/` for the maintainer's home directory path, the reference host's name, or any real LAN IP returns no matches.

### Scheduling

- [ ] Given a completed setup, when the operator runs `npm run schedule:install`, then a plist exists at `~/Library/LaunchAgents/com.inbox-manager.daily.plist` containing that operator's home directory and repo path and no reference to any other user.
- [ ] Given the job is installed, when `npm run schedule:status` runs, then it reports the job as loaded.
- [ ] Given the job is installed, when `npm run schedule:install` is run a second time, then it succeeds and exactly one job remains loaded.
- [ ] Given the job is installed, when `npm run schedule:uninstall` runs, then the plist is gone and `launchctl list` shows no `com.inbox-manager.daily`.
- [ ] Given a scheduled `daily` run completes, when it finishes, then a digest email arrives at `DIGEST_RECIPIENT` — or at the authenticated account when that variable is unset.

### Error handling

- [ ] Given `LLAMA_BASE_URL` points at a host that is powered off, when `npm run doctor` runs, then it exits 1 and prints the unreachable-host remedy naming sleep, the server process, and interface binding — with no stack trace.
- [ ] Given a model server that is up with no model loaded, when doctor runs, then the message distinguishes this from unreachable.
- [ ] Given `credentials.json` is absent, when setup runs, then it blocks with the Google Cloud walkthrough and continues on its own once the file appears.
- [ ] Given a revoked token, when any mailbox command runs, then it exits 1 with `Run: npm run auth`.
- [ ] Given `AI_PROVIDER=llama` and an empty `LLAMA_BASE_URL`, when any command starts, then it fails during `validateConfig()` before any Gmail call.

### Security / privacy

- [ ] `git ls-files` on the published repo returns no `.env`, `*.db`, `token.json`, `credentials.json`, `newsletter-state.json`, `logs/*`, `reports/*`, `deal-database.json`, or `action-dataset.json`.
- [ ] Searching the published tree for the maintainer's email address, any real LAN IP, home directory path, or private host name returns no matches — this spec included.
- [ ] A fresh clone by a second person, followed by setup, never sends mail to, or reads mail from, the maintainer's account.
- [ ] With `AI_PROVIDER=llama`, no email subject, sender, or body is sent to any host other than `LLAMA_BASE_URL` and Google's Gmail API.

### Edge cases

- [ ] Given a first-ever run with an empty database, when `npm run db-stats` runs, then it prints the empty-state message rather than zero-row tables.
- [ ] Given an existing `.env`, when setup is re-run and the operator chooses "start fresh", then the previous file survives as `.env.bak-<timestamp>`.
- [ ] Given a repo where `.env` was force-added to git, when doctor runs, then it reports the tracked-secret condition.

---

## Non-Functional Requirements

- **Time to first success**: a competent macOS user with the model host already running reaches a green `npm run doctor` in under 15 minutes, Google Cloud project creation included.
- **Host hardware**: the reference configuration needs Apple Silicon, ~15 GB free disk for the model, and 32 GB unified memory. The reference model has been run successfully on an M2 Max/32 GB with `BATCH_SIZE=500` (15 emails per model request, 3 concurrent). Below 32 GB the operator must substitute a smaller MLX model, and the README shall say the classifier prompt is only validated against the reference model.
- **Platform**: macOS only. `osascript` notifications and launchd scheduling are assumed; no Windows or Linux support is claimed, and the README says so.
- **Cost**: the default path (local model) costs $0 per run and requires no account beyond Google. API providers are opt-in and the README states their per-run cost order of magnitude.
- **Privacy**: on the default path, email content reaches only the operator's own machines and Google. This is a stated selling point and must remain true of any code that ships.
- **Idempotence**: `setup`, `doctor`, and `schedule:install` are all safe to run repeatedly; none destroys existing state without an explicit prompt and a backup.
- **Failure legibility**: no command in this spec surfaces an unhandled exception or raw API JSON to the operator. Every failure path prints a human sentence and a next action.
- **Maintenance**: per-user values live in `.env`; a future divergence between the two installations should be a config diff, not a source diff.

---

## Out of Scope

This spec intentionally does not cover:

- **`src/deal-review.ts`, `src/benchmark.ts`, and the Ollama provider** — these depend on `deal-database.json` and `action-dataset.json`, which are the maintainer's personal data, and on a locally-tuned prompt. They stay out of the published repo. (Deal *extraction* during `bulk`/`daily` and the deals section of the digest remain, since they live in `src/index.ts` and work from an empty database.)
- **Migrating any existing classification data** — the new operator starts with an empty `inbox.db`. The maintainer's 47 MB database is not shared, exported, or seeded.
- **Sharing an OAuth client** — each operator creates their own Google Cloud project and `credentials.json`. Publishing/verifying the OAuth app with Google is not attempted.
- **Provisioning or managing the model host** — installing LM Studio or `mlx_lm.server`, downloading weights, or keeping the host awake are the operator's responsibility and are documented as prerequisites, not automated.
- **A GUI, web UI, or menu-bar app** — this remains a CLI.
- **Multi-account support** — one Gmail account per checkout. Two accounts means two checkouts with separate `DB_PATH` and `token.json`.
- **Automated tests / CI** — the repo has none today; adding a test suite is separate work.
- **Undo tooling** — bulk-reverting an `organize` run is not implemented; the README documents the manual Gmail search-and-move instead.
- **Publishing to npm** or producing a Homebrew formula.

---

## Open Questions

| Question | Owner | Resolution |
|----------|-------|------------|
| ~~Does the OAuth consent screen need to be Published rather than Testing?~~ | Maintainer | **Resolved 2026-09-05**: yes. The maintainer's consent screen is in production, not a Testing credential. Corroborated by `token.json` — issued 2026-05-18, never rewritten since, and its refresh token still working ~3.5 months later, which a Testing-status app could not do. A new operator's project defaults to Testing, so this is now an explicit setup step (17a/17b) rather than an assumption. |
| ~~Which model server does the host run, and what flags?~~ | Maintainer | **Resolved 2026-09-05** by inspecting the running reference host: `mlx_lm server` from a uv venv (`~/mlx-env`, CPython 3.12.14, mlx 0.32.1, mlx-lm 0.31.3), wrapped in `caffeinate -dimsu`, under launchd with `KeepAlive`. Captured in Section G. |
| ~~Should the README recommend `gemma-4-26B-A4B-it-qat-4bit` or stay model-agnostic?~~ | Maintainer | **Resolved 2026-09-05**: ship it as the reference model (15 GB, validated against the classifier prompt) with the model id as a single documented variable for operators with less RAM. |
| ~~How hard should the README steer toward two Macs?~~ | Maintainer | **Resolved 2026-09-05**: frame it as **memory, not speed**. The model should sit on a machine with ≥24 GB doing nothing else; the driving Mac has no requirements. 24 GB is chosen because it is the base configuration of current MacBooks (up from 16 GB), not as a measured minimum. Splitting one model across machines with `exo` was tried and rejected — contention made it slower than either single-host arrangement. |
| ~~Pin `mlx-lm` or track latest?~~ | Maintainer | **Resolved 2026-09-05**: a floor, not a pin — `mlx-lm>=0.31.3`, overridable to an exact pin via `MLX_LM_SPEC` in `config.local.sh`. Fixes arrive without maintenance; known-too-old versions are still blocked. |
| ~~Should setup end with a smoke test?~~ | Maintainer | **Resolved 2026-09-05**: yes. Setup classifies 5 real emails with `DRY_RUN` forced true regardless of `.env`, so the run cannot modify the mailbox. It proves Gmail → model host → classification → parsing before setup claims success. Skipped, with guidance, when Gmail is not authorized. |
| ~~Keep `newsletters` in the shared version?~~ | Maintainer | **Resolved 2026-09-05**: ship it. Code-only, works from empty state, no personal data files; `newsletter-state.json` is git-ignored. Documented in the README command table, including that it sends mail. |
