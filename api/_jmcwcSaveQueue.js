/**
 * Trendz Tracker — Phase 17b/17c: Server Re-Export of Shared JMCWC Save Queue Coordinator (api/_jmcwcSaveQueue.js)
 *
 * The canonical browser-safe implementation with zero server imports lives in `shared/jmcwcSaveQueue.js`.
 */

export {
  JMCWC_MAX_PAUSE_BODY_BYTES,
  JMCWC_MAX_PATCH_BYTES,
  JMCWC_MAX_ANSWER_BYTES,
  utf8ByteLength,
  normalizeAnswerPatchValue,
  sanitizeAnswerPatchObject,
  buildPauseKeepalivePayload,
  createJmcwcSaveQueue,
} from '../shared/jmcwcSaveQueue.js';
