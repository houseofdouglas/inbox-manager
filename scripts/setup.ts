// Guided first run: leaves behind a valid .env, a working token.json, and a
// printed summary. Safe to re-run — every step detects what is already done.
import fs from 'fs';
import path from 'path';
import { readEnv, writeEnv, ENV_PATH } from './lib/env-file.js';
import {
  checkNode, checkDependencies, checkCredentials, probeModelHost,
  validateHostUrl, CREDENTIALS_PATH, TOKEN_PATH,
} from './lib/checks.js';
import {
  ask, confirm, choose, waitForFile, closePrompts,
  heading, pass, fail, warn, info, bold, dim, green, yellow,
} from './lib/ui.js';

type Provider = 'llama' | 'gemini' | 'claude';

const summary: string[] = [];
const record = (line: string) => summary.push(line);

async function step1_environment(): Promise<void> {
  heading('1 / 6   This machine');
  const node = checkNode();
  if (node.status === 'fail') {
    fail(node.name, node.remedy);
    process.exit(1);
  }
  pass(node.name, node.detail);

  const deps = await checkDependencies();
  if (deps.status === 'fail') {
    fail(deps.name, deps.remedy);
    process.exit(1);
  }
  pass(deps.name, deps.detail);
}

async function step2_existingEnv(): Promise<Record<string, string>> {
  heading('2 / 6   Configuration');
  if (!fs.existsSync(ENV_PATH)) {
    info('No .env yet', 'this run will create one');
    return {};
  }
  const existing = readEnv();
  info('.env already exists', `provider: ${existing.AI_PROVIDER ?? 'unset'}`);
  const action = await choose('What should I do with it?', [
    { label: 'Keep it and just check everything works', value: 'keep' as const },
    { label: 'Update it, keeping current values as defaults', value: 'update' as const },
    { label: 'Start fresh', value: 'fresh' as const, note: 'the old file is backed up first' },
  ], 1);
  if (action === 'keep') {
    console.log(dim('\n  Leaving .env alone. Run npm run doctor to verify it.'));
    return { __keep: 'true', ...existing };
  }
  return action === 'fresh' ? {} : existing;
}

async function step3_provider(current: Record<string, string>): Promise<Record<string, string>> {
  heading('3 / 6   AI provider');
  const provider = await choose('What should classify your email?', [
    { label: 'A local model (llama/MLX)', value: 'llama' as Provider, note: 'free, private, needs a capable Mac' },
    { label: 'Google Gemini', value: 'gemini' as Provider, note: 'API key, generous free tier' },
    { label: 'Anthropic Claude', value: 'claude' as Provider, note: 'API key, paid' },
  ], ['llama', 'gemini', 'claude'].indexOf((current.AI_PROVIDER as Provider) || 'llama'));

  if (provider === 'gemini' || provider === 'claude') {
    const keyName = provider === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY';
    const url = provider === 'gemini'
      ? 'https://aistudio.google.com/apikey'
      : 'https://console.anthropic.com/';
    console.log(dim(`\n  Get a key at ${url}`));
    const key = await ask(`${keyName}`, current[keyName] ?? '');
    if (!key) warn('No key entered', `Classification will fail until ${keyName} is set in .env.`);
    record(`Provider: ${provider}`);
    return { AI_PROVIDER: provider, [keyName]: key };
  }

  return { AI_PROVIDER: 'llama', ...(await step3b_modelHost(current)) };
}

async function step3b_modelHost(current: Record<string, string>): Promise<Record<string, string>> {
  const where = await choose('Where does the model run?', [
    { label: 'On this Mac', value: 'local' as const, note: 'http://localhost:8080' },
    { label: 'On another Mac on my network', value: 'remote' as const },
  ], (current.LLAMA_BASE_URL ?? '').includes('localhost') ? 0 : 1);

  let url = where === 'local' ? 'http://localhost:8080' : current.LLAMA_BASE_URL ?? '';
  let model = current.LLAMA_MODEL ?? '';

  while (true) {
    if (where === 'remote') {
      console.log(dim('\n  Use the IP address, not a .local name — see host/README.md.'));
      const host = await ask('Host address (IP or IP:port)', url.replace(/^https?:\/\//, '') || '192.168.1.50:8080');
      url = /^https?:\/\//.test(host) ? host : `http://${host.includes(':') ? host : `${host}:8080`}`;
    }

    const problem = validateHostUrl(url);
    if (problem) {
      fail('That address will not work', problem);
      if (where === 'local') return { LLAMA_BASE_URL: url, LLAMA_MODEL: model };
      continue;
    }

    console.log(dim(`\n  Probing ${url} ...`));
    const probe = await probeModelHost(url, model || undefined);

    if (!probe.reachable) {
      fail(`Cannot reach ${url}`,
        'Check that the host Mac is awake, the server is running (host/status.sh),\n' +
        'and that it is bound to 0.0.0.0 rather than 127.0.0.1.');
    } else if (probe.models.length === 0) {
      fail('The server is up but has no model loaded', 'Check the host log: tail -f ~/logs/mlx-server.log');
    } else {
      pass('Server reachable', probe.models.join(', '));
      // Offer the model the server actually reports rather than making the
      // operator transcribe an id by hand.
      model = probe.models[0];
      if (!probe.completed) {
        warn('The server answered /v1/models but could not complete a request.',
             'Classification will fail. Check the host log before continuing.');
      } else if ((probe.completionTokens ?? 0) > 50) {
        warn(`A one-word reply cost ${probe.completionTokens} tokens — the model is "thinking" out loud.`,
             'Classifications will come back truncated. Start the server with\n' +
             "--chat-template-args '{\"enable_thinking\": false}' (host/mlx-server.sh does this).");
      } else {
        pass('Trial completion', `${probe.completionTokens ?? '?'} tokens`);
      }
      record(`Provider: local model at ${url} (${model})`);
      return { LLAMA_BASE_URL: url, LLAMA_MODEL: model };
    }

    const retry = await choose('What now?', [
      { label: 'Retry', value: 'retry' as const },
      { label: 'Enter a different address', value: 'change' as const },
      { label: 'Continue anyway and fix it later', value: 'skip' as const },
    ], where === 'remote' ? 1 : 0);
    if (retry === 'skip') {
      record(`Provider: local model at ${url} (unverified)`);
      return { LLAMA_BASE_URL: url, LLAMA_MODEL: model || 'local' };
    }
    if (retry === 'change') continue;
  }
}

async function step4_google(): Promise<void> {
  heading('4 / 6   Google Cloud');
  const cred = checkCredentials();
  if (cred.status === 'pass') {
    pass(cred.name, cred.detail);
  } else {
    console.log(`
  You need an OAuth client from your OWN Google Cloud project:

    1. https://console.cloud.google.com/  →  create a project
    2. APIs & Services → Library → enable ${bold('Gmail API')}
    3. APIs & Services → OAuth consent screen:
         · User type: External
         · ${bold('Set publishing status to "In production"')}
    4. Credentials → Create credentials → OAuth client ID
         · Application type: ${bold('Desktop app')}
    5. Download the JSON and save it here as ${bold('credentials.json')}
`);
    console.log(dim('  Step 3 matters more than it looks: a project left in "Testing" has its'));
    console.log(dim('  refresh token expired by Google every 7 days, forcing weekly re-auth.'));
    console.log(dim('  "In production" without verification is correct here — you are the only user.\n'));

    const arrived = await waitForFile(CREDENTIALS_PATH, 'credentials.json');
    if (!arrived) {
      warn('Continuing without credentials.json', 'Gmail commands will fail until it is in place.');
      record('Google Cloud: incomplete — credentials.json missing');
      return;
    }
    const recheck = checkCredentials();
    if (recheck.status === 'fail') {
      fail(recheck.name, recheck.remedy);
      record('Google Cloud: credentials.json present but wrong type');
      return;
    }
    pass('credentials.json', recheck.detail);
  }

  // Publishing status is not readable from credentials.json, so ask outright
  // rather than assuming — the failure it causes shows up a week later.
  const inProduction = await confirm('Is that project\'s consent screen set to "In production"?', false);
  record(inProduction
    ? 'OAuth consent screen: confirmed In production'
    : 'OAuth consent screen: NOT confirmed — expect re-auth every 7 days');
  if (!inProduction) {
    warn('Leave it in Testing and Google will expire your token every 7 days.',
         'Fix it at: APIs & Services → OAuth consent screen → Publish app');
  }
}

async function step5_authorize(): Promise<void> {
  heading('5 / 6   Authorize Gmail');
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    info('Skipped', 'credentials.json is not in place yet');
    return;
  }

  if (fs.existsSync(TOKEN_PATH)) {
    try {
      const { GmailService } = await import('../src/services/gmail.js');
      const gmail = new GmailService();
      await gmail.initialize();
      const address = await gmail.getAuthenticatedAddress();
      pass('Already authorized', address);
      record(`Gmail account: ${address}`);
      if (!await confirm('Authorize a different account?', false)) return;
      fs.renameSync(TOKEN_PATH, `${TOKEN_PATH}.previous`);
    } catch {
      warn('The existing token no longer works', 'Re-authorizing.');
      fs.renameSync(TOKEN_PATH, `${TOKEN_PATH}.previous`);
    }
  }

  console.log(dim('\n  A browser window will open. Approve access for the account you want managed.'));
  console.log(dim('  "Google hasn\'t verified this app" is expected — Advanced → Go to (unsafe).\n'));
  try {
    const { GmailService } = await import('../src/services/gmail.js');
    const gmail = new GmailService();
    await gmail.initialize();
    const address = await gmail.getAuthenticatedAddress();
    pass('Authorized', address);
    if (!await confirm(`Is ${address} the account you meant?`, true)) {
      fs.unlinkSync(TOKEN_PATH);
      warn('Token discarded', 'Run npm run auth to try again with the right account.');
      record('Gmail account: wrong account authorized, token discarded');
      return;
    }
    record(`Gmail account: ${address}`);
  } catch (err) {
    fail('Authorization failed', err instanceof Error ? err.message : String(err));
    record('Gmail account: authorization failed');
  }
}

async function step6_processing(current: Record<string, string>): Promise<Record<string, string>> {
  heading('6 / 6   How runs should behave');
  console.log(dim('  Starting conservative: preview only, small batches. Change these once'));
  console.log(dim('  you have seen the classifications and trust them.\n'));

  const recipient = await ask(
    'Send the daily digest to (blank = the account you just authorized)',
    current.DIGEST_RECIPIENT ?? ''
  );
  const batch = await ask('Emails per run', current.BATCH_SIZE ?? '25');
  record(`Batch size: ${batch}, DRY_RUN=true`);
  return { DIGEST_RECIPIENT: recipient, BATCH_SIZE: batch, DRY_RUN: 'true' };
}

async function main() {
  console.log(bold('\nInbox Manager setup'));
  console.log(dim('  Six steps. Nothing touches your mailbox until you run organize yourself.'));

  if (!process.stdin.isTTY) {
    warn('stdin is not a terminal.',
         'Setup is interactive — run it directly in a terminal window.\n' +
         'For an unattended install, copy .env.example to .env and edit it,\n' +
         'then run: npm run auth && npm run doctor');
  }

  await step1_environment();
  const existing = await step2_existingEnv();
  const keepEnv = existing.__keep === 'true';
  delete existing.__keep;

  let values = { ...existing };
  if (!keepEnv) {
    values = { ...values, ...(await step3_provider(existing)) };
  } else {
    heading('3 / 6   AI provider');
    info('Keeping existing settings', existing.AI_PROVIDER ?? 'unset');
  }

  await step4_google();
  await step5_authorize();

  if (!keepEnv) {
    values = { ...values, ...(await step6_processing(existing)) };
    const backup = writeEnv(values);
    heading('Writing .env');
    pass('.env written', backup ? `previous version saved as ${path.basename(backup)}` : 'new file');
  } else {
    heading('6 / 6   How runs should behave');
    info('Keeping existing settings', `DRY_RUN=${existing.DRY_RUN ?? 'unset'}, BATCH_SIZE=${existing.BATCH_SIZE ?? 'unset'}`);
  }

  heading('Summary');
  for (const line of summary) info(line);

  heading('Scheduling');
  console.log(dim('  Runs three times a day, files new mail, and emails you a digest.'));
  console.log(dim('  Recommended only after you have watched a few manual runs.\n'));
  if (await confirm('Install the scheduled job now?', false)) {
    const { install } = await import('./schedule.js');
    await install();
  } else {
    info('Skipped', 'install it later with: npm run schedule:install');
  }

  console.log(`\n${bold('  Setup complete. Next, in order:')}`);
  console.log(`    ${green('1.')} npm run doctor        ${dim('verify everything')}`);
  console.log(`    ${green('2.')} npm run dev stats     ${dim('see your mailbox counts')}`);
  console.log(`    ${green('3.')} npm run classify      ${dim('classify a batch, change nothing')}`);
  // Only worth saying while they are still in preview mode.
  if ((values.DRY_RUN ?? 'true') !== 'false') {
    console.log(dim('\n  When the classifications look right, set DRY_RUN=false in .env and run'));
    console.log(dim('  npm run organize. Start with a small BATCH_SIZE and check Gmail after.\n'));
  } else {
    console.log(dim('\n  DRY_RUN is false — organize will move mail for real.\n'));
  }
}

main()
  .catch((err) => {
    console.error(`\n  ${yellow('!')} Setup stopped:`, err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closePrompts);
