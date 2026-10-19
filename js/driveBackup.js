/**
 * Trendz Tracker - SQL Migrations & Google Drive Backup (js/driveBackup.js)
 *
 * Uses Firebase Auth (GoogleAuthProvider) with the `drive.file` scope to create
 * a backup folder in the user's Google Drive and upload all 12 ordered SQL migration
 * scripts + README.md from `supabase/migrations/`.
 *
 * SECURITY & WORKSPACE RULES:
 * - Access token is cached strictly in memory (`cachedAccessToken`) and never
 *   stored in localStorage or sessionStorage.
 * - Cleared automatically via `onAuthStateChanged` when the user signs out.
 */

import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
} from 'firebase/auth';
import firebaseConfig from '../firebase-applet-config.json';

import sql01 from '../supabase/migrations/01_phase1_schema.sql?raw';
import sql02 from '../supabase/migrations/02_security_fixes_and_seeds.sql?raw';
import sql03 from '../supabase/migrations/03_phase2_today_ist_and_validate_result.sql?raw';
import sql04 from '../supabase/migrations/04_phase3_streak_todo_and_resources.sql?raw';
import sql05 from '../supabase/migrations/05_phase3b_admin_overview.sql?raw';
import sql06 from '../supabase/migrations/06_phase4a_review_audit_and_attendance.sql?raw';
import sql07 from '../supabase/migrations/07_phase4b_targets_and_weekly_tests.sql?raw';
import sql08 from '../supabase/migrations/08_phase4c_0_round_rework.sql?raw';
import sql09 from '../supabase/migrations/09_phase4c_2_admin_import_rounds.sql?raw';
import sql10 from '../supabase/migrations/10_phase5a_competition_and_leaderboard.sql?raw';
import sql11 from '../supabase/migrations/11_phase5b_reports_and_milestones.sql?raw';
import sql12 from '../supabase/migrations/12_phase5c_backup_and_health.sql?raw';
import readmeMd from '../supabase/migrations/README.md?raw';

export const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
];

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);

const provider = new GoogleAuthProvider();
for (const scope of SCOPES) {
  provider.addScope(scope);
}

// Flag to indicate if we are in the middle of a sign-in flow.
let isSigningIn = false;
// Cache the access token strictly in memory.
let cachedAccessToken = null;

/**
 * Ordered list of all 12 SQL migration scripts and README.md
 */
export const MIGRATION_FILES = [
  {
    order: 0,
    filename: 'README.md',
    label: 'README — Execution Order & Recovery Guide',
    content: readmeMd,
  },
  {
    order: 1,
    filename: '01_phase1_schema.sql',
    label: '1. Phase 1 Schema (supabase/schema.sql)',
    content: sql01,
  },
  {
    order: 2,
    filename: '02_security_fixes_and_seeds.sql',
    label: '2. Security Fixes: Safe Sign-Up Trigger, Category Uniqueness & Basics Seeds',
    content: sql02,
  },
  {
    order: 3,
    filename: '03_phase2_today_ist_and_validate_result.sql',
    label: '3. Phase 2: today_ist() and validate_result() Trigger',
    content: sql03,
  },
  {
    order: 4,
    filename: '04_phase3_streak_todo_and_resources.sql',
    label: '4. Phase 3: streak_for, todo_for and resources',
    content: sql04,
  },
  {
    order: 5,
    filename: '05_phase3b_admin_overview.sql',
    label: '5. Phase 3b: admin_overview()',
    content: sql05,
  },
  {
    order: 6,
    filename: '06_phase4a_review_audit_and_attendance.sql',
    label: '6. Phase 4a: Review, Audit and Attendance',
    content: sql06,
  },
  {
    order: 7,
    filename: '07_phase4b_targets_and_weekly_tests.sql',
    label: '7. Phase 4b: Targets and Weekly Tests',
    content: sql07,
  },
  {
    order: 8,
    filename: '08_phase4c_0_round_rework.sql',
    label: '8. Phase 4c-0: Round Simulator Series Rework',
    content: sql08,
  },
  {
    order: 9,
    filename: '09_phase4c_2_admin_import_rounds.sql',
    label: '9. Phase 4c-2: admin_import_rounds & CSV Import Batches',
    content: sql09,
  },
  {
    order: 10,
    filename: '10_phase5a_competition_and_leaderboard.sql',
    label: '10. Phase 5a: Competition & Role-Scoped Leaderboards',
    content: sql10,
  },
  {
    order: 11,
    filename: '11_phase5b_reports_and_milestones.sql',
    label: '11. Phase 5b: Weekly Report Email, Monthly Report & Milestones',
    content: sql11,
  },
  {
    order: 12,
    filename: '12_phase5c_backup_and_health.sql',
    label: '12. Phase 5c: Schema Health Verification',
    content: sql12,
  },
];

/**
 * Initialize Firebase Auth state listener.
 * Clears cachedAccessToken when user signs out or when token is not in memory.
 */
export function initDriveAuth(onAuthSuccess, onAuthFailure) {
  return onAuthStateChanged(auth, async (user) => {
    if (user) {
      if (cachedAccessToken) {
        if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken);
      } else if (!isSigningIn) {
        cachedAccessToken = null;
        if (onAuthFailure) onAuthFailure();
      }
    } else {
      cachedAccessToken = null;
      if (onAuthFailure) onAuthFailure();
    }
  });
}

/**
 * Triggers Google Sign-In popup and caches OAuth access token in memory.
 */
export async function googleSignInForDrive() {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Failed to obtain Google Drive access token.');
    }
    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
  } finally {
    isSigningIn = false;
  }
}

export function getDriveAccessToken() {
  return cachedAccessToken;
}

export async function googleSignOutFromDrive() {
  await auth.signOut();
  cachedAccessToken = null;
}

/**
 * Helper to upload a single text file inside a Google Drive folder using multipart upload.
 */
async function uploadTextFileToDriveFolder({ accessToken, folderId, filename, content, mimeType = 'text/plain' }) {
  const boundary = '-------trendz_sql_backup_' + Math.random().toString(36).slice(2);
  const metadata = {
    name: filename,
    mimeType,
    parents: [folderId],
  };

  const multipartBody =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}; charset=UTF-8\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--`;

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipartBody,
    }
  );

  if (!res.ok) {
    const errData = await res.json().catch(() => null);
    throw new Error(
      errData?.error?.message || `Failed to upload ${filename} to Google Drive (HTTP ${res.status}).`
    );
  }

  return res.json();
}

/**
 * Creates a Google Drive folder and uploads README.md + all 12 ordered SQL migration scripts.
 * @param {string} folderName
 * @param {(statusText: string) => void} [onProgress]
 */
export async function saveAllSqlMigrationsToDrive(
  folderName = 'Trendz Tracker SQL Migrations',
  onProgress = null
) {
  const accessToken = getDriveAccessToken();
  if (!accessToken) {
    throw new Error('Please sign in with Google first to save files to Google Drive.');
  }

  if (onProgress) onProgress(`Creating folder "${folderName}" in Google Drive...`);

  const folderRes = await fetch(
    'https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
      }),
    }
  );

  if (!folderRes.ok) {
    if (folderRes.status === 401 || folderRes.status === 403) {
      cachedAccessToken = null;
    }
    const errData = await folderRes.json().catch(() => null);
    throw new Error(
      errData?.error?.message || `Could not create folder in Google Drive (HTTP ${folderRes.status}).`
    );
  }

  const folder = await folderRes.json();
  const folderId = folder.id;

  const uploadedFiles = [];
  for (let i = 0; i < MIGRATION_FILES.length; i++) {
    const item = MIGRATION_FILES[i];
    if (onProgress) {
      onProgress(`Uploading (${i + 1}/${MIGRATION_FILES.length}): ${item.filename}...`);
    }
    const uploaded = await uploadTextFileToDriveFolder({
      accessToken,
      folderId,
      filename: item.filename,
      content: item.content,
      mimeType: item.filename.endsWith('.md') ? 'text/markdown' : 'text/plain',
    });
    uploadedFiles.push(uploaded);
  }

  return {
    folderId,
    folderName: folder.name || folderName,
    folderUrl: folder.webViewLink || `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`,
    uploadedCount: uploadedFiles.length,
  };
}
