/**
 * google-auth.js
 * Shared Google service-account auth for build-api.js and import-herbal-sheets.js.
 *
 * Credentials can come from (checked in this order):
 *   1. GOOGLE_CREDENTIALS_JSON_B64 — the key file's JSON, base64-encoded into
 *      a single line. Recommended for hosts like Hostinger's Web App: each
 *      deploy ships a fresh checkout of the Git repo, so a credentials.json
 *      uploaded by hand doesn't survive the next deploy, and many env-var
 *      input fields choke on raw multi-line JSON — base64 sidesteps both.
 *   2. GOOGLE_CREDENTIALS_JSON — either raw JSON content or a file path
 *      (local dev).
 *   3. ./credentials.json next to this file (local dev default).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createGoogleAuth(scopes) {
  const b64 = process.env.GOOGLE_CREDENTIALS_JSON_B64;
  if (b64 && b64.trim()) {
    const credentials = JSON.parse(Buffer.from(b64.trim(), 'base64').toString('utf8'));
    return new google.auth.GoogleAuth({ credentials, scopes });
  }

  const raw = process.env.GOOGLE_CREDENTIALS_JSON;
  if (raw && raw.trim().startsWith('{')) {
    return new google.auth.GoogleAuth({ credentials: JSON.parse(raw), scopes });
  }

  const keyFile = raw || path.join(__dirname, 'credentials.json');
  return new google.auth.GoogleAuth({ keyFile, scopes });
}

export function hasGoogleCredentials() {
  if ((process.env.GOOGLE_CREDENTIALS_JSON_B64 || '').trim()) return true;
  if ((process.env.GOOGLE_CREDENTIALS_JSON || '').trim()) return true;
  return fs.existsSync(path.join(__dirname, 'credentials.json'));
}
