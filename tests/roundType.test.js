/**
 * Trendz Tracker - Unit Tests for Flat Round Detection & Matrix Formatting (tests/roundType.test.js)
 *
 * Run with: node --test tests/*.test.js
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isFlatRound } from '../js/roundType.js';
import { buildRoundScoreMatrix } from '../js/stats.js';

describe('isFlatRound — pure detection of Flat Round types', () => {
  it('returns true when trimmed, lower-cased round type starts with "flat"', () => {
    assert.equal(isFlatRound('Flat Round'), true);
    assert.equal(isFlatRound('Flat round'), true);
    assert.equal(isFlatRound('flat'), true);
    assert.equal(isFlatRound('  FLAT ROUND  '), true);
    assert.equal(isFlatRound('Flat - Speed Test'), true);
  });

  it('returns false for "Category wise", empty, or unknown values', () => {
    assert.equal(isFlatRound('Category wise'), false);
    assert.equal(isFlatRound('Category Wise'), false);
    assert.equal(isFlatRound(''), false);
    assert.equal(isFlatRound('   '), false);
    assert.equal(isFlatRound(null), false);
    assert.equal(isFlatRound(undefined), false);
    assert.equal(isFlatRound('Timed Mock'), false);
    assert.equal(isFlatRound('Non-flat round'), false);
  });
});

describe('buildRoundScoreMatrix — flat round cell flags and total time summary preservation', () => {
  it('marks cells and headers with isFlat=true for flat rounds while keeping total round time in summary', () => {
    const seriesCategories = [
      { id: 'cat-1', name: '1d4r', section: 'round', active: true }
    ];
    const targetRounds = [
      {
        id: 'sr-flat',
        round_number: 1,
        round_date: '2026-10-25',
        round_type: 'Flat Round',
        time_taken_seconds: 1800
      },
      {
        id: 'sr-cat',
        round_number: 2,
        round_date: '2026-10-25',
        round_type: 'Category wise',
        time_taken_seconds: 1500
      }
    ];
    const results = [
      {
        id: 'res-1',
        student_round_id: 'sr-flat',
        category_id: 'cat-1',
        correct: 19,
        total: 20,
        time_seconds: 95
      },
      {
        id: 'res-2',
        student_round_id: 'sr-cat',
        category_id: 'cat-1',
        correct: 18,
        total: 20,
        time_seconds: 110
      }
    ];

    const matrix = buildRoundScoreMatrix(results, seriesCategories, targetRounds);

    assert.equal(matrix.roundHeaders[0].isFlat, true);
    assert.equal(matrix.roundHeaders[1].isFlat, false);

    assert.equal(matrix.rows[0].cells[0].isFlat, true);
    assert.equal(matrix.rows[0].cells[0].correct, 19);
    assert.equal(matrix.rows[0].cells[0].total, 20);

    assert.equal(matrix.rows[0].cells[1].isFlat, false);

    // Summary row "Time Taken" keeps using the round's total time (1800s -> 30:00)
    assert.equal(matrix.summary.timeTaken[0].seconds, 1800);
    assert.equal(matrix.summary.timeTaken[0].formatted, '30:00');
  });
});
