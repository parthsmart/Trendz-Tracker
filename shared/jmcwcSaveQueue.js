/**
 * Trendz Tracker — Shared Browser-Safe JMCWC Save Queue & Keepalive Coordinator (shared/jmcwcSaveQueue.js)
 *
 * Pure, zero-dependency, browser- and Node-compatible module with NO server imports:
 * 1. Only a single save request is in flight at any time.
 * 2. Dirty answer edits made while a save is in flight are coalesced into a single pending patch.
 * 3. If a save request fails transiently (network/5xx), the coordinator retries the EXACT same
 *    patch and sequence number (`save_seq`) before sending any subsequent coalesced patch.
 * 4. Sequence numbers (`save_seq`) start at 0 for each lease and increase strictly by 1 per patch.
 * 5. `buildPauseKeepalivePayload` enforces the 48 KB keepalive body budget and falls back to an
 *    unpatched pause/heartbeat payload when a dirty patch exceeds the browser keepalive budget.
 */

export const JMCWC_MAX_PAUSE_BODY_BYTES = 48 * 1024; // 48 KB safe keepalive budget (< 64 KB browser cap)
export const JMCWC_MAX_PATCH_BYTES = 250000;
export const JMCWC_MAX_ANSWER_BYTES = 4000;

const sharedTextEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

/**
 * Returns exact UTF-8 byte length of a string without Node Buffer dependencies.
 *
 * @param {string} str
 * @returns {number}
 */
export function utf8ByteLength(str) {
  const s = String(str ?? '');
  if (sharedTextEncoder) {
    return sharedTextEncoder.encode(s).length;
  }
  return unescape(encodeURIComponent(s)).length;
}

export function normalizeAnswerPatchValue(value) {
  if (value === null || value === undefined) return null;
  let str = '';
  if (typeof value === 'string') {
    str = value;
  } else if (Array.isArray(value)) {
    str = value.map((v) => (v === null || v === undefined ? '' : String(v).trim())).join(' ');
  } else if (typeof value === 'object') {
    str = Object.values(value)
      .map((v) => (v === null || v === undefined ? '' : String(v).trim()))
      .join(' ');
  } else {
    str = String(value);
  }
  const cleaned = str.replace(/[\r\n\t]+/g, ' ');
  return cleaned.trim().length === 0 ? '' : cleaned;
}

export function sanitizeAnswerPatchObject(rawPatch) {
  if (rawPatch === null || rawPatch === undefined) return null;
  if (typeof rawPatch !== 'object' || Array.isArray(rawPatch)) {
    throw new Error('Invalid answer patch.');
  }
  const out = {};
  for (const [key, val] of Object.entries(rawPatch)) {
    if (!key || typeof key !== 'string' || key.length > 100) {
      throw new Error('Invalid question or answer.');
    }
    const normalized = normalizeAnswerPatchValue(val);
    if (normalized !== null && utf8ByteLength(normalized) > JMCWC_MAX_ANSWER_BYTES) {
      throw new Error('Invalid question or answer.');
    }
    out[key] = normalized;
  }
  if (utf8ByteLength(JSON.stringify(out)) > JMCWC_MAX_PATCH_BYTES) {
    throw new Error('Invalid answer patch.');
  }
  return out;
}

/**
 * Build a `pause` payload for `pagehide` / `visibilitychange` (`visibilityState === 'hidden'`)
 * using `fetch(..., { keepalive: true })` with an `Authorization: Bearer ...` header.
 * Never puts auth tokens in URL query parameters.
 * If the dirty patch causes the request body to exceed `maxBytes` (default 48 KB), falls back to
 * an unpatched `pause` payload (`answers: null, save_seq: null`) so the server still pauses the
 * attempt and stops active-time accrual immediately.
 */
export function buildPauseKeepalivePayload({
  attempt_id,
  lease_id,
  save_seq = null,
  answers = null,
  maxBytes = JMCWC_MAX_PAUSE_BODY_BYTES,
} = {}) {
  const basePayload = {
    action: 'pause',
    attempt_id,
    lease_id,
    save_seq: null,
    answers: null,
  };

  if (answers && typeof answers === 'object' && Object.keys(answers).length > 0 && save_seq !== null) {
    const candidate = {
      action: 'pause',
      attempt_id,
      lease_id,
      save_seq,
      answers,
    };
    const bodyJson = JSON.stringify(candidate);
    const byteLen = utf8ByteLength(bodyJson);
    if (byteLen <= maxBytes) {
      return {
        payload: candidate,
        bodyJson,
        byteLength: byteLen,
        droppedOversizedPatch: false,
      };
    }
    const fallbackJson = JSON.stringify(basePayload);
    return {
      payload: basePayload,
      bodyJson: fallbackJson,
      byteLength: utf8ByteLength(fallbackJson),
      droppedOversizedPatch: true,
    };
  }

  const fallbackJson = JSON.stringify(basePayload);
  return {
    payload: basePayload,
    bodyJson: fallbackJson,
    byteLength: utf8ByteLength(fallbackJson),
    droppedOversizedPatch: false,
  };
}

/**
 * Create a stateful save-queue coordinator for a single attempt session.
 *
 * @param {object} options
 * @param {(payload: { attempt_id: string, lease_id: string, save_seq: number, answers: Record<string, string|null> }) => Promise<any>} options.sendSave
 * @param {(err: any) => void} [options.onConflictOrTerminal]
 * @param {(status: 'saving'|'saved'|'offline') => void} [options.onStatusChange]
 */
export function createJmcwcSaveQueue({ sendSave, onConflictOrTerminal, onStatusChange } = {}) {
  if (typeof sendSave !== 'function') {
    throw new Error('createJmcwcSaveQueue requires a sendSave function.');
  }

  let attemptId = null;
  let leaseId = null;
  let nextSeq = 0;
  let dirtyPatch = {};
  let pendingRetry = null; // { seq: number, patch: Record<string, string | null> }
  let inFlightPromise = null;
  let halted = false;

  function hasKeys(obj) {
    return Boolean(obj && Object.keys(obj).length > 0);
  }

  function notifyStatus(status) {
    if (typeof onStatusChange === 'function') {
      onStatusChange(status);
    }
  }

  function startSession({ attempt_id, lease_id, initial_seq = 0 }) {
    attemptId = attempt_id;
    leaseId = lease_id;
    nextSeq = Number.isInteger(initial_seq) && initial_seq >= 0 ? initial_seq : 0;
    dirtyPatch = {};
    pendingRetry = null;
    halted = false;
  }

  function stopSession() {
    halted = true;
    leaseId = null;
  }

  function queueAnswer(questionId, rawValue) {
    if (!questionId || typeof questionId !== 'string') {
      throw new Error('questionId must be a non-empty string');
    }
    dirtyPatch[questionId] = normalizeAnswerPatchValue(rawValue);
  }

  function queuePatch(patchObj) {
    const clean = sanitizeAnswerPatchObject(patchObj);
    if (!clean) return;
    for (const [k, v] of Object.entries(clean)) {
      dirtyPatch[k] = v;
    }
  }

  async function runLoop() {
    while (!halted && leaseId && attemptId && (pendingRetry !== null || hasKeys(dirtyPatch))) {
      if (pendingRetry === null) {
        const snapshot = { ...dirtyPatch };
        dirtyPatch = {};
        const seq = nextSeq;
        nextSeq += 1;
        pendingRetry = { seq, patch: snapshot };
      }

      const currentBatch = pendingRetry;
      notifyStatus('saving');
      try {
        const res = await sendSave({
          attempt_id: attemptId,
          lease_id: leaseId,
          save_seq: currentBatch.seq,
          answers: { ...currentBatch.patch },
        });
        // Succeeded: clear pendingRetry so the next iteration can send any newly coalesced dirtyPatch
        pendingRetry = null;
        if (res && res.attempt && res.attempt.status && res.attempt.status !== 'running') {
          halted = true;
          if (typeof onConflictOrTerminal === 'function') {
            onConflictOrTerminal(res);
          }
          return res;
        }
        if (!hasKeys(dirtyPatch)) {
          notifyStatus('saved');
        }
      } catch (err) {
        // Terminal lease/status errors halt the queue; transient errors keep pendingRetry intact
        const status = Number(err?.statusCode || err?.status || 0);
        if (status === 401 || status === 403 || status === 404 || status === 409) {
          halted = true;
          if (typeof onConflictOrTerminal === 'function') {
            onConflictOrTerminal(err);
          }
        } else {
          notifyStatus('offline');
        }
        throw err;
      }
    }
  }

  function flush() {
    if (inFlightPromise) {
      return inFlightPromise;
    }
    inFlightPromise = runLoop().finally(() => {
      inFlightPromise = null;
    });
    return inFlightPromise;
  }

  /**
   * Snapshot any unsent dirty answers (including any unconfirmed retry batch)
   * for flushing with an explicit `pause` or `submit` call.
   */
  function getUnflushedSnapshot() {
    const merged = {
      ...(pendingRetry ? pendingRetry.patch : {}),
      ...dirtyPatch,
    };
    if (!hasKeys(merged)) {
      return null;
    }
    const seq = pendingRetry ? pendingRetry.seq : nextSeq;
    return {
      save_seq: seq,
      answers: merged,
    };
  }

  function clearDirty() {
    dirtyPatch = {};
    pendingRetry = null;
  }

  function getState() {
    return {
      attempt_id: attemptId,
      lease_id: leaseId,
      next_seq: nextSeq,
      has_in_flight: Boolean(inFlightPromise),
      pending_retry: pendingRetry
        ? { seq: pendingRetry.seq, patch: { ...pendingRetry.patch } }
        : null,
      dirty_patch: { ...dirtyPatch },
      halted,
    };
  }

  return {
    startSession,
    stopSession,
    queueAnswer,
    queuePatch,
    flush,
    getUnflushedSnapshot,
    clearDirty,
    getState,
  };
}
