/**
 * Trendz Tracker — Phase 17b: Authenticated JMCWC Server API Endpoint (api/jmcwc.js)
 *
 * Exposes the server-authoritative JMCWC student session lifecycle and admin APIs.
 */

import { createJmcwcServer } from './_jmcwcServer.js';

const defaultJmcwcHandler = createJmcwcServer();

export default async function handler(req, res) {
  return defaultJmcwcHandler(req, res);
}
