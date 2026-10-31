/**
 * Trendz Tracker — Flash Anzan Daily Task Matching & Query Helpers (js/flashTaskMatch.js)
 *
 * Pure, DOM-free and network-free helpers for Phase 14a:
 * - `matchesTask(settings, task)`: compares the setup screen's current settings
 *   against a Flash Anzan task's fixed settings (empty/null means "Any").
 *   NOTE: This is strictly for the live UI indicator on `/pages/flash.html`.
 *   Actual daily task completion (`done_count` / `done`) is ALWAYS computed
 *   by the database RPC `todo_for`.
 * - `parseFlashTaskQuery(search)`: reads and validates URL query parameters
 *   (`task=1`, `digits`, `count`, `speed`, `mode`), ignoring any out-of-range
 *   or malformed values.
 * - `applyTaskToSettings(baseSettings, task)`: returns a copy of `baseSettings`
 *   with any fixed task fields overriding the corresponding properties.
 */

function isUnsetValue(val) {
  if (val === null || val === undefined) return true;
  const str = String(val).trim();
  return str === '' || str.toLowerCase() === 'any';
}

/**
 * Pure comparison between a student's current Flash Anzan setup controls
 * (`{ digits, count, speed_ms, mode }`) and a task's fixed settings
 * (`{ flash_digits, flash_count, flash_speed_ms, flash_mode }` or
 * `{ digits, count, speed_ms, speed, mode }`).
 *
 * Returns `true` when every non-empty setting on `task` matches `settings`.
 *
 * @param {object} settings
 * @param {object} task
 * @returns {boolean}
 */
export function matchesTask(settings, task) {
  if (!settings || typeof settings !== 'object') return false;
  if (!task || typeof task !== 'object') return true;

  const reqDigits =
    task.flash_digits !== undefined
      ? task.flash_digits
      : task.task_flash_digits !== undefined
        ? task.task_flash_digits
        : task.digits;

  if (!isUnsetValue(reqDigits)) {
    if (Number(settings.digits) !== Number(reqDigits)) {
      return false;
    }
  }

  const reqCount =
    task.flash_count !== undefined
      ? task.flash_count
      : task.task_flash_count !== undefined
        ? task.task_flash_count
        : task.count;

  if (!isUnsetValue(reqCount)) {
    if (Number(settings.count) !== Number(reqCount)) {
      return false;
    }
  }

  const reqSpeedMs =
    task.flash_speed_ms !== undefined
      ? task.flash_speed_ms
      : task.task_flash_speed_ms !== undefined
        ? task.task_flash_speed_ms
        : task.speed_ms !== undefined
          ? task.speed_ms
          : task.speed;

  if (!isUnsetValue(reqSpeedMs)) {
    const curSpeedMs =
      settings.speed_ms !== undefined ? settings.speed_ms : settings.speed;
    if (Number(curSpeedMs) !== Number(reqSpeedMs)) {
      return false;
    }
  }

  const reqMode =
    task.flash_mode !== undefined
      ? task.flash_mode
      : task.task_flash_mode !== undefined
        ? task.task_flash_mode
        : task.mode;

  if (!isUnsetValue(reqMode)) {
    const cleanReqMode = String(reqMode).trim().toLowerCase();
    const cleanCurMode = String(settings.mode ?? '').trim().toLowerCase();
    if (cleanCurMode !== cleanReqMode) {
      return false;
    }
  }

  return true;
}

/**
 * Parses URL query parameters for `/pages/flash.html` (`task=1`, `digits`, `count`, `speed`, `mode`).
 * Validates each parameter against the Flash Anzan limits and ignores invalid ones.
 *
 * Ranges:
 * - `digits`: whole number `1` to `5`
 * - `count`: whole number `2` to `1000`
 * - `speed`: whole number `200` to `5000` in steps of `100` (milliseconds)
 * - `mode`: `'add'` or `'add_sub'`
 *
 * @param {string|URLSearchParams} search
 * @returns {{
 *   isTask: boolean,
 *   hasAnyParam: boolean,
 *   task: {
 *     flash_digits: number|null,
 *     flash_count: number|null,
 *     flash_speed_ms: number|null,
 *     flash_mode: string|null
 *   }
 * }}
 */
export function parseFlashTaskQuery(search = '') {
  const params =
    search instanceof URLSearchParams
      ? search
      : new URLSearchParams(typeof search === 'string' ? search : '');

  const isTask = params.get('task') === '1';

  let flash_digits = null;
  const rawDigits = params.get('digits');
  if (rawDigits !== null && /^\d+$/.test(rawDigits.trim())) {
    const d = Number(rawDigits.trim());
    if (Number.isInteger(d) && d >= 1 && d <= 5) {
      flash_digits = d;
    }
  }

  let flash_count = null;
  const rawCount = params.get('count');
  if (rawCount !== null && /^\d+$/.test(rawCount.trim())) {
    const c = Number(rawCount.trim());
    if (Number.isInteger(c) && c >= 2 && c <= 1000) {
      flash_count = c;
    }
  }

  let flash_speed_ms = null;
  const rawSpeed = params.get('speed');
  if (rawSpeed !== null && /^\d+$/.test(rawSpeed.trim())) {
    const ms = Number(rawSpeed.trim());
    if (Number.isInteger(ms) && ms >= 200 && ms <= 5000 && ms % 100 === 0) {
      flash_speed_ms = ms;
    }
  }

  let flash_mode = null;
  const rawMode = params.get('mode');
  if (rawMode !== null) {
    const m = rawMode.trim().toLowerCase();
    if (m === 'add' || m === 'add_sub') {
      flash_mode = m;
    }
  }

  const hasAnyParam =
    flash_digits !== null ||
    flash_count !== null ||
    flash_speed_ms !== null ||
    flash_mode !== null;

  return {
    isTask,
    hasAnyParam,
    task: {
      flash_digits,
      flash_count,
      flash_speed_ms,
      flash_mode,
    },
  };
}

/**
 * Applies any fixed fields from `task` onto `baseSettings`, leaving unset fields untouched.
 *
 * @param {object} baseSettings - `{ digits, count, speed_ms, mode }`
 * @param {object} task - `{ flash_digits, flash_count, flash_speed_ms, flash_mode }`
 * @returns {{ digits: number, count: number, speed_ms: number, mode: string }}
 */
export function applyTaskToSettings(baseSettings = {}, task = {}) {
  const next = { ...baseSettings };
  if (!task || typeof task !== 'object') return next;

  const d = task.flash_digits !== undefined ? task.flash_digits : task.digits;
  if (!isUnsetValue(d)) {
    next.digits = Number(d);
  }

  const c = task.flash_count !== undefined ? task.flash_count : task.count;
  if (!isUnsetValue(c)) {
    next.count = Number(c);
  }

  const ms =
    task.flash_speed_ms !== undefined
      ? task.flash_speed_ms
      : task.speed_ms !== undefined
        ? task.speed_ms
        : task.speed;
  if (!isUnsetValue(ms)) {
    next.speed_ms = Number(ms);
  }

  const m = task.flash_mode !== undefined ? task.flash_mode : task.mode;
  if (!isUnsetValue(m)) {
    next.mode = String(m).trim().toLowerCase();
  }

  return next;
}
