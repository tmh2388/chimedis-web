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

/**
 * Đọc service account từ giá trị biến môi trường: chấp nhận base64 của file JSON (chuẩn) HOẶC dán thẳng nguyên văn JSON.
 * Giá trị sai KHÔNG làm sập server (trước đây JSON.parse ném lỗi ngay lúc import → deploy hỏng): trả null và ghi log.
 */
export function parseServiceAccount(raw, label = 'GOOGLE_CREDENTIALS_JSON_B64') {
  const v = String(raw || '').trim();
  if (!v) return null;
  const tryJson = (text) => {
    try {
      const o = JSON.parse(text);
      return o && typeof o === 'object' && o.client_email && o.private_key ? o : null;
    } catch (_) { return null; }
  };
  const parsed = v.startsWith('{') ? tryJson(v) : tryJson(Buffer.from(v.replace(/\s+/g, ''), 'base64').toString('utf8'));
  if (!parsed) console.error(`[google-auth] ${label} không phải JSON service account hợp lệ (cần base64 của file .json hoặc nguyên văn JSON) — bỏ qua.`);
  return parsed;
}

export function createGoogleAuth(scopes) {
  const fromB64 = parseServiceAccount(process.env.GOOGLE_CREDENTIALS_JSON_B64, 'GOOGLE_CREDENTIALS_JSON_B64');
  if (fromB64) return new google.auth.GoogleAuth({ credentials: fromB64, scopes });

  const raw = process.env.GOOGLE_CREDENTIALS_JSON;
  const fromJson = raw && raw.trim().startsWith('{') ? parseServiceAccount(raw, 'GOOGLE_CREDENTIALS_JSON') : null;
  if (fromJson) return new google.auth.GoogleAuth({ credentials: fromJson, scopes });

  const keyFile = (raw && !raw.trim().startsWith('{') ? raw : null) || path.join(__dirname, 'credentials.json');
  return new google.auth.GoogleAuth({ keyFile, scopes });
}

export function hasGoogleCredentials() {
  if (parseServiceAccount(process.env.GOOGLE_CREDENTIALS_JSON_B64, 'GOOGLE_CREDENTIALS_JSON_B64')) return true;
  if (parseServiceAccount(process.env.GOOGLE_CREDENTIALS_JSON, 'GOOGLE_CREDENTIALS_JSON')) return true;
  return fs.existsSync(path.join(__dirname, 'credentials.json'));
}
