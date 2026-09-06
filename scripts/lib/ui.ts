// Terminal output and prompting shared by setup, doctor and schedule.
import readline from 'readline/promises';
import { stdin, stdout } from 'process';

const useColor = stdout.isTTY;
const c = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const bold = (s: string) => c('1', s);
export const dim = (s: string) => c('2', s);
export const green = (s: string) => c('32', s);
export const yellow = (s: string) => c('33', s);
export const red = (s: string) => c('31', s);

export function heading(s: string): void {
  console.log(`\n${bold(s)}`);
}

export function pass(s: string, detail?: string): void {
  console.log(`  ${green('✓')} ${s}${detail ? dim(`  ${detail}`) : ''}`);
}

export function fail(s: string, remedy?: string): void {
  console.log(`  ${red('✗')} ${s}`);
  if (remedy) for (const line of remedy.split('\n')) console.log(`      ${line}`);
}

export function warn(s: string, detail?: string): void {
  console.log(`  ${yellow('!')} ${s}`);
  if (detail) for (const line of detail.split('\n')) console.log(`      ${line}`);
}

export function info(s: string, detail?: string): void {
  console.log(`  ${dim('·')} ${s}${detail ? dim(`  ${detail}`) : ''}`);
}

let rl: readline.Interface | null = null;
let stdinClosed = false;

function io() {
  if (!rl) {
    rl = readline.createInterface({ input: stdin, output: stdout });
    // Once stdin ends, further question() promises never settle — Node then
    // exits 0 with the run half-finished and no error, which looks like
    // success. Track it and throw instead.
    rl.on('close', () => { stdinClosed = true; });
  }
  return rl;
}

class NoInputError extends Error {
  constructor() {
    super('No more input: this command needs an interactive terminal.\n' +
          'Run it directly in a terminal rather than piping input or running it from a script.');
    this.name = 'NoInputError';
  }
}

async function question(prompt: string): Promise<string> {
  if (stdinClosed) throw new NoInputError();
  const answer = await Promise.race([
    io().question(prompt),
    new Promise<never>((_, reject) => {
      io().once('close', () => reject(new NoInputError()));
    }),
  ]);
  return answer;
}

export function closePrompts(): void {
  rl?.close();
  rl = null;
}

export async function ask(prompt: string, fallback = ''): Promise<string> {
  const suffix = fallback ? dim(` [${fallback}]`) : '';
  const answer = (await question(`  ${prompt}${suffix}: `)).trim();
  return answer || fallback;
}

export async function confirm(prompt: string, defaultYes = false): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = (await question(`  ${prompt} ${dim(hint)} `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

// Numbered menu. Returns the chosen option's value.
export async function choose<T>(
  prompt: string,
  options: { label: string; value: T; note?: string }[],
  defaultIndex = 0
): Promise<T> {
  console.log(`\n  ${prompt}`);
  options.forEach((o, i) => {
    const marker = i === defaultIndex ? green('→') : ' ';
    console.log(`   ${marker} ${i + 1}. ${o.label}${o.note ? dim(`  — ${o.note}`) : ''}`);
  });
  while (true) {
    const raw = (await question(`  Choice ${dim(`[${defaultIndex + 1}]`)}: `)).trim();
    if (!raw) return options[defaultIndex].value;
    const n = parseInt(raw, 10);
    if (n >= 1 && n <= options.length) return options[n - 1].value;
    console.log(`  ${yellow('!')} Enter a number from 1 to ${options.length}.`);
  }
}

// Waits for a file to appear, so setup doesn't have to be restarted after a
// manual download step. Returns false if the user gives up.
export async function waitForFile(filePath: string, label: string): Promise<boolean> {
  const fs = await import('fs');
  if (fs.existsSync(filePath)) return true;
  console.log(`\n  Waiting for ${label}. ${dim('Press Enter once it is in place, or type "skip".')}`);
  while (true) {
    const answer = (await question('  > ')).trim().toLowerCase();
    if (answer === 'skip') return false;
    if (fs.existsSync(filePath)) return true;
    console.log(`  ${yellow('!')} Still not seeing ${filePath}`);
  }
}
