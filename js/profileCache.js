/**
 * Trendz Tracker - SessionStorage Profile Cache (js/profileCache.js)
 *
 * Phase 15a (Candidate A):
 * - Caches {id, role, level, name, full_name, student_code, active, must_change_password, leaderboard_visible}
 *   in sessionStorage with a 2-minute TTL.
 * - Cleared on sign-out, on password change, and after any profile edit.
 * - Used ONLY to render quickly; always revalidated in the background and never used for security decisions.
 */

export const PROFILE_CACHE_KEY = 'tt_profile_cache_v1';
export const PROFILE_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Sanitizes a profile object down to the safe cached fields.
 *
 * @param {Record<string, any> | null | undefined} raw
 * @returns {Record<string, any> | null}
 */
export function sanitizeCachedProfile(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id || !raw.role) {
    return null;
  }
  const resolvedName = String(raw.full_name || raw.name || '').trim();
  return {
    id: String(raw.id),
    role: String(raw.role),
    level: raw.level ?? null,
    name: resolvedName,
    full_name: resolvedName,
    student_code: raw.student_code ?? null,
    active: raw.active !== false,
    must_change_password: Boolean(raw.must_change_password),
    leaderboard_visible: raw.leaderboard_visible !== false,
  };
}

/**
 * Reads the cached profile from sessionStorage if it exists, matches `expectedUserId` (when provided),
 * and is within the 2-minute TTL.
 *
 * @param {string | null} [expectedUserId=null]
 * @param {number} [now=Date.now()]
 * @param {Storage | null} [storage]
 * @returns {Record<string, any> | null}
 */
export function readProfileCache(
  expectedUserId = null,
  now = Date.now(),
  storage = typeof window !== 'undefined' ? window.sessionStorage : null
) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(PROFILE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.profile) return null;

    const ageMs = now - Number(parsed.ts || 0);
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > PROFILE_CACHE_TTL_MS) {
      storage.removeItem(PROFILE_CACHE_KEY);
      return null;
    }

    const sanitized = sanitizeCachedProfile(parsed.profile);
    if (!sanitized) return null;

    if (expectedUserId && String(sanitized.id) !== String(expectedUserId)) {
      return null;
    }

    return sanitized;
  } catch {
    return null;
  }
}

/**
 * Writes the sanitized profile to sessionStorage with a fresh timestamp.
 *
 * @param {Record<string, any>} profile
 * @param {number} [now=Date.now()]
 * @param {Storage | null} [storage]
 * @returns {Record<string, any> | null}
 */
export function writeProfileCache(
  profile,
  now = Date.now(),
  storage = typeof window !== 'undefined' ? window.sessionStorage : null
) {
  const sanitized = sanitizeCachedProfile(profile);
  if (!sanitized || !storage) return sanitized;

  try {
    storage.setItem(
      PROFILE_CACHE_KEY,
      JSON.stringify({
        ts: now,
        profile: sanitized,
      })
    );
  } catch {
    // Ignore storage quota or private mode errors
  }
  return sanitized;
}

/**
 * Clears the cached profile from sessionStorage.
 *
 * @param {Storage | null} [storage]
 */
export function clearProfileCache(
  storage = typeof window !== 'undefined' ? window.sessionStorage : null
) {
  if (!storage) return;
  try {
    storage.removeItem(PROFILE_CACHE_KEY);
  } catch {
    // Ignore storage errors
  }
}
