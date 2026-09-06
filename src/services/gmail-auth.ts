import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import fs from 'fs/promises';
import path from 'path';
import { createServer } from 'http';
import { URL } from 'url';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels'
];

interface OAuthClientConfig {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
}

/** Shape of credentials.json as downloaded from the Google Cloud Console. */
interface OAuthCredentials {
  installed?: OAuthClientConfig;
  web?: OAuthClientConfig;
}

const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

export async function getGmailClient() {
  const credentials = await loadCredentials();
  const auth = await authorize(credentials);
  return google.gmail({ version: 'v1', auth });
}

async function loadCredentials(): Promise<OAuthCredentials> {
  try {
    const content = await fs.readFile(CREDENTIALS_PATH, 'utf-8');
    return JSON.parse(content);
  } catch {
    throw new Error(
      'credentials.json not found. Please:\n' +
      '1. Go to Google Cloud Console\n' +
      '2. Create a new project or select existing\n' +
      '3. Enable Gmail API\n' +
      '4. Create OAuth 2.0 credentials (Desktop app)\n' +
      '5. Download and save as credentials.json in project root'
    );
  }
}

async function authorize(credentials: OAuthCredentials): Promise<OAuth2Client> {
  const clientConfig = credentials.installed || credentials.web;
  if (!clientConfig) {
    throw new Error(
      'credentials.json is missing an "installed" or "web" client section. ' +
      'Re-download the OAuth 2.0 client credentials (Desktop app) from the Google Cloud Console.'
    );
  }
  const { client_secret, client_id, redirect_uris } = clientConfig;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  try {
    const token = await fs.readFile(TOKEN_PATH, 'utf-8');
    const stored = JSON.parse(token);
    oAuth2Client.setCredentials(stored);

    // The library refreshes the access token in memory. Persist whatever comes
    // back so a refresh token rotated by Google isn't lost — otherwise the next
    // run re-authorizes for no reason. Google omits refresh_token on a plain
    // access-token refresh, so keep the stored one when it's absent.
    oAuth2Client.on('tokens', (tokens) => {
      const merged = { ...stored, ...tokens };
      if (!merged.refresh_token && stored.refresh_token) {
        merged.refresh_token = stored.refresh_token;
      }
      fs.writeFile(TOKEN_PATH, JSON.stringify(merged)).catch((err) => {
        console.error('Warning: could not persist refreshed Gmail token:', err);
      });
    });

    return oAuth2Client;
  } catch {
    return await getNewToken(oAuth2Client);
  }
}

async function getNewToken(oAuth2Client: OAuth2Client): Promise<OAuth2Client> {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });

  console.log('Authorize this app by visiting this url:', authUrl);
  console.log('\nWaiting for authorization...');

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        if (req.url && req.url.indexOf('/?code=') > -1) {
          const url = new URL(req.url, 'http://localhost:3000');
          const code = url.searchParams.get('code');

          res.end('Authentication successful! You can close this window.');
          server.close();

          if (code) {
            resolve(code);
          } else {
            reject(new Error('No code in response'));
          }
        }
      } catch (e) {
        reject(e);
      }
    }).listen(3000, () => {
      console.log('Local server started on http://localhost:3000');
    });
  });

  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  // issued_at survives later refresh writes (the merge keeps stored fields), so
  // `npm run doctor` can tell a long-lived token from one that is about to hit
  // the 7-day expiry a Testing-status consent screen imposes.
  await fs.writeFile(TOKEN_PATH, JSON.stringify({ ...tokens, issued_at: new Date().toISOString() }));
  console.log('Token stored to', TOKEN_PATH);

  return oAuth2Client;
}
