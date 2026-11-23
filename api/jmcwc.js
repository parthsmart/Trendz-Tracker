/**
 * Trendz Tracker — Phase 17b: Authenticated JMCWC Server API Endpoint (api/jmcwc.js)
 *
 * Exposes the server-authoritative JMCWC student session lifecycle and admin APIs.
 * Also handles Google Drive workbook sync under Vercel Hobby serverless limits.
 */

import { createJmcwcServer } from './_jmcwcServer.js';
import jmcwcDriveSyncHandler from './_jmcwcDriveSync.js';

const defaultJmcwcHandler = createJmcwcServer();

export default async function handler(req, res) {
  if (
    req.headers['x-jmcwc-drive-sync'] ||
    req.query?.drive_sync ||
    req.url?.includes('drive-sync')
  ) {
    return jmcwcDriveSyncHandler(req, res);
  }
  return defaultJmcwcHandler(req, res);
}
