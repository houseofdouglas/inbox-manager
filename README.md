# Inbox Manager

Classifies your Gmail with an AI model and files it: marketing mail into
`marketing/{company}` and marked read, receipts into `transactional`, real mail
from real people into `personal`. Built for inboxes with tens of thousands of
messages, and designed to run unattended three times a day once you trust it.

By default it runs a model on your own Mac, so **your email never leaves your
machines and each run costs nothing**.

> **It modifies your real mailbox.** `organize` moves mail out of the inbox and
> marks marketing mail as read. `DRY_RUN=true` is the shipped default and
> nothing is touched until you change it. Label changes are reversible in Gmail,
> but there is no bulk-undo command — see [Undoing a run](#undoing-a-run).

## Two ways to run it

Everything is identical except one line of configuration.

| | Where the model runs | `LLAMA_BASE_URL` |
|---|---|---|
| **One Mac** | Same Mac as this checkout | `http://localhost:8080` |
| **Two Macs** | A second Mac on your network | `http://192.168.1.50:8080` |

Two Macs is the better arrangement if you have a spare machine: classification
is GPU-hungry, and a 26B model on the Mac you are working on will make itself
felt. Start on one and move later — changing that one line is the entire
migration. No re-auth, no re-setup, no database changes.

## What you need

- **A Mac.** macOS only: scheduling uses launchd and alerts use `osascript`.
- **A Google account** whose mail you want organized.
- **A model host**, which is either this Mac or another one — Apple Silicon,
  32 GB of unified memory, ~15 GB free disk. See [host/README.md](host/README.md).
- **About 15 minutes**, most of it clicking through Google Cloud Console.

No API key is required. If you would rather use one — Gemini has a generous
free tier — setup will offer that instead and you can skip the model host
entirely.

## Setup

**1. Stand up the model host.** On whichever Mac will run the model:

```bash
./host/setup-host.sh        # hardware checks, Python env, downloads the model
./host/install-service.sh   # starts it and keeps it running across reboots
```

On a two-Mac setup, copy just the `host/` directory to that machine — it does
not need the rest of this repo. Full detail in [host/README.md](host/README.md).

**2. Install and configure.** On the Mac that will drive Gmail:

```bash
npm install
npm run setup
```

`npm run setup` walks through the whole thing: Google Cloud project, OAuth
client, Gmail authorization, model host address, and how conservative the first
runs should be. It is safe to re-run and never overwrites your `.env` without
backing it up first.

**3. Verify.**

```bash
npm run doctor
```

Every precondition, pass or fail, each failure with the command that fixes it.
Exits 0 only when everything passes.

### The Google Cloud part

This is the fiddly bit, and setup walks you through it, but for reference:

1. [console.cloud.google.com](https://console.cloud.google.com/) → create a project
2. APIs & Services → Library → enable the **Gmail API**
3. APIs & Services → OAuth consent screen → User type **External**, then
   **set publishing status to "In production"**
4. Credentials → Create credentials → OAuth client ID → **Desktop app**
5. Download the JSON, save it as `credentials.json` in this directory

Two things people get wrong here:

**Publishing status must be "In production."** A new project defaults to
"Testing", and Google expires refresh tokens for Testing-status apps after
seven days — you would be re-authorizing every week forever. "In production"
without Google verification is correct for this: you are the only user of your
own app.

**You will see "Google hasn't verified this app."** That is expected and not a
mistake. Choose *Advanced → Go to (unsafe)*. The app is one you created minutes
ago; verification is for apps distributed to strangers.

## Your first week

Do not skip to the scheduler. The point of this order is that you see what the
classifier does before it does it at scale.

1. **`npm run dev stats`** — confirms Gmail is connected. Read-only.
2. **`npm run classify`** — classifies a batch and prints the results. Changes
   nothing. Read the output: does it have your bank in `transactional`, your
   mother in `personal`?
3. **Set `DRY_RUN=false` and `BATCH_SIZE=25` in `.env`**, then
   **`npm run organize`**. Check Gmail. Twenty-five is small enough to fix by
   hand if you hate the result.
4. **Raise `BATCH_SIZE`** and run `organize` repeatedly to work through the
   backlog. A large inbox takes several passes.
5. **`npm run schedule:install`** once you trust it. Three runs a day, with a
   digest email summarizing what moved.

## Commands

| Command | What it does | Touches your mailbox |
|---|---|---|
| `npm run setup` | Guided first-run configuration | no |
| `npm run doctor` | Checks every precondition | no |
| `npm run auth` | Re-run Gmail authorization | no |
| `npm run dev stats` | Total / inbox / unread counts | no |
| `npm run classify` | Classify a batch and print results | no |
| `npm run organize` | Classify and file mail | **yes** (unless `DRY_RUN=true`) |
| `npm run dev bulk` | Large backlog pass, resumable | **yes** |
| `npm run dev daily` | What the scheduler runs: fix-ups, bulk pass, digest email | **yes** |
| `npm run newsletters` | Rate newsletters, email a digest of the good ones | **yes** (sends mail) |
| `npm run dev db-stats` | Reporting from the local database | no |
| `npm run dev fix-unread` | Mark any marketing mail left unread as read | **yes** |
| `npm run dev fix-unknown` | Re-file mail that landed under an unknown company | **yes** |
| `npm run dev merge-labels` | Merge duplicate company labels | **yes** |
| `npm run dev migrate-labels` | Move to the current label scheme | **yes** |
| `npm run dev relabel-missing` | Re-apply labels to archived mail | **yes** |
| `npm run schedule:install` | Install the three-times-daily job | no |
| `npm run schedule:status` | Is the job loaded, when did it last run | no |
| `npm run schedule:uninstall` | Remove the job | no |

## Configuration

All of it lives in `.env` — copy `.env.example` or let `npm run setup` write it.

| Variable | Meaning | Default |
|---|---|---|
| `AI_PROVIDER` | `llama`, `gemini`, `claude`, or `claude-cli` | `llama` |
| `LLAMA_BASE_URL` | Model server address | `http://localhost:8080` |
| `LLAMA_MODEL` | Model id the server reports | reference gemma-4 build |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | If using Gemini | — / `gemini-2.5-flash` |
| `ANTHROPIC_API_KEY` / `CLAUDE_MODEL` | If using Claude | — / `sonnet` |
| `DIGEST_RECIPIENT` | Where digests and alerts go | the account you authorized |
| `BATCH_SIZE` | Emails per run | `50` |
| `DRY_RUN` | `true` = preview only | `true` |
| `DB_PATH` | Local classification database | `inbox.db` |

## Where your data lives

Everything stays on your machine, and all of it is git-ignored:

| File | What it holds |
|---|---|
| `inbox.db` | Every classification made — subjects, senders, companies |
| `token.json` | Your Gmail access and refresh tokens |
| `credentials.json` | Your OAuth client |
| `.env` | Configuration, including any API keys |
| `logs/` | Output from scheduled runs |

With `AI_PROVIDER=llama`, email content goes to exactly two places: Google (it
is already there) and your own model host. To remove everything, delete this
directory and run `npm run schedule:uninstall` first; then revoke the app at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Undoing a run

There is no bulk-undo. To reverse a batch by hand, search Gmail for the label
and move it back:

```
label:marketing/Amazon        →  select all  →  Move to Inbox
```

Marking mail unread again is `Mark as unread` on the same selection. This is
why `DRY_RUN=true` ships as the default and why step 3 above uses a small batch.

## Troubleshooting

Run `npm run doctor` first — it diagnoses most of these and prints the fix.

| Symptom | Cause and fix |
|---|---|
| `Cannot reach http://…:8080` | Host asleep, server not running, or bound to loopback. Run `./host/status.sh` on the host. |
| Client hangs instead of erroring | The host Mac went to sleep with sockets open. `caffeinate` must be wrapping the server — `host/mlx-server.sh` does this. |
| Works on the host, fails from the other Mac | Server bound to `127.0.0.1`, or you used a `.local` name. Use `--host 0.0.0.0` and the IP address. |
| Classifications come back truncated | The model is emitting a reasoning block. Start the server with `--chat-template-args '{"enable_thinking": false}'`. |
| Trial completion times out | Normal right after starting the server, or after a long idle — the model is paging back in. Wait a minute, re-run doctor. |
| `[METAL] … Insufficient Memory` in the host log | Batch too large for available GPU memory. Lower `BATCH_SIZE`, close other GPU-heavy apps, or use a smaller model. |
| `invalid_grant` / authorization expired | `npm run auth`. If it recurs weekly, your consent screen is still in "Testing". |
| Port 3000 in use during authorization | Something else is on that port; the OAuth loopback needs it. Quit it and retry. |
| `credentials.json` rejected as a Web client | Create a **Desktop app** OAuth client instead. |
| `better-sqlite3` fails to load | `xcode-select --install` then `npm rebuild better-sqlite3`. |
| Scheduled runs not happening | `npm run schedule:status`. A run that would have fired while the Mac was asleep happens at next wake. |
| Two runs overlap | The second exits immediately — a PID lock prevents duplicates. Expected. |
| Nothing to process | Inbox is already filed. Not an error. |

## Cost

| Provider | Cost for ~30,000 emails |
|---|---|
| Local model (default) | Nothing, beyond electricity |
| Gemini free tier | Nothing, if spread across days (15 req/min, 1500/day) |
| Claude Haiku | Roughly $5–10 |
| Claude Sonnet | Roughly $30–50 |

## Development

```bash
npm run type-check   # tsc across src/ and scripts/
npm run build        # compile src/ to dist/
npm run lint
```

## License

MIT — see [LICENSE](LICENSE).
