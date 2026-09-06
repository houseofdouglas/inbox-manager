// Installs, removes and reports on the launchd job that runs `daily`.
// Everything machine-specific — Node's path, the repo location, $HOME — is
// resolved here at install time and substituted into the template.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { config } from '../src/config.js';
import { ask, bold, dim, green, red, yellow, closePrompts } from './lib/ui.js';

const execFileAsync = promisify(execFile);

// Derived from LAUNCHD_LABEL_PREFIX so all three jobs share one namespace.
const LABEL = config.dailyJobLabel;
const REPO = process.cwd();
const TEMPLATE = path.join(REPO, 'templates', 'com.inbox-manager.daily.plist.template');
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG_DIR = path.join(REPO, 'logs');
const DEFAULT_HOURS = [8, 12, 19];
const DOMAIN = `gui/${process.getuid?.() ?? 0}`;

function resolveRunner(): string[] {
  const node = process.execPath;
  const npx = path.join(path.dirname(node), 'npx');
  if (!fs.existsSync(npx)) {
    throw new Error(`Could not find npx next to Node at ${node}. Is Node installed via nvm or Homebrew?`);
  }
  return [node, npx, 'tsx', 'src/index.ts', 'daily'];
}

export function renderPlist(hours: number[]): string {
  const template = fs.readFileSync(TEMPLATE, 'utf-8');
  const args = resolveRunner().map((a) => `    <string>${a}</string>`).join('\n');
  const intervals = hours.map((h) =>
    `    <dict><key>Hour</key><integer>${h}</integer><key>Minute</key><integer>0</integer></dict>`
  ).join('\n');
  return template
    .replace('__LABEL__', LABEL)
    .replace('__PROGRAM_ARGUMENTS__', args)
    .replace('__WORKING_DIR__', REPO)
    .replace('__CALENDAR_INTERVALS__', intervals)
    .replace('__LOG_PATH__', path.join(LOG_DIR, 'daily.log'))
    .replace('__ERROR_LOG_PATH__', path.join(LOG_DIR, 'daily-error.log'))
    .replace('__HOME__', os.homedir())
    .replace('__PATH__', `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`);
}

function parseHours(input: string): number[] | null {
  const hours = input.split(/[,\s]+/).filter(Boolean).map((h) => parseInt(h, 10));
  if (!hours.length || hours.some((h) => Number.isNaN(h) || h < 0 || h > 23)) return null;
  return [...new Set(hours)].sort((a, b) => a - b);
}

export async function install(hours?: number[]): Promise<void> {
  if (!fs.existsSync(path.join(REPO, 'package.json'))) {
    throw new Error(`Run this from the inbox-manager repo root (currently ${REPO}).`);
  }
  if (!fs.existsSync(TEMPLATE)) throw new Error(`Missing template: ${TEMPLATE}`);

  let times = hours;
  if (!times) {
    console.log(bold('\nScheduling daily runs'));
    console.log(dim(`  Default: ${DEFAULT_HOURS.map((h) => `${h}:00`).join(', ')} local time.`));
    const answer = await ask('Hours to run (comma-separated, 0-23)', DEFAULT_HOURS.join(','));
    times = parseHours(answer) ?? DEFAULT_HOURS;
  }

  // launchd cannot create the parent directory of its log paths; without this
  // the job fails with no visible output anywhere.
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.writeFileSync(PLIST, renderPlist(times));

  await execFileAsync('plutil', ['-lint', PLIST]);

  // Replace rather than duplicate: booting out a job that isn't loaded is fine.
  await execFileAsync('launchctl', ['bootout', `${DOMAIN}/${LABEL}`]).catch(() => undefined);
  await execFileAsync('launchctl', ['bootstrap', DOMAIN, PLIST]);

  console.log(`\n  ${green('✓')} Installed ${LABEL}`);
  console.log(dim(`    runs at ${times.map((h) => `${h}:00`).join(', ')}`));
  console.log(dim(`    plist:  ${PLIST}`));
  console.log(dim(`    logs:   ${path.join(LOG_DIR, 'daily.log')}`));
  console.log(dim('\n  A run that would have fired while the Mac was asleep happens at next wake.'));
}

export async function uninstall(): Promise<void> {
  await execFileAsync('launchctl', ['bootout', `${DOMAIN}/${LABEL}`]).catch(() => undefined);
  if (fs.existsSync(PLIST)) fs.unlinkSync(PLIST);
  console.log(`\n  ${green('✓')} Removed ${LABEL}`);
  console.log(dim('    Your database and logs are untouched.'));
}

export async function status(): Promise<void> {
  console.log(bold('\nScheduled runs'));
  let loaded = false;
  try {
    await execFileAsync('launchctl', ['print', `${DOMAIN}/${LABEL}`]);
    loaded = true;
  } catch { /* not loaded */ }

  console.log(loaded
    ? `  ${green('✓')} ${LABEL} is loaded`
    : `  ${yellow('!')} ${LABEL} is not loaded  ${dim('(npm run schedule:install)')}`);

  if (fs.existsSync(PLIST)) {
    const plist = fs.readFileSync(PLIST, 'utf-8');
    const hours = [...plist.matchAll(/<key>Hour<\/key><integer>(\d+)<\/integer>/g)].map((m) => `${m[1]}:00`);
    if (hours.length) console.log(dim(`    scheduled: ${hours.join(', ')}`));
  }

  const log = path.join(LOG_DIR, 'daily.log');
  const errLog = path.join(LOG_DIR, 'daily-error.log');
  console.log(fs.existsSync(log)
    ? dim(`    last run:  ${fs.statSync(log).mtime.toLocaleString()}`)
    : dim('    last run:  no runs logged yet'));
  if (fs.existsSync(errLog) && fs.statSync(errLog).size > 0) {
    console.log(`  ${yellow('!')} ${errLog} is not empty — check it for failures`);
  }
}

async function main() {
  const command = process.argv[2] ?? 'status';
  try {
    if (command === 'install') await install();
    else if (command === 'uninstall') await uninstall();
    else if (command === 'status') await status();
    else {
      console.error(`Unknown command: ${command}. Use install, uninstall or status.`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`\n  ${red('✗')} ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  } finally {
    closePrompts();
  }
}

// Only run the CLI when invoked directly. setup.ts imports install() from this
// module, and without this guard that import would also execute the CLI.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
