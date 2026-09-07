import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GmailService } from './services/gmail.js';
import { EmailClassifier } from './services/classifier.js';
import { GeminiClassifier } from './services/gemini-classifier.js';
import { LlamaClassifier } from './services/llama-classifier.js';
import { ClaudeCliClassifier } from './services/claude-cli-classifier.js';
import { DatabaseService } from './services/database.js';
import { DealExtractor } from './services/deal-extractor.js';
import { NewsletterAnalyzer } from './services/newsletter-analyzer.js';
import { NewsletterStateService } from './services/newsletter-state.js';
import { config, validateConfig, calculateCost } from './config.js';
import { ProcessingResult, EmailData, EmailClassification, UsageMetadata, NewsletterResult, EmailRecord } from './types.js';

interface IClassifier {
  classify(email: EmailData): Promise<EmailClassification>;
  classifyBatch(emails: EmailData[]): Promise<Map<string, EmailClassification>>;
}

async function main() {
  let gmailService: GmailService | null = null;
  let command = 'organize';
  try {
    validateConfig();

    command = process.argv[2] || 'organize';

    gmailService = new GmailService();
    console.log('Initializing Gmail connection...');
    await gmailService.initialize();

    if (command === 'stats') {
      await showStats(gmailService);
      return;
    }

    if (command === 'classify') {
      await classifyOnly(gmailService);
      return;
    }

    if (command === 'organize') {
      await organizeInbox(gmailService);
      return;
    }

    if (command === 'newsletters') {
      await reviewNewsletters(gmailService);
      return;
    }

    // Send the digest on its own, without a classify-and-file run in front of
    // it. --test covers a fixed 7-day window and leaves last_digest untouched,
    // so a trial send cannot swallow the window the next real digest reports.
    if (command === 'digest') {
      const test = process.argv.includes('--test');
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      await sendDailyDigest(gmailService, since, { test });
      return;
    }

    if (command === 'bulk' || command === 'daily') {
      const heldBy = acquireBulkLock();
      if (heldBy !== null) {
        console.log(`⏭  Skipping — another bulk run (PID ${heldBy}) is already in progress. Not starting a duplicate.`);
        return;
      }
      try {
        if (command === 'daily') {
          await fixUnknownLabels(gmailService);
        }
        const runStart = new Date().toISOString();
        await bulkProcess(gmailService);
        if (command === 'daily') {
          await normalizeCompanyNames();
          await sendDailyDigest(gmailService, runStart);
        }
      } finally {
        releaseBulkLock();
      }
      return;
    }

    if (command === 'db-stats') {
      await showDbStats();
      return;
    }

    if (command === 'migrate-labels') {
      await gmailService.migrateMarketingLabels(config.dryRun);
      return;
    }

    if (command === 'merge-labels') {
      await mergeLabels(gmailService);
      return;
    }

    if (command === 'relabel-missing' || command === 'relabel-archived') {
      await relabelArchived(gmailService);
      return;
    }

    if (command === 'fix-unknown') {
      await fixUnknownLabels(gmailService);
      return;
    }

    if (command === 'fix-unread') {
      await fixUnreadMarketing(gmailService);
      return;
    }

    console.error(`Unknown command: ${command}`);
    console.log('Available commands: stats, classify, organize, bulk, db-stats, migrate-labels, relabel-missing, fix-unknown, fix-unread');
    process.exit(1);
  } catch (error) {
    console.error('Error:', error);
    if (command === 'bulk' || command === 'daily') {
      const reason = error instanceof Error ? error.message : String(error);
      await notifyFailure(gmailService, 'Inbox Manager: run crashed', `The "${command}" command crashed unexpectedly:\n\n${reason}`);
    }
    process.exit(1);
  }
}

async function showStats(gmailService: GmailService) {
  console.log('\nFetching email statistics...\n');
  const stats = await gmailService.getEmailCount();

  console.log('📊 Email Statistics');
  console.log('─'.repeat(40));
  console.log(`Total emails:     ${stats.total.toLocaleString()}`);
  console.log(`Inbox emails:     ${stats.inbox.toLocaleString()}`);
  console.log(`Unread emails:    ${stats.unread.toLocaleString()}`);
  console.log('─'.repeat(40));
}

function createClassifier(): IClassifier {
  if (config.aiProvider === 'claude') {
    return new EmailClassifier();
  } else if (config.aiProvider === 'llama') {
    return new LlamaClassifier(config.llamaBaseUrl, config.llamaModel);
  } else if (config.aiProvider === 'claude-cli') {
    return new ClaudeCliClassifier();
  } else {
    return new GeminiClassifier(config.geminiApiKey, config.geminiModel);
  }
}

const execFileAsync = promisify(execFile);

// Restart the model server when it stops working. Two topologies:
//   · model on another Mac  → LLAMA_SSH_HOST, restarted over ssh
//   · model on this Mac     → loopback base URL, restarted with launchctl
// Unset and non-loopback means we have no way in, and say so rather than
// pretending to recover.
// The default is macOS/launchd — `kickstart -k` restarts even a process that is
// running but wedged, which is the case this exists for. A non-macOS model host
// must set LLAMA_RESTART_CMD to its own equivalent; empty disables restarts.
function remoteStartCommand(): string {
  return config.llamaRestartCmd;
}

function isLoopbackHost(): boolean {
  try {
    const { hostname } = new URL(config.llamaBaseUrl);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

async function tryStartRemoteLlamaServer(): Promise<boolean> {
  const command = remoteStartCommand();
  if (!command) {
    console.log('   Automatic restart is disabled (LLAMA_RESTART_CMD is empty).');
    return false;
  }
  if (config.llamaSshHost) {
    await execFileAsync(
      'ssh',
      ['-o', 'ConnectTimeout=10', config.llamaSshHost, command],
      { timeout: 30_000 }
    );
    return true;
  }
  if (isLoopbackHost()) {
    await execFileAsync('/bin/sh', ['-c', command], { timeout: 30_000 });
    return true;
  }
  console.log(
    '   No way to restart the model host automatically.\n' +
    '   Set LLAMA_SSH_HOST in .env (an ssh alias for the model machine) to enable it.'
  );
  return false;
}

// Called when the classifier endpoint appears to be down (repeated connection
// errors). Confirms the outage, attempts a remote restart over SSH if it's the
// llama provider, then polls for recovery. Returns false if the endpoint never
// comes back — the caller should stop the run rather than keep burning through
// the inbox marking everything as an error.
async function recoverClassifierEndpoint(classifier: IClassifier): Promise<boolean> {
  if (!(classifier instanceof LlamaClassifier)) return false;

  // Deliberately canGenerate() and not isHealthy(): a server whose generation
  // thread has died keeps answering /v1/models, so a liveness check here would
  // declare everything fine and let the run burn through the inbox marking
  // every email as an error. That is exactly what happened on 2026-09-04.
  if (await classifier.canGenerate()) return true;

  const reachable = await classifier.isHealthy();
  console.log(reachable
    ? '\n\n⚠️  llama server is reachable but not generating — attempting restart...'
    : '\n\n⚠️  llama server unreachable — attempting restart...');

  try {
    const attempted = await tryStartRemoteLlamaServer();
    if (!attempted) return false;
  } catch (err) {
    console.log(`   Restart attempt failed: ${(err as Error).message}`);
  }

  // Model loading can take a minute or two — poll for up to 3 minutes.
  for (let attempt = 0; attempt < 18; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10_000));
    if (await classifier.canGenerate(30_000)) {
      console.log('   ✓ llama server is generating again — resuming.\n');
      return true;
    }
  }
  return false;
}

// Best-effort failure alert: a macOS notification (visible if you're at the
// machine) plus an email to yourself (reaches you even when you're away).
// Both channels are independent and swallow their own errors — a notification
// failure should never crash the run it's reporting on.
async function notifyFailure(gmailService: GmailService | null, subject: string, message: string): Promise<void> {
  try {
    await execFileAsync('osascript', [
      '-e',
      `display notification ${JSON.stringify(message)} with title ${JSON.stringify(subject)} sound name "Basso"`,
    ]);
  } catch {
    // no GUI session, osascript unavailable, etc.
  }

  if (gmailService) {
    try {
      await gmailService.sendEmail(
        await resolveRecipient(gmailService),
        `⚠️ ${subject}`,
        `<p>${message.replace(/\n/g, '<br>')}</p>`
      );
    } catch (err) {
      console.error('Failed to send failure notification email:', err);
    }
  }
}

const BULK_LOCK_PATH = path.join(process.cwd(), '.bulk.lock');

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Prevents `bulk`/`daily` runs from overlapping — e.g. the 7am launchd `daily`
// job firing while a manual `bulk` run from the day before is still going.
// Concurrent runs hammer the same llama.cpp endpoint and starve each other's
// health checks, which triggers false-positive "endpoint unreachable" stops
// and failure emails even though the endpoint is fine — just busy.
function acquireBulkLock(): number | null {
  if (fs.existsSync(BULK_LOCK_PATH)) {
    const heldBy = parseInt(fs.readFileSync(BULK_LOCK_PATH, 'utf-8').trim(), 10);
    if (!isNaN(heldBy) && isProcessAlive(heldBy)) {
      return heldBy;
    }
  }
  fs.writeFileSync(BULK_LOCK_PATH, String(process.pid));
  return null;
}

function releaseBulkLock(): void {
  try {
    if (parseInt(fs.readFileSync(BULK_LOCK_PATH, 'utf-8').trim(), 10) === process.pid) {
      fs.unlinkSync(BULK_LOCK_PATH);
    }
  } catch {
    // already gone
  }
}

async function normalizeCompanyNames(): Promise<void> {
  const db = new DatabaseService();
  const names = db.getDistinctCompanyNames();
  db.close();

  if (names.length === 0) return;

  const completionFn = await createCompletionFn(1200);
  const BATCH = 40;
  let updated = 0;

  for (let i = 0; i < names.length; i += BATCH) {
    const batch = names.slice(i, i + BATCH);
    const numbered = batch.map((n, idx) => `${idx + 1}. ${n}`).join('\n');

    const prompt = `You are cleaning up company names extracted from marketing emails. For each name in the list, return the canonical short consumer-facing brand name.

Rules:
- Strip legal suffixes: LLC, Inc, Corp, Ltd, Co, Group, International, Holdings
- Strip domain extensions: .com, .net, .org
- Use what consumers call the brand ("Home Depot" not "The Home Depot, Inc.")
- If already clean (e.g. "Amazon"), return it unchanged
- If multiple names refer to the same company (e.g. "myQ (Chamberlain)" and "Chamberlain Group LLC"), map both to the same canonical name
- Title Case

Names:
${numbered}

Output a JSON object mapping each input name exactly as given to its canonical form:
{"Input Name Here": "Canonical Name", ...}
Output the JSON object only, nothing else.`;

    let response: string;
    try {
      response = await completionFn(prompt);
    } catch (err) {
      console.warn(`⚠️  Normalization batch ${Math.floor(i / BATCH) + 1} failed: ${(err as Error).message}`);
      continue;
    }

    const cleaned = response.replace(/```(?:json)?/g, '').replace(/```/g, '').trim();
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!objMatch) {
      console.warn(`⚠️  Normalization batch ${Math.floor(i / BATCH) + 1} parse failed`);
      continue;
    }

    let mapping: Record<string, string>;
    try {
      mapping = JSON.parse(objMatch[0]);
    } catch {
      console.warn(`⚠️  Normalization batch ${Math.floor(i / BATCH) + 1} JSON error`);
      continue;
    }

    const db2 = new DatabaseService();
    for (const [oldName, canonicalName] of Object.entries(mapping)) {
      if (typeof canonicalName !== 'string' || !canonicalName.trim()) continue;
      if (oldName === canonicalName) continue;
      if (!batch.includes(oldName)) continue;
      db2.updateCompanyName(oldName, canonicalName.trim());
      updated++;
    }
    db2.close();
  }

  if (updated > 0) {
    console.log(`\n✅ Normalized ${updated} company name${updated !== 1 ? 's' : ''}`);
  }
}

// DIGEST_RECIPIENT in .env wins; otherwise mail goes to whichever account
// token.json authorized, so a fresh install needs no configuration at all.
async function resolveRecipient(gmailService: GmailService): Promise<string> {
  return config.digestRecipient || await gmailService.getAuthenticatedAddress();
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// One combined email per run: deals + who's mailing you + inbox health.
// The window runs from the previous digest (not this run's start) so a run that
// was skipped — laptop asleep at 8am — still gets reported in the next email.
async function sendDailyDigest(
  gmailService: GmailService,
  runStart: string,
  opts: { test?: boolean } = {},
): Promise<void> {
  const db = new DatabaseService();

  const nowIso = new Date().toISOString();
  // A test send reports the window it was handed and does not move the
  // bookmark, so the next scheduled digest still covers everything since the
  // last real one.
  const since = opts.test ? runStart : (db.getMeta('last_digest') ?? runStart);

  const health = db.getClassificationHealthSince(since);
  if (health.total === 0) {
    // Nothing was processed in the window — no news is not worth an email.
    db.close();
    return;
  }

  const dealsHtml = buildDealsSection(db, since, config.gmailAccountIndex);
  const companiesHtml = buildCompaniesSection(db, since);
  const flagged = db.getBuriedTransactionalCandidates(since);

  // Record the send up front so a mid-send crash can't re-report the same window.
  if (!opts.test) db.setMeta('last_digest', nowIso);
  db.close();

  const healthHtml = buildHealthSection(health, flagged);

  const hr = '<hr style="border:none;border-top:1px solid #eee;margin:24px 0">';
  const html = [dealsHtml.html, companiesHtml, healthHtml].join(hr);

  const now = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const bits = [`${health.total} classified`];
  if (dealsHtml.count > 0) bits.unshift(`${dealsHtml.count} deal${dealsHtml.count > 1 ? 's' : ''}`);
  if (flagged.length > 0) bits.push(`${flagged.length} to review`);
  const subject = `${opts.test ? '[TEST] ' : ''}📬 Inbox Digest — ${bits.join(' · ')} (${now})`;

  try {
    await gmailService.sendEmail(await resolveRecipient(gmailService), subject, html);
    console.log(`\n📬 Digest sent — ${bits.join(', ')}.`);
  } catch (err) {
    console.error('   ⚠️  Failed to send digest:', err);
  }
}

// Gmail permalink for one message.
//
// The /u/ slot takes an account index, not an address. An address there --
// percent-encoded, so the @ arrives as %40 -- fails with Gmail's "your account
// is temporarily unavailable", numeric code 6446, which reads like an outage
// rather than a malformed URL. GMAIL_ACCOUNT_INDEX exists for readers whose
// mailbox is not the first account signed in; 0 is right for most people.
//
// #all/ rather than #inbox/ — marketing mail is archived by the time the
// digest goes out, so an #inbox/ link would land on nothing.
function gmailLink(accountIndex: string, messageId: string): string {
  return `https://mail.google.com/mail/u/${encodeURIComponent(accountIndex)}/#all/${encodeURIComponent(messageId)}`;
}

function buildDealsSection(db: DatabaseService, since: string, accountIndex: string): { html: string; count: number } {
  const currentDeals = db.getDealsExtractedSince(since);
  const history14d = db.getRecentDealHistory(since, 14);
  const history7d  = db.getRecentDealHistory(since, 7);

  // Company names are now expected to be canonical from the LLM prompt,
  // so we compare case-insensitively on the name as extracted.
  const norm = (s: string) => s.toLowerCase().trim();

  const seenDescriptions = new Set(history14d.map(d => `${norm(d.company_name)}::${d.description}`));
  const companyCounts7d  = new Map<string, number>();
  for (const d of history7d) {
    const k = norm(d.company_name);
    companyCounts7d.set(k, (companyCounts7d.get(k) ?? 0) + 1);
  }

  const good = currentDeals.filter(d => {
    if (d.discount_type === 'percentage' && (d.discount_value ?? 0) < 20) return false;
    if (d.discount_type === 'flat'       && (d.discount_value ?? 0) < 20) return false;
    if (d.discount_type !== 'percentage' && d.discount_type !== 'flat' && d.discount_type !== 'bogo') return false;

    const key = norm(d.company_name);
    if (seenDescriptions.has(`${key}::${d.description}`)) return false;
    if ((companyCounts7d.get(key) ?? 0) >= 4) return false;

    return true;
  });

  if (good.length === 0) {
    return {
      count: 0,
      html: `<h2 style="font-family:sans-serif;margin:0 0 8px">🏷 Good deals</h2>
<p style="font-family:sans-serif;color:#777;font-size:14px;margin:0">No new deals worth flagging in this window.</p>`,
    };
  }

  const rows = good.map(d => {
    const discount = d.discount_type === 'percentage'
      ? `${d.discount_value}% off`
      : d.discount_type === 'flat'
        ? `$${d.discount_value} off`
        : d.discount_type;
    const href = esc(gmailLink(accountIndex, d.email_id));
    return `<tr>
      <td style="padding:6px 12px;font-weight:bold"><a href="${href}" style="color:#1a73e8;text-decoration:none">${esc(d.company_name)}</a></td>
      <td style="padding:6px 12px;color:#c0392b">${esc(discount)}</td>
      <td style="padding:6px 12px"><a href="${href}" style="color:#222;text-decoration:none">${esc(d.description)}</a></td>
    </tr>`;
  }).join('\n');

  const html = `<h2 style="font-family:sans-serif;margin:0 0 8px">🏷 ${good.length} new deal${good.length > 1 ? 's' : ''} found</h2>
<table style="font-family:sans-serif;border-collapse:collapse;font-size:14px">
  <thead>
    <tr style="background:#f2f2f2">
      <th style="padding:6px 12px;text-align:left">Company</th>
      <th style="padding:6px 12px;text-align:left">Discount</th>
      <th style="padding:6px 12px;text-align:left">Description</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>`;

  return { html, count: good.length };
}

// `"Name" <a@b.com>` → `Name`, `<a@b.com>` → `a@b.com`. Company names, which
// never carry an angle-bracket address, pass through untouched.
function prettySender(raw: string): string {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (!m) return raw.trim();
  return m[1].trim() || m[2].trim();
}

// Who mailed you in this window, grouped by category then volume.
function buildCompaniesSection(db: DatabaseService, since: string): string {
  const rows = db.getCompanyBreakdownSince(since);
  if (rows.length === 0) {
    return `<h2 style="font-family:sans-serif;margin:0 0 8px">🏢 Who's mailing you</h2>
<p style="font-family:sans-serif;color:#777;font-size:14px;margin:0">No senders in this window.</p>`;
  }

  // Rows fall back to the raw From header when there's no company name (most
  // personal mail), so labels are prettified here — which can make two rows
  // collapse to the same name, hence the merge rather than a plain push.
  const byCategory = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const counts = byCategory.get(r.category) ?? new Map<string, number>();
    const label = prettySender(r.company);
    counts.set(label, (counts.get(label) ?? 0) + r.count);
    byCategory.set(r.category, counts);
  }

  // Familiar categories first, then anything else the classifier produced.
  const PRIMARY = ['marketing', 'transactional', 'personal'];
  const categories = [...byCategory.keys()].sort((a, b) => {
    const ia = PRIMARY.indexOf(a), ib = PRIMARY.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a.localeCompare(b);
  });

  const blocks = categories.map(cat => {
    const list = [...byCategory.get(cat)!.entries()]
      .map(([company, count]) => ({ company, count }))
      .sort((a, b) => b.count - a.count || a.company.localeCompare(b.company));
    const emails = list.reduce((n, c) => n + c.count, 0);
    const items = list.map(c => `<tr>
      <td style="padding:3px 12px 3px 0">${esc(c.company)}</td>
      <td style="padding:3px 0;text-align:right;color:#555;white-space:nowrap">${c.count}</td>
    </tr>`).join('\n');

    return `<div style="margin:0 0 18px">
  <div style="font-family:sans-serif;font-size:13px;font-weight:bold;text-transform:uppercase;letter-spacing:.04em;color:#444;margin:0 0 6px">
    ${esc(cat)} — ${list.length} compan${list.length === 1 ? 'y' : 'ies'}, ${emails} email${emails === 1 ? '' : 's'}
  </div>
  <table style="font-family:sans-serif;border-collapse:collapse;font-size:14px;min-width:280px">
    <tbody>${items}</tbody>
  </table>
</div>`;
  }).join('\n');

  // Counted after the merge above so the header agrees with the rows listed.
  const totalCompanies = [...byCategory.values()].reduce((n, m) => n + m.size, 0);
  const totalEmails = rows.reduce((n, r) => n + r.count, 0);

  return `<h2 style="font-family:sans-serif;margin:0 0 4px">🏢 Who's mailing you</h2>
<p style="font-family:sans-serif;font-size:13px;color:#555;margin:0 0 14px">
  ${totalCompanies} sender${totalCompanies === 1 ? '' : 's'} · ${totalEmails} email${totalEmails === 1 ? '' : 's'} in this window.
</p>
${blocks}`;
}

function buildHealthSection(
  health: { byCategory: Array<{ category: string; count: number }>; total: number; archived: number; newSenders: number },
  candidates: Array<{ from_address: string; subject: string; company_name: string | null; sender_txn_pct: number; sender_total: number }>
): string {
  let flagHtml: string;
  if (candidates.length === 0) {
    flagHtml = `<p style="font-family:sans-serif;color:#27ae60;font-size:15px;margin:0 0 8px">
      ✅ No buried-transactional candidates — nothing important looks misfiled.</p>`;
  } else {
    const rows = candidates.map(c => `<tr>
      <td style="padding:6px 12px;font-weight:bold">${esc(prettySender(c.company_name || c.from_address))}</td>
      <td style="padding:6px 12px;color:#c0392b">${c.sender_txn_pct}% txn (${c.sender_total})</td>
      <td style="padding:6px 12px">${esc(c.subject)}</td>
    </tr>`).join('\n');
    flagHtml = `<h3 style="font-family:sans-serif;color:#c0392b;margin:0 0 4px">🚩 ${candidates.length} possible buried transactional</h3>
    <p style="font-family:sans-serif;font-size:13px;color:#555;margin:0 0 10px">Filed as marketing (archived + read) but from senders who usually send you transactional mail. Review these:</p>
    <table style="font-family:sans-serif;border-collapse:collapse;font-size:14px">
      <thead><tr style="background:#f2f2f2">
        <th style="padding:6px 12px;text-align:left">Sender</th>
        <th style="padding:6px 12px;text-align:left">Sender history</th>
        <th style="padding:6px 12px;text-align:left">Subject</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  const catLine = health.byCategory.map(c => `${c.count} ${c.category}`).join(', ');
  const archivedPct = health.total > 0 ? Math.round((health.archived / health.total) * 100) : 0;

  return `<h2 style="font-family:sans-serif;margin:0 0 10px">📊 Inbox health</h2>
${flagHtml}
<p style="font-family:sans-serif;font-size:14px;color:#333;margin:14px 0 0">
  <strong>${health.total}</strong> emails classified in this window — ${esc(catLine)}.<br>
  ${health.archived} archived (${archivedPct}%) · ${health.newSenders} new sender${health.newSenders !== 1 ? 's' : ''} seen for the first time.
</p>`;
}

function getProviderDisplayName(): string {
  if (config.aiProvider === 'claude') {
    return `Claude ${config.claudeModel}`;
  } else if (config.aiProvider === 'llama') {
    return `llama.cpp (${config.llamaModel}) @ ${config.llamaBaseUrl}`;
  } else if (config.aiProvider === 'claude-cli') {
    return `Claude CLI (claude -p)`;
  } else {
    return `Gemini ${config.geminiModel}`;
  }
}

async function createCompletionFn(maxTokens = 512): Promise<(prompt: string) => Promise<string>> {
  if (config.aiProvider === 'llama') {
    const baseUrl = config.llamaBaseUrl.replace(/\/$/, '');
    const { request } = await import('undici');
    return async (prompt: string) => {
      const { body, statusCode } = await request(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: config.llamaModel,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          temperature: 0.1,
          enable_thinking: false,
          chat_template_kwargs: { enable_thinking: false },
        }),
        headersTimeout: 600_000,
        bodyTimeout: 600_000,
      });
      if (statusCode !== 200) throw new Error(`llama server error: ${statusCode}`);
      const data = await body.json() as { choices: Array<{ message: { content: string } }> };
      return data.choices[0]?.message?.content ?? '';
    };
  }
  // Claude CLI completion
  if (config.aiProvider === 'claude-cli') {
    const { execSync } = await import('child_process');
    return async (prompt: string) => {
      const result = execSync('claude -p', {
        input: prompt,
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });
      return result.toString().trim();
    };
  }
  // Fallback: Gemini completion
  if (config.aiProvider === 'gemini') {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const client = new GoogleGenerativeAI(config.geminiApiKey);
    const model = client.getGenerativeModel({ model: config.geminiModel });
    return async (prompt: string) => {
      const result = await model.generateContent(prompt);
      return result.response.text();
    };
  }
  // Claude completion
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  return async (prompt: string) => {
    const message = await client.messages.create({
      model: config.getClaudeModelId(),
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });
    return message.content[0].type === 'text' ? message.content[0].text : '';
  };
}

const THREE_WEEKS_MS = 21 * 24 * 60 * 60 * 1000;

function isMeetingInvite(email: EmailData): boolean {
  const sub = email.subject.toLowerCase();
  const from = email.from.toLowerCase();
  return /invitation:|invited you to|meeting invite|you're invited|cordially invited|join (me|us) (for|on)|zoom invite|teams meeting|google meet invite/.test(sub)
    || from.includes('calendar-notification@')
    || from.includes('@calendar.')
    || sub.startsWith('accepted:')
    || sub.startsWith('declined:')
    || sub.startsWith('tentative:');
}

function isPolicyOrAdminUpdate(email: EmailData): boolean {
  const sub = email.subject.toLowerCase();
  return /(privacy policy|terms of service|terms of use|terms and conditions|policy update|updated (our |your )?(terms|policy|privacy)|changes to our (terms|privacy|policy)|we.ve updated|data protection|gdpr|ccpa|we.re updating|important changes to|notice of (change|update))/.test(sub);
}

function parseEmailDate(dateStr: string): { ts: number; year: number; month: number } {
  const ts = dateStr ? new Date(dateStr).getTime() : Date.now();
  const d = new Date(isNaN(ts) ? Date.now() : ts);
  return { ts: isNaN(ts) ? Date.now() : ts, year: d.getFullYear(), month: d.getMonth() + 1 };
}

// Runs `fn` over `items` with at most `limit` calls in flight, preserving input
// order in the result. `fn` is expected to handle its own errors — a rejection
// here aborts the whole batch.
async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function bulkProcess(gmailService: GmailService) {
  const db = new DatabaseService();
  const classifier = createClassifier();
  const completionFn = await createCompletionFn();
  const dealExtractor = new DealExtractor(completionFn, db);

  console.log(`\n📦 Bulk Inbox Processor — ${getProviderDisplayName()}`);
  if (config.dryRun) console.log('⚠️  DRY RUN — no Gmail changes will be made\n');

  const alreadyDone = db.getProcessedCount();
  if (alreadyDone > 0) {
    console.log(`↩️  Resuming — ${alreadyDone.toLocaleString()} emails already in database\n`);
  }

  // Phase 1: collect all inbox IDs before touching anything, avoiding pagination drift
  console.log('Phase 1: Collecting inbox IDs...');
  const allIds: string[] = [];
  let pageToken: string | undefined;
  let pageNum = 0;
  do {
    pageNum++;
    const page = await gmailService.getInboxPage(100, pageToken);
    pageToken = page.nextPageToken;
    allIds.push(...page.ids);
    process.stdout.write(`\r  Page ${pageNum} — ${allIds.length.toLocaleString()} IDs collected...`);
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (pageToken);
  console.log(`\n  Total: ${allIds.length.toLocaleString()} emails in inbox.\n`);

  // Phase 2: process each ID
  console.log('Phase 2: Classifying and archiving...\n');
  const stats = { marketing: 0, transactional: 0, personal: 0, errors: 0, skipped: 0, trashed: 0 };
  const startTime = Date.now();

  const MAX_CONSECUTIVE_CONNECTION_ERRORS = 3;
  let consecutiveConnectionErrors = 0;

  // Emails are processed in chunks rather than one at a time. The classifier's
  // batch path sends 15 emails per request with 3 requests in flight, which is
  // what src/benchmark.ts actually measures (~680ms/email). The old per-email
  // loop forfeited all of it and cost ~6s/email, because every email paid for
  // its own classification round trip plus two serial Gmail round trips — a
  // 13k inbox took ~22h instead of ~2.5h.
  const CHUNK_SIZE = 45;        // 3 classifier batches of 15
  const GMAIL_CONCURRENCY = 8;  // read round trips in flight
  const WRITE_CONCURRENCY = 5;  // label modifications in flight
  const DEAL_CONCURRENCY = 3;   // extra LLM calls in flight

  // Only the llama provider has a restartable local endpoint, so only it gets
  // the outage-recovery escalation; for hosted providers an empty result is
  // just an error to count.
  const canRecoverEndpoint = classifier instanceof LlamaClassifier;

  const printProgress = (done: number) => {
    process.stdout.write(`\r  [${done.toLocaleString()}/${allIds.length.toLocaleString()}] M:${stats.marketing} T:${stats.transactional} P:${stats.personal} Skip:${stats.skipped} Trash:${stats.trashed} E:${stats.errors}   `);
  };

  const stopForOutage = async (done: number): Promise<never> => {
    const message = `AI classifier endpoint unreachable after ${consecutiveConnectionErrors} consecutive failures and recovery attempts.\n\n`
      + `Processed ${done.toLocaleString()}/${allIds.length.toLocaleString()} emails before stopping (no progress lost — failed emails weren't saved).\n\n`
      + `Resume with: npm run dev bulk`;
    console.log(`\n\n🛑 Stopping — AI classifier endpoint is unreachable after ${consecutiveConnectionErrors} consecutive failures.`);
    console.log(`   Processed ${done.toLocaleString()}/${allIds.length.toLocaleString()} before stopping (no progress lost — failed emails weren't saved).`);
    console.log(`   Resume later with: npm run dev bulk\n`);
    await notifyFailure(gmailService, 'Inbox Manager: bulk run stopped', message);
    db.close();
    process.exit(1);
  };

  for (let start = 0; start < allIds.length; start += CHUNK_SIZE) {
    const chunkIds = allIds.slice(start, start + CHUNK_SIZE);
    const done = Math.min(start + CHUNK_SIZE, allIds.length);

    // Already-processed emails need no network read at all
    const toFetch: string[] = [];
    for (const id of chunkIds) {
      const emailState = db.getEmailState(id);
      if (emailState?.skip) {
        // Archive in Gmail if this was a dry-run leftover still sitting in inbox
        if (emailState.needsGmailArchive && !config.dryRun) {
          try {
            await gmailService.archiveEmail(id);
          } catch {
            // best-effort
          }
        }
        stats.skipped++;
        continue;
      }
      toFetch.push(id);
    }

    const fetched = await mapWithLimit(toFetch, GMAIL_CONCURRENCY, async id => {
      try {
        return await gmailService.getEmailWithBody(id);
      } catch {
        stats.errors++;
        return null;
      }
    });

    // Rule-based trashing runs before the LLM — these need no classification
    const candidates: { email: EmailData; body: string }[] = [];
    for (const item of fetched) {
      if (!item) continue;
      const { email, body } = item;
      const { ts: emailTs } = parseEmailDate(email.date);

      if (isMeetingInvite(email) && emailTs < Date.now() - THREE_WEEKS_MS) {
        await gmailService.trashEmail(email.id, config.dryRun);
        stats.trashed++;
        if (!config.dryRun) console.log(`\n🗑  Trashed stale invite: ${email.subject}`);
        continue;
      }
      if (isPolicyOrAdminUpdate(email)) {
        await gmailService.trashEmail(email.id, config.dryRun);
        stats.trashed++;
        if (!config.dryRun) console.log(`\n🗑  Trashed policy update: ${email.subject}`);
        continue;
      }
      candidates.push({ email, body });
    }

    if (candidates.length === 0) {
      printProgress(done);
      continue;
    }

    let classifications: Map<string, EmailClassification>;
    try {
      classifications = await classifier.classifyBatch(candidates.map(c => c.email));
    } catch {
      classifications = new Map();
    }

    // classifyBatch already retries individually and omits anything it still
    // cannot classify, so an empty map means the endpoint is gone rather than
    // that these particular emails were unparseable.
    if (classifications.size === 0) {
      stats.errors += candidates.length;
      if (canRecoverEndpoint) {
        consecutiveConnectionErrors++;
        if (consecutiveConnectionErrors >= MAX_CONSECUTIVE_CONNECTION_ERRORS) {
          const recovered = await recoverClassifierEndpoint(classifier);
          if (!recovered) await stopForOutage(start);
          consecutiveConnectionErrors = 0;
        }
      }
      printProgress(done);
      continue;
    }
    consecutiveConnectionErrors = 0;

    // Persist first, then do the network work concurrently. sqlite writes are
    // synchronous so they stay ordered and cheap here.
    const organizeQueue: { email: EmailData; classification: EmailClassification }[] = [];
    const personalQueue: { email: EmailData; classification: EmailClassification }[] = [];
    const dealQueue: { email: EmailData; body: string; company: string }[] = [];

    for (const { email, body } of candidates) {
      const classification = classifications.get(email.id);
      if (!classification) {
        // Deliberately left in the inbox and unsaved, for a later run to retry
        stats.errors++;
        continue;
      }

      const { ts, year, month } = parseEmailDate(email.date);

      const record: EmailRecord = {
        id: email.id,
        threadId: email.threadId,
        subject: email.subject,
        fromAddress: email.from,
        dateRaw: email.date,
        dateTs: ts,
        year,
        month,
        category: classification.category,
        companyName: classification.companyName ?? null,
        confidence: classification.confidence,
        snippet: email.snippet,
        archived: classification.category !== 'personal' ? 1 : 0,
        processedAt: new Date().toISOString(),
      };

      db.saveEmail(record);
      stats[classification.category]++;

      if (classification.category === 'marketing' && classification.companyName) {
        dealQueue.push({ email, body, company: classification.companyName });
      }
      if (classification.category === 'personal') {
        // Labelled but deliberately left in the inbox and unread — organizeEmail
        // always strips INBOX, which would archive real mail from real people.
        personalQueue.push({ email, classification });
      } else {
        organizeQueue.push({ email, classification });
      }
    }

    await mapWithLimit(dealQueue, DEAL_CONCURRENCY, async ({ email, body, company }) => {
      try {
        const deal = await dealExtractor.extract(email.id, company, email.subject, body);
        if (deal) db.saveDeal(deal);
      } catch {
        // best-effort
      }
      return null;
    });

    await mapWithLimit(organizeQueue, WRITE_CONCURRENCY, async ({ email, classification }) => {
      try {
        await gmailService.organizeEmail(email.id, classification, config.dryRun, email.from);
      } catch {
        stats.errors++;
      }
      return null;
    });

    await mapWithLimit(personalQueue, WRITE_CONCURRENCY, async ({ email, classification }) => {
      try {
        await gmailService.applyLabelOnly(email.id, classification, config.dryRun, email.from);
      } catch {
        stats.errors++;
      }
      return null;
    });

    printProgress(done);
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;

  console.log(`\n\n✨ Bulk processing complete in ${mins}m ${secs}s`);
  console.log('─'.repeat(40));
  console.log(`  Marketing:     ${stats.marketing.toLocaleString()}`);
  console.log(`  Transactional: ${stats.transactional.toLocaleString()}`);
  console.log(`  Personal:      ${stats.personal.toLocaleString()}`);
  console.log(`  Skipped:       ${stats.skipped.toLocaleString()} (already processed)`);
  console.log(`  Trashed:       ${stats.trashed.toLocaleString()} (stale invites + policy emails)`);
  console.log(`  Errors:        ${stats.errors}`);
  console.log('─'.repeat(40));
  console.log(`\n💡 Run 'npm run dev db-stats' to see historical analysis\n`);

  db.close();
}

interface LabelGroup {
  canonical: string;
  variants: string[];
}

async function groupBatchWithAI(
  names: string[],
  complete: (prompt: string) => Promise<string>,
  nameSet: Set<string>
): Promise<LabelGroup[]> {
  const prompt = `Below is a list of company/brand names from email labels. Many are duplicates or variations of the same brand.

Identify groups of names that refer to the same company and provide the single best canonical name for each group.

Guidelines:
- Abbreviations are duplicates (WSJ = Wall Street Journal)
- Truncated or garbled names are variants (e.g. "Mar" is "Marco's Pizza", "Men" is "Men's Wearhouse", "Cost" is "Costco")
- Sub-brands merge under the parent (Amazon Pharmacy → Amazon, Amazon Health → Amazon)
- Use proper spelling with apostrophes, capitals, and punctuation for the canonical name
- Only return groups with 2 or more names — ignore singletons

Company names:
${names.join('\n')}

Respond ONLY with a JSON array, no explanation, no markdown fences:
[{"canonical": "Wall Street Journal", "variants": ["WSJ", "The Wall Street Journal"]}, ...]`;

  const response = await complete(prompt);

  try {
    const match = response.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON array found');
    const parsed = JSON.parse(match[0]) as LabelGroup[];
    return parsed
      .filter(g => Array.isArray(g.variants) && g.variants.length > 0 && g.canonical)
      .map(g => ({
        canonical: g.canonical,
        variants: [...new Set(g.variants.filter(v => nameSet.has(v.toLowerCase())))],
      }))
      .filter(g => g.variants.length > 0);
  } catch {
    console.error('Failed to parse AI grouping response:', response.slice(0, 500));
    return [];
  }
}

async function groupLabelsWithAI(
  companyNames: string[],
  complete: (prompt: string) => Promise<string>
): Promise<LabelGroup[]> {
  const nameSet = new Set(companyNames.map(n => n.toLowerCase()));

  // Sort alphabetically so variants of the same company land in the same batch
  const sorted = [...companyNames].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  const BATCH_SIZE = 80;
  const allGroups: LabelGroup[] = [];

  for (let i = 0; i < sorted.length; i += BATCH_SIZE) {
    const batch = sorted.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const total = Math.ceil(sorted.length / BATCH_SIZE);
    process.stdout.write(`\r  Batch ${batchNum}/${total}...`);
    const groups = await groupBatchWithAI(batch, complete, nameSet);
    allGroups.push(...groups);
  }
  console.log();

  // Variants that should never be merged into any other label
  const NEVER_MERGE = new Set([
    'larry h miller chevrolet murray',
    'larry h. miller chevrolet murray',
    'u alumni',
    'uvu alumni association',
  ]);

  // Merge groups with the same canonical, also treating "The X" and "X" as the same
  const byCanonical = new Map<string, LabelGroup>();
  for (const g of allGroups) {
    const key = g.canonical.toLowerCase().replace(/^the\s+/, '');
    if (byCanonical.has(key)) {
      // Keep whichever canonical lacks the "The " prefix (cleaner)
      const existing = byCanonical.get(key)!;
      if (existing.canonical.startsWith('The ') && !g.canonical.startsWith('The ')) {
        existing.canonical = g.canonical;
      }
      existing.variants.push(...g.variants);
    } else {
      byCanonical.set(key, { canonical: g.canonical, variants: [...g.variants] });
    }
  }

  // Dedupe variants, drop self-references and blocklisted pairs
  const seen = new Set<string>();
  return [...byCanonical.values()]
    .map(g => ({
      canonical: g.canonical,
      variants: [...new Set(g.variants)]
        .filter(v => {
          if (v.toLowerCase() === g.canonical.toLowerCase()) return false;
          if (NEVER_MERGE.has(v.toLowerCase())) return false;
          const key = v.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }),
    }))
    .filter(g => g.variants.length > 0);
}

async function mergeLabels(gmailService: GmailService) {
  console.log('\n🔀 Marketing Label Merger (AI-powered)\n');

  const labels = await gmailService.getMarketingLabels();
  console.log(`Found ${labels.length} marketing labels. Asking AI to group duplicates...\n`);

  const completionFn = await createCompletionFn(4096);
  const groups = await groupLabelsWithAI(labels.map(l => l.companyName), completionFn);

  if (groups.length === 0) {
    console.log('No duplicate labels found.\n');
    return;
  }

  console.log(`Found ${groups.length} groups to merge:\n`);
  for (const group of groups) {
    console.log(`  ✦ ${group.canonical}`);
    for (const v of group.variants) console.log(`    ← ${v}`);
  }

  if (config.dryRun) {
    console.log('\n⚠️  DRY RUN — no changes made. Set DRY_RUN=false to execute.\n');
    return;
  }

  console.log('\nExecuting merges...\n');
  let merged = 0;
  let totalMoved = 0;

  // Build a lookup from company name → label id
  const labelByName = new Map(labels.map(l => [l.companyName.toLowerCase(), l]));

  for (const group of groups) {
    const canonicalLabelId = await gmailService.ensureLabel(`marketing/${group.canonical}`);

    for (const variantName of group.variants) {
      const label = labelByName.get(variantName.toLowerCase());
      if (!label) continue;

      const ids = await gmailService.listLabelMessageIds(label.id);
      if (ids.length > 0) {
        // Everything here is marketing by construction, so strip UNREAD too —
        // marketing is always read, whichever path last touched the message.
        await gmailService.batchModifyMessages(ids, [canonicalLabelId], [label.id, 'UNREAD']);
        totalMoved += ids.length;
      }
      await gmailService.deleteLabel(label.id);
      console.log(`  ✓ ${variantName} → ${group.canonical} (${ids.length} messages)`);
      merged++;
    }
  }

  console.log(`\n✨ Done — ${merged} labels merged, ${totalMoved.toLocaleString()} messages relabelled.`);
  console.log('Run migrate-labels next to set all marketing labels to "Show if Unread".\n');
}

async function showDbStats() {
  const db = new DatabaseService();
  const total = db.getProcessedCount();

  if (total === 0) {
    console.log('\nNo data yet — run the bulk command first.\n');
    db.close();
    return;
  }

  console.log(`\n📊 Inbox Database Stats (${total.toLocaleString()} emails)\n`);

  // Category totals
  console.log('── Category Totals ──────────────────────');
  for (const row of db.getCategoryTotals()) {
    const pct = ((row.count / total) * 100).toFixed(1);
    console.log(`  ${row.category.padEnd(15)} ${row.count.toLocaleString().padStart(8)}  (${pct}%)`);
  }

  // Volume by year
  console.log('\n── Email Volume by Year ─────────────────');
  const byYearMonth = db.getCountByYearMonth();
  const byYear: Record<number, Record<string, number>> = {};
  for (const row of byYearMonth) {
    if (!byYear[row.year]) byYear[row.year] = { marketing: 0, transactional: 0, personal: 0 };
    byYear[row.year][row.category] = (byYear[row.year][row.category] || 0) + row.count;
  }
  for (const year of Object.keys(byYear).sort()) {
    const y = byYear[Number(year)];
    const ytotal = Object.values(y).reduce((a, b) => a + b, 0);
    console.log(`  ${year}   total: ${ytotal.toLocaleString().padStart(6)}  M: ${(y.marketing || 0).toLocaleString().padStart(5)}  T: ${(y.transactional || 0).toLocaleString().padStart(5)}  P: ${(y.personal || 0).toLocaleString().padStart(4)}`);
  }

  // Top marketing senders
  console.log('\n── Top Marketing Senders ────────────────');
  for (const row of db.getTopSenders('marketing', 10)) {
    console.log(`  ${row.count.toString().padStart(5)}  ${row.from_address.slice(0, 60)}`);
  }

  // Repetitive promoters (discount fatigue)
  const repetitive = db.getRepetitivePromoters(10);
  if (repetitive.length > 0) {
    console.log('\n── Discount Fatigue (always the same deal) ──');
    for (const row of repetitive) {
      console.log(`  ${row.company_name.padEnd(25)} ${row.deal_count} deals  avg novelty: ${row.avg_novelty}  → "${row.typical_offer}"`);
    }
  }

  // Actually good deals (high novelty)
  const topDeals = db.getTopDeals(10);
  if (topDeals.length > 0) {
    console.log('\n── Most Unusual Deals (actually worth looking at) ──');
    for (const row of topDeals) {
      console.log(`  [${(row.novelty_score * 100).toFixed(0)}%] ${row.company_name.padEnd(20)} ${row.description}`);
      console.log(`        "${row.email_subject.slice(0, 60)}"`);
    }
  }

  console.log('');
  db.close();
}

async function classifyOnly(gmailService: GmailService) {
  const classifier = createClassifier();

  console.log(`\n📥 Fetching ${config.batchSize} emails from inbox...\n`);
  const emails = await gmailService.getInboxEmails(config.batchSize);

  if (emails.length === 0) {
    console.log('No emails found in inbox.');
    return;
  }

  console.log(`🤖 Classifying ${emails.length} emails using ${getProviderDisplayName()}...\n`);

  const classifications = await classifier.classifyBatch(emails);

  console.log('\n📋 Classification Results:');
  console.log('─'.repeat(80));

  const stats = { marketing: 0, transactional: 0, personal: 0 };
  const totalUsage: UsageMetadata = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  emails.forEach((email) => {
    const classification = classifications.get(email.id);
    if (!classification) return;

    stats[classification.category]++;

    // Aggregate usage statistics
    if (classification.usage) {
      totalUsage.inputTokens += classification.usage.inputTokens;
      totalUsage.outputTokens += classification.usage.outputTokens;
      totalUsage.totalTokens += classification.usage.totalTokens;
    }

    const categoryEmoji = {
      marketing: '📢',
      transactional: '🧾',
      personal: '👤'
    }[classification.category];

    const company = classification.companyName ? ` (${classification.companyName})` : '';
    console.log(`${categoryEmoji} ${classification.category.toUpperCase()}${company}`);
    console.log(`   From: ${email.from}`);
    console.log(`   Subject: ${email.subject}`);
    console.log(`   Confidence: ${(classification.confidence * 100).toFixed(0)}%`);
    console.log(`   Reasoning: ${classification.reasoning}`);
    console.log('─'.repeat(80));
  });

  console.log('\n📊 Summary:');
  console.log(`   Marketing:     ${stats.marketing}`);
  console.log(`   Transactional: ${stats.transactional}`);
  console.log(`   Personal:      ${stats.personal}`);

  // Display usage statistics and cost
  if (totalUsage.totalTokens > 0) {
    const totalCost = calculateCost(totalUsage);
    console.log('\n💰 Token Usage & Cost:');
    console.log(`   Input tokens:  ${totalUsage.inputTokens.toLocaleString()}`);
    console.log(`   Output tokens: ${totalUsage.outputTokens.toLocaleString()}`);
    console.log(`   Total tokens:  ${totalUsage.totalTokens.toLocaleString()}`);
    console.log(`   Estimated cost: $${totalCost.toFixed(6)}`);

    // Project cost for full inbox if applicable
    const processedCount = stats.marketing + stats.transactional + stats.personal;
    if (processedCount > 0 && processedCount < 1000) {
      const costPer1000 = (totalCost / processedCount) * 1000;
      console.log(`   Cost per 1000:  $${costPer1000.toFixed(4)}`);
    }
  }
}

async function organizeInbox(gmailService: GmailService) {
  const classifier = createClassifier();

  console.log(`\n📥 Fetching ${config.batchSize} emails from inbox...\n`);
  const emails = await gmailService.getInboxEmails(config.batchSize);

  if (emails.length === 0) {
    console.log('No emails found in inbox.');
    return;
  }

  console.log(`🤖 Classifying ${emails.length} emails using ${getProviderDisplayName()}...\n`);
  const classifications = await classifier.classifyBatch(emails);

  if (config.dryRun) {
    console.log('⚠️  DRY RUN MODE - No changes will be made\n');
  }

  console.log('📁 Organizing emails...\n');

  const result: ProcessingResult = {
    processed: 0,
    skipped: 0,
    errors: 0,
    details: {
      marketing: 0,
      transactional: 0,
      personal: 0
    }
  };

  const totalUsage: UsageMetadata = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  for (const email of emails) {
    const classification = classifications.get(email.id);

    if (!classification) {
      result.skipped++;
      continue;
    }

    // Aggregate usage statistics
    if (classification.usage) {
      totalUsage.inputTokens += classification.usage.inputTokens;
      totalUsage.outputTokens += classification.usage.outputTokens;
      totalUsage.totalTokens += classification.usage.totalTokens;
    }

    try {
      await gmailService.organizeEmail(email.id, classification, config.dryRun);
      result.processed++;
      result.details[classification.category]++;
    } catch (error) {
      console.error(`✗ Error organizing email ${email.id}:`, error);
      result.errors++;
    }
  }

  console.log('\n✨ Processing Complete!');
  console.log('─'.repeat(40));
  console.log(`Processed:     ${result.processed}`);
  console.log(`  Marketing:   ${result.details.marketing}`);
  console.log(`  Transactional: ${result.details.transactional}`);
  console.log(`  Personal:    ${result.details.personal}`);
  console.log(`Skipped:       ${result.skipped}`);
  console.log(`Errors:        ${result.errors}`);
  console.log('─'.repeat(40));

  // Display usage statistics and cost
  if (totalUsage.totalTokens > 0) {
    const totalCost = calculateCost(totalUsage);
    console.log('\n💰 Token Usage & Cost:');
    console.log(`   Input tokens:  ${totalUsage.inputTokens.toLocaleString()}`);
    console.log(`   Output tokens: ${totalUsage.outputTokens.toLocaleString()}`);
    console.log(`   Total tokens:  ${totalUsage.totalTokens.toLocaleString()}`);
    console.log(`   Estimated cost: $${totalCost.toFixed(6)}`);

    // Project cost for full inbox if applicable
    const processedCount = result.processed;
    if (processedCount > 0 && processedCount < 1000) {
      const costPer1000 = (totalCost / processedCount) * 1000;
      console.log(`   Cost per 1000:  $${costPer1000.toFixed(4)}`);
    }
  }

  if (config.dryRun) {
    console.log('\n💡 To actually organize emails, set DRY_RUN=false in .env');
  }
}

// Process one date window: fetch, analyze, archive boring ones. Returns results.
async function processNewsletterWindow(
  gmailService: GmailService,
  analyzer: NewsletterAnalyzer,
  startDate: Date,
  endDate: Date,
  windowLabel: string
): Promise<NewsletterResult[]> {
  const start = startDate.toISOString().split('T')[0];
  const end = endDate.toISOString().split('T')[0];
  console.log(`\n   📅 ${windowLabel} (${start} → ${end})`);

  const newsletters = await gmailService.getNewsletterEmails(startDate, endDate, 30);

  if (newsletters.length === 0) {
    console.log('      No newsletters found.');
    return [];
  }

  console.log(`      Found ${newsletters.length}. Analyzing...`);

  const results: NewsletterResult[] = [];
  const concurrency = 3;

  for (let i = 0; i < newsletters.length; i += concurrency) {
    const batch = newsletters.slice(i, i + concurrency);
    const analyzed = await Promise.all(
      batch.map(async (email) => {
        try {
          const analysis = await analyzer.analyze(email);
          const emoji = analysis.interestScore >= 7 ? '🔥' : analysis.interestScore >= 5 ? '✅' : '📭';
          console.log(`      ${emoji} [${analysis.interestScore}/10] ${email.subject.slice(0, 55)}`);
          return { email, analysis } as NewsletterResult;
        } catch (err) {
          console.error(`      ⚠️  Failed to analyze: ${email.subject}`, err);
          return null;
        }
      })
    );
    analyzed.forEach(r => { if (r) results.push(r); });
  }

  // Archive uninteresting ones
  const boring = results.filter(r => !r.analysis.isInteresting);
  if (!config.dryRun && boring.length > 0) {
    console.log(`      🗂  Archiving ${boring.length} uninteresting...`);
    for (const { email } of boring) {
      try {
        await gmailService.archiveEmail(email.id);
      } catch (err) {
        console.error(`      ⚠️  Could not archive ${email.id}:`, err);
      }
    }
  }

  return results;
}

async function reviewNewsletters(gmailService: GmailService) {
  const state = new NewsletterStateService();
  const analyzer = new NewsletterAnalyzer();

  console.log(`\n📰 Newsletter Review`);
  console.log(`   Status: ${state.getStatus()}`);

  // --- Window 1: always the last 24 hours ---
  const recent = state.getRecentWindow();
  const recentResults = await processNewsletterWindow(
    gmailService, analyzer, recent.startDate, recent.endDate, 'Last 24 hours'
  );

  // --- Window 2: next historical day (walking backward) ---
  const historical = state.getHistoricalWindow();
  const historicalResults = await processNewsletterWindow(
    gmailService, analyzer, historical.startDate, historical.endDate,
    `Historical: ${historical.label}`
  );

  // Update state for the historical cursor
  state.markHistoricalProcessed(historical.startDate);

  // Combine and report
  const allResults = [...recentResults, ...historicalResults];
  const interesting = allResults.filter(r => r.analysis.isInteresting);
  const boring = allResults.filter(r => !r.analysis.isInteresting);

  console.log(`\n   📊 Total: ${interesting.length} interesting, ${boring.length} archived`);

  if (allResults.length === 0) {
    console.log('\n✨ Done — no newsletters found in either window.\n');
    return;
  }

  // Save combined report
  const today = recent.endDate.toISOString().split('T')[0];
  const digestMarkdown = buildDigestMarkdown(allResults, today, historical.label);
  const digestHtml = buildDigestHtml(allResults, today, historical.label);

  // Save markdown to inbox-manager/reports/
  const reportsDir = path.join(process.cwd(), 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir);
  const reportPath = path.join(reportsDir, `newsletter-digest-${today}.md`);
  fs.writeFileSync(reportPath, digestMarkdown);
  console.log(`\n   💾 Markdown saved: reports/newsletter-digest-${today}.md`);

  // Also save HTML to ../email-minder/reports/ if that folder exists (scheduled task context)
  const emailMinderReports = path.join(process.cwd(), '..', 'email-minder', 'reports');
  const htmlFilename = `newsletter-digest-${today}.html`;
  if (fs.existsSync(emailMinderReports)) {
    const htmlPath = path.join(emailMinderReports, htmlFilename);
    fs.writeFileSync(htmlPath, digestHtml);
    console.log(`   💾 HTML saved: email-minder/reports/${htmlFilename}`);
  }

  // Send digest email
  if (!config.dryRun && interesting.length > 0) {
    try {
      const subject = `📰 Newsletter Digest ${today}: ${interesting.length} worth reading`;
      const recipient = await resolveRecipient(gmailService);
      await gmailService.sendEmail(recipient, subject, digestHtml);
      console.log(`   📧 Digest sent to ${recipient}`);
    } catch (err) {
      console.error('   ⚠️  Failed to send digest email:', err);
    }
  } else if (interesting.length === 0) {
    console.log('   📧 Nothing interesting — skipping digest email');
  }

  console.log(`\n✨ Done. Next run: last 24h + historical day ${historical.label} moving back one more.\n`);
}

function buildDigestMarkdown(results: NewsletterResult[], dateLabel: string, historicalLabel?: string): string {
  const interesting = results.filter(r => r.analysis.isInteresting);
  const boring = results.filter(r => !r.analysis.isInteresting);

  const coverage = historicalLabel
    ? `Last 24h + historical day ${historicalLabel}`
    : `Last 24h`;

  const lines: string[] = [
    `# Newsletter Digest: ${dateLabel}`,
    '',
    `**Coverage:** ${coverage}`,
    `**${interesting.length} worth reading** · **${boring.length} archived**`,
    '',
  ];

  if (interesting.length > 0) {
    lines.push('## Worth Reading\n');
    for (const { email, analysis } of interesting.sort((a, b) => b.analysis.interestScore - a.analysis.interestScore)) {
      const score = analysis.interestScore;
      const emoji = score >= 7 ? '🔥' : '✅';
      lines.push(`### ${emoji} ${email.subject}`);
      lines.push(`**From:** ${email.from}  |  **Score:** ${score}/10`);
      if (analysis.relevantTopics.length) lines.push(`**Topics:** ${analysis.relevantTopics.join(', ')}`);
      lines.push('');
      lines.push(analysis.summary);
      if (analysis.keyPoints.length) {
        lines.push('');
        lines.push('**Key points:**');
        analysis.keyPoints.forEach(p => lines.push(`- ${p}`));
      }
      if (analysis.actionItems.length) {
        lines.push('');
        lines.push('**Action items:**');
        analysis.actionItems.forEach(a => lines.push(`- ${a}`));
      }
      if (email.unsubscribeLink) {
        lines.push('');
        lines.push(`[Unsubscribe](${email.unsubscribeLink})`);
      }
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  if (boring.length > 0) {
    lines.push('## Archived (Nothing Notable)\n');
    for (const { email, analysis } of boring) {
      lines.push(`- **${email.subject}** (${email.from.split('<')[0].trim()}) — ${analysis.reason}`);
    }
  }

  return lines.join('\n');
}

function buildDigestHtml(results: NewsletterResult[], dateLabel: string, _historicalLabel?: string): string {
  const interesting = results
    .filter(r => r.analysis.isInteresting)
    .sort((a, b) => b.analysis.interestScore - a.analysis.interestScore);
  const boring = results.filter(r => !r.analysis.isInteresting);

  const card = ({ email, analysis }: NewsletterResult) => {
    const score = analysis.interestScore;
    const emoji = score >= 7 ? '🔥' : '✅';
    const keyPoints = analysis.keyPoints.length
      ? `<ul>${analysis.keyPoints.map(p => `<li>${p}</li>`).join('')}</ul>` : '';
    const actions = analysis.actionItems.length
      ? `<p><strong>Action items:</strong></p><ul>${analysis.actionItems.map(a => `<li>${a}</li>`).join('')}</ul>` : '';
    const topics = analysis.relevantTopics.length
      ? `<p style="color:#666;font-size:13px;">${analysis.relevantTopics.join(' · ')}</p>` : '';
    const unsub = email.unsubscribeLink
      ? `<p style="margin-top:8px;font-size:12px;"><a href="${email.unsubscribeLink}" style="color:#999;">Unsubscribe</a></p>` : '';

    return `
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:16px;">
      <h3 style="margin:0 0 4px;">${emoji} ${email.subject}</h3>
      <p style="color:#6b7280;font-size:13px;margin:0 0 8px;">${email.from} &nbsp;·&nbsp; Score: ${score}/10</p>
      ${topics}
      <p>${analysis.summary}</p>
      ${keyPoints}
      ${actions}
      ${unsub}
    </div>`;
  };

  const boringList = boring.length
    ? `<h2>Archived — Nothing Notable</h2>
       <ul>${boring.map(r => `<li><strong>${r.email.subject}</strong> — ${r.analysis.reason}</li>`).join('')}</ul>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;max-width:640px;margin:0 auto;padding:24px;">
  <h1>📰 Newsletter Digest: ${dateLabel}</h1>
  <p>${interesting.length} worth reading · ${boring.length} archived</p>
  <hr>
  ${interesting.length ? `<h2>Worth Reading</h2>${interesting.map(card).join('')}` : '<p>Nothing particularly interesting today.</p>'}
  ${boringList}
</body>
</html>`;
}

// Repairs emails that were classified and archived but never had their label
// applied in Gmail — the result of a dry run writing archived=1 rows, or of an
// organize call failing after the DB write. They are already out of the inbox,
// so this adds the label only and deliberately leaves INBOX/UNREAD alone.
async function relabelArchived(gmailService: GmailService) {
  const db = new DatabaseService();
  console.log('\n🏷  Relabel Missing\n');
  if (config.dryRun) console.log('⚠️  DRY RUN — no Gmail changes will be made\n');

  // Anything carrying no user label. The inbox is included on purpose: personal
  // mail is labelled but never archived, so it lives here unlabelled too.
  // Sent/draft/trash/spam and chats are excluded — not ours to organize.
  const query = 'has:nouserlabels -in:sent -in:draft -in:trash -in:spam -in:chats';
  console.log('Finding emails with no label...');
  const ids = await gmailService.listMessageIdsByQuery(query);
  console.log(`  Found ${ids.length.toLocaleString()} unlabeled emails.\n`);
  if (ids.length === 0) {
    db.close();
    return;
  }

  // Only act on emails this tool has already classified. Anything absent from
  // the DB is left untouched — we have no basis for a label.
  const targets: { id: string; classification: EmailClassification }[] = [];
  let notInDb = 0;
  const otherSkipped = new Map<string, number>();

  for (const id of ids) {
    const state = db.getEmailState(id);
    if (!state) {
      notInDb++;
      continue;
    }
    if (state.category !== 'marketing' && state.category !== 'transactional' && state.category !== 'personal') {
      // Only the three real categories get restored. The DB still holds stray
      // legacy categories ('technical', 'unknown', 'news', a capitalised
      // 'Transactional') from an older schema, and those must not be forced
      // into a current label — labelFor() silently maps anything unrecognised
      // to 'personal', which would mislabel them as friend-and-family mail.
      otherSkipped.set(state.category, (otherSkipped.get(state.category) ?? 0) + 1);
      continue;
    }
    targets.push({
      id,
      classification: {
        category: state.category as EmailClassification['category'],
        companyName: state.companyName ?? undefined,
        confidence: 1,
        reasoning: 'relabel from stored classification',
      },
    });
  }

  console.log(`  ${targets.length.toLocaleString()} have a stored classification to restore.`);
  console.log(`  ${notInDb.toLocaleString()} not in the database — left untouched.`);
  const otherTotal = [...otherSkipped.values()].reduce((a, b) => a + b, 0);
  console.log(`  ${otherTotal.toLocaleString()} not marketing/transactional/personal — left untouched.`);
  [...otherSkipped.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([cat, n]) => console.log(`      ${cat}: ${n.toLocaleString()}`));
  console.log('');
  if (targets.length === 0) {
    db.close();
    return;
  }

  const applied = new Map<string, number>();
  const errorReasons = new Map<string, number>();
  let errors = 0;
  let done = 0;

  // Gmail throttles bursts of modify calls, so a failure here is usually
  // "try again shortly" rather than "this email is broken". Back off and retry
  // before giving up, and always record *why* — a bare error count gives no
  // way to tell rate limiting apart from a genuinely bad label.
  const isTransient = (msg: string) =>
    /rate|quota|429|500|502|503|backend|timeout|socket|ECONNRESET/i.test(msg);

  await mapWithLimit(targets, 5, async ({ id, classification }) => {
    let lastError = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const labelName = await gmailService.applyLabelOnly(id, classification, config.dryRun);
        applied.set(labelName, (applied.get(labelName) ?? 0) + 1);
        lastError = '';
        break;
      } catch (err) {
        lastError = (err as Error).message ?? String(err);
        if (attempt === 3 || !isTransient(lastError)) break;
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    if (lastError) {
      errors++;
      const key = lastError.slice(0, 100);
      errorReasons.set(key, (errorReasons.get(key) ?? 0) + 1);
    }
    done++;
    if (done % 25 === 0 || done === targets.length) {
      process.stdout.write(`\r  Relabeled ${done.toLocaleString()}/${targets.length.toLocaleString()}  (errors: ${errors})   `);
    }
    return null;
  });

  const top = [...applied.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n\n✨ Relabel complete`);
  console.log('─'.repeat(40));
  console.log(`  Labeled:  ${(targets.length - errors).toLocaleString()}`);
  console.log(`  Errors:   ${errors.toLocaleString()}`);
  console.log(`  Distinct labels: ${top.length.toLocaleString()}`);
  if (errorReasons.size > 0) {
    console.log('\n  failure reasons:');
    [...errorReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .forEach(([reason, n]) => console.log(`    ${n.toLocaleString()}x  ${reason}`));
  }
  console.log('─'.repeat(40));
  top.slice(0, 15).forEach(([name, n]) => console.log(`  ${name}: ${n.toLocaleString()}`));
  if (top.length > 15) console.log(`  ... and ${top.length - 15} more labels`);
  console.log('');

  db.close();
}

// Backfill for marketing mail that was labelled by a path which left UNREAD
// alone — relabel-missing/relabel-archived before applyLabelOnly honoured
// shouldMarkAsRead. Marketing is always read, so any unread message under a
// marketing/ label is by definition a leftover from that bug.
async function fixUnreadMarketing(gmailService: GmailService) {
  console.log('\n📖 Mark Marketing Read\n');
  if (config.dryRun) console.log('⚠️  DRY RUN — no Gmail changes will be made\n');

  // A parent-label query does not cascade to sublabels in the Gmail API, so
  // every marketing/<company> label has to be walked individually.
  const labels = await gmailService.getMarketingLabels();
  console.log(`Scanning ${labels.length.toLocaleString()} marketing labels for unread mail...`);

  const found: Array<{ name: string; ids: string[] }> = [];
  let total = 0;
  for (const label of labels) {
    const ids = await gmailService.listLabelMessageIds(label.id, ['UNREAD']);
    if (ids.length > 0) {
      found.push({ name: label.name, ids });
      total += ids.length;
    }
  }

  console.log(`  Found ${total.toLocaleString()} unread marketing emails across ${found.length.toLocaleString()} labels.\n`);
  if (total === 0) {
    console.log('✨ Nothing to fix.\n');
    return;
  }

  found.sort((a, b) => b.ids.length - a.ids.length);
  found.slice(0, 15).forEach(f => console.log(`  ${f.name}: ${f.ids.length.toLocaleString()}`));
  if (found.length > 15) console.log(`  ... and ${found.length - 15} more labels`);
  console.log('');

  if (config.dryRun) {
    console.log(`[DRY RUN] Would mark ${total.toLocaleString()} emails as read.\n`);
    return;
  }

  let fixed = 0;
  let errors = 0;
  for (const { name, ids } of found) {
    try {
      // Label membership is already correct here — only UNREAD is wrong.
      await gmailService.batchModifyMessages(ids, [], ['UNREAD']);
      fixed += ids.length;
    } catch (err) {
      errors += ids.length;
      console.error(`  ✗ ${name}: ${(err as Error).message}`);
    }
  }

  console.log('─'.repeat(40));
  console.log(`  Marked read: ${fixed.toLocaleString()}`);
  console.log(`  Errors:      ${errors.toLocaleString()}`);
  console.log('─'.repeat(40));
  console.log('\n✨ Done.\n');
}

async function fixUnknownLabels(gmailService: GmailService) {
  const db = new DatabaseService();
  console.log('\n🔧 Fix Unknown Labels\n');

  const UNKNOWN_LABELS: Array<{ labelId: string; prefix: string }> = [
    { labelId: 'Label_497', prefix: 'marketing' },
    { labelId: 'Label_346', prefix: 'transactional' },
  ];

  for (const { labelId, prefix } of UNKNOWN_LABELS) {
    console.log(`\nFetching emails in ${prefix}/Unknown...`);
    const ids = await gmailService.listLabelMessageIds(labelId);
    console.log(`  Found ${ids.length} messages.`);
    if (ids.length === 0) continue;

    let moved = 0, skipped = 0;
    for (const id of ids) {
      const row = db.db.prepare(
        'SELECT company_name, category, from_address FROM emails WHERE id = ?'
      ).get(id) as { company_name: string | null; category: string; from_address: string } | undefined;

      // Resolve company name: DB record → from_address fallback → live Gmail fetch
      let companyName = row?.company_name ?? null;
      if (!companyName) {
        const fromAddress = row?.from_address ?? null;
        if (fromAddress) {
          companyName = gmailService.extractSenderName(fromAddress);
        } else {
          // No DB record at all — fetch from Gmail
          try {
            const email = await gmailService.getEmailById(id);
            companyName = gmailService.extractSenderName(email.from);
          } catch {
            skipped++;
            continue;
          }
        }
      }

      const targetLabel = `${prefix}/${companyName}`;
      try {
        const targetId = await gmailService.ensureLabel(targetLabel);
        // Marketing is always marked read; transactional stays unread so it can
        // still be reviewed from its bucket.
        const remove = prefix === 'marketing' ? [labelId, 'UNREAD'] : [labelId];
        await gmailService.batchModifyMessages([id], [targetId], remove);
        moved++;
        process.stdout.write(`\r  Moved ${moved}/${ids.length}...`);
      } catch {
        skipped++;
      }
    }
    console.log(`\n  Done — ${moved} moved, ${skipped} skipped.`);
  }

  console.log('\n✨ Fix complete.\n');
  db.close();
}

main();
