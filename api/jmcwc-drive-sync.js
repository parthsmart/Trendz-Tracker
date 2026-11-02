/**
 * Trendz Tracker — Phase 17a: Server-Side Google Drive / Sheets JMCWC Workbook Sync (api/jmcwc-drive-sync.js)
 *
 * Uses a client-obtained Google OAuth access token (`Authorization: Bearer <token>`)
 * to locate and download the original XLSX bytes of:
 * - JMCWC-2026-Simulator-Juniors-1.xlsx
 * - JMCWC-2026-Simulator-Juniors-2.xlsx
 * - JMCWC-2026-Simulator-Seniors.xlsx
 * into server-only `/docs/sources/` (never logged, never placed in `/public` or `dist/`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseXlsxBuffer } from '../scripts/inspectJmcwcWorkbooks.js';

export const JMCWC_EXPECTED_WORKBOOKS = Object.freeze([
  'JMCWC-2026-Simulator-Juniors-1.xlsx',
  'JMCWC-2026-Simulator-Juniors-2.xlsx',
  'JMCWC-2026-Simulator-Seniors.xlsx',
]);

const SOURCES_DIR = path.resolve(process.cwd(), 'docs', 'sources');

function ensureSourcesDir() {
  if (!fs.existsSync(SOURCES_DIR)) {
    fs.mkdirSync(SOURCES_DIR, { recursive: true });
  }
}

function summarizeWorkbook(fileName, parsed, extraMeta = {}) {
  const visibleSheets = parsed.sheets
    .filter((s) => s.state === 'visible')
    .map((s) => s.name);
  const hiddenSheets = parsed.sheets
    .filter((s) => s.state !== 'visible')
    .map((s) => ({ name: s.name, state: s.state }));

  let sampleFormula = null;
  for (const sheet of parsed.sheets) {
    if (sheet.state !== 'visible') continue;
    for (const [cellRef, cellObj] of Object.entries(sheet.cells)) {
      if (cellObj.formula) {
        sampleFormula = {
          sheet: sheet.name,
          cell: cellRef,
          formula: cellObj.formula,
          value: cellObj.value,
        };
        break;
      }
    }
    if (sampleFormula) break;
  }

  const brokenCells = [];
  for (const sheet of parsed.sheets) {
    for (const b of sheet.brokenCells) {
      brokenCells.push({
        sheet: sheet.name,
        state: sheet.state,
        ...b,
      });
    }
  }

  return {
    fileName,
    visibleSheets,
    hiddenSheets,
    sampleFormula,
    brokenCells,
    ...extraMeta,
  };
}

export default async function jmcwcDriveSyncHandler(req, res) {
  ensureSourcesDir();

  // GET: Report which source files currently exist in `/docs/sources`
  if (req.method === 'GET') {
    const existing = fs.readdirSync(SOURCES_DIR);
    const reports = [];
    for (const name of existing) {
      if (name.endsWith('.xlsx')) {
        const fullPath = path.join(SOURCES_DIR, name);
        const buf = fs.readFileSync(fullPath);
        const parsed = parseXlsxBuffer(buf);
        reports.push(summarizeWorkbook(name, parsed));
      } else if (name.endsWith('.pdf')) {
        const stat = fs.statSync(path.join(SOURCES_DIR, name));
        reports.push({ fileName: name, kind: 'pdf', sizeBytes: stat.size });
      }
    }
    return res.status(200).json({
      ok: true,
      sourcesDir: 'docs/sources',
      files: reports,
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Missing Google OAuth Bearer token in Authorization header.',
    });
  }

  const saved = [];
  const notFound = [];
  const duplicates = {};

  for (const targetName of JMCWC_EXPECTED_WORKBOOKS) {
    const baseStem = targetName.replace(/\.xlsx$/i, '');
    const q = encodeURIComponent(
      `(name = '${targetName}' or name = '${baseStem}') and trashed = false`
    );
    const listRes = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,modifiedTime,size)&orderBy=modifiedTime desc&pageSize=10`,
      {
        headers: { Authorization: authHeader },
      }
    );
    if (!listRes.ok) {
      const errText = await listRes.text();
      return res.status(listRes.status).json({
        error: `Google Drive API search failed (${listRes.status}): ${errText}`,
      });
    }
    const listData = await listRes.json();
    const matches = Array.isArray(listData.files) ? listData.files : [];
    if (matches.length === 0) {
      notFound.push(targetName);
      continue;
    }
    if (matches.length > 1) {
      duplicates[targetName] = matches;
    }

    const fileMeta = matches[0];
    let downloadUrl;
    if (fileMeta.mimeType === 'application/vnd.google-apps.spreadsheet') {
      const exportMime = encodeURIComponent(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      downloadUrl = `https://www.googleapis.com/drive/v3/files/${fileMeta.id}/export?mimeType=${exportMime}`;
    } else {
      downloadUrl = `https://www.googleapis.com/drive/v3/files/${fileMeta.id}?alt=media`;
    }

    const dlRes = await fetch(downloadUrl, {
      headers: { Authorization: authHeader },
    });
    if (!dlRes.ok) {
      notFound.push(targetName);
      continue;
    }
    const arrayBuf = await dlRes.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    const targetPath = path.join(SOURCES_DIR, targetName);
    fs.writeFileSync(targetPath, buf);
    const parsed = parseXlsxBuffer(buf);
    saved.push(
      summarizeWorkbook(targetName, parsed, {
        driveFileId: fileMeta.id,
        modifiedTime: fileMeta.modifiedTime,
        duplicateMatchesCount: matches.length,
      })
    );
  }

  fs.writeFileSync(
    path.join(SOURCES_DIR, 'drive_manifest.json'),
    JSON.stringify({ syncedAt: new Date().toISOString(), saved, notFound, duplicates }, null, 2)
  );

  return res.status(200).json({
    ok: true,
    saved,
    notFound,
    duplicates,
  });
}
