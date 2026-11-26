/**
 * Trendz Tracker — JMCWC paper-style worksheet helpers (js/jmcwcPaper.js)
 *
 * Pure, DOM-free helpers that shape online Main Round practice like the official
 * JMCWC 2026 simulator workbooks (docs/sources/JMCWC-2026-Simulator-*.xlsx):
 * - one sheet per category with the workbook's bilingual German / English heading,
 * - a "Punkte / Points" value beside every question and a "Total value" per sheet,
 * - an Excel-style result: Total score / maximum, score per sheet, and the
 *   "Marks to be corrected" list from the revision workbook footer.
 *
 * Also holds the pure helpers for the custom practice set builder, which follows
 * the owner's revision workbook (one question per difficulty level by default,
 * with the student choosing how many of each level appear).
 */

/** Headings copied from row 1–4 of each visible sheet of the official simulators. */
export const JMCWC_SHEET_HEADINGS = Object.freeze({
  addition: { de: 'Additionen', en: 'Additions' },
  subtraction: { de: 'Subtraktionen', en: 'Integer subtractions' },
  mixed: { de: 'Addition und Subtraktion gemischt', en: 'Addition and Subtraction mixed' },
  multiplication: { de: 'Multiplikation', en: 'Multiplications' },
  division: { de: 'Aufgehende Divisionen', en: 'Integer divisions' },
  brackets: { de: 'Klammern: die Antworten sind ganzzahlig', en: 'Brackets, answers are whole numbers' },
  prime_factors: { de: 'Primzahlzerlegung', en: 'Factorisation', note: 'E.g. 84 = 2×2×3×7' },
  hcf_lcm: {
    de: 'Größter gemeinsamer Teiler & kleinstes gemeinsames Vielfaches',
    en: 'Highest Common Factor & Lowest Common Multiple',
  },
  fraction_add: {
    de: 'Brüche addieren',
    en: 'Fraction additions',
    note: 'Write answers as mixed fractions in simplest form. 3/2 or 1 2/4 is not correct, only 1 1/2.',
  },
  fraction_sub: {
    de: 'Brüche subtrahieren',
    en: 'Fraction subtractions',
    note: 'Write answers as mixed fractions in simplest form. 3/2 or 1 2/4 is not correct, only 1 1/2.',
  },
  fraction_mul: {
    de: 'Brüche multiplizieren',
    en: 'Fraction multiplications',
    note: 'Write answers as mixed fractions in simplest form. 3/2 or 1 2/4 is not correct, only 1 1/2.',
  },
  fraction_div: {
    de: 'Brüche dividieren',
    en: 'Fraction divisions',
    note: 'Write answers as mixed fractions in simplest form. 3/2 or 1 2/4 is not correct, only 1 1/2.',
  },
  approximation: { de: 'Ungefähre Multiplikationen & Divisionen', en: 'Approximate multiplications & divisions' },
  remainder: { de: 'Reste', en: 'Remainders', note: 'Example: 19 ÷ 6 has remainder 1' },
  ratio: {
    de: 'Berechnung von Verhältnissen',
    en: 'Ratio calculations',
    note: 'The answers are integer numbers',
  },
  square_root: { de: 'Perfekte Quadratwurzeln', en: 'Perfect square roots', note: 'Example: √64 = 8' },
  inexact_square_root: { de: 'Irrationale Quadratwurzel', en: 'Irrational square roots' },
  next_square: { de: 'Nachfolgende Quadrate', en: 'Next squares', note: 'E.g. the next square after 157 is 169' },
  cube_root: { de: 'Aufgehende Kubikwurzel', en: 'Cube roots: exact answers' },
  next_cube: { de: 'Nächste Kubikzahl', en: 'Next cubes', note: 'E.g. the next cube after 45 is 64' },
  calendar: { de: 'Kalenderrechnen', en: 'Calendar calculations' },
  elapsed_time: { de: 'Vergangene Zeit in Sekunden', en: 'Time elapsed in seconds' },
  sum_squares: {
    de: 'Summe von Quadraten',
    en: 'Sum of squares',
    note: 'Write the numbers whose squares add up to the total, not the squares.',
  },
});

export function getJmcwcSheetHeading(categoryKey, fallbackTitle = '') {
  const h = JMCWC_SHEET_HEADINGS[categoryKey];
  if (h) return { de: h.de, en: h.en, note: h.note || '' };
  const title = String(fallbackTitle || categoryKey || 'Category');
  return { de: '', en: title, note: '' };
}

/** "Additionen / Additions" — the heading line as printed on the workbook sheet. */
export function formatJmcwcSheetHeadingLine(categoryKey, fallbackTitle = '') {
  const h = getJmcwcSheetHeading(categoryKey, fallbackTitle);
  return h.de ? `${h.de} / ${h.en}` : h.en;
}

function isAnswered(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function toMarks(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Build the paper model from the runner's sectioned questions.
 * @param {Array<{section_order:number, category_slug:string, display_name?:string, questions:Array}>} sections
 * @param {Record<string,string>} answers
 */
export function buildPaperSheetModel(sections = [], answers = {}) {
  const safeAnswers = answers && typeof answers === 'object' ? answers : {};
  const sheets = (Array.isArray(sections) ? sections : []).map((sec, idx) => {
    const key = sec.category_slug || sec.category_key || `section_${idx + 1}`;
    const heading = getJmcwcSheetHeading(key, sec.display_name || sec.category_name);
    const questions = (Array.isArray(sec.questions) ? sec.questions : []).map((q, qIdx) => {
      const qKey = q.question_key || q.id;
      return {
        ...q,
        question_key: qKey,
        number: qIdx + 1,
        marks: toMarks(q.marks ?? q.max_marks),
        answered: isAnswered(safeAnswers[qKey]),
      };
    });
    return {
      key,
      section_order: sec.section_order ?? idx + 1,
      heading,
      heading_line: heading.de ? `${heading.de} / ${heading.en}` : heading.en,
      questions,
      total_value: questions.reduce((sum, q) => sum + q.marks, 0),
      answered_count: questions.filter((q) => q.answered).length,
    };
  });
  return {
    sheets,
    question_count: sheets.reduce((s, sh) => s + sh.questions.length, 0),
    answered_count: sheets.reduce((s, sh) => s + sh.answered_count, 0),
    total_value: sheets.reduce((s, sh) => s + sh.total_value, 0),
  };
}

function formatMarks(n) {
  const v = toMarks(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/**
 * Excel-style result summary for a graded attempt or custom set.
 * @param {Array<{id?:string, question_key?:string, category_key:string, max_marks:number, award:number, verdict:string}>} reviewItems
 * @param {(key:string)=>string} [titleFor]
 */
export function buildPaperResultModel(reviewItems = [], titleFor = (k) => k) {
  const bySheet = new Map();
  const order = [];
  for (const item of Array.isArray(reviewItems) ? reviewItems : []) {
    const key = item.category_key || item.category_slug || 'category';
    let sheet = bySheet.get(key);
    if (!sheet) {
      sheet = {
        key,
        heading_line: formatJmcwcSheetHeadingLine(key, titleFor(key)),
        title: titleFor(key),
        earned: 0,
        total_value: 0,
        question_count: 0,
        corrections: [],
      };
      bySheet.set(key, sheet);
      order.push(sheet);
    }
    sheet.question_count += 1;
    const max = toMarks(item.max_marks);
    const award = toMarks(item.award);
    sheet.total_value += max;
    sheet.earned += award;
    if (award < max) {
      sheet.corrections.push({
        number: sheet.question_count,
        question_id: item.id || item.question_key || '',
        lost: max - award,
        verdict: item.verdict || 'wrong',
      });
    }
  }
  const earned = order.reduce((s, sh) => s + sh.earned, 0);
  const max = order.reduce((s, sh) => s + sh.total_value, 0);
  const corrections = order.flatMap((sh) =>
    sh.corrections.map((c) => ({ ...c, sheet_key: sh.key, sheet_title: sh.title }))
  );
  return {
    sheets: order.map((sh) => ({
      ...sh,
      earned_label: `${formatMarks(sh.earned)} / ${formatMarks(sh.total_value)}`,
    })),
    earned,
    max,
    total_score_label: `${formatMarks(earned)} / ${formatMarks(max)}`,
    marks_to_be_corrected: corrections.reduce((s, c) => s + c.lost, 0),
    corrections,
  };
}

/** Short correction text per sheet, e.g. "Q2 (−4), Q5 (−1.5)". */
export function formatSheetCorrections(sheet) {
  if (!sheet || !Array.isArray(sheet.corrections) || sheet.corrections.length === 0) return 'All correct';
  return sheet.corrections.map((c) => `Q${c.number} (−${formatMarks(c.lost)})`).join(', ');
}

// ============================================================================
// Custom practice set (revision workbook style)
// ============================================================================

export const JMCWC_CUSTOM_MAX_PER_LEVEL = 10;
export const JMCWC_CUSTOM_MAX_QUESTIONS = 150;

export function clampCustomCount(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, JMCWC_CUSTOM_MAX_PER_LEVEL);
}

export function customCountKey(categoryKey, level) {
  return `${categoryKey}:${level}`;
}

/** Revision-sheet default: one question of every level in every category offered. */
export function buildDefaultCustomCounts(options = [], perLevel = 1) {
  const counts = {};
  for (const cat of Array.isArray(options) ? options : []) {
    for (const lvl of Array.isArray(cat.levels) ? cat.levels : []) {
      counts[customCountKey(cat.category_key, lvl.level)] = clampCustomCount(perLevel);
    }
  }
  return counts;
}

/** Number of questions and maximum points the chosen counts will produce. */
export function summarizeCustomCounts(options = [], counts = {}) {
  let questions = 0;
  let minPoints = 0;
  let maxPoints = 0;
  let categories = 0;
  for (const cat of Array.isArray(options) ? options : []) {
    let catQuestions = 0;
    for (const lvl of Array.isArray(cat.levels) ? cat.levels : []) {
      const c = clampCustomCount(counts[customCountKey(cat.category_key, lvl.level)]);
      catQuestions += c;
      minPoints += c * toMarks(lvl.min_marks);
      maxPoints += c * toMarks(lvl.max_marks);
    }
    if (catQuestions > 0) categories += 1;
    questions += catQuestions;
  }
  return {
    questions,
    categories,
    min_points: minPoints,
    max_points: maxPoints,
    points_label: minPoints === maxPoints ? `${maxPoints}` : `${minPoints}–${maxPoints}`,
    over_limit: questions > JMCWC_CUSTOM_MAX_QUESTIONS,
  };
}

/** Request body selections for `custom_create`, skipping zero counts. */
export function buildCustomSelections(options = [], counts = {}) {
  const selections = [];
  for (const cat of Array.isArray(options) ? options : []) {
    for (const lvl of Array.isArray(cat.levels) ? cat.levels : []) {
      const count = clampCustomCount(counts[customCountKey(cat.category_key, lvl.level)]);
      if (count > 0) selections.push({ category_key: cat.category_key, level: lvl.level, count });
    }
  }
  return selections;
}

/** "3 pts" or "3–6 pts" label for a level. */
export function formatCustomLevelPoints(level) {
  const min = toMarks(level?.min_marks);
  const max = toMarks(level?.max_marks);
  return min === max ? `${max} pts` : `${min}–${max} pts`;
}
