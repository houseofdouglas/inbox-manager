// Every precondition inbox-manager needs, expressed as an independent check.
// doctor runs all of them; setup runs the ones relevant to the step it is on.
// Nothing here mutates the mailbox, the database, or any config file.
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { request } from 'undici';

const execFileAsync = promisify(execFile);

export interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn' | 'info';
  detail?: string;
  remedy?: string;
}

const ok = (name: string, detail?: string): CheckResult => ({ name, status: 'pass', detail });
const bad = (name: string, remedy: string, detail?: string): CheckResult =>
  ({ name, status: 'fail', detail, remedy });
const iffy = (name: string, remedy: string, detail?: string): CheckResult =>
  ({ name, status: 'warn', detail, remedy });
const note = (name: string, detail?: string): CheckResult => ({ name, status: 'info', detail });

export const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');
export const TOKEN_PATH = path.join(process.cwd(), 'token.json');

export function requiredNodeMajor(): number {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
    const m = String(pkg.engines?.node ?? '').match(/(\d+)/);
    return m ? parseInt(m[1], 10) : 20;
  } catch {
    return 20;
  }
}

export function checkNode(): CheckResult {
  const need = requiredNodeMajor();
  const have = parseInt(process.versions.node.split('.')[0], 10);
  return have >= need
    ? ok('Node.js', `v${process.versions.node}`)
    : bad('Node.js', `Install Node ${need} or newer, then re-run:\n  nvm install ${need} && nvm use ${need}`,
        `v${process.versions.node}, need >= ${need}`);
}

export async function checkDependencies(): Promise<CheckResult> {
  if (!fs.existsSync(path.join(process.cwd(), 'node_modules'))) {
    return bad('Dependencies', 'Run: npm install');
  }
  try {
    // The native module is the one that breaks — importing it is the check.
    await import('better-sqlite3');
    return ok('Dependencies', 'better-sqlite3 loads');
  } catch (err) {
    return bad(
      'Dependencies',
      'better-sqlite3 failed to load — it needs to compile against your Node version:\n' +
      '  xcode-select --install\n  npm rebuild better-sqlite3',
      err instanceof Error ? err.message.split('\n')[0] : String(err)
    );
  }
}

export function checkEnvFile(): CheckResult {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    return bad('.env', 'Run: npm run setup\n(or: cp .env.example .env and edit it)');
  }
  return ok('.env', 'present');
}

// A .local hostname works from the host itself and fails from anywhere else,
// because mlx binds IPv4 only while .local can resolve to IPv6-only records.
export function validateHostUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `"${url}" is not a valid URL. Expected something like http://192.168.1.50:8080`;
  }
  if (!/^https?:$/.test(parsed.protocol)) return 'The URL must start with http:// or https://';
  if (parsed.hostname.endsWith('.local')) {
    return `Use the host's IP address, not "${parsed.hostname}".\n` +
           'mlx_lm binds IPv4 only, and .local names can resolve to IPv6-only\n' +
           'records — which looks like a dead server for no visible reason.';
  }
  return null;
}

export interface HostProbe {
  reachable: boolean;
  models: string[];
  completed: boolean;
  completionTokens?: number;
  error?: string;
  timedOut?: boolean;
}

// Long enough to cover a genuinely slow first request (a model still loading,
// or weights faulting back in after a long idle), short enough that a wedged
// server is reported rather than waited on forever.
const COMPLETION_TIMEOUT_MS = 180_000;

// Two questions, answered separately: is anything listening, and can it
// actually complete? "Up but no model loaded" is a distinct failure.
export async function probeModelHost(baseUrl: string, model?: string): Promise<HostProbe> {
  const base = baseUrl.replace(/\/$/, '');
  const probe: HostProbe = { reachable: false, models: [], completed: false };

  try {
    const res = await request(`${base}/v1/models`, {
      method: 'GET', headersTimeout: 5_000, bodyTimeout: 5_000,
    });
    if (res.statusCode !== 200) {
      probe.error = `GET /v1/models returned HTTP ${res.statusCode}`;
      return probe;
    }
    probe.reachable = true;
    const body = await res.body.json() as { data?: { id: string }[] };
    probe.models = (body.data ?? []).map((m) => m.id);
  } catch (err) {
    probe.error = err instanceof Error ? err.message : String(err);
    return probe;
  }

  try {
    const res = await request(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: model || probe.models[0] || 'local',
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        max_tokens: 100,
      }),
      headersTimeout: COMPLETION_TIMEOUT_MS,
      bodyTimeout: COMPLETION_TIMEOUT_MS,
    });
    if (res.statusCode !== 200) {
      probe.error = `POST /v1/chat/completions returned HTTP ${res.statusCode}`;
      return probe;
    }
    const body = await res.body.json() as {
      choices?: { message?: { content?: string } }[];
      usage?: { completion_tokens?: number };
    };
    probe.completed = Boolean(body.choices?.[0]?.message?.content);
    probe.completionTokens = body.usage?.completion_tokens;
  } catch (err) {
    probe.error = err instanceof Error ? err.message : String(err);
    probe.timedOut = /timeout/i.test(probe.error);
  }
  return probe;
}

export async function checkModelHost(baseUrl: string, model: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const urlProblem = validateHostUrl(baseUrl);
  if (urlProblem) return [bad('Model host URL', urlProblem, baseUrl)];

  const probe = await probeModelHost(baseUrl, model);
  if (!probe.reachable) {
    return [bad('Model host',
      `Cannot reach ${baseUrl}.\n` +
      '  · Is the host Mac awake and the server running?  host/status.sh\n' +
      '  · Is it bound to 0.0.0.0 rather than 127.0.0.1?\n' +
      '  · Is LLAMA_BASE_URL in .env the right address?',
      probe.error)];
  }
  if (probe.models.length === 0) {
    return [bad('Model host',
      'The server is up but reports no models — check that it finished loading:\n  tail -f ~/logs/mlx-server.log',
      `${baseUrl} answered /v1/models with an empty list`)];
  }
  results.push(ok('Model host', `${baseUrl} — ${probe.models.join(', ')}`));

  if (model && !probe.models.includes(model)) {
    results.push(iffy('Model name',
      `LLAMA_MODEL in .env does not match what the server reports.\n` +
      `Set it to: ${probe.models[0]}`,
      `.env says "${model}"`));
  }

  if (!probe.completed && probe.timedOut) {
    // /v1/models is served by the HTTP thread and keeps returning 200 even when
    // the generation thread is gone — so "reachable" is not "working". An OOM
    // that kills only that thread leaves the process alive, which means launchd
    // KeepAlive never fires and the server looks healthy from the outside.
    results.push(bad('Trial completion',
      'The server accepted the request and never answered.\n' +
      'It reports models but cannot generate — usually its generation thread\n' +
      'died (commonly a Metal out-of-memory) while the process stayed alive,\n' +
      'so launchd never restarted it. Check the host log for a traceback:\n' +
      '  tail -50 ~/logs/mlx-server.log\n' +
      'Then restart it:\n' +
      '  ./host/install-service.sh',
      'no response before timeout'));
  } else if (!probe.completed) {
    results.push(bad('Trial completion',
      'The server accepted the request but returned no usable content.\n  tail -f ~/logs/mlx-server.log',
      probe.error));
  } else if ((probe.completionTokens ?? 0) > 50) {
    // "Reply with exactly: OK" should cost a handful of tokens. Far more means
    // the model is emitting a reasoning block, which overruns the classifier's
    // token budget and truncates its JSON mid-object.
    results.push(iffy('Trial completion',
      'The model spent ' + probe.completionTokens + ' tokens on a one-word reply,\n' +
      'which means it is emitting a reasoning block. Classifications will come\n' +
      'back truncated. Start the server with:\n' +
      "  --chat-template-args '{\"enable_thinking\": false}'\n" +
      '(host/mlx-server.sh does this for you.)'));
  } else {
    results.push(ok('Trial completion', `${probe.completionTokens ?? '?'} tokens`));
  }
  return results;
}

export function checkCredentials(): CheckResult {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    return bad('credentials.json',
      'Download an OAuth client (Desktop app) from your own Google Cloud project\n' +
      'and save it here as credentials.json. Run: npm run setup');
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
    if (!parsed.installed) {
      return bad('credentials.json',
        'This is a Web application OAuth client. Create a Desktop app client\n' +
        'instead — the loopback flow on port 3000 requires it.',
        parsed.web ? 'found a "web" client' : 'no "installed" section');
    }
    return ok('credentials.json', 'Desktop app client');
  } catch {
    return bad('credentials.json', 'The file is not valid JSON — re-download it from Google Cloud Console.');
  }
}

export async function checkGmail(): Promise<CheckResult[]> {
  if (!fs.existsSync(TOKEN_PATH)) {
    return [bad('Gmail authorization', 'Run: npm run auth')];
  }
  const results: CheckResult[] = [];
  try {
    const { GmailService } = await import('../../src/services/gmail.js');
    const gmail = new GmailService();
    await gmail.initialize();
    const address = await gmail.getAuthenticatedAddress();
    results.push(ok('Gmail authorization', address));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const expired = /invalid_grant|Token has been expired|revoked/i.test(message);
    return [bad('Gmail authorization',
      expired
        ? 'Authorization expired or was revoked. Run: npm run auth\n' +
          'The two usual causes, in order:\n' +
          '  1. The OAuth consent screen was left in "Testing" status — Google\n' +
          '     expires those refresh tokens after 7 days. Set it to "In production".\n' +
          '  2. Access was revoked at https://myaccount.google.com/permissions'
        : `Gmail API call failed. Run: npm run auth\n${message}`,
      expired ? 'invalid_grant' : undefined)];
  }

  // Token age is the cheapest evidence that the consent screen is set right:
  // a token still working after a week cannot be from a Testing-status project.
  try {
    const stored = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
    if (stored.issued_at) {
      const days = Math.floor((Date.now() - Date.parse(stored.issued_at)) / 86_400_000);
      results.push(days >= 7
        ? ok('OAuth consent screen', `token is ${days} days old — consent screen is in production`)
        : note('OAuth consent screen', `token is ${days} day(s) old — too new to confirm it will outlive 7 days`));
    } else {
      results.push(note('OAuth consent screen', 'token predates age tracking — re-auth to start recording it'));
    }
  } catch {
    // token.json unreadable is already covered by the API call above
  }
  return results;
}

export async function checkDatabase(dbPath: string): Promise<CheckResult> {
  const resolved = path.resolve(dbPath);
  if (!fs.existsSync(resolved)) {
    try {
      fs.accessSync(path.dirname(resolved), fs.constants.W_OK);
      return note('Database', `${dbPath} will be created on the first run`);
    } catch {
      return bad('Database', `Cannot write to ${path.dirname(resolved)}`);
    }
  }
  try {
    const Database = (await import('better-sqlite3')).default;
    // Read-only: doctor must never create tables or migrate a schema.
    const db = new Database(resolved, { readonly: true, fileMustExist: true });
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all() as { name: string }[];
    const names = tables.map((t) => t.name);
    const missing = ['emails', 'deals', 'meta'].filter((t) => !names.includes(t));
    const count = names.includes('emails')
      ? (db.prepare('SELECT COUNT(*) AS n FROM emails').get() as { n: number }).n
      : 0;
    db.close();
    if (missing.length) {
      return iffy('Database', `Missing tables: ${missing.join(', ')} — they are created on the next run.`);
    }
    return ok('Database', `${dbPath} — ${count.toLocaleString()} classified emails`);
  } catch (err) {
    return bad('Database', `Cannot open ${dbPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function checkSchedule(label: string): Promise<CheckResult> {
  try {
    await execFileAsync('launchctl', ['print', `gui/${process.getuid?.() ?? 0}/${label}`]);
    const logPath = path.join(process.cwd(), 'logs', 'daily.log');
    const last = fs.existsSync(logPath) ? fs.statSync(logPath).mtime.toLocaleString() : 'no runs logged yet';
    return note('Scheduled runs', `installed — last log activity: ${last}`);
  } catch {
    return note('Scheduled runs', 'not installed (npm run schedule:install)');
  }
}

// .gitignore protects nothing if a file was force-added before it was ignored.
export async function checkTrackedSecrets(): Promise<CheckResult> {
  const sensitive = ['.env', 'token.json', 'credentials.json', 'inbox.db', 'newsletter-state.json'];
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '--', ...sensitive]);
    const tracked = stdout.split('\n').filter(Boolean);
    if (tracked.length) {
      return bad('Git hygiene',
        `These are tracked by git despite .gitignore — remove them before pushing:\n` +
        tracked.map((f) => `  git rm --cached ${f}`).join('\n'),
        tracked.join(', '));
    }
    return ok('Git hygiene', 'no secrets tracked');
  } catch {
    return note('Git hygiene', 'not a git repository — skipped');
  }
}
