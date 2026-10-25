/**
 * Trendz Tracker - Unit Tests for Admin Profile Editing Form Logic (tests/profileForm.test.js)
 *
 * Run with: node --test tests/*.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectExistingLevels,
  diffProfileFields,
  formatProfileAuditChanges,
  normalizeProfileInput,
  suggestLevel
} from '../js/profileForm.js';

describe('normalizeProfileInput — trimming, length limits, and empty level becomes null', () => {
  it('trims full_name and level, and normalizes booleans', () => {
    const res = normalizeProfileInput({
      full_name: '  Aarav Sharma  ',
      level: '  Junior 1  ',
      leaderboard_visible: true,
      active: false
    });

    assert.equal(res.errors, undefined);
    assert.deepEqual(res.value, {
      full_name: 'Aarav Sharma',
      level: 'Junior 1',
      leaderboard_visible: true,
      active: false
    });
  });

  it('turns empty or whitespace-only level into null (never an empty string)', () => {
    const resEmpty = normalizeProfileInput({
      full_name: 'Riya Sen',
      level: ''
    });
    assert.equal(resEmpty.errors, undefined);
    assert.equal(resEmpty.value.level, null);

    const resSpaces = normalizeProfileInput({
      full_name: 'Riya Sen',
      level: '    '
    });
    assert.equal(resSpaces.errors, undefined);
    assert.equal(resSpaces.value.level, null);
  });

  it('enforces full_name length between 2 and 60 characters', () => {
    const tooShort = normalizeProfileInput({ full_name: 'A', level: 'Level 1' });
    assert.ok(tooShort.errors?.full_name);

    const blank = normalizeProfileInput({ full_name: '   ', level: 'Level 1' });
    assert.ok(blank.errors?.full_name);

    const minOk = normalizeProfileInput({ full_name: 'Ab', level: null });
    assert.equal(minOk.errors, undefined);
    assert.equal(minOk.value.full_name, 'Ab');

    const maxOk = normalizeProfileInput({ full_name: 'A'.repeat(60), level: null });
    assert.equal(maxOk.errors, undefined);
    assert.equal(maxOk.value.full_name.length, 60);

    const tooLong = normalizeProfileInput({ full_name: 'A'.repeat(61), level: null });
    assert.ok(tooLong.errors?.full_name);
  });

  it('enforces level length up to 30 characters when non-empty', () => {
    const oneChar = normalizeProfileInput({ full_name: 'Riya Sen', level: 'A' });
    assert.equal(oneChar.errors, undefined);
    assert.equal(oneChar.value.level, 'A');

    const maxLevel = normalizeProfileInput({ full_name: 'Riya Sen', level: 'L'.repeat(30) });
    assert.equal(maxLevel.errors, undefined);
    assert.equal(maxLevel.value.level.length, 30);

    const tooLongLevel = normalizeProfileInput({ full_name: 'Riya Sen', level: 'L'.repeat(31) });
    assert.ok(tooLongLevel.errors?.level);
  });
});

describe('suggestLevel — case-insensitive level suggestion', () => {
  const levels = ['Junior 1', 'Level 2', 'Master'];

  it('returns the canonical level when typed matches except for upper or lower case', () => {
    assert.equal(suggestLevel(levels, 'junior 1'), 'Junior 1');
    assert.equal(suggestLevel(levels, 'JUNIOR 1'), 'Junior 1');
    assert.equal(suggestLevel(levels, '  jUnIoR 1  '), 'Junior 1');
    assert.equal(suggestLevel(levels, 'level 2'), 'Level 2');
    assert.equal(suggestLevel(levels, 'MASTER'), 'Master');
  });

  it('returns null when typed already has the exact canonical casing', () => {
    assert.equal(suggestLevel(levels, 'Junior 1'), null);
    assert.equal(suggestLevel(levels, '  Junior 1  '), null);
    assert.equal(suggestLevel(levels, 'Level 2'), null);
  });

  it('returns null when typed does not match any existing level or is empty', () => {
    assert.equal(suggestLevel(levels, 'Senior 4'), null);
    assert.equal(suggestLevel(levels, ''), null);
    assert.equal(suggestLevel(levels, '   '), null);
    assert.equal(suggestLevel([], 'junior 1'), null);
  });
});

describe('diffProfileFields & formatProfileAuditChanges — single update diffing and audit display', () => {
  it('returns only the fields that actually changed and never includes student_code or role', () => {
    const original = {
      id: 'usr-101',
      student_code: 'STU101',
      role: 'student',
      full_name: 'Aarav Sharma',
      level: 'Level 1',
      leaderboard_visible: true,
      active: true
    };

    const normalized = {
      full_name: 'Aarav Sharma',
      level: 'Level 2',
      leaderboard_visible: false,
      active: true
    };

    const diff = diffProfileFields(original, normalized);
    assert.deepEqual(diff, {
      level: 'Level 2',
      leaderboard_visible: false
    });
    assert.equal('student_code' in diff, false);
    assert.equal('role' in diff, false);
  });

  it('collects distinct levels and formats audit changes cleanly', () => {
    const levels = collectExistingLevels([
      { level: 'Level 2' },
      { level: 'Junior 1' },
      { level: 'level 2' },
      { level: '' }
    ]);
    assert.deepEqual(levels, ['Junior 1', 'Level 2']);

    const changes = formatProfileAuditChanges(
      { level: 'Level 1', leaderboard_visible: true },
      { level: null, leaderboard_visible: false }
    );
    assert.deepEqual(changes, [
      {
        field: 'level',
        label: 'Level',
        oldDisplay: 'Level 1',
        newDisplay: 'None (All levels)'
      },
      {
        field: 'leaderboard_visible',
        label: 'Show on leaderboards',
        oldDisplay: 'Shown',
        newDisplay: 'Hidden'
      }
    ]);
  });
});
