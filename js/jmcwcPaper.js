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

/**
 * Headings and instruction lines copied from the printed area of each visible
 * sheet of the official simulators. `lines` are the example / instruction rows
 * printed under the title; rows themselves only show the numbers (see
 * buildPaperRowDisplay).
 */
export const JMCWC_SHEET_HEADINGS = Object.freeze({
  addition: { de: 'Additionen', en: 'Additions', lines: [] },
  subtraction: { de: 'Subtraktionen', en: 'Integer subtractions', lines: [] },
  mixed: { de: 'Addition und Subtraktion gemischt', en: 'Addition and Subtraction mixed', lines: [] },
  multiplication: { de: 'Multiplikation', en: 'Multiplications', lines: [] },
  division: { de: 'Aufgehende Divisionen', en: 'Integer divisions', lines: [] },
  brackets: { de: 'Klammern: die Antworten sind ganzzahlig', en: 'Brackets, answers are whole numbers', lines: [] },
  prime_factors: {
    de: 'Primzahlzerlegung',
    en: 'Factorisation',
    lines: [
      'Beispiel / E.g. 84 = 2×2×3×7',
      'Die Reihenfolge der Primfaktoren ist nicht wichtig',
      'The order of the prime factors does not matter',
    ],
  },
  hcf_lcm: {
    de: 'Größter gemeinsamer Teiler & kleinstes gemeinsames Vielfaches',
    en: 'Highest Common Factor & Lowest Common Multiple',
    lines: [],
  },
  fraction_add: {
    de: 'Brüche addieren',
    en: 'Fraction additions',
    lines: [
      'Schreibe die Antworten als gemischten Bruch in seiner einfachsten Form. 3/2 oder 1 2/4 ist nicht richtig. Nur 1½ ist richtig.',
      'Each question must be answered in its simplest form. 3/2 or 1 2/4 is not acceptable. This should be 1½.',
    ],
  },
  fraction_sub: {
    de: 'Brüche subtrahieren',
    en: 'Fraction subtractions',
    lines: [
      'Schreibe die Antworten als gemischten Bruch in seiner einfachsten Form. 3/2 oder 1 2/4 ist nicht richtig! Nur 1½ ist richtig.',
      'Each question must be answered in its simplest form. 3/2 or 1 2/4 is not acceptable. This should be 1½.',
    ],
  },
  fraction_mul: {
    de: 'Brüche multiplizieren',
    en: 'Fraction multiplications',
    lines: [
      'Schreibe die Antworten als gemischten Bruch in seiner einfachsten Form. 3/2 oder 1 2/4 ist nicht richtig! Nur 1½ ist richtig.',
      'Each question must be answered in its simplest form. 3/2 or 1 2/4 is not acceptable. This should be 1½.',
    ],
  },
  fraction_div: {
    de: 'Brüche dividieren',
    en: 'Fraction divisions',
    lines: [
      'Schreibe die Antworten als gemischten Bruch in gekürzter Form. 3/2 oder 1 2/4 ist nicht richtig! Nur 1½ ist richtig.',
      'Each question must be answered in its simplest form. 3/2 or 1 2/4 is not acceptable. This should be 1½.',
    ],
  },
  approximation: { de: 'Ungefäer Multiplikatiounen & Divisiounen', en: 'Approximate Multiplications & Divisions', lines: [] },
  remainder: {
    de: 'Reste',
    en: 'Remainders',
    lines: ['Beispiel: 19 ÷ 6 hat den rest 1', 'Example: 19 ÷ 6 has remainder 1'],
  },
  ratio: {
    de: 'Berechnung von Verhältnissen',
    en: 'Ratio calculations',
    lines: ['Die Antworten sind ganzzahlig / The answers are integer numbers'],
  },
  square_root: { de: 'Perfekte Quadratwurzeln', en: 'Perfect square roots', lines: ['Beispiel / Example:  √64 = 8'] },
  inexact_square_root: {
    de: 'Irrationale Quadratwurzel',
    en: 'Irrational Square Roots',
    lines: ['Beispiel / Example:  √59 (1 d.p.) = 7.7'],
  },
  next_square: {
    de: 'Nachfolgende Quadrate',
    en: 'Next squares',
    lines: ['z.B : das nächste Quadrat nach 157 ist 169', 'e.g. the next square after 157 = 169'],
  },
  cube_root: {
    de: 'AUFGEHENDE KUBIKWURZEL',
    en: 'CUBE ROOTS: EXACT ANSWERS',
    lines: ['Beispiel / Example:  ³√50653 = 37'],
  },
  next_cube: {
    de: 'Nächste Kubikzahl',
    en: 'Next cubes',
    lines: ['z.B : die Kubikzahl nach 45 ist 64', 'e.g. the next cube after 45 = 64'],
  },
  calendar: { de: 'KALENDERRECHNEN', en: 'CALENDAR CALCULATIONS', lines: [] },
  elapsed_time: {
    de: 'Vergangene Zeit in Sekunden',
    en: 'Time elapsed in seconds',
    lines: ['Beispiel / example:  von/from 04:43:47 bis/to 04:58:21 = 874 Sekunden / seconds'],
  },
  sum_squares: {
    de: 'Summe von Quadraten',
    en: 'Sum of squares',
    lines: [
      'Example / Beispiel:',
      '35 = 5² + 3² + 1² = ✓,  35 = 25 + 9 + 1  = X,  35 = 5² + 3² + 1² + 0²  = X',
      'Each of the following numbers may be written as the sum of 2, 3, or 4 squares. Do not write more than 4 squares for any number. There may be more than one answer; only one is required in each case.',
      'Jede der folgenden Zahlen kann geschrieben werden als die Summe von 2, 3 oder 4 Quadraten. Schreibe nicht mehr als 4 Quadrate pro Aufgabe. Mehrere Antworten sind möglich, eine Antwort reicht aber.',
    ],
  },
});

/**
 * Stacked sheets print several sums side by side: Int Adds and Mixed adds+subs
 * have 3 per row, Int Mults 2 per row (all three simulator workbooks).
 */
export const JMCWC_SHEET_COLUMNS = Object.freeze({ addition: 3, mixed: 3, multiplication: 2 });

export function getJmcwcSheetHeading(categoryKey, fallbackTitle = '') {
  const h = JMCWC_SHEET_HEADINGS[categoryKey];
  if (h) return { de: h.de, en: h.en, lines: [...(h.lines || [])] };
  const title = String(fallbackTitle || categoryKey || 'Category');
  return { de: '', en: title, lines: [] };
}

/** "Additionen / Additions" — the heading line as printed on the workbook sheet. */
export function formatJmcwcSheetHeadingLine(categoryKey, fallbackTitle = '') {
  const h = getJmcwcSheetHeading(categoryKey, fallbackTitle);
  return h.de ? `${h.de} / ${h.en}` : h.en;
}

// ============================================================================
// Row display (what one printed workbook row shows)
// ============================================================================

const BILINGUAL_MONTHS = Object.freeze({
  January: 'Januar(y)',
  February: 'Februar(y)',
  March: 'March/März',
  April: 'April',
  May: 'May/Mai',
  June: 'June/Juni',
  July: 'July/Juli',
  August: 'August',
  September: 'September',
  October: 'October/Oktober',
  November: 'November',
  December: 'December/Dezember',
});

const BILINGUAL_WEEKDAYS = Object.freeze({
  Monday: 'Monday/Montag',
  Tuesday: 'Tuesday/Dienstag',
  Wednesday: 'Wednesday/Mittwoch',
  Thursday: 'Thursday/Donnerstag',
  Friday: 'Friday/Freitag',
  Saturday: 'Saturday/Samstag',
  Sunday: 'Sunday/Sonntag',
});

const MONTH_RE = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/g;

function bilingualDate(text) {
  return String(text).replace(MONTH_RE, (name) => BILINGUAL_MONTHS[name]);
}

function bilingualWeekday(day) {
  return BILINGUAL_WEEKDAYS[day] || day;
}

/** The workbook prints subtraction with an en dash. */
function enDash(text) {
  return String(text).replace(/\s[−-]\s/g, ' – ');
}

const STACK_RE = /^\d+(?:\s*[+−×-]\s*\d+)+\s*=$/;

/**
 * How one question row looks on the printed workbook: only the numbers, with the
 * explanation left to the sheet heading and sub-headings.
 *
 * kinds: 'stack' (rows: [{op, value}], then "="), 'text' (`math` says whether to
 * typeset fractions and roots), 'lines' (plain text lines, German then English).
 * `group` names the sub-heading block the row belongs to (see
 * getPaperSubheadingLines); `suffix` is printed after the text (ratio "X =").
 * Prompts that do not match a known pattern come back unchanged as 'text'.
 * @param {string} categoryKey
 * @param {string} prompt
 */
export function buildPaperRowDisplay(categoryKey, prompt) {
  const p = String(prompt ?? '').trim();
  const text = (t, extra = {}) => ({ kind: 'text', text: t, math: true, group: null, ...extra });
  const plain = (t, extra = {}) => ({ kind: 'text', text: t, math: false, group: null, ...extra });
  let m;

  switch (categoryKey) {
    case 'addition':
    case 'mixed':
    case 'multiplication': {
      if (!STACK_RE.test(p)) break;
      const body = p.replace(/\s*=$/, '');
      const rows = [];
      const re = /([+−×-])?\s*(\d+)/g;
      while ((m = re.exec(body)) !== null) {
        const op = rows.length === 0 ? '' : (m[1] || '+').replace(/[−-]/, '–');
        rows.push({ op, value: m[2] });
      }
      return { kind: 'stack', rows, group: null };
    }
    case 'subtraction':
    case 'division':
    case 'brackets':
    case 'fraction_add':
    case 'fraction_sub':
    case 'fraction_mul':
    case 'fraction_div':
      return text(enDash(p));
    case 'prime_factors':
      if ((m = p.match(/^Prime factorisation of (\d+):?$/))) return plain(m[1]);
      break;
    case 'sum_squares':
      if ((m = p.match(/^Express (\d+) as the sum of/))) return plain(m[1]);
      break;
    case 'hcf_lcm':
      if ((m = p.match(/^(HCF|LCM)\(([\d,\s]+)\) =$/))) {
        const nums = m[2].split(',').map((n) => n.trim());
        const count = nums.length === 3 ? 'three' : 'two';
        return plain(nums.join(',   '), { group: `${m[1].toLowerCase()}:${count}` });
      }
      break;
    case 'approximation': {
      if ((m = p.match(/^Approximate (\S+) ([×÷]) (\S+) to (.+):$/))) {
        const how = m[4];
        const sf = how.match(/^(\d+) significant figures$/);
        const dp = how.match(/^(\d+) decimal places?$/);
        const group = how === 'the nearest integer' ? 'int' : sf ? `sf:${sf[1]}` : dp ? `dp:${dp[1]}` : null;
        return text(`${m[1]}  ${m[2]}  ${m[3]}  =`, { group });
      }
      if ((m = p.match(/^Estimate (\S+) ([×÷]) (\S+) \(within (\d+(?:\.\d+)?)%\):$/))) {
        return text(`${m[1]}  ${m[2]}  ${m[3]}  =`, { group: `pct:${m[4]}` });
      }
      break;
    }
    case 'remainder':
      if ((m = p.match(/^Remainder when (\d+) is divided by (\d+):?$/))) return text(`${m[1]} ÷ ${m[2]} =`);
      break;
    case 'ratio':
      if ((m = p.match(/^Find x: (\S+) : (\S+) = (\S+) : (\S+)$/))) {
        const t = [m[1], m[2], m[3], m[4]].map((v) => (v === 'x' ? 'X' : v));
        return text(`${t[0]} ÷ ${t[1]} = ${t[2]} ÷ ${t[3]}`, { suffix: 'X  =' });
      }
      break;
    case 'square_root':
      return text(p);
    case 'cube_root':
      return plain(p.replace(/∛/g, '³√'));
    case 'inexact_square_root':
      if ((m = p.match(/^√(\d+) \(to (\d+) decimal places?\) =$/))) {
        const unit = m[2] === '1' ? 'Nachkommastelle / d.p.' : 'Nachkommastellen / d.p.';
        return text(`√${m[1]}   mit / to  ${m[2]}  ${unit}`);
      }
      break;
    case 'next_square':
      if ((m = p.match(/^Next perfect square strictly greater than (\d+):?$/))) {
        return { kind: 'lines', lines: ['Welche ist die nächste Quadratzahl nach', `What is the next exact square after ${m[1]} ?`], group: null };
      }
      break;
    case 'next_cube':
      if ((m = p.match(/^Next perfect cube strictly greater than (\d+):?$/))) {
        return { kind: 'lines', lines: ['Welche ist die nächste Kubikzahl nach', `What is the next exact cube after ${m[1]} ?`], group: null };
      }
      break;
    case 'calendar':
      if ((m = p.match(/^What day of the week is (.+)\?$/))) return plain(bilingualDate(m[1]), { group: 'day' });
      if ((m = p.match(/^Fill in an appropriate month: (\d+) \[ \? \] (\d+) = (\w+)$/))) {
        return plain(`${m[1]}  ____  ${m[2]}  =  ${bilingualWeekday(m[3])}`, { group: 'month' });
      }
      if ((m = p.match(/^Fill in a suitable year from (\d+) - (\d+) for which (.+) = (\w+)/))) {
        return plain(`${bilingualDate(m[3])}  ____  =  ${bilingualWeekday(m[4])}`, { group: `year:${m[1]} - ${m[2]}` });
      }
      break;
    case 'elapsed_time':
      if ((m = p.match(/^Time elapsed from (\S+) on (.+) to (\S+) on (.+) \(in seconds\):$/))) {
        return plain(`von/from  ${m[1]}  am/on  ${bilingualDate(m[2])}  bis/to  ${m[3]}  am/on  ${bilingualDate(m[4])}`);
      }
      if ((m = p.match(/^Time elapsed from (\S+) to (\S+?)( \(next day\))?(?: \(in seconds\))?:$/))) {
        return plain(`von/from  ${m[1]}  bis/to  ${m[2]}${m[3] ? '  (+1 Tag / next day)' : ''}`);
      }
      break;
    default:
      break;
  }
  return text(p);
}

function formatQRange(from, to) {
  return from === to ? `${from}` : `${from}-${to}`;
}

/**
 * Sub-heading lines printed above a block of rows (e.g. "For Q 1-10, find the
 * highest common factor…"), using the question range of that block.
 * @param {string} group  from buildPaperRowDisplay
 * @param {number} from   first question number of the block
 * @param {number} to     last question number of the block
 * @returns {string[]}
 */
export function getPaperSubheadingLines(group, from, to) {
  const r = formatQRange(from, to);
  const str = String(group || '');
  const cut = str.indexOf(':');
  const kind = cut === -1 ? str : str.slice(0, cut);
  const arg = cut === -1 ? '' : str.slice(cut + 1);
  const numbersDe = arg === 'three' ? 'der drei Zahlen' : 'der beiden Zahlen';
  const numbersEn = arg === 'three' ? 'the three numbers' : 'the two numbers';
  switch (kind) {
    case 'hcf':
      return [`Für Q ${r}, finde den größten gemeinsamen Teiler ${numbersDe}`, `For Q ${r}, find the highest common factor for ${numbersEn}`];
    case 'lcm':
      return [
        `Für die Fragen ${r} findest du das kleinste gemeinsame Vielfache ${numbersDe}`,
        `For Q ${r} find the lowest common multiple of ${numbersEn}`,
      ];
    case 'int':
      return [`Gib bei Q${r} die Antwort auf die nächste ganze Zahl an.`, `For Q${r}, give the answer to the nearest integer.`];
    case 'sf':
      return arg === '4'
        ? [`Für Q${r} gib die Antwort auf vier signifikante Stellen an.`, `For Q${r}, give the answer to four significant figures.`]
        : [`Für Q${r} gib die Antwort auf ${arg} signifikante Stellen an.`, `For Q${r}, give the answer to ${arg} significant figures.`];
    case 'dp':
      return arg === '1'
        ? [`Für Q${r} gib die Antwort auf 1 Nachkommastelle an.`, `For Q${r}, give the answer to 1 decimal place.`]
        : [`Für Q${r} gib die Antwort auf ${arg} Nachkommastellen an.`, `For Q${r}, give the answer to ${arg} decimal places.`];
    case 'pct':
      return [`Für Q${r} gib eine Schätzung auf ${arg}% genau an.`, `For Q${r}, give an estimate within ${arg}%.`];
    case 'day':
      return ['Auf welchen Wochentag fallen jeweils die folgenden Daten?', 'On which day of the week does each of the following dates occur?'];
    case 'month':
      return [
        'Fill in an appropriate month for each of the following.',
        'There may be more than one answer; only one is required.',
        'Trage einen passenden Monat ein.',
      ];
    case 'year':
      return [
        `Fill in an appropriate year from ${arg} for each of the following.`,
        'There may be more than one answer; only one is required.',
        `Trage ein passendes Jahr ein zwischen ${arg}`,
      ];
    default:
      return [];
  }
}

/** Attach `display` to each question and `subheading` to the first row of each block. */
function attachPaperDisplays(categoryKey, questions) {
  const displays = questions.map((q) => buildPaperRowDisplay(categoryKey, q.prompt));
  let i = 0;
  while (i < questions.length) {
    const group = displays[i].group;
    let j = i;
    while (group && j + 1 < questions.length && displays[j + 1].group === group) j += 1;
    if (group) {
      displays[i] = { ...displays[i], subheading: getPaperSubheadingLines(group, questions[i].number, questions[j].number) };
    }
    i = j + 1;
  }
  return questions.map((q, idx) => ({ ...q, display: displays[idx] }));
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
    const numbered = (Array.isArray(sec.questions) ? sec.questions : []).map((q, qIdx) => {
      const qKey = q.question_key || q.id;
      return {
        ...q,
        question_key: qKey,
        number: qIdx + 1,
        marks: toMarks(q.marks ?? q.max_marks),
        answered: isAnswered(safeAnswers[qKey]),
      };
    });
    const questions = attachPaperDisplays(key, numbered);
    return {
      key,
      section_order: sec.section_order ?? idx + 1,
      heading,
      heading_line: heading.de ? `${heading.de} / ${heading.en}` : heading.en,
      columns: JMCWC_SHEET_COLUMNS[key] || 1,
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
