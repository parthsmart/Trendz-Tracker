/**
 * Trendz Tracker — One-Question-at-a-Time Drill Player Unit Tests (tests/drillPlayer.test.js)
 *
 * Tests `createDrillPlayer` in `js/drillPlayer.js`:
 * - Question order (0 .. n-1).
 * - Skipping during the initial pass and revisiting skipped questions at the end.
 * - Detecting when the set is finished.
 * - Building the canonical answers array (`null` for unanswered questions).
 * - Idempotence of `finish()`: finishing twice does nothing on the second call.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDrillPlayer } from '../js/drillPlayer.js';

describe('Phase 9a — js/drillPlayer.js (Pure One-Question-at-a-Time Player)', () => {
  const sampleQuestions = [
    { type: 'mul', a: 3, b: 4, text: '3 x 4' },
    { type: 'mul', a: 5, b: 6, text: '5 x 6' },
    { type: 'div', dividend: 84, divisor: 7, text: '84 / 7' },
    { type: 'add_sub', rows: [4, 7, -3, 8], text: '+4 +7 -3 +8' },
  ];

  it('steps through questions in order and finishes when all questions are answered in pass 1', () => {
    const player = createDrillPlayer(sampleQuestions);

    assert.equal(player.isFinished(), false);
    assert.equal(player.getCurrentIndex(), 0);
    assert.equal(player.getCurrentQuestion().text, '3 x 4');

    player.answer('12');
    assert.equal(player.getCurrentIndex(), 1);
    assert.equal(player.getCurrentQuestion().text, '5 x 6');

    player.answer('30');
    assert.equal(player.getCurrentIndex(), 2);

    player.answer('12');
    assert.equal(player.getCurrentIndex(), 3);

    player.answer('16');
    assert.equal(player.isFinished(), true);
    assert.equal(player.getCurrentIndex(), null);
    assert.deepEqual(player.getAnswers(), ['12', '30', '12', '16']);
  });

  it('revisits skipped questions in order at the end of the first pass', () => {
    const player = createDrillPlayer(sampleQuestions);

    // Q0: skip
    player.skip();
    assert.equal(player.getCurrentIndex(), 1);

    // Q1: answer
    player.answer('30');
    assert.equal(player.getCurrentIndex(), 2);

    // Q2: skip (via blank answer)
    player.answer('   ');
    assert.equal(player.getCurrentIndex(), 3);

    // Q3: answer
    player.answer('16');

    // End of pass 1 -> must revisit skipped questions [0, 2] in order
    assert.equal(player.isFinished(), false);
    assert.equal(player.getState().isRevisitingSkipped, true);
    assert.equal(player.getCurrentIndex(), 0);

    // Answer Q0 during skipped pass
    player.answer('12');
    assert.equal(player.isFinished(), false);
    assert.equal(player.getCurrentIndex(), 2);

    // Skip Q2 again during skipped pass -> leaves Q2 as null and finishes the set
    player.skip();
    assert.equal(player.isFinished(), true);
    assert.deepEqual(player.getAnswers(), ['12', '30', null, '16']);
  });

  it('builds the answers array with null for unanswered questions when finished early', () => {
    const player = createDrillPlayer(sampleQuestions);
    player.answer('12');
    player.skip();

    const finalAnswers = player.finish();
    assert.deepEqual(finalAnswers, ['12', null, null, null]);
    assert.equal(player.isFinished(), true);
  });

  it('finishing twice does nothing on the second call', () => {
    let finishCalls = 0;
    const player = createDrillPlayer(sampleQuestions, {
      onFinish() {
        finishCalls += 1;
      },
    });

    player.answer('12');
    const firstFinish = player.finish();
    assert.ok(Array.isArray(firstFinish));
    assert.equal(finishCalls, 1);

    const secondFinish = player.finish();
    assert.equal(secondFinish, null);
    assert.equal(finishCalls, 1);

    // Answering or skipping after finish also does nothing
    assert.equal(player.answer('99'), false);
    assert.equal(player.skip(), false);
    assert.deepEqual(player.getAnswers(), ['12', null, null, null]);
  });
});
