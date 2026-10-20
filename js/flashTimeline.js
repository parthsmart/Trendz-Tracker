/**
 * Trendz Tracker — Flash Anzan Pure Timing & Schedule Builder (js/flashTimeline.js)
 *
 * Builds a deterministic, drift-free schedule of millisecond offsets from the start
 * of the flashing sequence (`performance.now()` anchor):
 * - Each number stays visible for `speed_ms` milliseconds
 * - Followed by a constant blank interval of `FLASH_BLANK_MS` (80 ms)
 * - Ends with a terminal `{ type: 'done' }` event at `count * (speed_ms + 80)`
 *
 * Pure module with zero DOM or network dependencies (`node --test` compatible).
 */

export const FLASH_BLANK_MS = 80;

/**
 * Builds the ordered timeline of events for a single Flash Anzan question.
 *
 * @param {object|number} settings - Settings object containing `{ speed_ms, count }` (or `speed_ms` number)
 * @param {number} [countOverride] - Optional explicit count of numbers in the question (2 to 1000)
 * @returns {Array<{ type: 'number' | 'blank' | 'done', index: number, offsetMs: number, durationMs: number }>}
 */
export function buildTimeline(settings = {}, countOverride = undefined) {
  const speedMsRaw =
    typeof settings === 'number' ? settings : Number(settings?.speed_ms);
  const countRaw =
    countOverride !== undefined ? Number(countOverride) : Number(settings?.count);

  const speedMs =
    Number.isFinite(speedMsRaw) && speedMsRaw > 0 ? Math.round(speedMsRaw) : 1000;
  const count =
    Number.isFinite(countRaw) && countRaw >= 1 ? Math.floor(countRaw) : 0;

  if (count <= 0) {
    return [
      {
        type: 'done',
        index: 0,
        offsetMs: 0,
        durationMs: 0,
      },
    ];
  }

  const stepMs = speedMs + FLASH_BLANK_MS;
  const events = [];

  for (let i = 0; i < count; i++) {
    const numberStartMs = i * stepMs;
    const blankStartMs = numberStartMs + speedMs;

    events.push({
      type: 'number',
      index: i,
      offsetMs: numberStartMs,
      durationMs: speedMs,
    });

    events.push({
      type: 'blank',
      index: i,
      offsetMs: blankStartMs,
      durationMs: FLASH_BLANK_MS,
    });
  }

  events.push({
    type: 'done',
    index: count,
    offsetMs: count * stepMs,
    durationMs: 0,
  });

  return events;
}
