/**
 * Trendz Tracker — Resources Lectures Serverless Function Endpoint (api/lectures.js)
 *
 * Exposes Google Classroom lecture catalogue operations:
 * - list_categories
 * - list_lectures
 * - get_lecture
 * - import_preview
 * - publish_import
 */

import { handleLecturesRequest } from './_lectures.js';

export default async function handler(req, res) {
  return handleLecturesRequest(req, res);
}
