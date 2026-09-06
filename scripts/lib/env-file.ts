// Minimal .env reader/writer that preserves comments and key order, so a file
// written by setup still reads like the documented .env.example.
import fs from 'fs';
import path from 'path';

export const ENV_PATH = path.join(process.cwd(), '.env');
export const ENV_EXAMPLE_PATH = path.join(process.cwd(), '.env.example');

export function readEnv(filePath = ENV_PATH): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

// Copies .env.example and substitutes values, so the operator's .env keeps the
// explanatory comments rather than being a bare list of keys.
export function renderEnv(values: Record<string, string>): string {
  const template = fs.existsSync(ENV_EXAMPLE_PATH)
    ? fs.readFileSync(ENV_EXAMPLE_PATH, 'utf-8')
    : '';
  if (!template) {
    return Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  }
  const seen = new Set<string>();
  const lines = template.split('\n').map((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (!m || !(m[1] in values)) return line;
    seen.add(m[1]);
    return `${m[1]}=${values[m[1]]}`;
  });
  const extra = Object.keys(values).filter((k) => !seen.has(k));
  if (extra.length) {
    lines.push('', '# Added by setup', ...extra.map((k) => `${k}=${values[k]}`));
  }
  return lines.join('\n');
}

// Never clobber an existing .env silently — always leave a dated copy behind.
export function backupEnv(filePath = ENV_PATH): string | null {
  if (!fs.existsSync(filePath)) return null;
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('') + '-' + [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  const backup = `${filePath}.bak-${stamp}`;
  fs.copyFileSync(filePath, backup);
  return backup;
}

export function writeEnv(values: Record<string, string>, filePath = ENV_PATH): string | null {
  const backup = backupEnv(filePath);
  fs.writeFileSync(filePath, renderEnv(values), { mode: 0o600 });
  // `mode` above only applies when the file is created — rewriting an existing
  // .env would otherwise keep its old permissions. This file can hold API keys.
  fs.chmodSync(filePath, 0o600);
  if (backup) fs.chmodSync(backup, 0o600);
  return backup;
}
