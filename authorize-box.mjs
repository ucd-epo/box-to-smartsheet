// authorize-box.mjs
//
// One-time Box sign-in for scheduled runs (BOX_AUTH_MODE=oauth).
// Opens Box in your browser, you approve access, and the resulting login is
// saved to .box-tokens.json. boxToSmartsheet.mjs renews it automatically after that.
//
// Run:  npm run authorize
//
// Rerun this only if the saved login expires (60 days with no runs) or is revoked.

import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { loadEnv, requireEnv, postToken, saveTokens, tokenFilePath } from './boxAuth.mjs';

loadEnv();

const clientId = requireEnv('BOX_CLIENT_ID');
const clientSecret = requireEnv('BOX_CLIENT_SECRET');
const port = Number(process.env.BOX_REDIRECT_PORT?.trim() || 3000);
const redirectUri = `http://localhost:${port}/callback`;
const state = crypto.randomBytes(16).toString('hex');

const authUrl = new URL('https://account.box.com/api/oauth2/authorize');
authUrl.search = new URLSearchParams({
  response_type: 'code',
  client_id: clientId,
  redirect_uri: redirectUri,
  state,
}).toString();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  if (url.pathname !== '/callback') {
    res.writeHead(404);
    res.end();
    return;
  }

  const reply = (status, message) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(message);
  };

  const error = url.searchParams.get('error');
  if (error) {
    const detail = url.searchParams.get('error_description') ?? error;
    reply(400, `Box did not grant access: ${detail}`);
    console.error(`Box did not grant access: ${detail}`);
    return shutdown(1);
  }

  if (url.searchParams.get('state') !== state) {
    reply(400, 'This sign-in link is stale. Go back to Terminal and use the link it printed.');
    return;
  }

  try {
    const tokenRes = await postToken({
      grant_type: 'authorization_code',
      code: url.searchParams.get('code'),
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    });
    if (!tokenRes.ok) {
      throw new Error(`Box token exchange failed (${tokenRes.status}): ${await tokenRes.text()}`);
    }
    saveTokens(await tokenRes.json());

    reply(200, 'Box sign-in complete. You can close this tab and go back to Terminal.');
    console.log(`Signed in. Saved Box login to ${tokenFilePath()}`);
    console.log('Scheduled runs will now renew the Box token automatically.');
    shutdown(0);
  } catch (err) {
    reply(500, `Sign-in failed: ${err.message}`);
    console.error(`Sign-in failed: ${err.message}`);
    shutdown(1);
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Port ${port} is already in use. Set BOX_REDIRECT_PORT to another port in .env ` +
      `and update the Redirect URI in your Box app to match.`
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  console.log('Opening Box in your browser. If it does not open, paste this link into your browser:\n');
  console.log(authUrl.href + '\n');
  console.log(`Waiting for sign-in on ${redirectUri} ...`);
  if (process.platform === 'darwin') execFile('open', [authUrl.href], () => {});
});

// Give up after 5 minutes so the script doesn't sit waiting forever.
setTimeout(() => {
  console.error('Timed out waiting for Box sign-in. Run `npm run authorize` again.');
  shutdown(1);
}, 5 * 60 * 1000).unref();

function shutdown(code) {
  server.close();
  setTimeout(() => process.exit(code), 200);
}
