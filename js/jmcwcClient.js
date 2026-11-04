export function formatJmcwcQuestionPrompt(question, fallback = '') {
  const prompt = typeof question.prompt === 'string'
    ? question.prompt : question.prompt?.text || question.prompt?.expression || fallback;
  // Older frozen Next Cubes attempts contain a wording typo; their cube answer
  // and marks are already correct. Correct presentation without altering saved data.
  return (question.category_key || question.category_slug) === 'next_cube'
    ? prompt.replace(/^Next perfect square strictly greater than /, 'Next perfect cube strictly greater than ')
    : prompt;
}

/**
 * Trendz Tracker — Phase 17c: Browser-Safe JMCWC Practice Controller & Pure State Helpers (js/jmcwcClient.js)
 *
 * Pure, browser-safe module with ZERO server imports (never imports generators, graders, blueprints,
 * or service-role credentials). Coordinates:
 * 1. Landing page state: assigned group label, unassigned block message, 3-slot flat round cap,
 *    unfinished flat round cards, category-wise selector with optional target and neutral comparison,
 *    and manual category target lookup.
 * 2. Runner state: 23-category / 230-question flat navigation or 10-question category navigation,
 *    question numbering, marks, answered/unanswered indicators, NO marked-for-review feature,
 *    accessible input configurations for all 14 answer types preserving raw text & decimal precision,
 *    and keyboard navigation.
 * 3. Timing, Pause, Saving & Local Recovery:
 *    - Monotonic display timer derived from server `active_ms` + elapsed time since last server sync.
 *    - Immediate question/input hiding on explicit Pause, tab hidden (`visibilitychange`), `pagehide`,
 *      lease loss (`409 LEASE_MISMATCH`), `paused`/`grading`/`submitted` responses, or 2-hour flat expiry.
 *    - Best-effort `fetch(..., { keepalive: true })` with `Authorization: Bearer <token>` header
 *      (never tokens in URLs), respecting the 48 KB keepalive body cap via `buildPauseKeepalivePayload`.
 *    - Save status indicator: `Saving`, `Saved`, `Offline—paused`.
 *    - Scoped `localStorage` unsent-answer recovery (`trendz_jmcwc_unsent_v1:<userId>:<attemptId>`),
 *      cleared on sign-out, account change, or submission, with Recover/Discard prompt on conflict,
 *      and never restored into submitted or expired attempts.
 * 4. Review & History formatting:
 *    - Earned / frozen attempt `max_marks`, partial marks, correct/partial/wrong/skipped counts,
 *      active time, submitted answers, explanations, and `"One valid answer"` label when alternatives exist.
 *    - `Manual` / `Online` history integration without merging weighted marks into legacy accuracy,
 *      Points leaderboard, or weekly-test scores.
 */

import {
  JMCWC_MAX_PAUSE_BODY_BYTES,
  buildPauseKeepalivePayload,
  createJmcwcSaveQueue,
  normalizeAnswerPatchValue,
} from '../shared/jmcwcSaveQueue.js';

export const JMCWC_FLAT_DURATION_MS = 7_200_000; // 2 hours of ACTIVE time
export const JMCWC_FLAT_ROUND_LIMIT_MS = JMCWC_FLAT_DURATION_MS;
export const JMCWC_FLAT_CAP_LIMIT = 3;
export const JMCWC_MAX_UNFINISHED_FLAT = JMCWC_FLAT_CAP_LIMIT;
export const JMCWC_HEARTBEAT_INTERVAL_MS = 10_000; // 10 seconds (< 25s server tick threshold)
export const JMCWC_UNSENT_STORAGE_PREFIX = 'trendz_jmcwc_unsent_v1:';
export const JMCWC_LAST_USER_STORAGE_KEY = 'trendz_jmcwc_active_user_v1';

export const JMCWC_GROUP_LABELS = Object.freeze({
  junior1: 'Junior 1',
  junior2: 'Junior 2',
  senior: 'Senior',
});

export const JMCWC_UNASSIGNED_MESSAGE = 'Ask your teacher to assign your JMCWC group.';
export const JMCWC_UNASSIGNED_GROUP_MESSAGE = JMCWC_UNASSIGNED_MESSAGE;
export const JMCWC_FLAT_CAP_MESSAGE =
  'You have three unfinished flat rounds. Complete one before starting another.';
export const JMCWC_UNFINISHED_GROUP_CHANGE_ERROR =
  "Complete this student's unfinished simulator attempts before changing group.";

export const DAY_OF_WEEK_OPTIONS = Object.freeze([
  { value: 'Sunday', short: 'Sun', index: 0 },
  { value: 'Monday', short: 'Mon', index: 1 },
  { value: 'Tuesday', short: 'Tue', index: 2 },
  { value: 'Wednesday', short: 'Wed', index: 3 },
  { value: 'Thursday', short: 'Thu', index: 4 },
  { value: 'Friday', short: 'Fri', index: 5 },
  { value: 'Saturday', short: 'Sat', index: 6 },
]);

/**
 * Admin-only suggestion table mapping normalized legacy Round category names (`public.categories` where `section = 'round'`)
 * to JMCWC `category_key`. Never used to apply targets automatically; an admin must explicitly confirm and save `legacy_category_id`.
 */
export const ADMIN_SUGGESTED_LEGACY_NAME_TO_JMCWC_KEY = Object.freeze({
  add: 'addition',
  addition: 'addition',
  sub: 'subtraction',
  subtraction: 'subtraction',
  mix: 'mixed',
  'add & sub': 'mixed',
  mult: 'multiplication',
  multiplication: 'multiplication',
  div: 'division',
  division: 'division',
  brac: 'brackets',
  brackets: 'brackets',
  'prime factors': 'prime_factors',
  'hcf and lcm': 'hcf_lcm',
  'hcf & lcm': 'hcf_lcm',
  'frac +': 'frac_add',
  'frac -': 'frac_sub',
  'frac *': 'frac_mul',
  'frac ÷': 'frac_div',
  'frac /': 'frac_div',
  approximation: 'approximation',
  remainder: 'remainder',
  ratio: 'ratio',
  'square root': 'sq_root',
  'sq. root': 'sq_root',
  'd.p': 'decimal_point',
  'd.p.': 'decimal_point',
  'decimal point': 'decimal_point',
  'next square': 'next_sq',
  'next sq.': 'next_sq',
  'cube root': 'cb_root',
  'cb. root': 'cb_root',
  'next cube': 'next_cb',
  'next cb.': 'next_cb',
  calendar: 'calendar',
  'time elapsed': 'time_elapsed',
  'sum of squares': 'sum_squares',
});

/**
 * Formats a JMCWC group key (`junior1`, `junior2`, `senior`) as a non-editable display label.
 */
export function formatJmcwcGroupLabel(groupKey) {
  if (!groupKey || typeof groupKey !== 'string') return 'Unassigned';
  const clean = groupKey.trim().toLowerCase();
  return JMCWC_GROUP_LABELS[clean] || groupKey;
}

/**
 * Canonical 23 JMCWC Category titles matching public.jmcwc_categories.
 */
export const JMCWC_CATEGORY_TITLES = Object.freeze({
  addition: 'Integer addition',
  subtraction: 'Integer subtraction',
  mixed: 'Mixed addition and subtraction',
  multiplication: 'Integer multiplication',
  division: 'Integer division',
  brackets: 'Brackets',
  prime_factors: 'Prime factorisation',
  hcf_lcm: 'HCF and LCM',
  fraction_add: 'Fraction addition',
  fraction_sub: 'Fraction subtraction',
  fraction_mul: 'Fraction multiplication',
  fraction_div: 'Fraction division',
  approximation: 'Approximations',
  remainder: 'Remainders',
  ratio: 'Ratios',
  square_root: 'Perfect square roots',
  inexact_square_root: 'Inexact square roots',
  next_square: 'Next squares',
  cube_root: 'Exact cube roots',
  next_cube: 'Next cubes',
  calendar: 'Calendars',
  elapsed_time: 'Elapsed time',
  sum_squares: 'Sums of squares',
});

/**
 * Returns a human-readable student-facing category title given an internal category key.
 */
export function formatJmcwcCategoryTitle(catKey, categoriesList = []) {
  if (!catKey || typeof catKey !== 'string') return 'Category';
  const cleanKey = catKey.trim().toLowerCase();
  if (Array.isArray(categoriesList)) {
    const found = categoriesList.find((c) => (c.key || c.id) === cleanKey);
    if (found && (found.label || found.display_name || found.title)) {
      return found.label || found.display_name || found.title;
    }
  }
  if (JMCWC_CATEGORY_TITLES[cleanKey]) {
    return JMCWC_CATEGORY_TITLES[cleanKey];
  }
  return cleanKey.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
}

/**
 * Formats milliseconds into `H:MM:SS` or `M:SS` for timers and cards.
 */
export function formatActiveDurationMs(ms, { alwaysHours = false } = {}) {
  const safeMs = Math.max(0, Math.floor(Number(ms) || 0));
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (alwaysHours || hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Formats seconds into `M:SS` or `H:MM:SS`.
 */
export function formatDurationSeconds(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) {
    return '—';
  }
  return formatActiveDurationMs(Math.max(0, Math.round(Number(seconds) * 1000)));
}

/**
 * Builds a neutral comparison between actual time and optional category target.
 * Target never forces stopping/submission or creates a penalty.
 *
 * @param {number} actualMs
 * @param {number|null|undefined} targetSeconds
 */
export function formatNeutralTargetComparison(actualMs, targetSeconds) {
  const actualSec = Math.max(0, Math.round((Number(actualMs) || 0) / 1000));
  const actualFormatted = formatDurationSeconds(actualSec);

  if (targetSeconds === null || targetSeconds === undefined || !(Number(targetSeconds) > 0)) {
    return {
      hasTarget: false,
      actualSeconds: actualSec,
      targetSeconds: null,
      deltaSeconds: null,
      actualText: actualFormatted,
      targetText: 'No target set',
      comparisonText: `Actual time: ${actualFormatted}`,
    };
  }

  const targetSec = Math.round(Number(targetSeconds));
  const targetFormatted = formatDurationSeconds(targetSec);
  const delta = actualSec - targetSec;

  let deltaLabel = 'Matches target';
  if (delta < 0) {
    deltaLabel = `${formatDurationSeconds(Math.abs(delta))} under target`;
  } else if (delta > 0) {
    deltaLabel = `${formatDurationSeconds(delta)} over target`;
  }

  return {
    hasTarget: true,
    actualSeconds: actualSec,
    targetSeconds: targetSec,
    deltaSeconds: delta,
    actualText: actualFormatted,
    targetText: targetFormatted,
    comparisonText: `Actual: ${actualFormatted} vs Target: ${targetFormatted} (${deltaLabel})`,
  };
}

/**
 * Resolves the configured optional target (in seconds) for a legacy manual Round category
 * (`public.categories` row) strictly via the explicitly configured `jmcwc_categories.legacy_category_id` mapping.
 * An unmapped category never silently receives a guessed target by name.
 */
export function resolveManualCategoryTargetSeconds(
  legacyCategory,
  jmcwcCategories = [],
  jmcwcTargets = {}
) {
  if (!legacyCategory || !jmcwcTargets || typeof jmcwcTargets !== 'object') {
    return null;
  }
  const isStringOrNumber = typeof legacyCategory === 'string' || typeof legacyCategory === 'number';
  const legacyId = isStringOrNumber
    ? String(legacyCategory).trim()
    : legacyCategory.id
      ? String(legacyCategory.id).trim()
      : null;

  if (!legacyId || !Array.isArray(jmcwcCategories)) {
    return null;
  }

  const mapped = jmcwcCategories.find(
    (c) => c && c.legacy_category_id && String(c.legacy_category_id).trim() === legacyId
  );
  const catKey = mapped ? mapped.key || mapped.id : null;
  if (catKey && jmcwcTargets[catKey] > 0) {
    return Number(jmcwcTargets[catKey]);
  }

  return null;
}

/**
 * Computes the monotonic display timer state from the authoritative server `active_ms`
 * and monotonic clock elapsed since the last server response.
 */
export function computeMonotonicTimerState({
  mode = 'flat',
  status = 'paused',
  baseActiveMs = 0,
  syncedAtMonoMs = null,
  nowMonoMs = 0,
  targetSeconds = null,
} = {}) {
  const safeBase = Math.max(0, Number(baseActiveMs) || 0);
  let currentActiveMs = safeBase;

  if (status === 'running' && syncedAtMonoMs !== null && Number.isFinite(Number(syncedAtMonoMs))) {
    const delta = Math.max(0, Number(nowMonoMs) - Number(syncedAtMonoMs));
    currentActiveMs = safeBase + delta;
  }

  if (mode === 'flat') {
    const clampedActiveMs = Math.min(JMCWC_FLAT_DURATION_MS, currentActiveMs);
    const remainingMs = Math.max(0, JMCWC_FLAT_DURATION_MS - clampedActiveMs);
    const expired = clampedActiveMs >= JMCWC_FLAT_DURATION_MS;
    const activeText = formatActiveDurationMs(clampedActiveMs, { alwaysHours: true });
    const remainingText = formatActiveDurationMs(remainingMs, { alwaysHours: true });
    return {
      mode: 'flat',
      activeMs: clampedActiveMs,
      elapsedActiveMs: clampedActiveMs,
      remainingMs,
      expired,
      activeText,
      formattedElapsed: activeText,
      remainingText,
      formattedRemaining: remainingText,
      targetComparison: null,
    };
  }

  const activeText = formatActiveDurationMs(currentActiveMs, { alwaysHours: false });
  return {
    mode: 'category',
    activeMs: currentActiveMs,
    elapsedActiveMs: currentActiveMs,
    remainingMs: null,
    expired: false,
    activeText,
    formattedElapsed: activeText,
    remainingText: null,
    formattedRemaining: activeText,
    targetComparison: formatNeutralTargetComparison(currentActiveMs, targetSeconds),
  };
}

/**
 * Builds the landing page view-model from the server `status` response.
 */
export function buildLandingPageViewModel(statusPayload = {}, extraAttempts = null) {
  const rawGroup = statusPayload?.group_key ?? statusPayload?.assigned_group ?? null;
  const assigned = Boolean(
    (statusPayload?.assigned !== false && rawGroup) ||
      (statusPayload?.assigned === true && rawGroup)
  );
  const groupKey = assigned ? rawGroup : null;
  const groupLabel = formatJmcwcGroupLabel(groupKey);
  const paperAvailable = Boolean(
    (statusPayload?.paper_available !== false && statusPayload?.paper) ||
      statusPayload?.paper_available === true
  );
  const attempts = Array.isArray(extraAttempts)
    ? extraAttempts
    : Array.isArray(statusPayload?.attempts)
      ? statusPayload.attempts
      : [];
  const rawCategories = Array.isArray(statusPayload?.categories) ? statusPayload.categories : [];
  const targets =
    statusPayload?.targets && typeof statusPayload.targets === 'object'
      ? statusPayload.targets
      : {};

  const paperSections = Array.isArray(statusPayload?.paper?.sections)
    ? statusPayload.paper.sections
    : Array.isArray(statusPayload?.paper?.spec?.sections)
      ? statusPayload.paper.spec.sections
      : [];

  const rawPaperQcount = Number(
    statusPayload?.paper?.total_questions ??
    statusPayload?.paper?.spec?.total_questions ??
    statusPayload?.paper?.question_count ??
    statusPayload?.paper?.spec?.question_count
  );

  const sectionsQcountSum = paperSections.reduce((acc, s) => {
    const count =
      Number(s?.question_count) ||
      (Array.isArray(s?.questions) ? s.questions.length : 0) ||
      (Array.isArray(s?.slots) ? s.slots.length : 0);
    return acc + count;
  }, 0);

  const paperQuestionCount =
    rawPaperQcount > 0
      ? rawPaperQcount
      : sectionsQcountSum > 0
        ? sectionsQcountSum
        : null;

  const categories = rawCategories.map((c, idx) => {
    const key = c.key || c.id || c.category_slug || `cat_${idx + 1}`;
    const targetSec = targets[key] > 0 ? Number(targets[key]) : null;
    const matchedSec = paperSections.find((s) => (s.key || s.category_key) === key);
    const matchedCount =
      (matchedSec && Number(matchedSec.question_count) > 0 ? Number(matchedSec.question_count) : null) ??
      (matchedSec && Array.isArray(matchedSec.questions) && matchedSec.questions.length > 0 ? matchedSec.questions.length : null) ??
      (matchedSec && Array.isArray(matchedSec.slots) && matchedSec.slots.length > 0 ? matchedSec.slots.length : null) ??
      (Number(c.question_count) > 0 ? Number(c.question_count) : null) ??
      null;
    const displayName = formatJmcwcCategoryTitle(key, [c]);
    return {
      ...c,
      key,
      id: key,
      category_slug: key,
      label: displayName,
      display_name: displayName,
      position: c.position ?? c.section_order ?? idx + 1,
      section_order: c.section_order ?? c.position ?? idx + 1,
      target_seconds: targetSec,
      target_formatted: targetSec ? formatDurationSeconds(targetSec) : null,
      question_count: matchedCount,
    };
  });

  const unfinishedFlatAttempts = attempts.filter(
    (a) => a && a.mode === 'flat' && a.status !== 'submitted'
  );
  const unfinishedCategoryAttempts = attempts.filter(
    (a) => a && a.mode === 'category' && a.status !== 'submitted'
  );
  const submittedAttempts = attempts.filter((a) => a && a.status === 'submitted');

  const unfinishedFlatCount = unfinishedFlatAttempts.length;
  const flatCapReached = unfinishedFlatCount >= JMCWC_FLAT_CAP_LIMIT;
  const canStartNewFlat = assigned && paperAvailable && !flatCapReached;
  const canStartCategory = assigned && paperAvailable && categories.length > 0;

  let flatDisabledReason = null;
  if (!assigned) {
    flatDisabledReason = JMCWC_UNASSIGNED_MESSAGE;
  } else if (!paperAvailable) {
    flatDisabledReason =
      statusPayload?.message || 'Online practice is currently unavailable while papers await publication.';
  } else if (flatCapReached) {
    flatDisabledReason = JMCWC_FLAT_CAP_MESSAGE;
  }

  const unfinishedFlatCards = unfinishedFlatAttempts.map((att) => {
    const activeMs = Math.max(0, Number(att.active_ms) || 0);
    const remainingMs = Math.max(0, JMCWC_FLAT_DURATION_MS - activeMs);
    const answeredCount = Math.max(0, Number(att.answered_count) || 0);
    const questionCount =
      Number(att.question_count) ||
      paperQuestionCount ||
      (Array.isArray(att.questions) ? att.questions.length : null) ||
      230;
    const activeTimeFormatted = formatActiveDurationMs(activeMs, { alwaysHours: true });
    const remainingTimeFormatted = formatActiveDurationMs(remainingMs, { alwaysHours: true });
    return {
      id: att.id,
      created_at: att.created_at,
      started_at: att.created_at || att.started_at,
      status: att.status,
      answered_count: answeredCount,
      question_count: questionCount,
      answered_label: `${answeredCount} / ${questionCount} answered`,
      active_ms: activeMs,
      active_time_label: activeTimeFormatted,
      active_time_formatted: activeTimeFormatted,
      remaining_ms: remainingMs,
      remaining_time_label: remainingTimeFormatted,
      remaining_time_formatted: remainingTimeFormatted,
    };
  });

  const catMap = new Map(categories.map((c) => [c.key, c.display_name]));
  const unfinishedCategoryCards = unfinishedCategoryAttempts.map((att) => {
    const activeMs = Math.max(0, Number(att.active_ms) || 0);
    const answeredCount = Math.max(0, Number(att.answered_count) || 0);
    const catKey = att.category_key || att.category_id;
    const catSec = paperSections.find((s) => (s.key || s.category_key) === catKey);
    const questionCount =
      Number(att.question_count) ||
      Number(catSec?.question_count) ||
      (Array.isArray(att.questions) ? att.questions.length : null) ||
      10;
    return {
      id: att.id,
      created_at: att.created_at,
      started_at: att.created_at || att.started_at,
      status: att.status,
      category_key: catKey,
      category_name: catMap.get(catKey) || catKey || 'Category Practice',
      answered_count: answeredCount,
      question_count: questionCount,
      active_ms: activeMs,
      active_time_formatted: formatActiveDurationMs(activeMs, { alwaysHours: false }),
    };
  });

  return {
    assigned,
    hasGroup: assigned,
    groupKey,
    groupLabel,
    unassignedMessage: assigned ? null : JMCWC_UNASSIGNED_MESSAGE,
    paperAvailable,
    hasPublishedPaper: paperAvailable,
    paperUnavailableMessage: !paperAvailable
      ? statusPayload?.message || 'Online practice paper for your group is not published yet.'
      : null,
    paper: statusPayload?.paper || null,
    totalPaperQuestions: paperQuestionCount,
    paperSections,
    statusMessage: statusPayload?.message || null,
    unfinishedFlatCount,
    flatCapLimit: JMCWC_FLAT_CAP_LIMIT,
    maxUnfinishedFlatRounds: JMCWC_FLAT_CAP_LIMIT,
    flatCapReached,
    canStartNewFlat,
    canStartCategory,
    flatDisabledReason,
    newFlatDisabledReason: flatDisabledReason,
    unfinishedFlatCards,
    unfinishedCategoryAttempts,
    unfinishedCategoryCards,
    submittedAttempts,
    categories,
    targets,
  };
}

// ============================================================================
// Scoped Local Unsent-Answer Recovery (`localStorage`)
// ============================================================================

function getSafeStorage(customStorage = null) {
  if (customStorage) return customStorage;
  if (typeof localStorage !== 'undefined') return localStorage;
  return null;
}

export function getUnsentRecoveryStorageKey(userId, attemptId) {
  if (!userId || !attemptId) return null;
  return `${JMCWC_UNSENT_STORAGE_PREFIX}${String(userId).trim()}:${String(attemptId).trim()}`;
}

/**
 * Saves unsent dirty answers to `localStorage` scoped strictly by `userId` and `attemptId`.
 */
export function saveLocalUnsentRecovery(userId, attemptId, patchObj, storage = null) {
  const store = getSafeStorage(storage);
  const key = getUnsentRecoveryStorageKey(userId, attemptId);
  if (!store || !key) return false;

  if (!patchObj || typeof patchObj !== 'object' || Object.keys(patchObj).length === 0) {
    try {
      store.removeItem(key);
    } catch {
      // Ignore storage errors
    }
    return false;
  }

  try {
    store.setItem(
      key,
      JSON.stringify({
        user_id: String(userId),
        attempt_id: String(attemptId),
        updated_at: new Date().toISOString(),
        answers: { ...patchObj },
      })
    );
    store.setItem(JMCWC_LAST_USER_STORAGE_KEY, String(userId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads local unsent answers for a specific `(userId, attemptId)`.
 * Never returns data belonging to a different user or attempt.
 */
export function loadLocalUnsentRecovery(userId, attemptId, storage = null) {
  const store = getSafeStorage(storage);
  const key = getUnsentRecoveryStorageKey(userId, attemptId);
  if (!store || !key) return null;

  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      parsed.user_id !== String(userId) ||
      parsed.attempt_id !== String(attemptId) ||
      !parsed.answers ||
      typeof parsed.answers !== 'object' ||
      Array.isArray(parsed.answers)
    ) {
      store.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Clears local unsent answers for a specific `(userId, attemptId)` (e.g. on submission or discard).
 */
export function clearLocalUnsentForAttempt(userId, attemptId, storage = null) {
  const store = getSafeStorage(storage);
  const key = getUnsentRecoveryStorageKey(userId, attemptId);
  if (!store || !key) return;
  try {
    store.removeItem(key);
  } catch {
    // Ignore storage errors
  }
}

/**
 * Clears ALL JMCWC local unsent recovery entries in `localStorage`
 * (or all entries for a specific user / on sign-out / on account change).
 */
export function clearAllJmcwcLocalRecovery({ onlyOtherUsersExcept = null, storage = null } = {}) {
  const store = getSafeStorage(storage);
  if (!store) return 0;

  let removed = 0;
  try {
    const keysToDelete = [];
    for (let i = 0; i < store.length; i += 1) {
      const k = store.key(i);
      if (!k || !k.startsWith(JMCWC_UNSENT_STORAGE_PREFIX)) continue;
      if (onlyOtherUsersExcept) {
        const expectedPrefix = `${JMCWC_UNSENT_STORAGE_PREFIX}${String(onlyOtherUsersExcept).trim()}:`;
        if (k.startsWith(expectedPrefix)) continue;
      }
      keysToDelete.push(k);
    }
    for (const k of keysToDelete) {
      store.removeItem(k);
      removed += 1;
    }
    if (!onlyOtherUsersExcept) {
      store.removeItem(JMCWC_LAST_USER_STORAGE_KEY);
    } else {
      store.setItem(JMCWC_LAST_USER_STORAGE_KEY, String(onlyOtherUsersExcept).trim());
    }
  } catch {
    // Ignore storage iteration errors
  }
  return removed;
}

/**
 * Enforces account-change cleanup: if the currently authenticated user differs from the
 * previous user recorded in `localStorage`, clears all previous JMCWC unsent recovery entries.
 */
export function syncJmcwcRecoveryUserScope(currentUserId, storage = null) {
  const store = getSafeStorage(storage);
  if (!store || !currentUserId) return;
  try {
    const prevUser = store.getItem(JMCWC_LAST_USER_STORAGE_KEY);
    if (prevUser && prevUser !== String(currentUserId)) {
      clearAllJmcwcLocalRecovery({ storage: store });
    } else {
      clearAllJmcwcLocalRecovery({ onlyOtherUsersExcept: currentUserId, storage: store });
    }
    store.setItem(JMCWC_LAST_USER_STORAGE_KEY, String(currentUserId));
  } catch {
    // Ignore
  }
}

/**
 * Evaluates whether local unsent answers can/should be offered for recovery on an attempt.
 * - Never restores into `submitted` or `grading` attempts.
 * - Never restores into expired flat attempts (`active_ms >= 7200000`).
 * - Compares local unsent entries against `attempt.answers`; if any question differs,
 *   returns `{ hasConflict: true, diffPatch, conflictingQuestionIds }` so the student can
 *   choose **Recover** or **Discard**.
 */
export function evaluateLocalUnsentRecovery(userId, attempt, storage = null) {
  if (!userId || !attempt || !attempt.id) {
    return { eligible: false, hasConflict: false, diffPatch: {} };
  }

  const isExpiredFlat =
    attempt.mode === 'flat' && Number(attempt.active_ms || 0) >= JMCWC_FLAT_DURATION_MS;
  if (attempt.status === 'submitted' || attempt.status === 'grading' || isExpiredFlat) {
    clearLocalUnsentForAttempt(userId, attempt.id, storage);
    return { eligible: false, hasConflict: false, diffPatch: {} };
  }

  const record = loadLocalUnsentRecovery(userId, attempt.id, storage);
  if (!record || !record.answers) {
    return { eligible: false, hasConflict: false, diffPatch: {} };
  }

  const serverAnswers =
    attempt.answers && typeof attempt.answers === 'object' ? attempt.answers : {};
  const validQuestionIds = Array.isArray(attempt.questions)
    ? new Set(attempt.questions.map((q) => String(q.id)))
    : null;

  const diffPatch = {};
  const conflictingQuestionIds = [];

  for (const [qId, localVal] of Object.entries(record.answers)) {
    if (validQuestionIds && !validQuestionIds.has(qId)) continue;
    const normLocal = normalizeAnswerPatchValue(localVal) ?? '';
    const normServer = normalizeAnswerPatchValue(serverAnswers[qId]) ?? '';
    if (normLocal !== normServer) {
      diffPatch[qId] = normLocal;
      conflictingQuestionIds.push(qId);
    }
  }

  if (conflictingQuestionIds.length === 0) {
    clearLocalUnsentForAttempt(userId, attempt.id, storage);
    return { eligible: false, hasConflict: false, diffPatch: {} };
  }

  return {
    eligible: true,
    hasConflict: true,
    diffPatch,
    conflictingQuestionIds,
    updatedAt: record.updated_at || null,
  };
}

// ============================================================================
// Accessible Input Descriptors for All 14 JMCWC Answer Types
// ============================================================================

/**
 * Returns accessible input metadata and helper controls for a question's `input` spec.
 * Guarantees raw text and decimal precision are preserved without float coercion.
 */
export function describeQuestionInputSpec(question) {
  const input = question?.input && typeof question.input === 'object' ? question.input : {};
  // Check input.type FIRST (from generator), then input.answer_type, then question.answer_type, default to 'integer'
  const resolvedType = String(input.type || input.answer_type || question?.answer_type || 'integer').toLowerCase();
  const fields = Array.isArray(input.fields) ? input.fields : null;
  const qNum = question?.question_index ?? question?.slot ?? '';
  const defaultAria = qNum ? `Answer for Question ${qNum}` : 'Enter your answer';

  const withAliases = (spec) => ({
    ...spec,
    kind: spec.widget,
    ariaLabel: spec.ariaLabel || defaultAria,
    helperText: spec.hint,
    slotCount: Array.isArray(spec.fields) ? spec.fields.length : (spec.slotCount || 2),
    options:
      spec.widget === 'day_of_week'
        ? DAY_OF_WEEK_OPTIONS.map((d) => (typeof d === 'string' ? d : d.value))
        : spec.options,
    dayOptions: spec.options,
  });

  // Preserve explicit answer_type if provided in test or spec
  const explicitAnswerType = input.answer_type || question?.answer_type || null;

  switch (resolvedType) {
    case 'integer':
      return withAliases({
        answerType: explicitAnswerType || 'integer',
        widget: 'text',
        inputMode: input.mode || 'numeric',
        placeholder: input.placeholder || 'Enter whole number',
        hint: input.hint || 'Whole number (digits only).',
        allowSignToggle: false,
      });

    case 'signed_number':
      return withAliases({
        answerType: explicitAnswerType || 'signed_number',
        widget: 'text',
        inputMode: input.mode || 'text',
        placeholder: input.placeholder || 'e.g. -42 or 42',
        hint: input.hint || 'Signed number (use - for negative values).',
        allowSignToggle: true,
      });

    case 'decimal': {
      const decPlaces = input.decimals !== undefined ? input.decimals : input.decimal_places;
      return withAliases({
        answerType: explicitAnswerType || 'decimal',
        widget: 'text',
        inputMode: input.mode || 'decimal',
        placeholder:
          input.placeholder ||
          (decPlaces !== undefined ? `To ${decPlaces} decimal places` : 'Enter decimal value'),
        hint:
          input.hint ||
          (decPlaces !== undefined
            ? `Decimal answer (${decPlaces} decimal places). Exact digits are preserved.`
            : 'Decimal or integer value. Exact digits are preserved.'),
        allowSignToggle: true,
      });
    }

    case 'money_decimal':
      return withAliases({
        answerType: explicitAnswerType || 'money_decimal',
        widget: 'text',
        inputMode: input.mode || 'decimal',
        prefixSymbol: input.currency_symbol || '$',
        placeholder: input.placeholder || 'e.g. 123.45',
        hint: input.hint || 'Currency amount (2 decimal places).',
        allowSignToggle: false,
      });

    case 'fraction':
    case 'fraction_or_decimal':
      return withAliases({
        answerType: explicitAnswerType || 'fraction_or_decimal',
        widget: 'text',
        inputMode: input.mode || 'text',
        placeholder: input.placeholder || 'e.g. 3/4, 1 1/2, or 0.75',
        hint: input.hint || 'Enter a fraction (a/b), mixed number (w a/b), or exact decimal.',
        quickInsertTokens: ['/'],
        allowSignToggle: true,
      });

    case 'repeating_decimal':
      return withAliases({
        answerType: explicitAnswerType || 'repeating_decimal',
        widget: 'text',
        inputMode: input.mode || 'text',
        placeholder: input.placeholder || 'e.g. 0.(3), 0.3..., or 1/3',
        hint: input.hint || 'Enter repeating decimal e.g. 0.(3) or fraction a/b.',
        quickInsertTokens: ['(', ')', '/'],
        allowSignToggle: false,
      });

    case 'mixed_number':
      return withAliases({
        answerType: explicitAnswerType || 'mixed_number',
        widget: 'mixed_number',
        inputMode: input.mode || 'text',
        placeholder: input.placeholder || 'e.g. 2 3/5 or 13/5',
        hint: input.hint || 'Enter whole part and fraction (e.g. 2 3/5) or improper fraction.',
        quickInsertTokens: [' ', '/'],
        allowSignToggle: true,
      });

    case 'base_representation':
      return withAliases({
        answerType: explicitAnswerType || 'base_representation',
        widget: 'text',
        inputMode: input.mode || 'numeric',
        suffixBadge: input.target_base ? `Base ${input.target_base}` : 'Base representation',
        placeholder: input.placeholder || `Digits in base ${input.target_base || ''}`.trim(),
        hint: input.hint || `Write digits in base ${input.target_base || 'n'}.`,
        allowSignToggle: false,
      });

    case 'ratio':
      return withAliases({
        answerType: explicitAnswerType || 'ratio',
        widget: 'ratio',
        inputMode: input.mode || 'text',
        placeholder: input.placeholder || 'e.g. 3 : 4',
        hint: input.hint || 'Enter simplified ratio as A : B.',
        quickInsertTokens: [' : '],
        allowSignToggle: false,
      });

    case 'elapsed_time':
    case 'time_24h':
      return withAliases({
        answerType: explicitAnswerType || 'time_24h',
        widget: 'text',
        inputMode: input.mode || 'text',
        placeholder: input.placeholder || (input.format === 'minutes' ? 'Total minutes' : 'Hours and minutes (e.g. 3:25)'),
        hint: input.hint || (input.format === 'minutes' ? 'Enter total elapsed minutes.' : 'Enter time in H:MM or HH:MM:SS format.'),
        quickInsertTokens: [':'],
        allowSignToggle: false,
      });

    case 'day_of_week':
      return withAliases({
        answerType: explicitAnswerType || 'day_of_week',
        widget: 'day_of_week',
        inputMode: input.mode || 'text',
        placeholder: input.placeholder || 'Select a day or type 0-6 / Sun-Sat',
        hint: input.hint || 'Choose a day of the week (or type 0=Sun ... 6=Sat).',
        options: DAY_OF_WEEK_OPTIONS,
        allowSignToggle: false,
      });

    case 'pair':
    case 'multi_value': {
      const fieldList =
        fields && fields.length > 0
          ? fields
          : [
              { key: 'val1', label: 'Value 1' },
              { key: 'val2', label: 'Value 2' },
            ];
      return withAliases({
        answerType: explicitAnswerType || 'multi_value',
        widget: 'multi_value',
        inputMode: input.mode || 'text',
        fields: fieldList,
        slotCount: fieldList.length,
        placeholder:
          input.placeholder ||
          fieldList.map((f) => (typeof f === 'string' ? f : f.label || f.key)).join(', '),
        hint:
          input.hint ||
          `Enter ${fieldList.map((f) => (typeof f === 'string' ? f : f.label || f.key)).join(' and ')} separated by commas or spaces.`,
        quickInsertTokens: [', '],
        allowSignToggle: true,
      });
    }

    case 'sum_squares':
      return withAliases({
        answerType: explicitAnswerType || 'expression_or_number',
        widget: 'sum_squares',
        inputMode: input.mode || 'text',
        placeholder: input.placeholder || 'Enter bases (e.g. 5, 3, 2 or 5^2 + 3^2 + 2^2)',
        hint: input.hint || 'Enter bases separated by commas or sum of squares (e.g. 5^2 + 3^2 + 2^2).',
        quickInsertTokens: ['^2', ' + '],
        allowSignToggle: false,
      });

    case 'prime_factorization':
      return withAliases({
        answerType: explicitAnswerType || 'prime_factorization',
        widget: 'text',
        inputMode: input.mode || 'text',
        placeholder: input.placeholder || 'e.g. 2 × 2 × 3 or 2^2 × 3',
        hint: input.hint || 'Enter prime factors multiplied together (e.g. 2 × 3 × 5 or 2^2 * 3).',
        quickInsertTokens: [' × ', '^'],
        allowSignToggle: false,
      });

    case 'text': {
      // Check if text is prime factors or calendar day
      if (question?.category_key === 'prime_factors') {
        return withAliases({
          answerType: explicitAnswerType || 'prime_factorization',
          widget: 'text',
          inputMode: input.mode || 'text',
          placeholder: input.placeholder || 'e.g. 2 × 2 × 3 or 2^2 × 3',
          hint: input.hint || 'Enter prime factors multiplied together (e.g. 2 × 3 × 5 or 2^2 * 3).',
          quickInsertTokens: [' × ', '^'],
          allowSignToggle: false,
        });
      }
      if (question?.category_key === 'calendar' && (!input.placeholder || input.placeholder.includes('Monday'))) {
        return withAliases({
          answerType: explicitAnswerType || 'day_of_week',
          widget: 'day_of_week',
          inputMode: input.mode || 'text',
          placeholder: input.placeholder || 'Select a day or type 0-6 / Sun-Sat',
          hint: input.hint || 'Choose a day of the week (or type 0=Sun ... 6=Sat).',
          options: DAY_OF_WEEK_OPTIONS,
          allowSignToggle: false,
        });
      }
      return withAliases({
        answerType: explicitAnswerType || 'expression_or_number',
        widget: 'text',
        inputMode: input.mode || 'text',
        placeholder: input.placeholder || 'Enter your answer',
        hint: input.hint || 'Enter your answer.',
        allowSignToggle: true,
      });
    }

    case 'expression_or_number':
    default:
      return withAliases({
        answerType: explicitAnswerType || 'expression_or_number',
        widget: 'text',
        inputMode: input.mode || 'text',
        placeholder: input.placeholder || 'Enter your answer',
        hint: input.hint || 'Enter your answer.',
        allowSignToggle: true,
      });
  }
}

/**
 * Splits a raw multi-value answer string into individual field values for multi-field inputs,
 * while preserving exact raw strings.
 */
export function splitMultiValueRaw(rawAnswer, fieldCount = 2) {
  const s = String(rawAnswer ?? '');
  if (!s.trim()) {
    return Array.from({ length: fieldCount }, () => '');
  }
  const parts = s.includes(',')
    ? s.split(',').map((p) => p.trim())
    : s
        .trim()
        .split(/\s+/)
        .map((p) => p.trim());
  return Array.from({ length: fieldCount }, (_, idx) => parts[idx] ?? '');
}

/**
 * Joins multi-field input values into a raw answer string.
 */
export function joinMultiValueRaw(values = []) {
  const cleaned = values.map((v) => String(v ?? '').trim());
  if (cleaned.every((v) => v === '')) return '';
  return cleaned.join(', ');
}

// ============================================================================
// Review & History Formatting Helpers
// ============================================================================

/**
 * Determines whether a review item has alternative valid answers (e.g. `sum_squares` decompositions)
 * and should display `"One valid answer"` instead of `"Expected answer"`.
 */
export function hasAlternativeValidAnswers(reviewItem) {
  if (!reviewItem) return false;
  if (reviewItem.category_key === 'sum_squares') return true;
  const exp = String(reviewItem.explanation || '').toLowerCase();
  return (
    exp.includes('one valid') ||
    exp.includes('any valid') ||
    exp.includes('alternative') ||
    exp.includes('decomposition')
  );
}

/**
 * Formats a completed attempt (`status === 'submitted'`) into a normalized review model.
 * Uses the frozen attempt-specific `max_marks` (`attempt.score.max_marks` or `attempt.max_marks`),
 * never cached workbook baseline totals.
 */
export function buildSubmittedReviewViewModel(attemptOrEnvelope, categories = []) {
  if (!attemptOrEnvelope) return null;

  const isEnvelope =
    attemptOrEnvelope.attempt &&
    typeof attemptOrEnvelope.attempt === 'object' &&
    !attemptOrEnvelope.status;
  const attempt = isEnvelope ? attemptOrEnvelope.attempt : attemptOrEnvelope;
  if (!attempt || attempt.status !== 'submitted') return null;

  const score =
    (isEnvelope && attemptOrEnvelope.score) ||
    attempt.score ||
    attempt.score_summary ||
    {};
  const frozenMaxMarks = Number(score.max_marks ?? attempt.max_marks ?? 0);
  const earnedMarks = Number(score.marks ?? score.earned_marks ?? 0);
  const correctCount = Number(score.correct ?? score.correct_count ?? 0);
  const partialCount = Number(score.partial ?? score.partial_count ?? 0);
  const wrongCount = Number(score.wrong ?? score.wrong_count ?? 0);
  const skippedCount = Number(score.skipped ?? score.skipped_count ?? 0);
  const activeMs = Number(attempt.active_ms ?? 0);
  const targetSeconds =
    (isEnvelope ? attemptOrEnvelope.targetSeconds : null) ??
    attempt.target_seconds ??
    null;

  const categoryTitleMap = new Map();
  if (Array.isArray(categories)) {
    for (const c of categories) {
      if (c && (c.key || c.id)) {
        categoryTitleMap.set(c.key || c.id, c.label || c.display_name || c.title || c.key || c.id);
      }
    }
  }

  const rawReview = Array.isArray(attempt.review)
    ? attempt.review
    : isEnvelope && Array.isArray(attemptOrEnvelope.review_questions)
      ? attemptOrEnvelope.review_questions
      : [];
  let partialMarksEarned = 0;

  const items = rawReview.map((item, idx) => {
    const award = Number(item.award ?? item.awarded_marks ?? 0);
    const maxMarks = Number(item.max_marks ?? 0);
    if (item.verdict === 'partial') {
      partialMarksEarned += award;
    }
    const useAltLabel = hasAlternativeValidAnswers(item);
    const rawStudentVal = item.student_answer ?? item.submitted_raw ?? null;
    const studentRaw =
      rawStudentVal === null ||
      rawStudentVal === undefined ||
      String(rawStudentVal).trim() === ''
        ? null
        : String(rawStudentVal);
    const promptText = formatJmcwcQuestionPrompt(item, `Question ${idx + 1}`);
    const catName =
      item.category_name ||
      categoryTitleMap.get(item.category_key) ||
      formatJmcwcCategoryTitle(item.category_key, categories) ||
      item.category_key ||
      'Category';
    const expectedLabel = useAltLabel ? 'One valid answer' : 'Expected answer';
    const expectedStr = String(item.expected ?? item.expected_display ?? '');

    return {
      index: idx + 1,
      id: item.id || item.question_key || `q_${idx + 1}`,
      question_key: item.question_key || item.id || `Q${idx + 1}`,
      category_key: item.category_key,
      category_label: catName,
      category_name: catName,
      slot: item.slot,
      prompt_text: promptText,
      prompt: promptText,
      prompt_obj: item.prompt || {},
      max_marks: maxMarks,
      award,
      awarded_marks: award,
      verdict: item.verdict || 'skipped',
      student_answer: studentRaw,
      submitted_raw: studentRaw,
      student_answer_display: studentRaw !== null ? studentRaw : 'Skipped',
      expected_label: expectedLabel,
      expected_answer_label: expectedLabel,
      expected: expectedStr,
      expected_display: expectedStr,
      explanation: String(item.explanation ?? ''),
    };
  });

  const groupLabel = formatJmcwcGroupLabel(attempt.group_key);
  const activeTimeFormatted = formatActiveDurationMs(activeMs, {
    alwaysHours: attempt.mode === 'flat',
  });
  const targetComparison =
    attempt.mode === 'category'
      ? formatNeutralTargetComparison(activeMs, targetSeconds)
      : null;

  return {
    attempt_id: attempt.id,
    group_key: attempt.group_key,
    group_label: groupLabel,
    groupLabel,
    mode: attempt.mode,
    mode_label:
      attempt.mode === 'flat'
        ? 'Flat Round (23 Categories)'
        : `Category-wise: ${categoryTitleMap.get(attempt.category_key) || attempt.category_key || 'Category'}`,
    category_key: attempt.category_key || null,
    created_at: attempt.created_at,
    finished_at: attempt.finished_at,
    submittedAt: attempt.finished_at || attempt.submitted_at || null,
    submitted_reason: attempt.submitted_reason || 'early',
    submitted_reason_label:
      attempt.submitted_reason === 'time_limit'
        ? 'Auto-submitted at 2-hour active time limit'
        : 'Submitted',
    earned_marks: earnedMarks,
    earnedMarks,
    max_marks: frozenMaxMarks,
    maxMarks: frozenMaxMarks,
    marks_label: `${earnedMarks} / ${frozenMaxMarks} marks`,
    partial_marks_earned: partialMarksEarned,
    partialMarks: partialMarksEarned,
    correct: correctCount,
    correctCount,
    partial: partialCount,
    partialCount,
    wrong: wrongCount,
    wrongCount,
    skipped: skippedCount,
    skippedCount,
    total_questions: correctCount + partialCount + wrongCount + skippedCount || items.length,
    active_ms: activeMs,
    active_time_label: activeTimeFormatted,
    activeTimeFormatted,
    target_comparison: targetComparison,
    targetComparison,
    items,
    questions: items,
  };
}

/**
 * Formats submitted JMCWC online attempts into Round Scores history rows labeled `Online`,
 * while keeping them strictly separate from legacy manual accuracy, Points leaderboard,
 * and weekly-test scores.
 */
export function formatOnlineAttemptsForRoundHistory(attempts = [], categories = []) {
  if (!Array.isArray(attempts)) return [];

  const categoryTitleMap = new Map();
  if (Array.isArray(categories)) {
    for (const c of categories) {
      if (c && (c.key || c.id)) {
        categoryTitleMap.set(c.key || c.id, c.label || c.display_name || c.title || c.key || c.id);
      }
    }
  }

  return attempts
    .filter((a) => a && a.status === 'submitted')
    .map((att) => {
      const score = att.score || att.score_summary || {};
      const marks = Number(score.marks ?? score.earned_marks ?? 0);
      const maxMarks = Number(score.max_marks ?? att.max_marks ?? 0);
      const correct = Number(score.correct ?? 0);
      const partial = Number(score.partial ?? 0);
      const wrong = Number(score.wrong ?? 0);
      const skipped = Number(score.skipped ?? 0);
      const activeMs = Number(att.active_ms ?? 0);
      const activeTimeDisplay = formatActiveDurationMs(activeMs, {
        alwaysHours: att.mode === 'flat',
      });
      const targetComp =
        att.mode === 'category'
          ? formatNeutralTargetComparison(activeMs, att.target_seconds)
          : null;

      return {
        id: att.id,
        source_badge: 'Online',
        is_online_jmcwc: true,
        is_submitted: true,
        status: att.status,
        excludes_from_legacy_points_and_accuracy: true,
        group_key: att.group_key,
        group_label: formatJmcwcGroupLabel(att.group_key),
        mode: att.mode,
        mode_label: att.mode === 'flat' ? 'Flat round' : 'Category-wise',
        category_key: att.category_key,
        title:
          att.mode === 'flat'
            ? 'Full 23-Category Paper'
            : categoryTitleMap.get(att.category_key) || att.category_key || 'Category Practice',
        created_at: att.created_at,
        finished_at: att.finished_at,
        date_iso: att.finished_at || att.created_at,
        marks,
        max_marks: maxMarks,
        marks_display: `${marks} / ${maxMarks}`,
        marks_text: `${marks} / ${maxMarks}`,
        correct,
        correct_count: correct,
        partial,
        partial_count: partial,
        wrong,
        skipped,
        active_ms: activeMs,
        active_time_display: activeTimeDisplay,
        active_time_formatted: activeTimeDisplay,
        target_seconds: att.target_seconds ?? null,
        target_comparison_text: targetComp?.hasTarget ? targetComp.comparisonText : null,
      };
    });
}

// ============================================================================
// Authenticated JMCWC Runner Session Controller (Injectable Clock & Fetch)
// ============================================================================

/**
 * Creates a controllable client session coordinator for a JMCWC attempt.
 *
 * Enforces:
 * - Immediate question/input hiding on explicit Pause, tab hidden, `pagehide`,
 *   lease loss (`409 LEASE_MISMATCH`), `paused`/`grading`/`submitted` status, or 2-hour flat expiry.
 * - Authenticated `fetch('/api/jmcwc', { keepalive: true })` on `pagehide` / `visibilitychange` (`hidden`),
 *   never putting tokens in URLs, respecting `JMCWC_MAX_PAUSE_BODY_BYTES`.
 * - Save indicator state (`Saving`, `Saved`, `Offline—paused`).
 * - Early submission confirmation with answered/unanswered counts.
 * - Paused submission requiring explicit Resume-and-Submit confirmation.
 */
export function createJmcwcRunnerController({
  userId,
  getAccessToken,
  getBearerToken,
  fetchImpl = typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null,
  nowFn = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  storage = null,
  onStateChange = () => {},
} = {}) {
  const resolveAccessToken =
    typeof getAccessToken === 'function'
      ? getAccessToken
      : typeof getBearerToken === 'function'
        ? getBearerToken
        : null;
  if (!resolveAccessToken) {
    throw new Error('createJmcwcRunnerController requires a getAccessToken function.');
  }

  let state = {
    attempt: null,
    questionsVisible: false,
    inputsVisible: false,
    saveIndicator: 'Saved', // 'Saving' | 'Saved' | 'Offline—paused'
    leaseLostMessage: null,
    pausedMessage: null,
    expiredMessage: null,
    recoveryPrompt: null, // { diffPatch, conflictingQuestionIds }
    earlySubmitConfirmation: null, // { answeredCount, unansweredCount, totalCount }
    pausedSubmitConfirmation: null, // { attemptId }
    takeoverConfirmation: null, // { attemptId, runningAttemptId, message }
    currentCategoryIndex: 0,
    currentQuestionIndex: 0,
    localAnswers: {},
    baseActiveMs: 0,
    syncedAtMonoMs: null,
  };

  function emitState() {
    onStateChange(getSnapshot());
  }

  async function callApi(payload, { keepalive = false } = {}) {
    const token = await resolveAccessToken();
    if (!token) {
      const err = new Error('Authentication session expired. Please sign in again.');
      err.statusCode = 401;
      throw err;
    }
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
    const response = await fetchImpl('/api/jmcwc', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      ...(keepalive ? { keepalive: true } : {}),
    });
    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    if (!response.ok) {
      const err = new Error(data.error || `Request failed (${response.status})`);
      err.statusCode = response.status;
      err.status = response.status;
      err.code = data.code || 'JMCWC_API_ERROR';
      if (data.attempt) err.attempt = data.attempt;
      if (data.running_attempt_id) err.running_attempt_id = data.running_attempt_id;
      throw err;
    }
    return data;
  }

  const saveQueue = createJmcwcSaveQueue({
    sendSave: async ({ attempt_id, lease_id, save_seq, answers }) => {
      const res = await callApi({
        action: 'save',
        attempt_id,
        lease_id,
        save_seq,
        answers,
      });
      if (res?.attempt) {
        syncServerAttempt(res.attempt, { preserveLocalDirty: true });
      }
      return res;
    },
    onConflictOrTerminal: (errOrRes) => {
      handleConflictOrTerminal(errOrRes);
    },
    onStatusChange: (status) => {
      if (status === 'saving') {
        state.saveIndicator = 'Saving';
      } else if (status === 'saved') {
        state.saveIndicator = 'Saved';
        // Clear local unsent recovery once all dirty patches are flushed
        const snap = saveQueue.getUnflushedSnapshot();
        if (!snap && state.attempt?.id) {
          clearLocalUnsentForAttempt(userId, state.attempt.id, storage);
        }
      } else if (status === 'offline') {
        state.saveIndicator = 'Offline—paused';
        state.questionsVisible = false;
        state.inputsVisible = false;
        state.pausedMessage =
          'Connection interrupted. Questions are hidden and the round is paused until you reconnect and click Resume.';
      }
      emitState();
    },
  });

  function hideQuestionsImmediately({ reason = null, leaseLost = false, expired = false } = {}) {
    state.questionsVisible = false;
    state.inputsVisible = false;
    saveQueue.stopSession();
    if (leaseLost) {
      state.leaseLostMessage = reason || 'Session changed in another tab or window. Reload or resume this round.';
    } else if (expired) {
      state.expiredMessage = reason || 'Two-hour active time limit reached. Finalizing your saved answers...';
    } else if (reason) {
      state.pausedMessage = reason;
    }
    emitState();
  }

  function handleConflictOrTerminal(errOrRes) {
    const code = errOrRes?.code || '';
    const att = errOrRes?.attempt || null;

    if (code === 'LEASE_MISMATCH') {
      hideQuestionsImmediately({
        leaseLost: true,
        reason: errOrRes.message || 'Session changed. Reload this round.',
      });
      return;
    }

    if (code === 'SESSION_PAUSED' || att?.status === 'paused') {
      if (att) {
        state.attempt = { ...state.attempt, ...att, questions: undefined, lease_id: undefined };
        state.baseActiveMs = Number(att.active_ms ?? state.baseActiveMs);
        state.syncedAtMonoMs = null;
      }
      hideQuestionsImmediately({
        reason: errOrRes.message || 'Round is paused. Click Resume to continue.',
      });
      return;
    }

    if (att && (att.status === 'submitted' || att.status === 'grading')) {
      syncServerAttempt(att);
    }
  }

  function syncServerAttempt(attempt, { preserveLocalDirty = false } = {}) {
    if (!attempt) return;
    const prevAttempt = state.attempt;
    state.attempt = attempt;
    if (prevAttempt?.id !== attempt.id) state.localAnswers = {};
    state.baseActiveMs = Number(attempt.active_ms ?? 0);
    state.syncedAtMonoMs = attempt.status === 'running' ? nowFn() : null;

    if (attempt.status === 'submitted') {
      state.questionsVisible = false;
      state.inputsVisible = false;
      state.pausedMessage = null;
      state.leaseLostMessage = null;
      state.expiredMessage = null;
      state.recoveryPrompt = null;
      state.earlySubmitConfirmation = null;
      state.pausedSubmitConfirmation = null;
      saveQueue.stopSession();
      clearLocalUnsentForAttempt(userId, attempt.id, storage);
      emitState();
      return;
    }

    if (attempt.status !== 'running' || !attempt.lease_id) {
      state.questionsVisible = false;
      state.inputsVisible = false;
      saveQueue.stopSession();
      emitState();
      return;
    }

    // Running with an active lease
    if (Array.isArray(attempt.questions)) {
      const serverAns =
        attempt.answers && typeof attempt.answers === 'object' ? { ...attempt.answers } : {};
      if (!preserveLocalDirty) {
        state.localAnswers = serverAns;
      } else {
        const unflushed = saveQueue.getUnflushedSnapshot();
        state.localAnswers = {
          ...serverAns,
          ...(unflushed?.answers || {}),
        };
      }
    } else if (prevAttempt?.id === attempt.id && prevAttempt?.questions) {
      state.attempt = {
        ...attempt,
        questions: prevAttempt.questions,
      };
    }

    const isNewLease = !prevAttempt || prevAttempt.lease_id !== attempt.lease_id;
    if (isNewLease) {
      const initialSeq = Number(attempt.save_seq ?? -1) + 1;
      saveQueue.startSession({
        attempt_id: attempt.id,
        lease_id: attempt.lease_id,
        initial_seq: Math.max(0, initialSeq),
      });

      // Check for local unsent answer recovery conflicts on resume
      const recovery = evaluateLocalUnsentRecovery(userId, state.attempt, storage);
      if (recovery.eligible && recovery.hasConflict) {
        state.recoveryPrompt = {
          diffPatch: recovery.diffPatch,
          conflictingQuestionIds: recovery.conflictingQuestionIds,
          updatedAt: recovery.updatedAt,
        };
      } else {
        state.recoveryPrompt = null;
      }
    }

    state.questionsVisible = true;
    state.inputsVisible = true;
    state.pausedMessage = null;
    state.leaseLostMessage = null;
    state.expiredMessage = null;
    state.saveIndicator = 'Saved';
    emitState();
  }

  /**
   * Loads an attempt in read-only / paused / submitted state (e.g. on page load or reload).
   * Note: Returning or reloading NEVER auto-resumes; if the attempt is paused or lacks the lease,
   * questions remain hidden until explicit `resumeAttempt()` is called.
   */
  async function readAttempt(attemptId) {
    const res = await callApi({
      action: 'read',
      attempt_id: attemptId,
      lease_id: null,
    });
    syncServerAttempt(res.attempt);
    if (res.attempt?.status !== 'submitted') {
      state.questionsVisible = false;
      state.inputsVisible = false;
      state.pausedMessage =
        'Round is paused. Click Resume to load questions and continue your attempt.';
      emitState();
    }
    return res.attempt;
  }

  /**
   * Explicitly resumes a paused or unfinished attempt, acquiring a fresh `lease_id`.
   */
  async function resumeAttempt(attemptId, { confirmTakeover = false, takeover = false } = {}) {
    try {
      const res = await callApi({
        action: 'resume',
        attempt_id: attemptId,
        confirm_takeover: Boolean(confirmTakeover || takeover),
      });
      state.takeoverConfirmation = null;
      syncServerAttempt(res.attempt);
      return res.attempt;
    } catch (err) {
      err.attemptId = attemptId;
      if (err.code === 'TAKEOVER_CONFIRMATION_REQUIRED') {
        state.takeoverConfirmation = {
          attemptId,
          runningAttemptId: err.running_attempt_id || null,
          message: err.message,
        };
        emitState();
      }
      throw err;
    }
  }

  /**
   * Creates a new attempt (`mode: 'flat' | 'category'`) and immediately resumes it.
   */
  async function startAttempt({
    mode = 'flat',
    categoryKey = null,
    categoryId = null,
    requestId = null,
    confirmTakeover = false,
    takeover = false,
  } = {}) {
    const reqUuid =
      requestId ||
      (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : '10000000-1000-4000-8000-' + String(Date.now()).padStart(12, '0').slice(-12));
    const cat = mode === 'category' ? categoryKey || categoryId : null;
    const createRes = await callApi({
      action: 'create',
      request_id: reqUuid,
      mode,
      category_key: cat,
    });
    const createdId = createRes?.attempt?.id;
    if (!createdId) {
      throw new Error('Failed to create attempt.');
    }
    try {
      return await resumeAttempt(createdId, { confirmTakeover: Boolean(confirmTakeover || takeover) });
    } catch (err) {
      err.attemptId = createdId;
      throw err;
    }
  }

  /**
   * Updates an answer in the runner, persists to scoped local unsent recovery,
   * and enqueues a serialized save patch.
   */
  function editAnswer(questionId, rawValue) {
    if (!state.questionsVisible || !state.inputsVisible || !state.attempt || state.attempt.status !== 'running') {
      return false;
    }
    const normalized = normalizeAnswerPatchValue(rawValue);
    state.localAnswers[questionId] = normalized ?? '';
    saveQueue.queueAnswer(questionId, rawValue);

    const unflushed = saveQueue.getUnflushedSnapshot();
    saveLocalUnsentRecovery(userId, state.attempt.id, unflushed?.answers || {}, storage);
    state.saveIndicator = 'Saving';
    emitState();

    saveQueue.flush().catch(() => {
      // Handled by saveQueue onConflictOrTerminal / onStatusChange
    });
    return true;
  }

  /**
   * Resolves a local unsent recovery prompt (`recover` or `discard`).
   */
  async function resolveRecoveryPrompt(decision = 'recover') {
    const prompt = state.recoveryPrompt;
    state.recoveryPrompt = null;
    if (!prompt || !state.attempt) {
      emitState();
      return;
    }
    if (decision === 'discard') {
      clearLocalUnsentForAttempt(userId, state.attempt.id, storage);
      emitState();
      return;
    }
    // Recover: apply diffPatch to localAnswers and flush via saveQueue
    for (const [qId, val] of Object.entries(prompt.diffPatch)) {
      state.localAnswers[qId] = val;
    }
    saveQueue.queuePatch(prompt.diffPatch);
    state.saveIndicator = 'Saving';
    emitState();
    await saveQueue.flush();
  }

  /**
   * Explicit Pause: immediately hides questions and inputs BEFORE the network call completes,
   * and requires explicit Resume to continue.
   */
  async function pauseAttempt({ reason = 'Round paused. Click Resume when you are ready to continue.' } = {}) {
    const att = state.attempt;
    if (!att) return null;

    const unflushed = saveQueue.getUnflushedSnapshot();
    const leaseId = att.lease_id || null;

    // Immediately hide questions and inputs
    hideQuestionsImmediately({ reason });

    if (!leaseId) {
      return state.attempt;
    }

    const keepaliveSpec = buildPauseKeepalivePayload({
      attempt_id: att.id,
      lease_id: leaseId,
      save_seq: unflushed ? unflushed.save_seq : null,
      answers: unflushed ? unflushed.answers : null,
      maxBytes: JMCWC_MAX_PAUSE_BODY_BYTES,
    });

    try {
      const res = await callApi(keepaliveSpec.payload);
      if (res?.attempt) {
        if (!keepaliveSpec.droppedOversizedPatch) {
          saveQueue.clearDirty();
          clearLocalUnsentForAttempt(userId, att.id, storage);
        }
        syncServerAttempt(res.attempt);
        if (res.attempt.status !== 'submitted') {
          state.pausedMessage = reason;
          emitState();
        }
      }
      return res?.attempt || null;
    } catch (err) {
      handleConflictOrTerminal(err);
      return null;
    }
  }

  /**
   * Best-effort background/close pause handler for `pagehide` and `visibilitychange` (`hidden`).
   * Immediately hides questions and sends an authenticated `fetch(..., { keepalive: true })`
   * with `Authorization: Bearer <token>` header (never tokens in URLs).
   */
  async function handleVisibilityHiddenOrPageHide() {
    const att = state.attempt;
    if (!att || att.status !== 'running' || !att.lease_id) {
      return null;
    }

    const unflushed = saveQueue.getUnflushedSnapshot();
    const leaseId = att.lease_id;

    hideQuestionsImmediately({
      reason: 'Paused because you switched tabs or backgrounded the window. Click Resume to continue.',
    });

    const keepaliveSpec = buildPauseKeepalivePayload({
      attempt_id: att.id,
      lease_id: leaseId,
      save_seq: unflushed ? unflushed.save_seq : null,
      answers: unflushed ? unflushed.answers : null,
      maxBytes: JMCWC_MAX_PAUSE_BODY_BYTES,
    });

    try {
      const res = await callApi(keepaliveSpec.payload, { keepalive: true });
      if (res?.attempt) {
        if (!keepaliveSpec.droppedOversizedPatch) {
          saveQueue.clearDirty();
          clearLocalUnsentForAttempt(userId, att.id, storage);
        }
        syncServerAttempt(res.attempt);
        if (res.attempt.status !== 'submitted') {
          state.pausedMessage =
            'Paused because you switched tabs or backgrounded the window. Click Resume to continue.';
          emitState();
        }
      }
      return keepaliveSpec;
    } catch {
      state.saveIndicator = 'Offline—paused';
      emitState();
      return keepaliveSpec;
    }
  }

  /**
   * Periodic heartbeat while running. Also checks if the 2-hour flat timer has expired.
   */
  async function sendHeartbeat() {
    const att = state.attempt;
    if (!att || att.status !== 'running' || !att.lease_id) return null;

    const timer = getTimerState();
    if (att.mode === 'flat' && timer.expired) {
      return handleFlatExpiry();
    }

    try {
      const res = await callApi({
        action: 'heartbeat',
        attempt_id: att.id,
        lease_id: att.lease_id,
      });
      if (res?.attempt) {
        syncServerAttempt(res.attempt, { preserveLocalDirty: true });
      }
      return res?.attempt || null;
    } catch (err) {
      handleConflictOrTerminal(err);
      return null;
    }
  }

  /**
   * At 2 hours (`7,200,000 ms`) of active time in a flat round:
   * Immediately hides inputs and finalizes already-saved answers.
   */
  async function handleFlatExpiry() {
    const att = state.attempt;
    if (!att) return null;
    const leaseId = att.lease_id || null;

    hideQuestionsImmediately({
      expired: true,
      reason: 'Two-hour active time limit reached. Finalizing your saved answers...',
    });

    try {
      // Send heartbeat or read so server `jmcwc_tick` transitions active_ms >= 7200000 to grading and settles it
      if (leaseId) {
        const res = await callApi({
          action: 'heartbeat',
          attempt_id: att.id,
          lease_id: leaseId,
        });
        if (res?.attempt?.status === 'submitted') {
          syncServerAttempt(res.attempt);
          return res.attempt;
        }
      }
      const readRes = await callApi({
        action: 'read',
        attempt_id: att.id,
      });
      if (readRes?.attempt?.status === 'submitted') {
        syncServerAttempt(readRes.attempt);
        return readRes.attempt;
      }
      // If server clock needed a final submit trigger
      if (leaseId) {
        const subRes = await callApi({
          action: 'submit',
          attempt_id: att.id,
          lease_id: leaseId,
        });
        syncServerAttempt(subRes.attempt);
        return subRes.attempt;
      }
      return readRes?.attempt || null;
    } catch (err) {
      handleConflictOrTerminal(err);
      return null;
    }
  }

  /**
   * Computes answered and unanswered counts for the current attempt.
   */
  function getAnswerCounts() {
    const questions = Array.isArray(state.attempt?.questions) ? state.attempt.questions : [];
    const totalCount = questions.length || Number(state.attempt?.question_count) || 0;
    let answeredCount = 0;

    if (questions.length > 0) {
      for (const q of questions) {
        const val = state.localAnswers[q.id];
        if (val !== null && val !== undefined && String(val).trim() !== '') {
          answeredCount += 1;
        }
      }
    } else {
      answeredCount = Number(state.attempt?.answered_count) || 0;
    }

    const unansweredCount = Math.max(0, totalCount - answeredCount);
    return { answeredCount, unansweredCount, totalCount };
  }

  /**
   * Initiates early submission:
   * - If the round is currently paused, requires explicit `pausedSubmitConfirmation` ("Resume and Submit").
   * - If the round is running, requires `earlySubmitConfirmation` showing `answeredCount` and `unansweredCount`.
   */
  function requestEarlySubmit() {
    if (!state.attempt) return null;
    if (state.attempt.status !== 'running' || !state.attempt.lease_id) {
      const counts = getAnswerCounts();
      state.pausedSubmitConfirmation = {
        attemptId: state.attempt.id,
        ...counts,
      };
      emitState();
      return { type: 'paused_submit_confirmation', ...state.pausedSubmitConfirmation };
    }

    const counts = getAnswerCounts();
    state.earlySubmitConfirmation = {
      attemptId: state.attempt.id,
      ...counts,
    };
    emitState();
    return { type: 'early_submit_confirmation', ...state.earlySubmitConfirmation };
  }

  function cancelSubmitConfirmation() {
    state.earlySubmitConfirmation = null;
    state.pausedSubmitConfirmation = null;
    emitState();
  }

  /**
   * Confirms and executes early submission (or explicit Resume-and-Submit when paused).
   */
  async function confirmSubmit({ allowResumeAndSubmit = false, confirmTakeover = false } = {}) {
    if (!state.attempt) return null;
    state.earlySubmitConfirmation = null;
    state.pausedSubmitConfirmation = null;

    let currentAttempt = state.attempt;
    if (currentAttempt.status !== 'running' || !currentAttempt.lease_id) {
      if (!allowResumeAndSubmit) {
        const counts = getAnswerCounts();
        state.pausedSubmitConfirmation = {
          attemptId: currentAttempt.id,
          ...counts,
        };
        emitState();
        throw new Error('Round is paused. Confirm Resume and Submit to finalize this attempt.');
      }
      currentAttempt = await resumeAttempt(currentAttempt.id, { confirmTakeover });
      if (currentAttempt.status === 'submitted') {
        return currentAttempt;
      }
    }

    // Flush any pending save queue patches or attach final unflushed snapshot to submit
    const unflushed = saveQueue.getUnflushedSnapshot();
    const leaseId = currentAttempt.lease_id;
    state.saveIndicator = 'Saving';
    state.inputsVisible = false;
    emitState();

    const res = await callApi({
      action: 'submit',
      attempt_id: currentAttempt.id,
      lease_id: leaseId,
      save_seq: unflushed ? unflushed.save_seq : null,
      answers: unflushed ? unflushed.answers : null,
    });

    saveQueue.clearDirty();
    clearLocalUnsentForAttempt(userId, currentAttempt.id, storage);
    syncServerAttempt(res.attempt);
    return res.attempt;
  }

  function getTimerState() {
    if (!state.attempt) {
      return computeMonotonicTimerState();
    }
    return computeMonotonicTimerState({
      mode: state.attempt.mode,
      status: state.attempt.status,
      baseActiveMs: state.baseActiveMs,
      syncedAtMonoMs: state.syncedAtMonoMs,
      nowMonoMs: nowFn(),
      targetSeconds: state.attempt.target_seconds,
    });
  }

  function buildSectionedQuestions(rawQuestions) {
    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return [];
    if (Array.isArray(rawQuestions[0]?.questions)) return rawQuestions;

    const byCat = new Map();
    const sections = [];
    for (let i = 0; i < rawQuestions.length; i += 1) {
      const q = rawQuestions[i];
      const catKey = q.category_key || 'category';
      let sec = byCat.get(catKey);
      if (!sec) {
        const catReadable = formatJmcwcCategoryTitle(catKey);
        sec = {
          section_order: sections.length + 1,
          category_slug: catKey,
          display_name: q.category_label || catReadable,
          category_name: q.category_label || catReadable,
          questions: [],
        };
        byCat.set(catKey, sec);
        sections.push(sec);
      }
      sec.questions.push({
        ...q,
        question_key: q.id,
        question_index: q.slot ?? sec.questions.length + 1,
        category_name: sec.category_name,
        marks: q.max_marks,
        prompt: formatJmcwcQuestionPrompt(q),
      });
    }
    return sections;
  }

  function getSnapshot() {
    const counts = getAnswerCounts();
    const rawQuestions = state.attempt?.questions || [];
    const status = state.leaseLostMessage
      ? 'lease_lost'
      : state.attempt?.status || 'idle';
    return {
      ...state,
      status,
      questionsHidden: !state.questionsVisible,
      saveStatusLabel: state.saveIndicator,
      recoveryConflict: state.recoveryPrompt,
      errorMessage: state.leaseLostMessage || state.pausedMessage || state.expiredMessage || null,
      score: state.attempt?.score || state.attempt?.score_summary || null,
      reviewQuestions: state.attempt?.review || [],
      answers: { ...state.localAnswers },
      localAnswers: { ...state.localAnswers },
      questions: buildSectionedQuestions(rawQuestions),
      flatQuestions: rawQuestions,
      timer: getTimerState(),
      answerCounts: counts,
    };
  }

  return {
    startAttempt,
    readAttempt,
    resumeAttempt,
    editAnswer,
    recordAnswer: editAnswer,
    resolveRecoveryPrompt,
    resolveRecoveryConflict: resolveRecoveryPrompt,
    pauseAttempt,
    handleVisibilityHiddenOrPageHide,
    sendHeartbeat,
    handleFlatExpiry,
    requestEarlySubmit,
    cancelSubmitConfirmation,
    confirmSubmit,
    submitAttempt: ({ resumeIfPaused = false, confirmTakeover = false } = {}) =>
      confirmSubmit({ allowResumeAndSubmit: resumeIfPaused, confirmTakeover }),
    getTimerState,
    getAnswerCounts,
    getSnapshot,
    getState: getSnapshot,
    saveQueue,
  };
}
