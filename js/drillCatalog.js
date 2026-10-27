/**
 * Trendz Tracker — Elements Drill Catalog Metadata (js/drillCatalog.js)
 *
 * Browser-safe display metadata for the 24 Elements worksheet drills.
 * Verified by unit tests (tests/drills.test.js) to match `api/_drills.js`
 * identically on key, title, group, questions, time_limit_seconds, enabled,
 * inputmode, and hint.
 */

export const MODULO_ENABLED = false;

/**
 * Placeholder question counts and time limits (in seconds) for the 10 staged
 * Square and Cube drills. Kept in ONE place so they are easy to change.
 */
export const SQUARES_STAGE_QUESTIONS = 25;
export const SQUARES_COMBINED_QUESTIONS = 100;
export const SQUARES_STAGE_1_TIME_SECONDS = 60;
export const SQUARES_STAGE_2_TIME_SECONDS = 75;
export const SQUARES_STAGE_3_TIME_SECONDS = 100;
export const SQUARES_STAGE_4_TIME_SECONDS = 120;
export const SQUARES_COMBINED_TIME_SECONDS = 360;

export const CUBES_STAGE_QUESTIONS = 25;
export const CUBES_COMBINED_QUESTIONS = 100;
export const CUBES_STAGE_1_TIME_SECONDS = 90;
export const CUBES_STAGE_2_TIME_SECONDS = 110;
export const CUBES_STAGE_3_TIME_SECONDS = 130;
export const CUBES_STAGE_4_TIME_SECONDS = 150;
export const CUBES_COMBINED_TIME_SECONDS = 480;

/**
 * Canonical stage specifications shared between `js/drillCatalog.js` and `api/_drills.js`.
 */
export const SQUARE_CUBE_STAGE_SPECS = Object.freeze({
  squares_stage_1: {
    key: 'squares_stage_1',
    title: 'Square - Stage 1 (1-25)',
    subgroup: 'Squares',
    min: 1,
    max: 25,
    power: 2,
    questions: SQUARES_STAGE_QUESTIONS,
    time_limit_seconds: SQUARES_STAGE_1_TIME_SECONDS,
    hint: 'Type the exact square of each number (1 to 25).',
  },
  squares_stage_2: {
    key: 'squares_stage_2',
    title: 'Square - Stage 2 (26-50)',
    subgroup: 'Squares',
    min: 26,
    max: 50,
    power: 2,
    questions: SQUARES_STAGE_QUESTIONS,
    time_limit_seconds: SQUARES_STAGE_2_TIME_SECONDS,
    hint: 'Type the exact square of each number (26 to 50).',
  },
  squares_stage_3: {
    key: 'squares_stage_3',
    title: 'Square - Stage 3 (51-75)',
    subgroup: 'Squares',
    min: 51,
    max: 75,
    power: 2,
    questions: SQUARES_STAGE_QUESTIONS,
    time_limit_seconds: SQUARES_STAGE_3_TIME_SECONDS,
    hint: 'Type the exact square of each number (51 to 75).',
  },
  squares_stage_4: {
    key: 'squares_stage_4',
    title: 'Square - Stage 4 (76-100)',
    subgroup: 'Squares',
    min: 76,
    max: 100,
    power: 2,
    questions: SQUARES_STAGE_QUESTIONS,
    time_limit_seconds: SQUARES_STAGE_4_TIME_SECONDS,
    hint: 'Type the exact square of each number (76 to 100).',
  },
  squares_combined: {
    key: 'squares_combined',
    title: 'Square - Combined (1-100)',
    subgroup: 'Squares',
    min: 1,
    max: 100,
    power: 2,
    questions: SQUARES_COMBINED_QUESTIONS,
    time_limit_seconds: SQUARES_COMBINED_TIME_SECONDS,
    hint: 'Type the exact square of each number (1 to 100).',
  },
  cubes_stage_1: {
    key: 'cubes_stage_1',
    title: 'Cube - Stage 1 (1-25)',
    subgroup: 'Cubes',
    min: 1,
    max: 25,
    power: 3,
    questions: CUBES_STAGE_QUESTIONS,
    time_limit_seconds: CUBES_STAGE_1_TIME_SECONDS,
    hint: 'Type the exact cube of each number (1 to 25).',
  },
  cubes_stage_2: {
    key: 'cubes_stage_2',
    title: 'Cube - Stage 2 (26-50)',
    subgroup: 'Cubes',
    min: 26,
    max: 50,
    power: 3,
    questions: CUBES_STAGE_QUESTIONS,
    time_limit_seconds: CUBES_STAGE_2_TIME_SECONDS,
    hint: 'Type the exact cube of each number (26 to 50).',
  },
  cubes_stage_3: {
    key: 'cubes_stage_3',
    title: 'Cube - Stage 3 (51-75)',
    subgroup: 'Cubes',
    min: 51,
    max: 75,
    power: 3,
    questions: CUBES_STAGE_QUESTIONS,
    time_limit_seconds: CUBES_STAGE_3_TIME_SECONDS,
    hint: 'Type the exact cube of each number (51 to 75).',
  },
  cubes_stage_4: {
    key: 'cubes_stage_4',
    title: 'Cube - Stage 4 (76-100)',
    subgroup: 'Cubes',
    min: 76,
    max: 100,
    power: 3,
    questions: CUBES_STAGE_QUESTIONS,
    time_limit_seconds: CUBES_STAGE_4_TIME_SECONDS,
    hint: 'Type the exact cube of each number (76 to 100).',
  },
  cubes_combined: {
    key: 'cubes_combined',
    title: 'Cube - Combined (1-100)',
    subgroup: 'Cubes',
    min: 1,
    max: 100,
    power: 3,
    questions: CUBES_COMBINED_QUESTIONS,
    time_limit_seconds: CUBES_COMBINED_TIME_SECONDS,
    hint: 'Type the exact cube of each number (1 to 100).',
  },
});

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
  squares_stage_1: {
    key: SQUARE_CUBE_STAGE_SPECS.squares_stage_1.key,
    title: SQUARE_CUBE_STAGE_SPECS.squares_stage_1.title,
    group: 'Squares and cubes',
    subgroup: SQUARE_CUBE_STAGE_SPECS.squares_stage_1.subgroup,
    questions: SQUARE_CUBE_STAGE_SPECS.squares_stage_1.questions,
    time_limit_seconds: SQUARE_CUBE_STAGE_SPECS.squares_stage_1.time_limit_seconds,
    enabled: true,
    inputmode: 'numeric',
    hint: SQUARE_CUBE_STAGE_SPECS.squares_stage_1.hint,
  },
  squares_stage_2: {
    key: SQUARE_CUBE_STAGE_SPECS.squares_stage_2.key,
    title: SQUARE_CUBE_STAGE_SPECS.squares_stage_2.title,
    group: 'Squares and cubes',
    subgroup: SQUARE_CUBE_STAGE_SPECS.squares_stage_2.subgroup,
    questions: SQUARE_CUBE_STAGE_SPECS.squares_stage_2.questions,
    time_limit_seconds: SQUARE_CUBE_STAGE_SPECS.squares_stage_2.time_limit_seconds,
    enabled: true,
    inputmode: 'numeric',
    hint: SQUARE_CUBE_STAGE_SPECS.squares_stage_2.hint,
  },
  squares_stage_3: {
    key: SQUARE_CUBE_STAGE_SPECS.squares_stage_3.key,
    title: SQUARE_CUBE_STAGE_SPECS.squares_stage_3.title,
    group: 'Squares and cubes',
    subgroup: SQUARE_CUBE_STAGE_SPECS.squares_stage_3.subgroup,
    questions: SQUARE_CUBE_STAGE_SPECS.squares_stage_3.questions,
    time_limit_seconds: SQUARE_CUBE_STAGE_SPECS.squares_stage_3.time_limit_seconds,
    enabled: true,
    inputmode: 'numeric',
    hint: SQUARE_CUBE_STAGE_SPECS.squares_stage_3.hint,
  },
  squares_stage_4: {
    key: SQUARE_CUBE_STAGE_SPECS.squares_stage_4.key,
    title: SQUARE_CUBE_STAGE_SPECS.squares_stage_4.title,
    group: 'Squares and cubes',
    subgroup: SQUARE_CUBE_STAGE_SPECS.squares_stage_4.subgroup,
    questions: SQUARE_CUBE_STAGE_SPECS.squares_stage_4.questions,
    time_limit_seconds: SQUARE_CUBE_STAGE_SPECS.squares_stage_4.time_limit_seconds,
    enabled: true,
    inputmode: 'numeric',
    hint: SQUARE_CUBE_STAGE_SPECS.squares_stage_4.hint,
  },
  squares_combined: {
    key: SQUARE_CUBE_STAGE_SPECS.squares_combined.key,
    title: SQUARE_CUBE_STAGE_SPECS.squares_combined.title,
    group: 'Squares and cubes',
    subgroup: SQUARE_CUBE_STAGE_SPECS.squares_combined.subgroup,
    questions: SQUARE_CUBE_STAGE_SPECS.squares_combined.questions,
    time_limit_seconds: SQUARE_CUBE_STAGE_SPECS.squares_combined.time_limit_seconds,
    enabled: true,
    inputmode: 'numeric',
    hint: SQUARE_CUBE_STAGE_SPECS.squares_combined.hint,
  },
  cubes_stage_1: {
    key: SQUARE_CUBE_STAGE_SPECS.cubes_stage_1.key,
    title: SQUARE_CUBE_STAGE_SPECS.cubes_stage_1.title,
    group: 'Squares and cubes',
    subgroup: SQUARE_CUBE_STAGE_SPECS.cubes_stage_1.subgroup,
    questions: SQUARE_CUBE_STAGE_SPECS.cubes_stage_1.questions,
    time_limit_seconds: SQUARE_CUBE_STAGE_SPECS.cubes_stage_1.time_limit_seconds,
    enabled: true,
    inputmode: 'numeric',
    hint: SQUARE_CUBE_STAGE_SPECS.cubes_stage_1.hint,
  },
  cubes_stage_2: {
    key: SQUARE_CUBE_STAGE_SPECS.cubes_stage_2.key,
    title: SQUARE_CUBE_STAGE_SPECS.cubes_stage_2.title,
    group: 'Squares and cubes',
    subgroup: SQUARE_CUBE_STAGE_SPECS.cubes_stage_2.subgroup,
    questions: SQUARE_CUBE_STAGE_SPECS.cubes_stage_2.questions,
    time_limit_seconds: SQUARE_CUBE_STAGE_SPECS.cubes_stage_2.time_limit_seconds,
    enabled: true,
    inputmode: 'numeric',
    hint: SQUARE_CUBE_STAGE_SPECS.cubes_stage_2.hint,
  },
  cubes_stage_3: {
    key: SQUARE_CUBE_STAGE_SPECS.cubes_stage_3.key,
    title: SQUARE_CUBE_STAGE_SPECS.cubes_stage_3.title,
    group: 'Squares and cubes',
    subgroup: SQUARE_CUBE_STAGE_SPECS.cubes_stage_3.subgroup,
    questions: SQUARE_CUBE_STAGE_SPECS.cubes_stage_3.questions,
    time_limit_seconds: SQUARE_CUBE_STAGE_SPECS.cubes_stage_3.time_limit_seconds,
    enabled: true,
    inputmode: 'numeric',
    hint: SQUARE_CUBE_STAGE_SPECS.cubes_stage_3.hint,
  },
  cubes_stage_4: {
    key: SQUARE_CUBE_STAGE_SPECS.cubes_stage_4.key,
    title: SQUARE_CUBE_STAGE_SPECS.cubes_stage_4.title,
    group: 'Squares and cubes',
    subgroup: SQUARE_CUBE_STAGE_SPECS.cubes_stage_4.subgroup,
    questions: SQUARE_CUBE_STAGE_SPECS.cubes_stage_4.questions,
    time_limit_seconds: SQUARE_CUBE_STAGE_SPECS.cubes_stage_4.time_limit_seconds,
    enabled: true,
    inputmode: 'numeric',
    hint: SQUARE_CUBE_STAGE_SPECS.cubes_stage_4.hint,
  },
  cubes_combined: {
    key: SQUARE_CUBE_STAGE_SPECS.cubes_combined.key,
    title: SQUARE_CUBE_STAGE_SPECS.cubes_combined.title,
    group: 'Squares and cubes',
    subgroup: SQUARE_CUBE_STAGE_SPECS.cubes_combined.subgroup,
    questions: SQUARE_CUBE_STAGE_SPECS.cubes_combined.questions,
    time_limit_seconds: SQUARE_CUBE_STAGE_SPECS.cubes_combined.time_limit_seconds,
    enabled: true,
    inputmode: 'numeric',
    hint: SQUARE_CUBE_STAGE_SPECS.cubes_combined.hint,
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
    subgroup: 'Squares',
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
    subgroup: 'Squares',
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
