/**
 * google-auth.js
 * Shared Google service-account auth for build-api.js and import-herbal-sheets.js.
 *
 * GOOGLE_CREDENTIALS_JSON can be either:
 *   - a file path to credentials.json (local dev), or
 *   - the raw JSON key content itself (recommended for hosts like Hostinger's
 *     Web App, where each deploy ships a fresh checkout of the Git repo and
 *     any file uploaded by hand — credentials.json is gitignored on purpose —
 *     does not survive the next deploy; env vars do).
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createGoogleAuth(scopes) {
  const raw = process.env.GOOGLE_CREDENTIALS_JSON;

  if (raw && raw.trim().startsWith('{')) {
    return new google.auth.GoogleAuth({ credentials: JSON.parse(raw), scopes });
  }

  const keyFile = raw || path.join(__dirname, 'credentials.json');
  return new google.auth.GoogleAuth({ keyFile, scopes });
}
