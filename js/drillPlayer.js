/**
 * Trendz Tracker — One-Question-at-a-Time Drill Player (js/drillPlayer.js)
 *
 * Pure state machine (zero DOM dependencies) for Phase 9a online Basics practice:
 * - Visits questions in order (0 .. n-1).
 * - Supports answering (`answer(val)` / `submitCurrent(val)`) and skipping (`skip()`).
 * - Any question skipped during the first pass is revisited in order at the end
 *   of the first pass (`isRevisitingSkipped === true`).
 * - Skipping a question during the skipped-questions pass leaves it unanswered (`null`)
 *   and advances to the next skipped question (finishing once all skipped questions
 *   have been revisited).
 * - Builds the canonical `answers` array (`string | null`, with `null` for unanswered).
 * - `finish()` is strictly idempotent: calling `finish()` a second time does nothing
 *   (returns `null` and never triggers `onFinish` twice).
 */

/**
 * Creates a new one-question-at-a-time drill player instance.
 *
 * @param {Array<object|string>} questions - List of question display objects or strings
 * @param {{ onFinish?: (answers: Array<string|null>) => void }} [options]
 */
export function createDrillPlayer(questions = [], options = {}) {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error('createDrillPlayer requires a non-empty questions array.');
  }

  const totalQuestions = questions.length;
  const questionList = questions.slice();
  const answers = new Array(totalQuestions).fill(null);

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
    if (!revisitingSkipped && skippedIndices.length > 0) {
      activeQueue = skippedIndices.slice();
      skippedIndices = [];
      queuePos = 0;
      revisitingSkipped = true;
      return;
    }

    // Either no questions were skipped in pass 1, or we finished the skipped review pass
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

    answers[idx] = trimmed.slice(0, 20);
    advanceCursor();
    return true;
  }

  /**
   * Skips the current question:
   * - During the initial pass, queues the question index to be revisited at the end.
   * - During the skipped-questions pass, leaves its answer as `null` and moves on.
   *
   * @returns {boolean} true if skipped, false if already finished
   */
  function skip() {
    if (finished) return false;
    const idx = getCurrentIndex();
    if (idx === null) return false;

    answers[idx] = null;
    if (!revisitingSkipped) {
      skippedIndices.push(idx);
    }

    advanceCursor();
    return true;
  }

  /**
   * Returns whether all passes (initial + skipped review) are complete or `finish()` was called.
   *
   * @returns {boolean}
   */
  function isFinished() {
    return finished;
  }

  /**
   * Returns a copy of the answers array (`null` for any unanswered question).
   *
   * @returns {Array<string|null>}
   */
  function getAnswers() {
    return answers.slice();
  }

  /**
   * Marks the set as finished and returns the final answers array on the FIRST call.
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
    const finalAnswers = answers.slice();
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
    const answeredCount = answers.filter((a) => a !== null).length;
    const unansweredCount = totalQuestions - answeredCount;
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
      unansweredCount,
      isFinished: finished,
      finishCommitted,
      answers: answers.slice(),
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
    finish,
    getState,
  };
}
