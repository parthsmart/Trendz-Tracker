/**
 * Unit tests for js/competitionKeys.js (Phase 8c)
 * Run with: node --test tests/competitionKeys.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { keyAction } from '../js/competitionKeys.js';

describe('keyAction — shared competition & worksheet keyboard shortcuts', () => {
  it('returns "next" for normal "+" key and NumpadAdd', () => {
    assert.equal(
      keyAction({ key: '+', code: 'Equal', ctrlKey: false, altKey: false, metaKey: false }),
      'next'
    );
    assert.equal(
      keyAction({ key: '+', code: 'NumpadAdd', ctrlKey: false, altKey: false, metaKey: false }),
      'next'
    );
    assert.equal(
      keyAction({ key: 'Add', code: 'NumpadAdd', ctrlKey: false, altKey: false, metaKey: false }),
      'next'
    );
  });

  it('returns "previous" for normal "-" (hyphen-minus), Unicode minus sign "−", and NumpadSubtract', () => {
    assert.equal(
      keyAction({ key: '-', code: 'Minus', ctrlKey: false, altKey: false, metaKey: false }),
      'previous'
    );
    assert.equal(
      keyAction({ key: '\u2212', code: 'Minus', ctrlKey: false, altKey: false, metaKey: false }),
      'previous'
    );
    assert.equal(
      keyAction({ key: '−', code: '', ctrlKey: false, altKey: false, metaKey: false }),
      'previous'
    );
    assert.equal(
      keyAction({ key: '-', code: 'NumpadSubtract', ctrlKey: false, altKey: false, metaKey: false }),
      'previous'
    );
    assert.equal(
      keyAction({ key: 'Subtract', code: 'NumpadSubtract', ctrlKey: false, altKey: false, metaKey: false }),
      'previous'
    );
  });

  it('returns "step" for normal "*" key and NumpadMultiply', () => {
    assert.equal(
      keyAction({ key: '*', code: 'Digit8', ctrlKey: false, altKey: false, metaKey: false }),
      'step'
    );
    assert.equal(
      keyAction({ key: '*', code: 'NumpadMultiply', ctrlKey: false, altKey: false, metaKey: false }),
      'step'
    );
    assert.equal(
      keyAction({ key: 'Multiply', code: 'NumpadMultiply', ctrlKey: false, altKey: false, metaKey: false }),
      'step'
    );
  });

  it('returns "unstep" for normal "/" key and NumpadDivide', () => {
    assert.equal(
      keyAction({ key: '/', code: 'Slash', ctrlKey: false, altKey: false, metaKey: false }),
      'unstep'
    );
    assert.equal(
      keyAction({ key: '/', code: 'NumpadDivide', ctrlKey: false, altKey: false, metaKey: false }),
      'unstep'
    );
    assert.equal(
      keyAction({ key: 'Divide', code: 'NumpadDivide', ctrlKey: false, altKey: false, metaKey: false }),
      'unstep'
    );
  });

  it('returns null whenever ctrlKey, altKey, or metaKey is pressed', () => {
    // Ctrl combinations (e.g. browser zoom in/out Ctrl + / Ctrl -)
    assert.equal(
      keyAction({ key: '+', code: 'Equal', ctrlKey: true, altKey: false, metaKey: false }),
      null
    );
    assert.equal(
      keyAction({ key: '-', code: 'NumpadSubtract', ctrlKey: true, altKey: false, metaKey: false }),
      null
    );
    assert.equal(
      keyAction({ key: '*', code: 'NumpadMultiply', ctrlKey: true, altKey: false, metaKey: false }),
      null
    );
    assert.equal(
      keyAction({ key: '/', code: 'NumpadDivide', ctrlKey: true, altKey: false, metaKey: false }),
      null
    );

    // Alt combinations
    assert.equal(
      keyAction({ key: '+', code: 'NumpadAdd', ctrlKey: false, altKey: true, metaKey: false }),
      null
    );
    assert.equal(
      keyAction({ key: '-', code: 'Minus', ctrlKey: false, altKey: true, metaKey: false }),
      null
    );
    assert.equal(
      keyAction({ key: '*', code: 'Digit8', ctrlKey: false, altKey: true, metaKey: false }),
      null
    );
    assert.equal(
      keyAction({ key: '/', code: 'Slash', ctrlKey: false, altKey: true, metaKey: false }),
      null
    );

    // Meta (Cmd/Win) combinations
    assert.equal(
      keyAction({ key: '+', code: 'Equal', ctrlKey: false, altKey: false, metaKey: true }),
      null
    );
    assert.equal(
      keyAction({ key: '-', code: 'Minus', ctrlKey: false, altKey: false, metaKey: true }),
      null
    );
    assert.equal(
      keyAction({ key: '*', code: 'NumpadMultiply', ctrlKey: false, altKey: false, metaKey: true }),
      null
    );
    assert.equal(
      keyAction({ key: '/', code: 'NumpadDivide', ctrlKey: false, altKey: false, metaKey: true }),
      null
    );
  });

  it('returns null for other keys (digits, Enter, Tab, arrows, letters, null/undefined)', () => {
    assert.equal(
      keyAction({ key: '5', code: 'Numpad5', ctrlKey: false, altKey: false, metaKey: false }),
      null
    );
    assert.equal(
      keyAction({ key: 'Enter', code: 'Enter', ctrlKey: false, altKey: false, metaKey: false }),
      null
    );
    assert.equal(
      keyAction({ key: 'Enter', code: 'NumpadEnter', ctrlKey: false, altKey: false, metaKey: false }),
      null
    );
    assert.equal(
      keyAction({ key: 'Tab', code: 'Tab', ctrlKey: false, altKey: false, metaKey: false }),
      null
    );
    assert.equal(
      keyAction({ key: 'ArrowDown', code: 'ArrowDown', ctrlKey: false, altKey: false, metaKey: false }),
      null
    );
    assert.equal(
      keyAction({ key: 'ArrowUp', code: 'ArrowUp', ctrlKey: false, altKey: false, metaKey: false }),
      null
    );
    assert.equal(
      keyAction({ key: '^', code: 'Digit6', ctrlKey: false, altKey: false, metaKey: false }),
      null
    );
    assert.equal(keyAction(null), null);
    assert.equal(keyAction(undefined), null);
    assert.equal(keyAction({}), null);
  });
});
