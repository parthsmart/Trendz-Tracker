/**
 * Trendz Tracker - Google Service Account Auth & Sheets REST v4 Helpers (api/_google.js)
 *
 * STRICT ARCHITECTURAL & SECURITY INVARIANTS:
 * - Zero external Google client libraries: uses Node's built-in `node:crypto` (`createSign`)
 *   for RS256 JWT assertion signing and native `fetch` for OAuth2 and Sheets REST API v4 calls.
 * - Never hard-codes, logs, or returns `GOOGLE_SERVICE_ACCOUNT_JSON`, `private_key`, `access_token`,
 *   or any student/database row data.
 * - Writes strictly use `valueInputOption=RAW` so values are never parsed or executed as formulas.
 * - Retries once after 2 seconds (`2000` ms) on HTTP 429 or 5xx responses.
 * - Error messages always include the HTTP status and Google's short message, and never include
 *   the token, private key, or any data row.
 */

import crypto from 'node:crypto';
import { getGoogleBackupConfig, hasGoogleBackupConfig } from './_configHelper.js';

export { getGoogleBackupConfig, hasGoogleBackupConfig };

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const GOOGLE_SHEETS_BASE_URL = 'https://sheets.googleapis.com/v4/spreadsheets';
const DEFAULT_RETRY_DELAY_MS = 2000;
const TOKEN_EXPIRY_SAFETY_BUFFER_MS = 120 * 1000; // Refresh 2 minutes before expiry

// In-memory token cache across warm serverless invocations
let tokenCache = {
  accessToken: '',
  expiresAtMs: 0,
  clientEmail: '',
};

/**
 * Resets the in-memory OAuth access token cache (used in tests).
 */
export function clearGoogleTokenCache() {
  tokenCache = {
    accessToken: '',
    expiresAtMs: 0,
    clientEmail: '',
  };
}

/**
 * Encodes a Buffer or UTF-8 string as Base64URL without padding.
 * @param {string|Buffer} input
 * @returns {string}
 */
function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/**
 * Scrubs any token or private key material from an error string and keeps it concise.
 * Never includes row data or credentials.
 *
 * @param {string} msg
 * @param {string[]} [secrets]
 * @returns {string}
 */
export function sanitizeGoogleErrorMessage(msg, secrets = []) {
  let clean = String(msg || 'Unknown Google API error');
  for (const s of secrets) {
    if (s && typeof s === 'string' && s.length >= 4) {
      clean = clean.split(s).join('[REDACTED]');
    }
  }
  clean = clean.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
  clean = clean.replace(/ya29\.[A-Za-z0-9._-]+/g, '[REDACTED_TOKEN]');
  clean = clean.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_KEY]');
  return clean.slice(0, 220);
}

/**
 * Builds and signs an RS256 JWT assertion for Google OAuth2 service account authentication.
 *
 * @param {{ clientEmail: string, privateKey: string, nowSec?: number }} params
 * @returns {string}
 */
export function buildServiceAccountJwt({ clientEmail, privateKey, nowSec }) {
  const issuedAt = typeof nowSec === 'number' ? Math.floor(nowSec) : Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 3600; // 1 hour expiry

  const header = {
    alg: 'RS256',
    typ: 'JWT',
  };

  const payload = {
    iss: clientEmail,
    scope: GOOGLE_SHEETS_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: issuedAt,
    exp: expiresAt,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  let signatureBase64Url;
  try {
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    signatureBase64Url = base64UrlEncode(signer.sign(privateKey));
  } catch {
    throw new Error('Google authentication error: Failed to sign service-account JWT with private_key.');
  }

  return `${signingInput}.${signatureBase64Url}`;
}

/**
 * Sleeps for the specified duration in milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extracts a short, safe error message from a non-2xx Google HTTP response.
 * Never includes tokens, keys, or data rows.
 *
 * @param {Response} response
 * @param {string[]} secrets
 * @returns {Promise<string>}
 */
async function extractGoogleHttpError(response, secrets = []) {
  let shortMessage = response.statusText || 'Request failed';
  try {
    const rawText = await response.text();
    if (rawText) {
      try {
        const parsed = JSON.parse(rawText);
        if (parsed && typeof parsed === 'object') {
          if (parsed.error && typeof parsed.error === 'object' && parsed.error.message) {
            shortMessage = String(parsed.error.message);
          } else if (typeof parsed.error_description === 'string') {
            shortMessage = parsed.error_description;
          } else if (typeof parsed.error === 'string') {
            shortMessage = parsed.error;
          } else if (typeof parsed.message === 'string') {
            shortMessage = parsed.message;
          }
        }
      } catch {
        shortMessage = rawText.slice(0, 140);
      }
    }
  } catch {
    // Ignore body read error
  }

  const safeMsg = sanitizeGoogleErrorMessage(shortMessage, secrets);
  return `Google API HTTP ${response.status}: ${safeMsg}`;
}

/**
 * Executes an HTTP request to Google APIs, retrying once after 2 seconds on HTTP 429 or 5xx.
 *
 * @param {string} url
 * @param {RequestInit} init
 * @param {{ fetchImpl?: typeof fetch, retryDelayMs?: number, secrets?: string[] }} [opts]
 * @returns {Promise<any>}
 */
export async function googleFetchWithRetry(url, init, opts = {}) {
  const fetchFn = opts.fetchImpl || fetch;
  const retryDelayMs = typeof opts.retryDelayMs === 'number' ? opts.retryDelayMs : DEFAULT_RETRY_DELAY_MS;
  const secrets = Array.isArray(opts.secrets) ? opts.secrets : [];

  for (let attempt = 0; attempt < 2; attempt++) {
    let response;
    try {
      response = await fetchFn(url, init);
    } catch (netErr) {
      if (attempt === 0) {
        await sleep(retryDelayMs);
        continue;
      }
      const rawMsg = netErr instanceof Error ? netErr.message : 'Network error';
      throw new Error(sanitizeGoogleErrorMessage(`Google API network error: ${rawMsg}`, secrets));
    }

    const status = response.status;
    const isRetryableStatus = status === 429 || (status >= 500 && status <= 599);

    if (!response.ok) {
      if (isRetryableStatus && attempt === 0) {
        await sleep(retryDelayMs);
        continue;
      }
      const formattedErr = await extractGoogleHttpError(response, secrets);
      throw new Error(formattedErr);
    }

    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }
  throw new Error('Google API request failed after retry.');
}

/**
 * Obtains a Google OAuth2 access token using the configured service account.
 * Caches the token in memory until shortly before it expires.
 *
 * @param {{ env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, retryDelayMs?: number, forceRefresh?: boolean }} [opts]
 * @returns {Promise<string>}
 */
export async function getAccessToken(opts = {}) {
  const { clientEmail, privateKey } = getGoogleBackupConfig(opts.env || process.env);
  const nowMs = Date.now();

  if (
    !opts.forceRefresh &&
    tokenCache.accessToken &&
    tokenCache.clientEmail === clientEmail &&
    nowMs < tokenCache.expiresAtMs - TOKEN_EXPIRY_SAFETY_BUFFER_MS
  ) {
    return tokenCache.accessToken;
  }

  const assertion = buildServiceAccountJwt({
    clientEmail,
    privateKey,
    nowSec: Math.floor(nowMs / 1000),
  });

  const bodyParams = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  const data = await googleFetchWithRetry(
    GOOGLE_TOKEN_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: bodyParams.toString(),
    },
    {
      fetchImpl: opts.fetchImpl,
      retryDelayMs: opts.retryDelayMs,
      secrets: [privateKey, assertion],
    }
  );

  const accessToken = typeof data?.access_token === 'string' ? data.access_token.trim() : '';
  if (!accessToken) {
    throw new Error('Google OAuth token response did not contain an access_token.');
  }

  const expiresInSec = Number(data?.expires_in) || 3600;
  tokenCache = {
    accessToken,
    expiresAtMs: Date.now() + expiresInSec * 1000,
    clientEmail,
  };

  return accessToken;
}

/**
 * Formats a sheet tab name for A1 range notation (quoting if needed).
 * @param {string} tabName
 * @param {string} [cellRange]
 * @returns {string}
 */
export function formatSheetRange(tabName, cellRange = '') {
  const cleanTab = String(tabName || '').trim();
  const needsQuotes = /[^A-Za-z0-9_]/.test(cleanTab);
  const escapedTab = needsQuotes ? `'${cleanTab.replace(/'/g, "''")}'` : cleanTab;
  return cellRange ? `${escapedTab}!${cellRange}` : escapedTab;
}

/**
 * Lists all tabs (sheets) in the target Google Spreadsheet.
 *
 * @param {string} sheetId
 * @param {{ env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, retryDelayMs?: number }} [opts]
 * @returns {Promise<Array<{ sheetId: number, title: string, rowCount: number, columnCount: number }>>}
 */
export async function getSpreadsheetTabs(sheetId, opts = {}) {
  const token = await getAccessToken(opts);
  const url = `${GOOGLE_SHEETS_BASE_URL}/${encodeURIComponent(sheetId)}?fields=sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))`;

  const data = await googleFetchWithRetry(
    url,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
    {
      fetchImpl: opts.fetchImpl,
      retryDelayMs: opts.retryDelayMs,
      secrets: [token],
    }
  );

  const sheets = Array.isArray(data?.sheets) ? data.sheets : [];
  return sheets.map((s) => {
    const props = s?.properties || {};
    const grid = props.gridProperties || {};
    return {
      sheetId: props.sheetId,
      title: String(props.title || ''),
      rowCount: Number(grid.rowCount) || 1000,
      columnCount: Number(grid.columnCount) || 26,
    };
  });
}

/**
 * Adds a new tab (sheet) to the Google Spreadsheet using `batchUpdate` -> `addSheet`
 * with explicit `rowCount: 1000` and `columnCount: numColumns + 2`.
 *
 * @param {string} sheetId
 * @param {string} tabTitle
 * @param {number} numColumns
 * @param {{ env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, retryDelayMs?: number }} [opts]
 * @returns {Promise<{ title: string, rowCount: number, columnCount: number }>}
 */
export async function addSpreadsheetTab(sheetId, tabTitle, numColumns, opts = {}) {
  const token = await getAccessToken(opts);
  const colCount = Math.max(1, Number(numColumns) || 1) + 2;
  const rowCount = 1000;
  const url = `${GOOGLE_SHEETS_BASE_URL}/${encodeURIComponent(sheetId)}:batchUpdate`;

  await googleFetchWithRetry(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: [
          {
            addSheet: {
              properties: {
                title: tabTitle,
                gridProperties: {
                  rowCount,
                  columnCount: colCount,
                },
              },
            },
          },
        ],
      }),
    },
    {
      fetchImpl: opts.fetchImpl,
      retryDelayMs: opts.retryDelayMs,
      secrets: [token],
    }
  );

  return {
    title: tabTitle,
    rowCount,
    columnCount: colCount,
  };
}

/**
 * Updates cell values at a range using `values.update` with `valueInputOption=RAW`.
 *
 * @param {string} sheetId
 * @param {string} range - e.g. `profiles!A1` or `profiles!A2`
 * @param {Array<Array<string|number|boolean>>} values
 * @param {{ env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, retryDelayMs?: number }} [opts]
 * @returns {Promise<any>}
 */
export async function valuesUpdate(sheetId, range, values, opts = {}) {
  const token = await getAccessToken(opts);
  const url = `${GOOGLE_SHEETS_BASE_URL}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;

  return googleFetchWithRetry(
    url,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        range,
        majorDimension: 'ROWS',
        values,
      }),
    },
    {
      fetchImpl: opts.fetchImpl,
      retryDelayMs: opts.retryDelayMs,
      secrets: [token],
    }
  );
}

/**
 * Appends rows to a tab using `values.append` with `valueInputOption=RAW` and `insertDataOption=INSERT_ROWS`.
 *
 * @param {string} sheetId
 * @param {string} range - e.g. `results!A1`
 * @param {Array<Array<string|number|boolean>>} values
 * @param {{ env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, retryDelayMs?: number }} [opts]
 * @returns {Promise<any>}
 */
export async function valuesAppend(sheetId, range, values, opts = {}) {
  const token = await getAccessToken(opts);
  const url = `${GOOGLE_SHEETS_BASE_URL}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

  return googleFetchWithRetry(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        majorDimension: 'ROWS',
        values,
      }),
    },
    {
      fetchImpl: opts.fetchImpl,
      retryDelayMs: opts.retryDelayMs,
      secrets: [token],
    }
  );
}

/**
 * Clears values in the specified range using `values.clear`.
 *
 * @param {string} sheetId
 * @param {string} range - e.g. `profiles!A15:ZZ2000`
 * @param {{ env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, retryDelayMs?: number }} [opts]
 * @returns {Promise<any>}
 */
export async function valuesClear(sheetId, range, opts = {}) {
  const token = await getAccessToken(opts);
  const url = `${GOOGLE_SHEETS_BASE_URL}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}:clear`;

  return googleFetchWithRetry(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    },
    {
      fetchImpl: opts.fetchImpl,
      retryDelayMs: opts.retryDelayMs,
      secrets: [token],
    }
  );
}
