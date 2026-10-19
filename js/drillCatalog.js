/**
 * Trendz Tracker — Elements Drill Catalog Metadata (js/drillCatalog.js)
 *
 * Browser-safe display metadata for the 18 Elements worksheet drills.
 * Verified by unit tests (tests/drills.test.js) to match `api/_drills.js`
 * identically on key, title, group, questions, time_limit_seconds, enabled,
 * inputmode, and hint.
 */

export const MODULO_ENABLED = false;

export const DRILL_GROUPS = [
  'Codes',
  'Squares and cubes',
  'Division',
  'Time',
  'Other',
];

export const DRILL_CATALOG = {
  day_codes: {
    key: 'day_codes',
    title: 'Day Codes',
    group: 'Codes',
    questions: 56,
    time_limit_seconds: 60,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Type the day code (Sunday=1, Monday=2, Tuesday=3, Wednesday=4, Thursday=5, Friday=6, Saturday=0).',
  },
  month_codes: {
    key: 'month_codes',
    title: 'Month Codes',
    group: 'Codes',
    questions: 56,
    time_limit_seconds: 60,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Type the month code (Jan=1, Feb=4, Mar=4, Apr=0, May=2, Jun=5, Jul=0, Aug=3, Sep=6, Oct=1, Nov=4, Dec=6).',
  },
  century_codes: {
    key: 'century_codes',
    title: 'Century Codes',
    group: 'Codes',
    questions: 56,
    time_limit_seconds: 60,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Type the century code from the first two digits mod 4 (0→6, 1→4, 2→2, 3→0).',
  },
  time_conversion: {
    key: 'time_conversion',
    title: 'Conversion in Seconds',
    group: 'Time',
    questions: 25,
    time_limit_seconds: 180,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Convert the given time into total seconds (commas optional).',
  },
  squares_11_50: {
    key: 'squares_11_50',
    title: 'Square (11-50)',
    group: 'Squares and cubes',
    questions: 50,
    time_limit_seconds: 120,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Type the exact square of each number.',
  },
  squares_51_100: {
    key: 'squares_51_100',
    title: 'Square (51-100)',
    group: 'Squares and cubes',
    questions: 50,
    time_limit_seconds: 180,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Type the exact square of each number.',
  },
  cubes_11_50: {
    key: 'cubes_11_50',
    title: 'Cube (11-50)',
    group: 'Squares and cubes',
    questions: 50,
    time_limit_seconds: 180,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Type the exact cube of each number.',
  },
  cubes_51_100: {
    key: 'cubes_51_100',
    title: 'Cube (51-100)',
    group: 'Squares and cubes',
    questions: 50,
    time_limit_seconds: 240,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Type the exact cube of each number.',
  },
  divide_by_4: {
    key: 'divide_by_4',
    title: 'Division by 4',
    group: 'Division',
    questions: 50,
    time_limit_seconds: 60,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Type the whole-number quotient (n div 4), ignoring any remainder.',
  },
  divide_by_7: {
    key: 'divide_by_7',
    title: 'Division by 7',
    group: 'Division',
    questions: 50,
    time_limit_seconds: 60,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Type only the remainder when divided by 7 (n mod 7).',
  },
  prime_factors: {
    key: 'prime_factors',
    title: 'Prime Factor',
    group: 'Other',
    questions: 20,
    time_limit_seconds: 300,
    enabled: true,
    inputmode: 'text',
    hint: 'Type the two prime factors separated by x, *, comma, or space (e.g. 13 x 97).',
  },
  modulo: {
    key: 'modulo',
    title: 'Modulo Calculation',
    group: 'Other',
    questions: 20,
    time_limit_seconds: 240,
    enabled: MODULO_ENABLED,
    inputmode: 'text',
    hint: 'Type quotient and remainder separated by a comma or space (e.g. 12, 5).',
  },
  ratio: {
    key: 'ratio',
    title: 'Ratio',
    group: 'Other',
    questions: 20,
    time_limit_seconds: 300,
    enabled: true,
    inputmode: 'text',
    hint: 'Type the simplified ratio in lowest terms as a/b (e.g. 4/7).',
  },
  days_to_seconds: {
    key: 'days_to_seconds',
    title: 'Days --> Seconds',
    group: 'Time',
    questions: 10,
    time_limit_seconds: 300,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Convert the days between the two dates into seconds (years ignored, Feb = 28 days).',
  },
  hours_to_seconds: {
    key: 'hours_to_seconds',
    title: 'Hours --> Seconds',
    group: 'Time',
    questions: 10,
    time_limit_seconds: 120,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Type the number of seconds between the two times.',
  },
  minutes_to_seconds: {
    key: 'minutes_to_seconds',
    title: 'Minutes --> Seconds',
    group: 'Time',
    questions: 10,
    time_limit_seconds: 120,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Type the number of seconds between the two mm:ss times.',
  },
  number_to_be_squared: {
    key: 'number_to_be_squared',
    title: 'Number To Be Squared',
    group: 'Squares and cubes',
    questions: 20,
    time_limit_seconds: 300,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Type the smallest whole number whose square is greater than the number shown.',
  },
  squares_3d_4d: {
    key: 'squares_3d_4d',
    title: '3D - 4D Square',
    group: 'Squares and cubes',
    questions: 20,
    time_limit_seconds: 300,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Type the exact square of each 3-digit or 4-digit number.',
  },
};

export const DRILL_CATALOG_LIST = Object.values(DRILL_CATALOG);

/**
 * Formats the time limit in human-readable form (e.g. "1 minute", "3 minutes", "90 seconds").
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatDrillTimeLimit(seconds) {
  const s = Number(seconds) || 0;
  if (s > 0 && s % 60 === 0) {
    const mins = s / 60;
    return `${mins} ${mins === 1 ? 'minute' : 'minutes'}`;
  }
  return `${s} seconds`;
}

/**
 * Formats the subtitle shown on each drill card, e.g. "56 questions - 1 minute".
 *
 * @param {{ questions: number, time_limit_seconds: number }} drill
 * @returns {string}
 */
export function formatDrillSubtitle(drill) {
  if (!drill) return '';
  return `${drill.questions} questions - ${formatDrillTimeLimit(drill.time_limit_seconds)}`;
}
