/**
 * Trendz Tracker — Pure To-Do Progress Display Helpers (js/todoProgress.js)
 *
 * Pure formatting helpers for rendering daily task progress on:
 * - Student Home (/pages/student.html)
 * - Admin Student Detail (/pages/student-detail.html)
 *
 * Strict rule:
 * - Never compute `done_count` or `done` in JavaScript; always read `done_count`,
 *   `required_count`, and `done` directly from the `todo_for(p_student)` RPC response.
 */

/**
 * Extracts numeric `done_count` and `required_count` from either `(doneCount, requiredCount)`
 * arguments or a single task object `{ done_count, required_count }`.
 *
 * @param {number|object} doneOrTask
 * @param {number} [requiredCount]
 * @returns {{ done: number, required: number }}
 */
function resolveCounts(doneOrTask, requiredCount) {
  let rawDone = doneOrTask;
  let rawReq = requiredCount;

  if (doneOrTask && typeof doneOrTask === 'object') {
    rawDone = doneOrTask.done_count;
    rawReq = doneOrTask.required_count;
  }

  const parsedReq = Number(rawReq);
  const required = Number.isFinite(parsedReq) && parsedReq >= 1 ? Math.floor(parsedReq) : 1;

  const parsedDone = Number(rawDone);
  const done = Number.isFinite(parsedDone) && parsedDone >= 0 ? Math.floor(parsedDone) : 0;

  return { done, required };
}

/**
 * Formats the per-task progress text `"d of r"`, clamping the displayed done count
 * to at most `required_count` (e.g. `"4 of 4"` even when 5 were done).
 *
 * @param {number|object} doneOrTask - `done_count` integer or task object `{ done_count, required_count }`
 * @param {number} [requiredCount=1] - `required_count` integer (1..50)
 * @returns {string} e.g. `"2 of 4"`, `"4 of 4"`
 */
export function progressText(doneOrTask, requiredCount = 1) {
  const { done, required } = resolveCounts(doneOrTask, requiredCount);
  const cappedDone = Math.min(done, required);
  return `${cappedDone} of ${required}`;
}

/**
 * Computes the progress bar percentage (`0` to `100`), capped at `100`.
 *
 * @param {number|object} doneOrTask - `done_count` integer or task object `{ done_count, required_count }`
 * @param {number} [requiredCount=1] - `required_count` integer (1..50)
 * @returns {number} Integer percentage in `0..100`
 */
export function percent(doneOrTask, requiredCount = 1) {
  const { done, required } = resolveCounts(doneOrTask, requiredCount);
  const cappedDone = Math.min(done, required);
  return Math.min(100, Math.max(0, Math.round((cappedDone / required) * 100)));
}

/**
 * Builds the header summary for a student's daily tasks (`"n of m tasks done today"`).
 * Strictly reads `task.done === true` from the database RPC response (`todo_for`);
 * never computes `done` from `done_count >= required_count` in JavaScript.
 *
 * @param {Array<{ done?: boolean }>} [tasks=[]]
 * @returns {{ done: number, total: number, text: string, toString: () => string }}
 */
export function summary(tasks = []) {
  const list = Array.isArray(tasks) ? tasks : [];
  const total = list.length;
  let done = 0;

  for (const task of list) {
    if (task && task.done === true) {
      done += 1;
    }
  }

  const text = `${done} of ${total} tasks done today`;
  return {
    done,
    total,
    text,
    toString() {
      return text;
    },
  };
}
