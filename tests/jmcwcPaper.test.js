import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  JMCWC_SHEET_HEADINGS,
  JMCWC_CUSTOM_MAX_PER_LEVEL,
  buildCustomSelections,
  buildDefaultCustomCounts,
  buildPaperResultModel,
  buildPaperSheetModel,
  clampCustomCount,
  customCountKey,
  formatCustomLevelPoints,
  formatJmcwcSheetHeadingLine,
  formatSheetCorrections,
  summarizeCustomCounts,
} from '../js/jmcwcPaper.js';
import { JMCWC_CATEGORY_TITLES, buildJmcwcSectionedQuestions } from '../js/jmcwcClient.js';

describe('JMCWC paper-style worksheet model', () => {
  it('has a bilingual workbook heading for every category', () => {
    for (const key of Object.keys(JMCWC_CATEGORY_TITLES)) {
      const h = JMCWC_SHEET_HEADINGS[key];
      assert.ok(h && h.de && h.en, key);
    }
    assert.equal(formatJmcwcSheetHeadingLine('addition'), 'Additionen / Additions');
    assert.equal(formatJmcwcSheetHeadingLine('unknown_key', 'Fallback'), 'Fallback');
  });

  it('numbers questions per sheet and sums Points into Total value', () => {
    const sections = buildJmcwcSectionedQuestions([
      { id: 'addition_s1', category_key: 'addition', slot: 1, max_marks: 3, prompt: '1 + 2 =' },
      { id: 'addition_s2', category_key: 'addition', slot: 2, max_marks: 4, prompt: '3 + 4 =' },
      { id: 'ratio_s1', category_key: 'ratio', slot: 1, max_marks: 6, prompt: 'x' },
    ]);
    const paper = buildPaperSheetModel(sections, { addition_s2: '7', ratio_s1: '  ' });
    assert.equal(paper.sheets.length, 2);
    assert.deepEqual(paper.sheets[0].questions.map((q) => q.number), [1, 2]);
    assert.equal(paper.sheets[0].total_value, 7);
    assert.equal(paper.sheets[0].answered_count, 1);
    assert.equal(paper.sheets[1].heading.note, 'The answers are integer numbers');
    assert.equal(paper.total_value, 13);
    assert.equal(paper.question_count, 3);
    assert.equal(paper.answered_count, 1, 'blank answers are not answered');
  });

  it('builds the Excel-style result with marks to be corrected per sheet', () => {
    const result = buildPaperResultModel(
      [
        { id: 'a1', category_key: 'addition', max_marks: 3, award: 3, verdict: 'correct' },
        { id: 'a2', category_key: 'addition', max_marks: 4, award: 0, verdict: 'wrong' },
        { id: 'r1', category_key: 'approximation', max_marks: 5, award: 2.5, verdict: 'partial' },
      ],
      (k) => JMCWC_CATEGORY_TITLES[k]
    );
    assert.equal(result.total_score_label, '5.5 / 12');
    assert.equal(result.marks_to_be_corrected, 6.5);
    assert.equal(result.sheets[0].earned_label, '3 / 7');
    assert.equal(formatSheetCorrections(result.sheets[0]), 'Q2 (−4)');
    assert.equal(formatSheetCorrections(result.sheets[1]), 'Q1 (−2.5)');
    assert.equal(formatSheetCorrections({ corrections: [] }), 'All correct');
    assert.equal(result.corrections.length, 2);
  });
});

describe('JMCWC custom set builder helpers', () => {
  const options = [
    { category_key: 'addition', levels: [{ level: 1, min_marks: 3, max_marks: 3 }, { level: 2, min_marks: 4, max_marks: 4 }] },
    { category_key: 'approximation', levels: [{ level: 1, min_marks: 1, max_marks: 6 }] },
  ];

  it('defaults to one question per level and clamps counts', () => {
    const counts = buildDefaultCustomCounts(options);
    assert.deepEqual(counts, { 'addition:1': 1, 'addition:2': 1, 'approximation:1': 1 });
    assert.equal(clampCustomCount(-3), 0);
    assert.equal(clampCustomCount('2.9'), 2);
    assert.equal(clampCustomCount(99), JMCWC_CUSTOM_MAX_PER_LEVEL);
    assert.equal(clampCustomCount('abc'), 0);
    assert.equal(customCountKey('ratio', 3), 'ratio:3');
  });

  it('summarizes questions, categories and the points range', () => {
    const counts = { 'addition:1': 2, 'addition:2': 0, 'approximation:1': 1 };
    const s = summarizeCustomCounts(options, counts);
    assert.equal(s.questions, 3);
    assert.equal(s.categories, 2);
    assert.equal(s.points_label, '7–12');
    assert.equal(s.over_limit, false);
    assert.deepEqual(buildCustomSelections(options, counts), [
      { category_key: 'addition', level: 1, count: 2 },
      { category_key: 'approximation', level: 1, count: 1 },
    ]);
    assert.equal(formatCustomLevelPoints(options[0].levels[0]), '3 pts');
    assert.equal(formatCustomLevelPoints(options[1].levels[0]), '1–6 pts');
  });

  it('flags sets above the question limit', () => {
    const many = Array.from({ length: 16 }, (_, i) => ({
      category_key: `c${i}`,
      levels: [{ level: 1, min_marks: 1, max_marks: 1 }],
    }));
    const s = summarizeCustomCounts(many, buildDefaultCustomCounts(many, 10));
    assert.equal(s.questions, 160);
    assert.equal(s.over_limit, true);
  });
});
