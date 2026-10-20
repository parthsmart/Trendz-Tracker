/**
 * Unit tests for js/calendarKeys.js (Phase 9b-1)
 * Run with: node --test tests/calendarKeys.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dayForKey, primaryKeyForDay } from '../js/calendarKeys.js';

describe('js/calendarKeys.js — dayForKey weekday mapping (0 = Monday .. 6 = Sunday)', () => {
  it('maps 0..7 with default Saturday (5): 0->Sat, 1->Sun, 2->Mon, ..., 7->Sat', () => {
    assert.equal(dayForKey('0'), 5); // Saturday
    assert.equal(dayForKey('1'), 6); // Sunday
    assert.equal(dayForKey('2'), 0); // Monday
    assert.equal(dayForKey('3'), 1); // Tuesday
    assert.equal(dayForKey('4'), 2); // Wednesday
    assert.equal(dayForKey('5'), 3); // Thursday
    assert.equal(dayForKey('6'), 4); // Friday
    assert.equal(dayForKey('7'), 5); // Saturday (same as key 0)
  });

  it('maps 0..7 when key 0 is set to Wednesday (2): 0->Wed, 1->Thu, 2->Fri, 3->Sat, 4->Sun, 5->Mon, 6->Tue, 7->Wed', () => {
    const wednesday = 2;
    assert.equal(dayForKey('0', wednesday), 2); // Wednesday
    assert.equal(dayForKey('1', wednesday), 3); // Thursday
    assert.equal(dayForKey('2', wednesday), 4); // Friday
    assert.equal(dayForKey('3', wednesday), 5); // Saturday
    assert.equal(dayForKey('4', wednesday), 6); // Sunday
    assert.equal(dayForKey('5', wednesday), 0); // Monday
    assert.equal(dayForKey('6', wednesday), 1); // Tuesday
    assert.equal(dayForKey('7', wednesday), 2); // Wednesday (same as key 0)
  });

  it('returns null for keys outside 0..7', () => {
    assert.equal(dayForKey('8'), null);
    assert.equal(dayForKey('9'), null);
    assert.equal(dayForKey('a'), null);
    assert.equal(dayForKey('+'), null);
    assert.equal(dayForKey(''), null);
    assert.equal(dayForKey(null), null);
    assert.equal(dayForKey(undefined), null);
  });

  it('computes the primary shortcut key 0..6 for any weekday button', () => {
    assert.equal(primaryKeyForDay(5, 5), 0); // Saturday when key 0 is Saturday
    assert.equal(primaryKeyForDay(0, 5), 2); // Monday when key 0 is Saturday
    assert.equal(primaryKeyForDay(2, 2), 0); // Wednesday when key 0 is Wednesday
  });
});
