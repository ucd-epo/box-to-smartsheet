// boxAuth.mjs
//
// Settings loading and Box authentication shared by boxToSmartsheet.mjs and
// authorize-box.mjs.
//
// Box auth modes (BOX_AUTH_MODE in .env):
//   oauth - OAuth 2.0 user login. Run `npm run authorize` once; after that the
//           script renews its own 60-minute token from a saved refresh token.
//           Use this for scheduled runs when you don't have a CCG app.
//   ccg   - Client Credentials Grant app approved by a Box admin.
//   token - A developer token pasted into BOX_TOKEN (expires after 60 minutes).
//
// If BOX_AUTH_MODE is blank, the mode is picked automatically: oauth if a saved
// login exists, ccg if BOX_SUBJECT_ID is set, otherwise token.

import fs from 'node:fs';
import path from 'node:path';

const PROJECT_DIR = import.meta.dirname;
export const TOKEN_URL = 'https://api.box.com/oauth2/token';

// Refresh when the saved access token has less than this left.
const REFRESH_MARGIN_MS = 15 * 60 * 1000;

// ---------- Settings ----------

// Loads .env from the project folder (not the current folder), so scheduled
// runs find it no matter where they start.
//
// .env is optional: on GitHub Actions there is no .env, and settings come from
// repository secrets and variables passed in as environment variables instead.
// Values already in the environment are never overwritten by .env.
export function loadEnv() {
  const envPath = path.join(PROJECT_DIR, '.env');
  if (!fs.existsSync(envPath)) {
    if (!process.env.GITHUB_ACTIONS) {
      console.log(`No .env file at ${envPath}; using environment variables only.`);
    }
    return;
  }
  if (typeof process.loadEnvFile !== 'function') {
    console.error('This Node version cannot load .env files. Update to Node 20.12 or newer.');
    process.exit(1);
  }
  process.loadEnvFile(envPath);
}

export function requireEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`Missing environment variable: ${name}`);
    process.exit(1);
  }
  return v.trim();
}

// ---------- Saved OAuth login ----------

export function tokenFilePath() {
  const p = process.env.BOX_TOKEN_FILE?.trim() || '.box-tokens.json';
  return path.isAbsolute(p) ? p : path.join(PROJECT_DIR, p);
}

// Writes the tokens with owner-only permissions. Writes to a temp file first so a
// crash mid-write can't corrupt the saved refresh token.
export function saveTokens(data) {
  if (!data.refresh_token) throw new Error('Box did not return a refresh token.');
  const file = tokenFilePath();
  const tmp = `${file}.tmp`;
  const record = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    saved_at: new Date().toISOString(),
  };
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function readTokens() {
  try {
    return JSON.parse(fs.readFileSync(tokenFilePath(), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Could not read saved Box login (${tokenFilePath()}): ${err.message}`);
  }
}

// ---------- Getting a token ----------

export function authMode() {
  const explicit = process.env.BOX_AUTH_MODE?.trim().toLowerCase();
  if (explicit) {
    if (!['oauth', 'ccg', 'token'].includes(explicit)) {
      console.error(`BOX_AUTH_MODE must be oauth, ccg, or token (got "${explicit}").`);
      process.exit(1);
    }
    return explicit;
  }
  if (fs.existsSync(tokenFilePath())) return 'oauth';
  if (process.env.BOX_SUBJECT_ID?.trim()) return 'ccg';
  return 'token';
}

// Returns a usable Box access token. forceRefresh is used after a 401 mid-run.
export async function getBoxToken({ forceRefresh = false } = {}) {
  const mode = authMode();
  if (mode === 'token') return requireEnv('BOX_TOKEN');
  if (mode === 'ccg') return getCcgToken();
  return getOAuthToken(forceRefresh);
}

async function getOAuthToken(forceRefresh) {
  const saved = readTokens();
  if (!saved?.refresh_token) {
    throw new Error('No saved Box login. Run `npm run authorize` once to sign in.');
  }

  if (!forceRefresh && saved.access_token && saved.expires_at - Date.now() > REFRESH_MARGIN_MS) {
    return saved.access_token;
  }

  const res = await postToken({
    grant_type: 'refresh_token',
    refresh_token: saved.refresh_token,
    client_id: requireEnv('BOX_CLIENT_ID'),
    client_secret: requireEnv('BOX_CLIENT_SECRET'),
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 400 && body.includes('invalid_grant')) {
      throw new Error(
        'The saved Box login has expired or was revoked (it lapses after 60 days without a run). ' +
        'Run `npm run authorize` to sign in again.'
      );
    }
    throw new Error(`Box token refresh failed (${res.status}): ${body}`);
  }

  // Box refresh tokens are single-use: save the new one before doing anything else.
  const data = await res.json();
  saveTokens(data);
  return data.access_token;
}

async function getCcgToken() {
  const res = await postToken({
    grant_type: 'client_credentials',
    client_id: requireEnv('BOX_CLIENT_ID'),
    client_secret: requireEnv('BOX_CLIENT_SECRET'),
    box_subject_type: (process.env.BOX_SUBJECT_TYPE ?? 'enterprise').trim(),
    box_subject_id: requireEnv('BOX_SUBJECT_ID'),
  });
  if (!res.ok) {
    throw new Error(`Box token request failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()).access_token;
}

export function postToken(params) {
  return fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
}
