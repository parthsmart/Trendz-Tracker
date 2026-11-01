/**
 * Unit Tests for Pure Navigation Menu State (tests/navMenuState.test.js)
 *
 * Run with: node --test tests/navMenuState.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMenuState,
  openMenuState,
  closeMenuState,
  toggleMenuState,
  moveFocusIndex,
  trapTabFocusIndex,
  applyMenuKeyAction,
  isDedicatedStagePathname,
} from '../js/navMenuState.js';

test('openMenuState and closeMenuState manage focus index and returnFocusToButton', () => {
  const initial = createMenuState(8);
  assert.equal(initial.isOpen, false);
  assert.equal(initial.focusedIndex, -1);
  assert.equal(initial.returnFocusToButton, false);

  const opened = openMenuState(initial);
  assert.equal(opened.isOpen, true);
  assert.equal(opened.focusedIndex, 0);
  assert.equal(opened.returnFocusToButton, false);

  const closedWithFocus = closeMenuState(opened, { returnFocus: true });
  assert.equal(closedWithFocus.isOpen, false);
  assert.equal(closedWithFocus.focusedIndex, -1);
  assert.equal(closedWithFocus.returnFocusToButton, true);

  const closedWithoutFocus = closeMenuState(opened, { returnFocus: false });
  assert.equal(closedWithoutFocus.isOpen, false);
  assert.equal(closedWithoutFocus.returnFocusToButton, false);
});

test('toggleMenuState flips between open and closed', () => {
  const s0 = createMenuState(5);
  const s1 = toggleMenuState(s0);
  assert.equal(s1.isOpen, true);
  assert.equal(s1.focusedIndex, 0);

  const s2 = toggleMenuState(s1);
  assert.equal(s2.isOpen, false);
  assert.equal(s2.returnFocusToButton, true);
});

test('moveFocusIndex wraps around on ArrowDown, ArrowUp, Home, and End', () => {
  // 4 items: indices 0, 1, 2, 3
  assert.equal(moveFocusIndex(0, 4, 'ArrowDown'), 1);
  assert.equal(moveFocusIndex(2, 4, 'ArrowDown'), 3);
  assert.equal(moveFocusIndex(3, 4, 'ArrowDown'), 0); // wrap last -> first

  assert.equal(moveFocusIndex(0, 4, 'ArrowUp'), 3); // wrap first -> last
  assert.equal(moveFocusIndex(2, 4, 'ArrowUp'), 1);

  assert.equal(moveFocusIndex(2, 4, 'Home'), 0);
  assert.equal(moveFocusIndex(1, 4, 'End'), 3);

  // Empty menu safety
  assert.equal(moveFocusIndex(0, 0, 'ArrowDown'), -1);
});

test('trapTabFocusIndex traps Tab at the last item and Shift+Tab at the first item', () => {
  // Forward Tab inside items 0..3
  assert.deepEqual(trapTabFocusIndex(0, 4, false), { trapped: false, nextIndex: 1 });
  assert.deepEqual(trapTabFocusIndex(3, 4, false), { trapped: true, nextIndex: 0 });

  // Backward Shift+Tab inside items 0..3
  assert.deepEqual(trapTabFocusIndex(2, 4, true), { trapped: false, nextIndex: 1 });
  assert.deepEqual(trapTabFocusIndex(0, 4, true), { trapped: true, nextIndex: 3 });
});

test('applyMenuKeyAction handles Escape, Arrow keys, and Tab focus trapping', () => {
  let state = openMenuState(createMenuState(3));
  assert.equal(state.focusedIndex, 0);

  state = applyMenuKeyAction(state, 'ArrowDown');
  assert.equal(state.focusedIndex, 1);

  state = applyMenuKeyAction(state, 'ArrowDown');
  assert.equal(state.focusedIndex, 2);

  // Wrap around to 0
  state = applyMenuKeyAction(state, 'ArrowDown');
  assert.equal(state.focusedIndex, 0);

  // Shift+Tab wraps from 0 to 2
  state = applyMenuKeyAction(state, 'Tab', { shiftKey: true });
  assert.equal(state.focusedIndex, 2);

  // Escape closes and marks returnFocusToButton = true
  state = applyMenuKeyAction(state, 'Escape');
  assert.equal(state.isOpen, false);
  assert.equal(state.returnFocusToButton, true);
});

test('isDedicatedStagePathname identifies full-screen stage pages', () => {
  assert.equal(isDedicatedStagePathname('/pages/basics-practice.html'), true);
  assert.equal(isDedicatedStagePathname('/pages/element-drill.html'), true);
  assert.equal(isDedicatedStagePathname('/pages/memoriad-play.html'), true);

  assert.equal(isDedicatedStagePathname('/pages/student.html'), false);
  assert.equal(isDedicatedStagePathname('/pages/admin.html'), false);
  assert.equal(isDedicatedStagePathname('/pages/leaderboard.html'), false);
});
