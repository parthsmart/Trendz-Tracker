import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROFILE_CACHE_TTL_MS,
  sanitizeCachedProfile,
  readProfileCache,
  writeProfileCache,
  clearProfileCache,
} from '../js/profileCache.js';
import { shouldPrefetchHref } from '../js/perf.js';

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, val) {
      map.set(key, String(val));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

test('profileCache stores only permitted fields and respects 2-minute TTL', () => {
  const storage = createMemoryStorage();
  const rawProfile = {
    id: 'student-123',
    role: 'student',
    level: 'Level 3',
    full_name: 'Aarav Sharma',
    student_code: 'TRZ001',
    active: true,
    must_change_password: false,
    leaderboard_visible: true,
    secret_token: 'should-not-be-cached',
  };

  const sanitized = sanitizeCachedProfile(rawProfile);
  assert.equal(sanitized.id, 'student-123');
  assert.equal(sanitized.name, 'Aarav Sharma');
  assert.equal(sanitized.full_name, 'Aarav Sharma');
  assert.equal(sanitized.secret_token, undefined);

  const now = 1_700_000_000_000;
  const written = writeProfileCache(rawProfile, now, storage);
  assert.ok(written);
  assert.equal(written.id, 'student-123');

  // Hit within 2-minute TTL
  const hit = readProfileCache('student-123', now + 60_000, storage);
  assert.ok(hit);
  assert.equal(hit.id, 'student-123');
  assert.equal(hit.student_code, 'TRZ001');

  // Miss when user ID differs
  const wrongUser = readProfileCache('student-999', now + 60_000, storage);
  assert.equal(wrongUser, null);

  // Miss after 2-minute TTL expires
  const expired = readProfileCache('student-123', now + PROFILE_CACHE_TTL_MS + 1, storage);
  assert.equal(expired, null);

  // Clear cache explicitly
  writeProfileCache(rawProfile, now, storage);
  clearProfileCache(storage);
  assert.equal(readProfileCache('student-123', now + 1000, storage), null);
});

test('shouldPrefetchHref skips Data-Saver, 2G, external links, and current page', () => {
  assert.equal(
    shouldPrefetchHref('/pages/leaderboard.html', '/pages/student.html', { saveData: false, effectiveType: '4g' }),
    true
  );

  // Skip when Data-Saver is enabled
  assert.equal(
    shouldPrefetchHref('/pages/leaderboard.html', '/pages/student.html', { saveData: true, effectiveType: '4g' }),
    false
  );

  // Skip on slow-2g or 2g connections
  assert.equal(
    shouldPrefetchHref('/pages/leaderboard.html', '/pages/student.html', { saveData: false, effectiveType: '2g' }),
    false
  );

  // Skip current page
  assert.equal(
    shouldPrefetchHref('/pages/student.html', '/pages/student.html', { saveData: false, effectiveType: '4g' }),
    false
  );

  // Skip hash links and API routes
  assert.equal(shouldPrefetchHref('#top', '/pages/student.html', null), false);
  assert.equal(shouldPrefetchHref('/api/basics-finish', '/pages/student.html', null), false);
  assert.equal(shouldPrefetchHref('https://example.com/page.html', '/pages/student.html', null), false);
});
