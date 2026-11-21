/**
 * Trendz Tracker — Practice Highest Records Data & Ranking Engine (js/practiceRecords.js)
 *
 * Implements strictly comparable records ever across all 4 practice sections:
 * - Basics: identical category & duration (30, 60, 120, 300 seconds; default 60s)
 * - Flash Anzan: identical (digits, count, mode) workload, ranked by fastest cleared speed (MIN speed_ms with correct >= 1)
 * - Elements: identical drill & configuration (correct DESC, time_seconds ASC)
 * - Memoriad: identical module & official scoring (settings->>'score' DESC, used_seconds ASC)
 *
 * Privacy & Eligibility Safeguards:
 * - Excludes profiles where active = false or leaderboard_visible = false
 * - Only completed online drills (drill_sessions.result_id link or session_id) or teacher-verified manual drills
 * - Permitted display name formatting (e.g. "Aarav S.")
 * - Genuine ties include all shared holders
 * - Authoritative RPC practice_highest_records with honest error states and zero client-side table fallbacks
 */

import { isSupabaseConfigured, isDemoAllowedHost } from './config.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import { DRILL_CATALOG_LIST } from './drillCatalog.js';
import { MEMORIAD_MODULE_CATALOG } from './memoriadStats.js';

export const BASICS_RECORD_DURATIONS = Object.freeze([30, 60, 120, 300]);
export const DEFAULT_BASICS_RECORD_DURATION = 60;

/**
 * Standard Flash Anzan benchmark presets for strictly comparable workloads.
 */
export const FLASH_RECORD_BENCHMARKS = Object.freeze([
  {
    key: 'flash_1d_10n_add',
    title: '1 Digit · 10 Numbers · Add',
    digits: 1,
    count: 10,
    mode: 'add',
    description: 'Foundation single-digit visualization: fastest cleared speed.',
  },
  {
    key: 'flash_2d_10n_add',
    title: '2 Digits · 10 Numbers · Add',
    digits: 2,
    count: 10,
    mode: 'add',
    description: 'Two-digit addition visualization: fastest cleared speed.',
  },
  {
    key: 'flash_2d_15n_add',
    title: '2 Digits · 15 Numbers · Add',
    digits: 2,
    count: 15,
    mode: 'add',
    description: 'Extended two-digit addition test: fastest cleared speed across 15 numbers.',
  },
  {
    key: 'flash_3d_10n_add',
    title: '3 Digits · 10 Numbers · Add',
    digits: 3,
    count: 10,
    mode: 'add',
    description: 'Advanced three-digit visualization: fastest cleared speed across 10 numbers.',
  },
  {
    key: 'flash_2d_10n_add_sub',
    title: '2 Digits · 10 Numbers · Add & Subtract',
    digits: 2,
    count: 10,
    mode: 'add_sub',
    description: 'Mixed addition and subtraction with negative numbers: fastest cleared speed.',
  },
]);

/**
 * Formats a student's name respecting leaderboard privacy (e.g. "Aarav S.")
 * @param {string|null} fullName
 * @param {string|null} studentCode
 * @param {'first_name_initial'|'full_name'|'student_code'} mode
 * @returns {string}
 */
export function formatRecordHolderName(fullName, studentCode, mode = 'first_name_initial') {
  const code = String(studentCode || '').trim() || '—';
  const name = String(fullName || '').trim();

  if (mode === 'student_code') return code;
  if (mode === 'full_name' && name) return name;

  const raw = name || code;
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return code;
  const first = parts[0];
  if (parts.length >= 2) {
    const lastInit = parts[parts.length - 1].charAt(0).toUpperCase();
    return `${first} ${lastInit}.`;
  }
  return first;
}

/**
 * Checks whether a student profile is eligible for practice records:
 * Must be active !== false AND leaderboard_visible !== false
 */
export function isStudentEligibleForRecords(profile) {
  if (!profile) return false;
  if (profile.active === false) return false;
  if (profile.leaderboard_visible === false) return false;
  return true;
}

/**
 * Checks whether a drill score row is eligible:
 * Online drill (session_id present or verified via drill_sessions) or verified by teacher (verified = true).
 */
export function isScoreEligibleForRecords(row) {
  if (!row) return false;
  const isOnline = row.source === 'site' || Boolean(row.session_id || row.settings?.session_id);
  const isVerified = Boolean(row.verified);
  return isOnline || isVerified;
}

/**
 * Computes strictly comparable Basics records per category for a given duration.
 *
 * Ranking Rule:
 * 1. Filter: category.section = 'basics', time_seconds = selectedDuration, eligible score & student.
 * 2. Primary: correct DESC
 * 3. Tie-breaker: (total - correct) ASC (fewest errors)
 * 4. Genuine ties: All students matching top (correct, errors) share the record.
 */
export function computeBasicsRecords({
  categories = [],
  results = [],
  profiles = [],
  durationSeconds = DEFAULT_BASICS_RECORD_DURATION,
  currentStudentId = null,
} = {}) {
  const profileMap = new Map();
  for (const p of profiles) {
    if (p && p.id && isStudentEligibleForRecords(p)) {
      profileMap.set(p.id, p);
    }
  }

  const basicsCats = categories.filter((c) => c.section === 'basics');

  const eligibleResults = results.filter((r) => {
    if (!r || !r.student_id || !r.category_id) return false;
    if (Number(r.time_seconds) !== Number(durationSeconds)) return false;
    if (!profileMap.has(r.student_id)) return false;
    if (!isScoreEligibleForRecords(r)) return false;
    return true;
  });

  const resultsByCat = new Map();
  for (const r of eligibleResults) {
    if (!resultsByCat.has(r.category_id)) resultsByCat.set(r.category_id, []);
    resultsByCat.get(r.category_id).push(r);
  }

  return basicsCats.map((cat) => {
    const catResults = resultsByCat.get(cat.id) || [];

    if (catResults.length === 0) {
      return {
        id: cat.id,
        category: cat,
        section: 'basics',
        title: cat.name,
        durationSeconds,
        settingsSummary: `${durationSeconds} seconds`,
        hasRecord: false,
        scoreDisplay: '—',
        scoreNumeric: 0,
        wrongCount: 0,
        holders: [],
        isHeldByMe: false,
        attemptUrl: `/pages/basics-practice.html?cat=${encodeURIComponent(cat.id)}&seconds=${durationSeconds}`,
        attemptLabel: 'Set the record',
      };
    }

    // Sort: correct DESC, wrong ASC
    catResults.sort((a, b) => {
      const corDiff = (Number(b.correct) || 0) - (Number(a.correct) || 0);
      if (corDiff !== 0) return corDiff;
      const wrongA = Math.max(0, (Number(a.total) || 0) - (Number(a.correct) || 0));
      const wrongB = Math.max(0, (Number(b.total) || 0) - (Number(b.correct) || 0));
      return wrongA - wrongB;
    });

    const bestRow = catResults[0];
    const bestCorrect = Number(bestRow.correct) || 0;
    const bestWrong = Math.max(0, (Number(bestRow.total) || 0) - bestCorrect);

    const tiedRows = catResults.filter((r) => {
      const c = Number(r.correct) || 0;
      const w = Math.max(0, (Number(r.total) || 0) - c);
      return c === bestCorrect && w === bestWrong;
    });

    const holderStudentIds = Array.from(new Set(tiedRows.map((r) => r.student_id)));
    const holders = holderStudentIds
      .map((sid) => {
        const prof = profileMap.get(sid);
        if (!prof) return null;
        return {
          student_id: prof.id,
          student_code: prof.student_code,
          display_name: formatRecordHolderName(prof.full_name, prof.student_code),
          is_me: Boolean(currentStudentId && currentStudentId === prof.id),
        };
      })
      .filter(Boolean);

    const isHeldByMe = holders.some((h) => h.is_me);

    return {
      id: cat.id,
      category: cat,
      section: 'basics',
      title: cat.name,
      durationSeconds,
      settingsSummary: `${durationSeconds} seconds`,
      hasRecord: true,
      scoreDisplay: `${bestCorrect} correct (${bestWrong} wrong)`,
      scoreNumeric: bestCorrect,
      wrongCount: bestWrong,
      holders,
      isHeldByMe,
      attemptUrl: `/pages/basics-practice.html?cat=${encodeURIComponent(cat.id)}&seconds=${durationSeconds}`,
      attemptLabel: isHeldByMe ? 'Defend record' : 'Attempt online',
    };
  });
}

/**
 * Computes strictly comparable Elements records per worksheet drill.
 */
export function computeElementsRecords({
  activityResults = [],
  profiles = [],
  currentStudentId = null,
} = {}) {
  const profileMap = new Map();
  for (const p of profiles) {
    if (p && p.id && isStudentEligibleForRecords(p)) {
      profileMap.set(p.id, p);
    }
  }

  const eligibleRows = activityResults.filter((r) => {
    if (!r || !r.student_id || r.activity_type !== 'element') return false;
    if (!profileMap.has(r.student_id)) return false;
    if (!isScoreEligibleForRecords(r)) return false;
    return true;
  });

  const rowsByDrill = new Map();
  for (const r of eligibleRows) {
    const drillKey = r.settings?.drill || r.settings?.drill_key || r.activity_name || '';
    if (!drillKey) continue;
    if (!rowsByDrill.has(drillKey)) rowsByDrill.set(drillKey, []);
    rowsByDrill.get(drillKey).push(r);
  }

  return DRILL_CATALOG_LIST.filter((d) => d.enabled).map((drill) => {
    const drillRows = rowsByDrill.get(drill.key) || [];

    if (drillRows.length === 0) {
      return {
        id: drill.key,
        drill,
        section: 'element',
        title: drill.title,
        group: drill.group,
        subgroup: drill.subgroup,
        settingsSummary: `${drill.questions} Qs · ${drill.time_limit_seconds}s limit`,
        hasRecord: false,
        scoreDisplay: '—',
        scoreNumeric: 0,
        timeSeconds: null,
        holders: [],
        isHeldByMe: false,
        attemptUrl: `/pages/element-drill.html?drill=${encodeURIComponent(drill.key)}`,
        attemptLabel: 'Set the record',
      };
    }

    // Sort: correct DESC, time_seconds ASC
    drillRows.sort((a, b) => {
      const corDiff = (Number(b.correct) || 0) - (Number(a.correct) || 0);
      if (corDiff !== 0) return corDiff;
      const timeA = Number(a.time_seconds) || 9999;
      const timeB = Number(b.time_seconds) || 9999;
      return timeA - timeB;
    });

    const bestRow = drillRows[0];
    const bestCorrect = Number(bestRow.correct) || 0;
    const bestTime = Number(bestRow.time_seconds) || drill.time_limit_seconds;

    const tiedRows = drillRows.filter((r) => {
      const c = Number(r.correct) || 0;
      const t = Number(r.time_seconds) || drill.time_limit_seconds;
      return c === bestCorrect && t === bestTime;
    });

    const holderStudentIds = Array.from(new Set(tiedRows.map((r) => r.student_id)));
    const holders = holderStudentIds
      .map((sid) => {
        const prof = profileMap.get(sid);
        if (!prof) return null;
        return {
          student_id: prof.id,
          student_code: prof.student_code,
          display_name: formatRecordHolderName(prof.full_name, prof.student_code),
          is_me: Boolean(currentStudentId && currentStudentId === prof.id),
        };
      })
      .filter(Boolean);

    const isHeldByMe = holders.some((h) => h.is_me);

    return {
      id: drill.key,
      drill,
      section: 'element',
      title: drill.title,
      group: drill.group,
      subgroup: drill.subgroup,
      settingsSummary: `${drill.questions} Qs · ${drill.time_limit_seconds}s limit`,
      hasRecord: true,
      scoreDisplay: `${bestCorrect} / ${drill.questions} in ${bestTime}s`,
      scoreNumeric: bestCorrect,
      timeSeconds: bestTime,
      holders,
      isHeldByMe,
      attemptUrl: `/pages/element-drill.html?drill=${encodeURIComponent(drill.key)}`,
      attemptLabel: isHeldByMe ? 'Defend record' : 'Attempt online',
    };
  });
}

/**
 * Computes strictly comparable Flash Anzan individual highest performance records.
 *
 * Ranking Rule (Independent Review Requirement):
 * Compare identical workloads (digits, count, mode).
 * Rank by fastest cleared flashing speed (MIN speed_ms with correct >= 1).
 * Genuine ties share the record.
 */
export function computeFlashRecords({
  activityResults = [],
  profiles = [],
  currentStudentId = null,
} = {}) {
  const profileMap = new Map();
  for (const p of profiles) {
    if (p && p.id && isStudentEligibleForRecords(p)) {
      profileMap.set(p.id, p);
    }
  }

  const eligibleRows = activityResults.filter((r) => {
    if (!r || !r.student_id || r.activity_type !== 'flash_anzan') return false;
    if (Number(r.correct) < 1) return false; // Must be a cleared try
    if (!profileMap.has(r.student_id)) return false;
    if (!isScoreEligibleForRecords(r)) return false;
    return true;
  });

  return FLASH_RECORD_BENCHMARKS.map((bm) => {
    const matchedRows = eligibleRows.filter((r) => {
      const s = r.settings || {};
      const d = Number(s.digits);
      const c = Number(s.count);
      const m = s.mode === 'add_sub' ? 'add_sub' : 'add';
      return d === bm.digits && c === bm.count && m === bm.mode;
    });

    if (matchedRows.length === 0) {
      return {
        id: bm.key,
        benchmark: bm,
        section: 'flash',
        title: bm.title,
        description: bm.description,
        settingsSummary: `${bm.digits}d · ${bm.count}n · ${bm.mode === 'add_sub' ? 'Add & Sub' : 'Add'}`,
        rawSettings: {
          digits: bm.digits,
          count: bm.count,
          mode: bm.mode,
        },
        hasRecord: false,
        scoreDisplay: '—',
        scoreNumeric: 0,
        holders: [],
        isHeldByMe: false,
        attemptLabel: 'Set the record',
      };
    }

    // Sort by fastest speed (speed_ms ASC)
    matchedRows.sort((a, b) => {
      const spA = Number(a.settings?.speed_ms) || 9999;
      const spB = Number(b.settings?.speed_ms) || 9999;
      return spA - spB;
    });

    const bestSpeed = Number(matchedRows[0].settings?.speed_ms) || 1000;

    // Genuine ties: all students who cleared at the best speed
    const tiedRows = matchedRows.filter((r) => {
      const sp = Number(r.settings?.speed_ms) || 1000;
      return sp === bestSpeed;
    });

    const holderStudentIds = Array.from(new Set(tiedRows.map((r) => r.student_id)));
    const holders = holderStudentIds
      .map((sid) => {
        const prof = profileMap.get(sid);
        if (!prof) return null;
        return {
          student_id: prof.id,
          student_code: prof.student_code,
          display_name: formatRecordHolderName(prof.full_name, prof.student_code),
          is_me: Boolean(currentStudentId && currentStudentId === prof.id),
        };
      })
      .filter(Boolean);

    const isHeldByMe = holders.some((h) => h.is_me);

    return {
      id: bm.key,
      benchmark: bm,
      section: 'flash',
      title: bm.title,
      description: bm.description,
      settingsSummary: `${bm.digits}d · ${bm.count}n · ${(bestSpeed / 1000).toFixed(1)}s`,
      rawSettings: {
        digits: bm.digits,
        count: bm.count,
        speed_ms: bestSpeed,
        mode: bm.mode,
      },
      hasRecord: true,
      scoreDisplay: `${bestSpeed}ms / number (${(bestSpeed / 1000).toFixed(1)}s)`,
      scoreNumeric: bestSpeed,
      holders,
      isHeldByMe,
      attemptLabel: isHeldByMe ? 'Defend record' : 'Attempt online',
    };
  });
}

/**
 * Computes strictly comparable Memoriad records per module using official scoring.
 */
export function computeMemoriadRecords({
  activityResults = [],
  profiles = [],
  currentStudentId = null,
} = {}) {
  const profileMap = new Map();
  for (const p of profiles) {
    if (p && p.id && isStudentEligibleForRecords(p)) {
      profileMap.set(p.id, p);
    }
  }

  const eligibleRows = activityResults.filter((r) => {
    if (!r || !r.student_id || r.activity_type !== 'memoriad') return false;
    if (!profileMap.has(r.student_id)) return false;
    if (!isScoreEligibleForRecords(r)) return false;
    return true;
  });

  const rowsByModule = new Map();
  for (const r of eligibleRows) {
    const modKey = r.settings?.module || r.settings?.module_key || r.activity_name || '';
    if (!modKey) continue;
    if (!rowsByModule.has(modKey)) rowsByModule.set(modKey, []);
    rowsByModule.get(modKey).push(r);
  }

  return MEMORIAD_MODULE_CATALOG.filter((m) => m.available).map((mod) => {
    const modRows = rowsByModule.get(mod.key) || [];

    if (modRows.length === 0) {
      return {
        id: mod.key,
        module: mod,
        section: 'memoriad',
        title: mod.title,
        badge: mod.badge,
        settingsSummary: mod.badge,
        hasRecord: false,
        scoreDisplay: '—',
        scoreNumeric: 0,
        holders: [],
        isHeldByMe: false,
        attemptUrl: `/pages/memoriad-play.html?module=${encodeURIComponent(mod.key)}`,
        attemptLabel: 'Set the record',
      };
    }

    // Sort: official_score DESC, time_seconds ASC
    modRows.sort((a, b) => {
      const scoreA = Number(a.settings?.score != null ? a.settings.score : a.correct) || 0;
      const scoreB = Number(b.settings?.score != null ? b.settings.score : b.correct) || 0;
      const scDiff = scoreB - scoreA;
      if (scDiff !== 0) return scDiff;
      const timeA = Number(a.settings?.used_seconds != null ? a.settings.used_seconds : a.time_seconds) || 9999;
      const timeB = Number(b.settings?.used_seconds != null ? b.settings.used_seconds : b.time_seconds) || 9999;
      return timeA - timeB;
    });

    const bestRow = modRows[0];
    const bestScore = Number(bestRow.settings?.score != null ? bestRow.settings.score : bestRow.correct) || 0;
    const bestTime = Number(bestRow.settings?.used_seconds != null ? bestRow.settings.used_seconds : bestRow.time_seconds) || 300;

    const tiedRows = modRows.filter((r) => {
      const s = Number(r.settings?.score != null ? r.settings.score : r.correct) || 0;
      const t = Number(r.settings?.used_seconds != null ? r.settings.used_seconds : r.time_seconds) || 300;
      return s === bestScore && t === bestTime;
    });

    const holderStudentIds = Array.from(new Set(tiedRows.map((r) => r.student_id)));
    const holders = holderStudentIds
      .map((sid) => {
        const prof = profileMap.get(sid);
        if (!prof) return null;
        return {
          student_id: prof.id,
          student_code: prof.student_code,
          display_name: formatRecordHolderName(prof.full_name, prof.student_code),
          is_me: Boolean(currentStudentId && currentStudentId === prof.id),
        };
      })
      .filter(Boolean);

    const isHeldByMe = holders.some((h) => h.is_me);

    let scoreDisplay = `${bestScore} points in ${bestTime}s`;
    if (mod.key === 'calendar') {
      scoreDisplay = `${bestScore} dates in ${bestTime}s`;
    }

    return {
      id: mod.key,
      module: mod,
      section: 'memoriad',
      title: mod.title,
      badge: mod.badge,
      settingsSummary: `${mod.badge} · ${bestTime}s`,
      hasRecord: true,
      scoreDisplay,
      scoreNumeric: bestScore,
      timeSeconds: bestTime,
      holders,
      isHeldByMe,
      attemptUrl: `/pages/memoriad-play.html?module=${encodeURIComponent(mod.key)}`,
      attemptLabel: isHeldByMe ? 'Defend record' : 'Attempt online',
    };
  });
}

/**
 * Normalizes a raw record object (from SQL RPC or computation) into the exact contract
 * required by renderRecordCardHtml.
 *
 * @param {Object} r
 * @param {'basics'|'element'|'flash'|'memoriad'} section
 * @param {string|null} currentStudentId
 * @param {Object} options
 * @returns {Object}
 */
export function normalizeRecordForRenderer(r, section, currentStudentId = null, options = {}) {
  if (!r) return null;
  const isHeldByMe = Boolean(
    r.isHeldByMe ??
    r.caller_holds ??
    (Array.isArray(r.holders) && currentStudentId && r.holders.some((h) => h.student_id === currentStudentId))
  );

  const hasRecord = Boolean(
    r.hasRecord ??
    r.has_record ??
    (r.correct != null || r.score != null || r.speed_ms != null)
  );

  let title = r.title || r.category_name || r.drill_key || r.module_key || 'Record';
  let settingsSummary = r.settingsSummary || r.settings_summary || '';
  let scoreDisplay = r.scoreDisplay || r.score_display || (hasRecord ? 'Recorded' : 'No record yet');
  let attemptUrl = r.attemptUrl || r.attempt_url || '#';
  let attemptLabel = r.attemptLabel || r.attempt_label || (isHeldByMe ? 'Defend record' : 'Attempt online');
  let rawSettings = r.rawSettings || r.raw_settings || {};

  if (section === 'basics') {
    const dur = r.durationSeconds || r.duration_seconds || options.durationSeconds || DEFAULT_BASICS_RECORD_DURATION;
    if (!settingsSummary) settingsSummary = `${dur} seconds`;
    if (!attemptUrl || attemptUrl === '#') {
      attemptUrl = `/pages/basics-practice.html?cat=${encodeURIComponent(r.category_id || r.id)}&seconds=${dur}`;
    }
    if (hasRecord && !r.scoreDisplay && !r.score_display) {
      scoreDisplay = `${r.correct ?? 0} correct (${r.wrong ?? 0} wrong)`;
    }
  } else if (section === 'flash') {
    const digits = r.digits ?? rawSettings.digits ?? 1;
    const count = r.count ?? rawSettings.count ?? 10;
    const mode = r.mode ?? rawSettings.mode ?? 'add';
    const speedMs = r.speed_ms ?? rawSettings.speed_ms;
    if (!title || title === 'Record') {
      title = `${digits} Digit${digits > 1 ? 's' : ''} · ${count} Numbers · ${mode === 'add_sub' ? 'Add & Subtract' : 'Add'}`;
    }
    if (!settingsSummary) settingsSummary = `${digits}d · ${count}n · ${mode}`;
    if (!rawSettings.digits) {
      rawSettings = { digits, count, mode, speed_ms: speedMs || 1000 };
    }
    if (!attemptUrl || attemptUrl === '#') {
      attemptUrl = `/pages/flash.html?digits=${digits}&count=${count}&speed=${speedMs || 1000}&mode=${mode}`;
    }
    if (hasRecord && !r.scoreDisplay && !r.score_display) {
      const sec = speedMs ? (speedMs / 1000).toFixed(3) : '—';
      scoreDisplay = `${sec}s (${speedMs || '—'} ms)`;
    }
  } else if (section === 'element') {
    const drill = r.drill_key || r.id;
    const drillObj = DRILL_CATALOG_LIST.find((d) => d.id === drill || d.key === drill);
    if (!title || title === 'Record') {
      title = drillObj?.title || drill;
    }
    if (!settingsSummary) settingsSummary = drillObj?.category || 'Worksheet Drill';
    if (!attemptUrl || attemptUrl === '#') {
      attemptUrl = `/pages/element-drill.html?drill=${encodeURIComponent(drill)}`;
    }
    if (hasRecord && !r.scoreDisplay && !r.score_display) {
      scoreDisplay = `${r.correct ?? 0} correct · ${r.time_seconds ?? 0}s`;
    }
  } else if (section === 'memoriad') {
    const mod = r.module_key || r.id;
    const modObj = MEMORIAD_MODULE_CATALOG.find((m) => m.id === mod || m.key === mod);
    const datesTier = r.dates_tier || (mod === 'calendar' ? 125 : null);
    if (!title || title === 'Record') {
      title = mod === 'calendar' ? `Calendar (${datesTier || 125} Dates)` : (modObj?.title || mod);
    }
    if (!settingsSummary) {
      settingsSummary = mod === 'calendar' ? `${datesTier || 125} dates` : (modObj?.description || 'Competition Module');
    }
    if (!attemptUrl || attemptUrl === '#') {
      attemptUrl = `/pages/memoriad-play.html?module=${encodeURIComponent(mod)}${datesTier ? `&dates=${datesTier}` : ''}`;
    }
    if (hasRecord && !r.scoreDisplay && !r.score_display) {
      scoreDisplay = `${r.score ?? r.official_score ?? 0} pts · ${r.used_seconds ?? 0}s`;
    }
  }

  return {
    ...r,
    id: r.id || r.category_id || r.drill_key || r.module_key,
    section,
    title,
    hasRecord,
    has_record: hasRecord,
    scoreDisplay,
    score_display: scoreDisplay,
    settingsSummary,
    settings_summary: settingsSummary,
    holders: Array.isArray(r.holders) ? r.holders : [],
    isHeldByMe,
    attemptUrl,
    attemptLabel,
    rawSettings,
  };
}

/**
 * Loads practice highest records across sections from server/database RPC.
 * Strictly throws if the database query fails, ensuring honest error display.
 *
 * @param {'basics'|'element'|'flash'|'memoriad'} section
 * @param {Object} options - e.g. { durationSeconds: 60 }
 * @param {Object|null} callerProfile
 * @returns {Promise<Array<Object>>}
 */
export async function loadPracticeHighestRecords(section, options = {}, callerProfile = null) {
  const currentStudentId = callerProfile?.id || null;

  if (isSupabaseConfigured()) {
    const supabase = await getSupabase();
    if (supabase) {
      const { data, error } = await supabase.rpc('practice_highest_records', {
        p_section: section,
        p_options: options,
      });

      if (error) {
        throw new Error(error.message || 'Database error loading records');
      }

      if (Array.isArray(data)) {
        return data.map((r) => normalizeRecordForRenderer(r, section, currentStudentId, options));
      }
      return [];
    }
  }

  // DemoDB fallback
  if (isDemoAllowedHost() && DemoDB) {
    let raw = [];
    if (typeof DemoDB.practiceHighestRecords === 'function') {
      raw = DemoDB.practiceHighestRecords(section, options, callerProfile);
    } else if (typeof DemoDB.getHighestRecords === 'function') {
      raw = DemoDB.getHighestRecords(section, options, callerProfile);
    }
    if (Array.isArray(raw)) {
      return raw.map((r) => normalizeRecordForRenderer(r, section, currentStudentId, options));
    }
  }

  return [];
}
