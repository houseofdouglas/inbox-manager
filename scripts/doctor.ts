// Read-only diagnosis. Every check prints pass/fail with the exact remedy.
// Exits 0 only if nothing failed. Never touches the mailbox or the database.
import { config } from '../src/config.js';
import {
  checkNode, checkDependencies, checkEnvFile, checkCredentials, checkGmail,
  checkModelHost, checkDatabase, checkSchedule, checkTrackedSecrets, CheckResult,
} from './lib/checks.js';
import { heading, pass, fail, warn, info, bold, dim, green, red, yellow } from './lib/ui.js';

function render(r: CheckResult): void {
  if (r.status === 'pass') pass(r.name, r.detail);
  else if (r.status === 'fail') fail(`${r.name}${r.detail ? dim(`  ${r.detail}`) : ''}`, r.remedy);
  else if (r.status === 'warn') warn(`${r.name}${r.detail ? dim(`  ${r.detail}`) : ''}`, r.remedy);
  else info(r.name, r.detail);
}

function providerChecks(): Promise<CheckResult[]> {
  switch (config.aiProvider) {
    case 'llama':
      return checkModelHost(config.llamaBaseUrl, config.llamaModel);
    case 'gemini':
      return Promise.resolve([config.geminiApiKey
        ? { name: 'Gemini', status: 'pass', detail: `key set, model ${config.geminiModel}` }
        : { name: 'Gemini', status: 'fail', remedy: 'Set GEMINI_API_KEY in .env — https://aistudio.google.com/apikey' }]);
    case 'claude':
      return Promise.resolve([config.anthropicApiKey
        ? { name: 'Claude', status: 'pass', detail: `key set, model ${config.claudeModel}` }
        : { name: 'Claude', status: 'fail', remedy: 'Set ANTHROPIC_API_KEY in .env — https://console.anthropic.com/' }]);
    default:
      return Promise.resolve([{ name: 'AI provider', status: 'info', detail: config.aiProvider }]);
  }
}

async function main() {
  console.log(bold('\nInbox Manager — checking your setup'));
  const results: CheckResult[] = [];
  const add = (r: CheckResult | CheckResult[]) => {
    for (const one of Array.isArray(r) ? r : [r]) { results.push(one); render(one); }
  };

  heading('Environment');
  add(checkNode());
  add(await checkDependencies());
  const envResult = checkEnvFile();
  add(envResult);

  heading(`AI provider — ${config.aiProvider}`);
  if (envResult.status === 'fail') {
    info('skipped', 'no .env to read settings from');
  } else {
    if (config.aiProvider === 'llama') {
      console.log(dim('  Sending a trial prompt. This can take a minute if the model is still loading.'));
    }
    add(await providerChecks());
  }

  heading('Gmail');
  const credResult = checkCredentials();
  add(credResult);
  if (credResult.status === 'pass') add(await checkGmail());
  else info('Authorization', 'skipped — credentials.json first');

  heading('Storage');
  add(await checkDatabase(config.dbPath));

  heading('Automation');
  add(await checkSchedule(config.dailyJobLabel));
  add(await checkTrackedSecrets());
  info('Dry run', config.dryRun
    ? 'DRY_RUN=true — nothing in your mailbox will be modified'
    : 'DRY_RUN=false — runs will move and mark mail');

  const failed = results.filter((r) => r.status === 'fail');
  const warned = results.filter((r) => r.status === 'warn');

  console.log();
  if (failed.length === 0 && warned.length === 0) {
    console.log(green(bold('  All checks passed.')));
    console.log(dim('  Try:  npm run dev stats'));
  } else if (failed.length === 0) {
    console.log(yellow(bold(`  ${warned.length} warning${warned.length === 1 ? '' : 's'}, nothing broken.`)));
  } else {
    console.log(red(bold(`  ${failed.length} check${failed.length === 1 ? '' : 's'} failed:`)));
    for (const f of failed) console.log(red(`    · ${f.name}`));
    console.log(dim('\n  Fix the first one and run npm run doctor again.'));
  }
  console.log();
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('\ndoctor crashed:', err);
  process.exit(1);
});
