/**
 * Trendz Tracker — Live Classes Serverless Function Endpoint (api/live-class.js)
 *
 * Exposes the authenticated Webinar.gg live classes lifecycle:
 * - get_class_details
 * - join (mints Webinar.gg join token server-to-server)
 * - sync_provider_status
 * - list
 * - create
 * - update_status
 *
 * Strict Cache-Control: no-store and role authorization.
 */

import { handleLiveClassRequest } from './_liveClass.js';

export default async function handler(req, res) {
  return handleLiveClassRequest(req, res);
}
