/**
 * Unit tests for js/answerSlots.js (Phase 9b-1)
 * Run with: node --test tests/answerSlots.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAnswerSlots,
  typeDigit,
  moveCursorLeft,
  moveCursorRight,
  setCursor,
  backspace,
  compact,
  toAnswerString,
} from '../js/answerSlots.js';

describe('js/answerSlots.js — Right-to-Left (rtl) mode', () => {
  it('starts at rightmost slot (10) and moves left as digits are typed', () => {
    let st = createAnswerSlots(11, 'rtl');
    assert.equal(st.cursor, 10);
    assert.equal(st.typedCount, 0);
    assert.equal(toAnswerString(st), '');

    st = typeDigit(st, '4');
    assert.equal(st.slots[10], '4');
    assert.equal(st.cursor, 9);
    assert.equal(st.typedCount, 1);

    st = typeDigit(st, '8');
    assert.equal(st.slots[9], '8');
    assert.equal(st.cursor, 8);
    assert.equal(st.typedCount, 2);
    assert.equal(toAnswerString(st), '84');
  });

  it('supports arrow cursor movement, backspace, and compacting gaps in rtl mode', () => {
    let st = createAnswerSlots(11, 'rtl');
    st = typeDigit(st, '1'); // slot 10 = '1', cursor = 9
    st = typeDigit(st, '2'); // slot 9 = '2', cursor = 8
    st = moveCursorLeft(st); // skip slot 8 -> cursor = 7
    st = typeDigit(st, '3'); // slot 7 = '3', cursor = 6

    // Currently slots 7='3', 8='', 9='2', 10='1'
    assert.equal(st.slots[8], '');
    assert.equal(toAnswerString(st), '321');

    // Compact closes the blank gap at slot 8 and packs flush right (slots 8='3', 9='2', 10='1')
    st = compact(st);
    assert.equal(st.slots[8], '3');
    assert.equal(st.slots[9], '2');
    assert.equal(st.slots[10], '1');
    assert.equal(st.slots[7], '');

    // Backspace in rtl clears the previously typed slot (slot 8) and moves cursor to 8
    st = backspace(st);
    assert.equal(st.slots[8], '');
    assert.equal(st.cursor, 8);
    assert.equal(toAnswerString(st), '21');
  });
});

describe('js/answerSlots.js — Left-to-Right (ltr) mode', () => {
  it('starts at leftmost slot (0) and moves right as digits are typed', () => {
    let st = createAnswerSlots(11, 'ltr');
    assert.equal(st.cursor, 0);

    st = typeDigit(st, '5');
    assert.equal(st.slots[0], '5');
    assert.equal(st.cursor, 1);

    st = typeDigit(st, '9');
    assert.equal(st.slots[1], '9');
    assert.equal(st.cursor, 2);
    assert.equal(toAnswerString(st), '59');
  });

  it('supports backspace, cursor movement, and compacting gaps in ltr mode', () => {
    let st = createAnswerSlots(11, 'ltr');
    st = typeDigit(st, '7'); // slot 0 = '7', cursor = 1
    st = moveCursorRight(st); // skip slot 1 -> cursor = 2
    st = typeDigit(st, '8'); // slot 2 = '8', cursor = 3

    st = compact(st);
    assert.equal(st.slots[0], '7');
    assert.equal(st.slots[1], '8');
    assert.equal(st.slots[2], '');
    assert.equal(st.cursor, 2);

    st = backspace(st);
    assert.equal(st.slots[1], '');
    assert.equal(st.cursor, 1);
    assert.equal(toAnswerString(st), '7');

    st = setCursor(st, 5);
    assert.equal(st.cursor, 5);
  });
});
