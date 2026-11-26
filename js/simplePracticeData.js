/**
 * Trendz Tracker — Simple practice data (js/simplePracticeData.js)
 *
 * Reads and saves Simple scores (table public.simple_practice_results).
 * Students save through the public.simple_practice_log RPC, which checks the
 * activity, the numbers, the date and the student's practice access.
 * In demo mode the scores live in localStorage.
 */

import { validateSimpleEntry } from './simplePractice.js';

export const DEMO_SIMPLE_STORAGE_KEY = 'trendz_demo_simple_practice_v1';
export const SIMPLE_HISTORY_LIMIT = 200;

function istToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

function readDemoRows() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(DEMO_SIMPLE_STORAGE_KEY) : null;
    const rows = raw ? JSON.parse(raw) : [];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function writeDemoRows(rows) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(DEMO_SIMPLE_STORAGE_KEY, JSON.stringify(rows));
}

/** Today's date in India time (server clock when available). */
export async function fetchSimpleToday({ supabase = null, isDemo = false } = {}) {
  if (isDemo || !supabase) return istToday();
  try {
    const { data, error } = await supabase.rpc('today_ist');
    if (!error && typeof data === 'string' && /^\d{4}-\d{2}-\d{2}/.test(data)) return data.slice(0, 10);
  } catch {
    // fall back to the browser clock
  }
  return istToday();
}

/** Newest first. */
export async function listSimpleResults(studentId, { supabase = null, isDemo = false } = {}) {
  if (isDemo || !supabase) {
    return readDemoRows()
      .filter((r) => r.student_id === studentId)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, SIMPLE_HISTORY_LIMIT);
  }
  const { data, error } = await supabase
    .from('simple_practice_results')
    .select('id, student_id, activity_key, source, correct, total, time_seconds, practiced_on, created_at')
    .eq('student_id', studentId)
    .order('created_at', { ascending: false })
    .limit(SIMPLE_HISTORY_LIMIT);
  if (error) throw new Error(error.message || 'Could not load your Simple scores.');
  return data || [];
}

/**
 * Saves a score for the signed-in student.
 * @returns {Promise<object>} the saved row
 */
export async function saveSimpleResult(studentId, entry, { supabase = null, isDemo = false, todayIST = null, rule = null } = {}) {
  const today = todayIST || istToday();
  const checked = validateSimpleEntry(entry, { todayIST: today, rule });
  if (checked.errors) throw new Error(checked.errors.join(' '));
  const v = checked.value;

  if (isDemo || !supabase) {
    const row = {
      id: `simple-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      student_id: studentId,
      ...v,
      practiced_on: v.practiced_on || today,
      created_at: new Date().toISOString(),
    };
    writeDemoRows([row, ...readDemoRows()]);
    return row;
  }

  const { data, error } = await supabase.rpc('simple_practice_log', {
    p_activity_key: v.activity_key,
    p_source: v.source,
    p_correct: v.correct,
    p_total: v.total,
    p_time_seconds: v.time_seconds,
    p_practiced_on: v.practiced_on,
  });
  if (error) throw new Error(error.message || 'Could not save your score.');
  return data;
}

/** Deletes one of the student's own offline logs. */
export async function deleteSimpleResult(studentId, id, { supabase = null, isDemo = false } = {}) {
  if (isDemo || !supabase) {
    writeDemoRows(readDemoRows().filter((r) => !(r.id === id && r.student_id === studentId)));
    return true;
  }
  const { error } = await supabase.rpc('simple_practice_delete', { p_id: id });
  if (error) throw new Error(error.message || 'Could not delete this entry.');
  return true;
}
