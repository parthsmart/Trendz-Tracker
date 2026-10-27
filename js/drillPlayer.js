/**
 * Trendz Tracker — One-Question-at-a-Time Drill Player (js/drillPlayer.js)
 *
 * Pure state machine (zero DOM dependencies) for online Basics practice:
 * - Visits questions in order (0 .. n-1).
 * - Supports answering (`answer(val)` / `submitCurrent(val)`) and skipping (`skip()`).
 * - In Phase 10g timed/unlimited pool mode (`revisitSkipped: false`):
 *   - Skipping a question counts as attempted and wrong (`null` in `reachedAnswers`)
 *     and advances to the next question in the pool without revisiting at the end.
 *   - `getReachedAnswers()` returns only the questions the student reached and
 *     answered/skipped in order (`0 .. attempted - 1`), excluding the question
 *     currently on screen when time runs out or when Finish is clicked.
 * - In legacy fixed-set mode (`revisitSkipped: true`, default when `mode` is not set):
 *   - Skipped questions are revisited in order at the end of the first pass.
 * - `finish()` is strictly idempotent: calling `finish()` a second time does nothing
 *   (returns `null` and never triggers `onFinish` twice).
 */

/**
 * Pure countdown timer helper computed from a fixed end timestamp (`endTimeMs`)
 * and a clock reading (`nowMs`, e.g. `performance.now()`).
 *
 * @param {number} endTimeMs - Target end time in milliseconds
 * @param {number} nowMs - Current clock reading in milliseconds
 * @param {number|null} [totalSeconds=null] - Optional total duration in seconds for progress bar %
 * @returns {{
 *   remainingMs: number,
 *   remainingSeconds: number,
 *   exactRemainingSeconds: number,
 *   expired: boolean,
 *   progressPercent: number
 * }}
 */
export function computeRemainingSeconds(endTimeMs, nowMs, totalSeconds = null) {
  const end = Number(endTimeMs) || 0;
  const now = Number(nowMs) || 0;
  const remainingMs = Math.max(0, end - now);
  const exactRemainingSeconds = remainingMs / 1000;
  const remainingSeconds = Math.max(0, Math.ceil(exactRemainingSeconds));
  const expired = now >= end;

  let progressPercent = 0;
  const totalMs = Number(totalSeconds) > 0 ? Number(totalSeconds) * 1000 : 0;
  if (totalMs > 0) {
    progressPercent = Math.max(0, Math.min(100, (remainingMs / totalMs) * 100));
  }

  return {
    remainingMs,
    remainingSeconds,
    exactRemainingSeconds,
    expired,
    progressPercent,
    progressFraction: progressPercent / 100,
  };
}

/**
 * Convenience wrapper returning the integer remaining seconds (0 when expired).
 *
 * @param {number} endTimeMs
 * @param {number} nowMs
 * @returns {number}
 */
export function getRemainingSeconds(endTimeMs, nowMs) {
  return computeRemainingSeconds(endTimeMs, nowMs).remainingSeconds;
}

/**
 * Creates a new one-question-at-a-time drill player instance.
 *
 * @param {Array<object|string>} questions - List of question display objects or strings
 * @param {{
 *   onFinish?: (answers: Array<string|null>) => void,
 *   revisitSkipped?: boolean,
 *   mode?: 'timed' | 'unlimited'
 * }} [options]
 */
export function createDrillPlayer(questions = [], options = {}) {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error('createDrillPlayer requires a non-empty questions array.');
  }

  const totalQuestions = questions.length;
  const questionList = questions.slice();
  const answers = new Array(totalQuestions).fill(null);
  const reachedAnswers = [];

  const isPoolMode =
    options?.revisitSkipped === false ||
    options?.mode === 'timed' ||
    options?.mode === 'unlimited';

  // First pass visits 0 .. totalQuestions - 1 in order
  let activeQueue = Array.from({ length: totalQuestions }, (_, i) => i);
  let skippedIndices = [];
  let queuePos = 0;
  let revisitingSkipped = false;
  let finished = false;
  let finishCommitted = false;

  const onFinishCallback =
    options && typeof options.onFinish === 'function' ? options.onFinish : null;

  /**
   * Internal helper to advance the cursor within the current pass,
   * transitioning to the skipped-questions pass if needed or marking the set finished.
   */
  function advanceCursor() {
    if (finished) return;

    queuePos += 1;

    if (queuePos < activeQueue.length) {
      return;
    }

    // Reached the end of the current pass
    if (!isPoolMode && !revisitingSkipped && skippedIndices.length > 0) {
      activeQueue = skippedIndices.slice();
      skippedIndices = [];
      queuePos = 0;
      revisitingSkipped = true;
      return;
    }

    // Either pool ran out, no questions were skipped in pass 1, or skipped review finished
    finished = true;
  }

  /**
   * Returns the 0-based index of the current question, or null when finished.
   *
   * @returns {number|null}
   */
  function getCurrentIndex() {
    if (finished || queuePos >= activeQueue.length) return null;
    return activeQueue[queuePos];
  }

  /**
   * Returns the current question object/string, or null when finished.
   *
   * @returns {object|string|null}
   */
  function getCurrentQuestion() {
    const idx = getCurrentIndex();
    return idx === null ? null : questionList[idx];
  }

  /**
   * Records an answer for the current question and advances to the next question.
   * If the provided value is null or empty/whitespace-only, delegates to `skip()`.
   *
   * @param {string|number|null} rawValue
   * @returns {boolean} true if state advanced, false if already finished
   */
  function answer(rawValue) {
    if (finished) return false;
    const idx = getCurrentIndex();
    if (idx === null) return false;

    const trimmed =
      rawValue === null || rawValue === undefined ? '' : String(rawValue).trim();

    if (trimmed === '') {
      return skip();
    }

    const cleanAnswer = trimmed.slice(0, 20);
    answers[idx] = cleanAnswer;
    if (isPoolMode) {
      reachedAnswers.push(cleanAnswer);
    } else if (!revisitingSkipped && reachedAnswers.length === idx) {
      reachedAnswers.push(cleanAnswer);
    } else if (idx < reachedAnswers.length) {
      reachedAnswers[idx] = cleanAnswer;
    }

    advanceCursor();
    return true;
  }

  /**
   * Skips the current question:
   * - In pool mode (`revisitSkipped: false`), records `null` in `reachedAnswers`
   *   (counts as attempted and wrong) and moves immediately to the next question.
   * - In legacy fixed-set mode, queues the question index during pass 1 to revisit at the end.
   *
   * @returns {boolean} true if skipped, false if already finished
   */
  function skip() {
    if (finished) return false;
    const idx = getCurrentIndex();
    if (idx === null) return false;

    answers[idx] = null;
    if (isPoolMode) {
      reachedAnswers.push(null);
    } else if (!revisitingSkipped) {
      skippedIndices.push(idx);
      if (reachedAnswers.length === idx) {
        reachedAnswers.push(null);
      }
    }

    advanceCursor();
    return true;
  }

  /**
   * Returns whether all passes (or the pool) are complete or `finish()` was called.
   *
   * @returns {boolean}
   */
  function isFinished() {
    return finished;
  }

  /**
   * Returns the reached answers array in order (`0 .. attempted - 1`),
   * excluding the question currently on screen.
   *
   * @returns {Array<string|null>}
   */
  function getReachedAnswers() {
    return reachedAnswers.slice();
  }

  /**
   * Returns the number of questions answered or skipped so far (`attempted`).
   *
   * @returns {number}
   */
  function getAttemptedCount() {
    return isPoolMode
      ? reachedAnswers.length
      : answers.filter((a) => a !== null).length;
  }

  /**
   * Returns the number of non-skipped (answered) questions so far.
   *
   * @returns {number}
   */
  function getAnsweredCount() {
    return isPoolMode
      ? reachedAnswers.filter((a) => a !== null).length
      : answers.filter((a) => a !== null).length;
  }

  /**
   * Returns a copy of the answers array:
   * - In pool mode (`revisitSkipped: false`), returns the reached answers prefix (`length = attempted`).
   * - In fixed-set mode, returns the full `totalQuestions` array (`null` for unanswered).
   *
   * @returns {Array<string|null>}
   */
  function getAnswers() {
    return isPoolMode ? reachedAnswers.slice() : answers.slice();
  }

  /**
   * Marks the round as finished and returns the final answers array on the FIRST call.
   * Subsequent calls to `finish()` do nothing and return `null` (idempotent guard
   * preventing duplicate submissions).
   *
   * @returns {Array<string|null>|null}
   */
  function finish() {
    if (finishCommitted) {
      return null;
    }
    finished = true;
    finishCommitted = true;
    const finalAnswers = getAnswers();
    if (onFinishCallback) {
      onFinishCallback(finalAnswers);
    }
    return finalAnswers;
  }

  /**
   * Returns a snapshot of current progress for UI rendering.
   */
  function getState() {
    const currentIndex = getCurrentIndex();
    const answeredCount = isPoolMode
      ? reachedAnswers.length
      : answers.filter((a) => a !== null).length;
    const unansweredCount = Math.max(0, totalQuestions - answeredCount);
    return {
      total: totalQuestions,
      currentIndex,
      currentNumber: currentIndex === null ? null : currentIndex + 1,
      currentQuestion: getCurrentQuestion(),
      isRevisitingSkipped: revisitingSkipped,
      remainingInCurrentPass: finished ? 0 : Math.max(0, activeQueue.length - queuePos),
      skippedPendingCount: revisitingSkipped
        ? Math.max(0, activeQueue.length - queuePos)
        : skippedIndices.length,
      answeredCount,
      attemptedCount: reachedAnswers.length,
      unansweredCount,
      isFinished: finished,
      finishCommitted,
      answers: getAnswers(),
      reachedAnswers: reachedAnswers.slice(),
    };
  }

  return {
    total: totalQuestions,
    getCurrentIndex,
    getCurrentQuestion,
    answer,
    submitCurrent: answer,
    skip,
    skipCurrent: skip,
    isFinished,
    getAnswers,
    getReachedAnswers,
    getAttemptedCount,
    getAnsweredCount,
    finish,
    getState,
  };
}
