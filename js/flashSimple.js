/**
 * Trendz Tracker — Flash Anzan "Simple" mode (js/flashSimple.js)
 *
 * Simple questions can be solved on the abacus without any formula (no small
 * friends, big friends or carries). Each rod (digit column) is worked on its own:
 * - Adding d to a rod showing v is direct when the lower beads fit
 *   (v % 5 + d % 5 <= 4) and the heaven bead is free (floor(v/5) + floor(d/5) <= 1).
 * - Subtracting d is direct when the rod already has those beads
 *   (v % 5 >= d % 5 and floor(v/5) >= floor(d/5)).
 *
 * Every flashed number has digits 1-9 only (no zeros), plus and minus numbers are
 * mixed at random, and the running total never goes below zero.
 *
 * The database function `flash_generate_question(..., 'simple')` uses the same
 * rules; this copy is used in demo mode and by the tests.
 */

export const FLASH_SIMPLE_MODE = 'simple';

/** True when `d` can be added to a rod showing `v` without a formula. */
export function canAddDirect(v, d) {
  return (v % 5) + (d % 5) <= 4 && Math.floor(v / 5) + Math.floor(d / 5) <= 1;
}

/** True when `d` can be taken from a rod showing `v` without a formula. */
export function canSubDirect(v, d) {
  return v % 5 >= d % 5 && Math.floor(v / 5) >= Math.floor(d / 5);
}

/** Digits 1-9 that can be added (sign 1) or subtracted (sign -1) on a rod showing `v`. */
export function directDigits(v, sign) {
  const out = [];
  for (let d = 1; d <= 9; d += 1) {
    if (sign > 0 ? canAddDirect(v, d) : canSubDirect(v, d)) out.push(d);
  }
  return out;
}

/** Splits a non-negative integer into `digits` rod values, most significant first. */
export function toRods(value, digits) {
  const rods = [];
  let rest = Math.abs(Math.trunc(Number(value) || 0));
  for (let i = 0; i < digits; i += 1) {
    rods.unshift(rest % 10);
    rest = Math.floor(rest / 10);
  }
  return rods;
}

/**
 * True when every step of `numbers` (signed, first one positive) can be done on
 * the abacus without a formula, rod by rod, and every digit is 1-9.
 */
export function isSimpleSequence(numbers, digits) {
  if (!Array.isArray(numbers) || numbers.length === 0) return false;
  const width = Math.max(1, Math.min(5, Number(digits) || 1));
  let rods = new Array(width).fill(0);
  for (let i = 0; i < numbers.length; i += 1) {
    const n = Number(numbers[i]);
    if (!Number.isInteger(n) || n === 0) return false;
    if (i === 0 && n < 0) return false;
    const sign = n < 0 ? -1 : 1;
    const ds = toRods(Math.abs(n), width);
    if (String(Math.abs(n)).length !== width) return false;
    const next = [];
    for (let c = 0; c < width; c += 1) {
      const d = ds[c];
      if (d < 1 || d > 9) return false;
      if (i > 0 && !(sign > 0 ? canAddDirect(rods[c], d) : canSubDirect(rods[c], d))) return false;
      next.push(rods[c] + sign * d);
    }
    rods = next;
  }
  return true;
}

/**
 * Builds a Simple question.
 * @param {number} digits 1..5
 * @param {number} count  2..1000
 * @param {{ random?: () => number, minusChance?: number }} [options]
 * @returns {number[]} signed numbers; the first one is positive
 */
export function generateSimpleQuestion(digits, count, { random = Math.random, minusChance = 0.5 } = {}) {
  const width = Math.max(1, Math.min(5, Math.trunc(Number(digits)) || 1));
  const total = Math.max(1, Math.trunc(Number(count)) || 1);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const rods = new Array(width).fill(0);
  const numbers = [];
  let prev = null;

  for (let i = 0; i < total; i += 1) {
    let sign = 1;
    if (i > 0) {
      // A rod at 9 cannot take any plus; a rod at 0 cannot take any minus.
      // Plus never makes a 0 and minus never makes a 9, so one of them always works.
      const canAdd = rods.every((v) => v < 9);
      const canSub = rods.every((v) => v > 0);
      if (canAdd && canSub) sign = random() < minusChance ? -1 : 1;
      else sign = canSub ? -1 : 1;
    }

    let value = 0;
    let ds = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      ds = rods.map((v) => (i === 0 ? 1 + Math.floor(random() * 9) : pick(directDigits(v, sign))));
      value = ds.reduce((acc, d) => acc * 10 + d, 0);
      if (value !== prev) break;
    }

    for (let c = 0; c < width; c += 1) rods[c] += sign * ds[c];
    numbers.push(sign * value);
    prev = value;
  }
  return numbers;
}
