/**
 * Unit tests for js/answerSlots.js (Phase 9b-1 & Phase 9b-1b)
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

describe('js/answerSlots.js — Right-to-Left (rtl) mode with g = 1', () => {
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

    // Backspace in rtl clears the most recently typed slot (slot 8) and moves cursor to 8
    st = backspace(st);
    assert.equal(st.slots[8], '');
    assert.equal(st.cursor, 8);
    assert.equal(toAnswerString(st), '21');
  });
});

describe('js/answerSlots.js — Group typing (rtl, g = 2, 3, 4)', () => {
  it('g = 2 with 11 slots: typing 1, 2, 3, 4 gives slots 7..10 = 3, 4, 1, 2 ("3412")', () => {
    let st = createAnswerSlots(11, 'rtl', '', 2);
    assert.equal(st.cursor, 9); // 11 - 2 = 9

    st = typeDigit(st, '1');
    assert.equal(st.slots[9], '1');
    assert.equal(st.cursor, 10);

    st = typeDigit(st, '2');
    assert.equal(st.slots[10], '2');
    assert.equal(st.cursor, 7); // jumps to leftmost slot of next group [7, 8]

    st = typeDigit(st, '3');
    assert.equal(st.slots[7], '3');
    assert.equal(st.cursor, 8);

    st = typeDigit(st, '4');
    assert.equal(st.slots[8], '4');
    assert.equal(st.cursor, 5);

    assert.deepEqual(st.slots.slice(7, 11), ['3', '4', '1', '2']);
    assert.equal(toAnswerString(st), '3412');
  });

  it('g = 2 with 11 slots: typing pairs until slot 1, then the last digit lands in slot 0', () => {
    let st = createAnswerSlots(11, 'rtl', '', 2);
    // Type 5 pairs (10 digits): [9,10], [7,8], [5,6], [3,4], [1,2]
    const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
    for (const d of digits) {
      st = typeDigit(st, d);
    }
    assert.equal(st.slots[1], '9');
    assert.equal(st.slots[2], '0');
    assert.equal(st.cursor, 0); // leftmost partial group [0]

    // 11th digit lands in slot 0
    st = typeDigit(st, '7');
    assert.equal(st.slots[0], '7');
    assert.equal(st.typedCount, 11);
    assert.equal(toAnswerString(st), '79078563412');
  });

  it('g = 3 and g = 4 examples including leftmost partial groups', () => {
    // g = 3: groups are [8,9,10], [5,6,7], [2,3,4], [0,1] (11 mod 3 = 2 slots)
    let st3 = createAnswerSlots(11, 'rtl', '', 3);
    assert.equal(st3.cursor, 8);
    for (const d of ['1', '2', '3']) st3 = typeDigit(st3, d);
    assert.deepEqual(st3.slots.slice(8, 11), ['1', '2', '3']);
    assert.equal(st3.cursor, 5);
    for (const d of ['4', '5', '6', '7', '8', '9']) st3 = typeDigit(st3, d);
    assert.equal(st3.cursor, 0); // jumps to leftmost partial group [0, 1]
    st3 = typeDigit(st3, '8');
    assert.equal(st3.slots[0], '8');
    assert.equal(st3.cursor, 1);
    st3 = typeDigit(st3, '9');
    assert.equal(st3.slots[1], '9');
    assert.equal(toAnswerString(st3), '89789456123');

    // g = 4: groups are [7,8,9,10], [3,4,5,6], [0,1,2] (11 mod 4 = 3 slots)
    let st4 = createAnswerSlots(11, 'rtl', '', 4);
    assert.equal(st4.cursor, 7);
    for (const d of ['1', '2', '3', '4']) st4 = typeDigit(st4, d);
    assert.deepEqual(st4.slots.slice(7, 11), ['1', '2', '3', '4']);
    assert.equal(st4.cursor, 3);
    for (const d of ['5', '6', '7', '8']) st4 = typeDigit(st4, d);
    assert.deepEqual(st4.slots.slice(3, 7), ['5', '6', '7', '8']);
    assert.equal(st4.cursor, 0); // leftmost partial group [0, 1, 2]
    st4 = typeDigit(st4, '9');
    assert.equal(st4.slots[0], '9');
    assert.equal(st4.cursor, 1);
    st4 = typeDigit(st4, '0');
    assert.equal(st4.slots[1], '0');
    assert.equal(st4.cursor, 2);
    st4 = typeDigit(st4, '1');
    assert.equal(st4.slots[2], '1');
    assert.equal(toAnswerString(st4), '90156781234');
  });

  it('supports backspace in the middle of a group and across group boundaries using typing history', () => {
    let st = createAnswerSlots(11, 'rtl', '', 3);
    st = typeDigit(st, '1'); // slot 8 = '1', cursor = 9
    st = typeDigit(st, '2'); // slot 9 = '2', cursor = 10
    st = typeDigit(st, '3'); // slot 10 = '3', cursor = 5 (next group)
    st = typeDigit(st, '4'); // slot 5 = '4', cursor = 6 (middle of second group)

    // Backspace in middle of second group removes '4' at slot 5 and restores cursor to 5
    st = backspace(st);
    assert.equal(st.slots[5], '');
    assert.equal(st.cursor, 5);
    assert.equal(toAnswerString(st), '123');

    // Backspace again removes '3' at slot 10 and restores cursor to 10
    st = backspace(st);
    assert.equal(st.slots[10], '');
    assert.equal(st.cursor, 10);
    assert.equal(toAnswerString(st), '12');

    // Typing '9' now puts '9' at slot 10 and jumps to slot 5
    st = typeDigit(st, '9');
    assert.equal(st.slots[10], '9');
    assert.equal(st.cursor, 5);
    assert.equal(toAnswerString(st), '129');
  });

  it('supports Left/Right arrows then typing (overwrites and continues by group rules) and Enter compaction', () => {
    let st = createAnswerSlots(11, 'rtl', '', 2);
    st = typeDigit(st, '1'); // slot 9 = '1', cursor = 10
    st = typeDigit(st, '2'); // slot 10 = '2', cursor = 7
    // Use arrows to move left to slot 5 (leaving [7, 8] blank)
    st = moveCursorLeft(st); // 6
    st = moveCursorLeft(st); // 5
    assert.equal(st.cursor, 5);

    // Type '8' at slot 5 -> cursor moves right inside group [5, 6] to 6
    st = typeDigit(st, '8');
    assert.equal(st.slots[5], '8');
    assert.equal(st.cursor, 6);
    st = typeDigit(st, '9');
    assert.equal(st.slots[6], '9');
    assert.equal(st.cursor, 3); // jumps to next group [3, 4]

    // Enter compaction closes blank gap at [7, 8] and packs flush right to slots 7..10
    st = compact(st);
    assert.deepEqual(st.slots.slice(7, 11), ['8', '9', '1', '2']);
    assert.equal(toAnswerString(st), '8912');
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
