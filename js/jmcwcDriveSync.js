/**
 * Trendz Tracker — Google Drive JMCWC Source Sync Client (js/jmcwcDriveSync.js)
 *
 * Uses client-side Google OAuth (`google.accounts.oauth2.initTokenClient` with the
 * applet's provisioned `oAuthClientId` and in-memory token caching only) to pass a
 * short-lived Bearer token to `/api/jmcwc-drive-sync` so the server can download
 * the three original JMCWC 2026 `.xlsx` workbooks into `/docs/sources/`.
 */

import firebaseConfig from '../firebase-applet-config.json';

export const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
];

// Cache the Google OAuth access token strictly in memory (never localStorage/sessionStorage).
let cachedAccessToken = null;
let gsiScriptPromise = null;

function loadGsiScript() {
  if (gsiScriptPromise) return gsiScriptPromise;
  gsiScriptPromise = new Promise((resolve, reject) => {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) {
      resolve(window.google);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(window.google);
    script.onerror = () => reject(new Error('Failed to load Google Identity Services script'));
    document.head.appendChild(script);
  });
  return gsiScriptPromise;
}

export async function googleSignIn() {
  const google = await loadGsiScript();
  return new Promise((resolve, reject) => {
    const tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: firebaseConfig.oAuthClientId,
      scope: SCOPES.join(' '),
      callback: (response) => {
        if (response && response.access_token) {
          cachedAccessToken = response.access_token;
          resolve({ accessToken: cachedAccessToken });
        } else {
          reject(
            new Error(
              response?.error_description || response?.error || 'Google sign-in cancelled'
            )
          );
        }
      },
    });
    tokenClient.requestAccessToken({ prompt: 'consent' });
  });
}

export function getAccessToken() {
  return cachedAccessToken;
}

export function clearAccessToken() {
  cachedAccessToken = null;
}

export async function syncJmcwcWorkbooksFromDrive() {
  let token = getAccessToken();
  if (!token) {
    const authRes = await googleSignIn();
    token = authRes.accessToken;
  }
  const res = await fetch('/api/jmcwc-drive-sync', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ action: 'sync_drive' }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to sync JMCWC workbooks from Google Drive');
  }
  return data;
}

function renderSyncStatus(container, summaries) {
  if (!container) return;
  const xlsxFiles = (summaries || []).filter((item) => item.fileName && item.fileName.endsWith('.xlsx'));
  if (xlsxFiles.length === 0) {
    container.innerHTML =
      'Click <strong>Sign in with Google &amp; Sync JMCWC .xlsx from Drive</strong> above so the server can read the 3 workbooks from your Google Drive.';
    return;
  }
  container.innerHTML = xlsxFiles
    .map((item) => {
      const sheetsCount = Array.isArray(item.visibleSheets) ? item.visibleSheets.length : 0;
      const sample = item.sampleFormula
        ? `${item.sampleFormula.sheet}!${item.sampleFormula.cell} = <code>${item.sampleFormula.formula}</code>`
        : 'no formula';
      return `<div style="margin-top:4px;"><strong>${item.fileName}</strong> — ${sheetsCount} visible sheets · sample formula: ${sample}</div>`;
    })
    .join('');
}

function ensureAdminTopSyncBanner() {
  if (document.getElementById('btn-google-drive-jmcwc-sync')) return;
  const mainContainer = document.querySelector('.main-content .container');
  if (!mainContainer) return;

  const card = document.createElement('section');
  card.id = 'jmcwc-drive-sync-section';
  card.className = 'card';
  card.style.marginBottom = 'var(--space-5)';
  card.style.borderLeft = '4px solid var(--color-primary)';
  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:var(--space-3);">
      <div>
        <strong style="font-size:var(--text-base);">Phase 17a: Authorize Google Drive Read for JMCWC 2026 Workbooks</strong>
        <div id="jmcwc-drive-sync-status" style="font-size:var(--text-sm);color:var(--text-muted);margin-top:4px;">
          Checking server docs/sources/...
        </div>
      </div>
      <button type="button" id="btn-google-drive-jmcwc-sync" class="gsi-material-button" style="display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border:1px solid var(--border-subtle);border-radius:var(--radius-sm);background:var(--bg-surface);cursor:pointer;">
        <div class="gsi-material-button-state"></div>
        <div class="gsi-material-button-content-wrapper" style="display:inline-flex;align-items:center;gap:8px;">
          <div class="gsi-material-button-icon" style="width:18px;height:18px;">
            <svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" style="display:block;width:18px;height:18px;">
              <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"></path>
              <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"></path>
              <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"></path>
              <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"></path>
              <path fill="none" d="M0 0h48v48H0z"></path>
            </svg>
          </div>
          <span class="gsi-material-button-contents" style="font-weight:600;font-size:var(--text-sm);">Sign in with Google &amp; Sync JMCWC .xlsx from Drive</span>
          <span style="display:none;">Sign in with Google</span>
        </div>
      </button>
    </div>
  `;
  mainContainer.prepend(card);
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      const checkRes = await fetch('/api/jmcwc-drive-sync');
      const checkData = await checkRes.json();
      const xlsxCount = (checkData.files || []).filter(
        (f) => f.fileName && f.fileName.endsWith('.xlsx')
      ).length;
      if (xlsxCount < 3) {
        ensureAdminTopSyncBanner();
      }
      const statusEl = document.getElementById('jmcwc-drive-sync-status');
      if (statusEl && checkData && Array.isArray(checkData.files)) {
        renderSyncStatus(statusEl, checkData.files);
      }
    } catch {
      ensureAdminTopSyncBanner();
    }

    const driveBtn = document.getElementById('btn-google-drive-jmcwc-sync');
    const statusEl = document.getElementById('jmcwc-drive-sync-status');

    if (driveBtn) {
      driveBtn.addEventListener('click', async () => {
        if (statusEl) {
          statusEl.textContent =
            'Opening Google OAuth popup and downloading JMCWC .xlsx workbooks to server docs/sources/...';
        }
        try {
          const res = await syncJmcwcWorkbooksFromDrive();
          renderSyncStatus(statusEl, res.saved || []);
          if (Array.isArray(res.notFound) && res.notFound.length > 0 && statusEl) {
            statusEl.innerHTML += `<div style="margin-top:4px;color:var(--color-warning);">Not found in Drive: ${res.notFound.join(', ')}</div>`;
          }
        } catch (err) {
          if (statusEl) statusEl.textContent = `Google Drive sync error: ${err.message}`;
        }
      });
    }
  });
}
