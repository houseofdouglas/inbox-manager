// Re-runs the Gmail OAuth flow. Used on first setup and whenever a token is
// revoked or expires.
import fs from 'fs';
import path from 'path';
import { GmailService } from '../src/services/gmail.js';
import { bold, dim, green, red } from './lib/ui.js';

const TOKEN_PATH = path.join(process.cwd(), 'token.json');

async function main() {
  if (fs.existsSync(TOKEN_PATH)) {
    fs.renameSync(TOKEN_PATH, `${TOKEN_PATH}.previous`);
    console.log(dim(`  Existing token moved to token.json.previous`));
  }
  console.log(bold('\nAuthorizing Gmail'));
  console.log(dim('  A browser window will open. Approve access for the account you want managed.'));
  console.log(dim('  If you see "Google hasn\'t verified this app", choose Advanced → Go to (unsafe).'));
  console.log(dim('  That warning is expected: the app is yours and unverified by design.\n'));

  const gmail = new GmailService();
  await gmail.initialize();
  const address = await gmail.getAuthenticatedAddress();
  console.log(`\n  ${green('✓')} Authorized as ${bold(address)}`);
  console.log(dim('  Token saved to token.json'));
}

main().catch((err) => {
  console.error(`\n  ${red('✗')} Authorization failed:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
