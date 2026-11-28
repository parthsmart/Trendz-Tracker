/**
 * Trendz Tracker: the student "world" layer (shared/world.js)
 *
 * Pure logic shared by the browser (js/journey.js, js/mascot.js), the server
 * (api/journey.js) and the tests. Nothing here touches the DOM or the database.
 *
 *   - Mascots: three original companions that grow with the student's level.
 *   - Journey: one island per standard level, stages that map to real practice,
 *     and a boss round (a short level exam) generated and marked on the server.
 *   - Seasons: themed 8-week seasons (the season leaderboard and tiers reuse XP).
 *
 * The journey stages also live in the `journey_stages` table (the migration seeds
 * the same list); tests/world.test.js checks the two copies match.
 */

import { STUDENT_LEVELS } from './levels.js';

/* ------------------------------------------------------------------------ */
/* Mascots                                                                   */
/* ------------------------------------------------------------------------ */

export const MASCOT_KINDS = Object.freeze(['owl', 'bot', 'dragon']);

export const MASCOTS = Object.freeze({
  owl: Object.freeze({
    kind: 'owl',
    name: 'Beadle',
    title: 'Beadle the owl',
    blurb: 'Wise and playful. A tiny abacus on its chest gains a rod as you level up.',
    forms: ['Egg', 'Owlet', 'Fledgling', 'Hooter', 'Night flyer', 'Bead keeper', 'Scholar',
      'Star gazer', 'Wise wing', 'Graduate', 'Sage', 'Grand sage'],
  }),
  bot: Object.freeze({
    kind: 'bot',
    name: 'Bead-bot',
    title: 'Bead-bot',
    blurb: 'A friendly robot whose body is an abacus. Each level adds a rod and an upgrade.',
    forms: ['Spark', 'Bolt', 'Gizmo', 'Counter', 'Calcu', 'Turbo', 'Processor',
      'Quantum', 'Supercore', 'Graduate', 'Mainframe', 'Grand mainframe'],
  }),
  dragon: Object.freeze({
    kind: 'dragon',
    name: 'Ember',
    title: 'Ember the dragon',
    blurb: 'Hatches from an egg and grows horns and wings. A little abacus glows on its belly.',
    forms: ['Egg', 'Hatchling', 'Nibbler', 'Glider', 'Flamelet', 'Soarer', 'Skyfire',
      'Stormwing', 'Highflame', 'Graduate', 'Elder', 'Grand elder'],
  }),
});

export function isMascotKind(kind) {
  return MASCOT_KINDS.includes(kind);
}

/** 0 (KA-1) .. 11 (Grandmaster); -1 when the student has no standard level. */
export function levelIndex(level) {
  return STUDENT_LEVELS.indexOf(level);
}

/**
 * The look of a mascot at a level: the form name plus the traits the SVG
 * renderer draws. A student with no level gets the first form.
 */
export function mascotForm(kind, level) {
  const k = isMascotKind(kind) ? kind : 'owl';
  const idx = Math.max(0, levelIndex(level));
  return {
    kind: k,
    stage: idx,
    name: MASCOTS[k].forms[idx],
    scale: 0.72 + idx * 0.028, // grows a little each level
    rods: Math.min(6, 1 + Math.floor(idx / 2)), // abacus rods on the body
    wings: idx >= 3,
    cap: idx === 9, // Graduate cap
    cape: idx >= 10, // Master and Grandmaster
    crown: idx === 11,
    hatching: idx === 0 && k !== 'bot',
  };
}

export const MASCOT_MOODS = Object.freeze(['idle', 'happy', 'cheer', 'encourage']);

/**
 * How the mascot reacts to a finished round.
 *   cheer      a new personal best
 *   happy      a streak of 3+ days, or a strong round (80%+)
 *   encourage  mistakes: under 60% right
 *   idle       anything else
 */
export function pickMascotMood({ correct = 0, total = 0, personalBest = false, streak = 0 } = {}) {
  if (personalBest) return 'cheer';
  const acc = total > 0 ? correct / total : 0;
  if (total > 0 && acc < 0.6) return 'encourage';
  if (Number(streak) >= 3 || (total > 0 && acc >= 0.8)) return 'happy';
  return 'idle';
}

const MOOD_LINES = Object.freeze({
  cheer: ['New personal best! You beat your record.', 'A new record! Your practice is paying off.'],
  happy: ['Great streak, keep it going!', 'Strong round. Your abacus hands are getting fast.'],
  encourage: ['Mistakes help you learn. Try a slower pace next round.', 'Every champion misses some. Check the beads and try again.'],
  idle: ['Nice work. One more round?', 'Steady practice builds speed.'],
});

/** A short line for the mascot's speech bubble (deterministic for tests via `pick`). */
export function mascotLine(mood, pick = 0) {
  const lines = MOOD_LINES[mood] || MOOD_LINES.idle;
  return lines[Math.abs(Math.trunc(pick)) % lines.length];
}

/* ------------------------------------------------------------------------ */
/* Journey: islands and stages                                               */
/* ------------------------------------------------------------------------ */

export const ISLAND_NAMES = Object.freeze({
  'KA-1': 'Pebble Isle',
  'KA-2': 'Bead Bay',
  'KA-3': 'Counting Cove',
  'Level 1': 'Abacus Atoll',
  'Level 2': 'Carry Key',
  'Level 3': 'Flash Falls',
  'Level 4': 'Rod Ridge',
  'Level 5': 'Mental Mesa',
  'Level 6': 'Lightning Lagoon',
  Graduate: 'Scholar Summit',
  Master: 'Master Mountain',
  Grandmaster: 'Grandmaster Peak',
});

/** Practice each stage counts, and the real page where it is practised. */
export const STAGE_KINDS = Object.freeze({
  rounds: { label: 'Abacus rounds', icon: '🎯', href: '/pages/round-scores.html' },
  basics: { label: 'Basics', icon: '➕', href: '/pages/basics.html' },
  flash: { label: 'Flash Anzan', icon: '⚡', href: '/pages/flash.html' },
  excel: { label: 'Excel-style main round', icon: '📄', href: '/pages/round-scores.html' },
  memoriad: { label: 'Memoriad', icon: '🧠', href: '/pages/memoriad.html' },
  oral: { label: 'Oral set (checked)', icon: '🗣️', href: '/pages/journey.html#oral' },
});

export const STAGE_ORDER = Object.freeze(['rounds', 'basics', 'flash', 'excel', 'memoriad', 'oral']);

/** How many stages must be cleared before the boss round opens (any 5 of 6). */
export const STAGES_FOR_BOSS = 5;

function roundsNeededFor(idx) {
  if (idx <= 2) return 3;
  if (idx <= 5) return 4;
  if (idx <= 8) return 5;
  return 6;
}

const STAGE_RULES = Object.freeze({
  rounds: { scale: 1, minAccuracy: 70 },
  basics: { scale: 1, minAccuracy: 70 },
  flash: { scale: 1, minAccuracy: 60 },
  excel: { fixed: 1, minAccuracy: 50 },
  memoriad: { fixed: 2, minAccuracy: 50 },
  oral: { fixed: 2, minAccuracy: 70 },
});

/** The stage list for one level (mirrors the `journey_stages` seed). */
export function journeyStages(level) {
  const idx = levelIndex(level);
  if (idx < 0) return [];
  return STAGE_ORDER.map((kind, i) => {
    const rule = STAGE_RULES[kind];
    return {
      level,
      ord: i + 1,
      kind,
      title: STAGE_KINDS[kind].label,
      rounds_needed: rule.fixed || roundsNeededFor(idx) * rule.scale,
      min_accuracy: rule.minAccuracy,
    };
  });
}

/**
 * Turns stage counts into the map state.
 * @param {Array<{kind:string, done:number, rounds_needed:number}>} stages
 */
export function journeyState(stages = []) {
  const list = stages.map((s) => ({
    ...s,
    done: Math.max(0, Number(s.done) || 0),
    complete: (Number(s.done) || 0) >= (Number(s.rounds_needed) || 1),
  }));
  const cleared = list.filter((s) => s.complete).length;
  return {
    stages: list,
    cleared,
    total: list.length,
    bossOpen: list.length > 0 && cleared >= Math.min(STAGES_FOR_BOSS, list.length),
  };
}

/* ------------------------------------------------------------------------ */
/* Boss rounds: generated and marked on the server                           */
/* ------------------------------------------------------------------------ */

export const BOSS_PASS_PERCENT = 80;
export const BOSS_ATTEMPTS_PER_DAY = 3;
export const ORAL_SET_SIZE = 10;
export const ORAL_PASS_PERCENT = 70;

/**
 * One blueprint per level, built from the level's real question types:
 *   add  = abacus addition/subtraction rows (digits x rows), like Basics "2d4r"
 *   mul  = multiplication (a-digit x b-digit), like Basics "2dx1d"
 *   div  = exact division (a-digit / b-digit), like Basics "3d/1d"
 *   flash = Flash Anzan: numbers flash one by one, answer the total
 *   oral = Oral round: two numbers read aloud, answer the result
 */
const B = (minutes, sections) => Object.freeze({ minutes, sections: Object.freeze(sections) });
export const BOSS_BLUEPRINTS = Object.freeze({
  'KA-1': B(6, [{ type: 'add', digits: 1, rows: 3, count: 6, minus: false }, { type: 'flash', digits: 1, rows: 3, count: 2, ms: 1500 }, { type: 'oral', op: '+', a: 1, b: 1, count: 2 }]),
  'KA-2': B(7, [{ type: 'add', digits: 1, rows: 5, count: 6, minus: true }, { type: 'flash', digits: 1, rows: 5, count: 2, ms: 1300 }, { type: 'oral', op: '+', a: 1, b: 1, count: 2 }]),
  'KA-3': B(8, [{ type: 'add', digits: 2, rows: 3, count: 5, minus: true }, { type: 'mul', a: 1, b: 1, count: 3 }, { type: 'flash', digits: 1, rows: 7, count: 2, ms: 1100 }, { type: 'oral', op: '+', a: 2, b: 1, count: 2 }]),
  'Level 1': B(8, [{ type: 'add', digits: 2, rows: 4, count: 5, minus: true }, { type: 'mul', a: 2, b: 1, count: 3 }, { type: 'flash', digits: 2, rows: 3, count: 2, ms: 1100 }, { type: 'oral', op: 'x', a: 1, b: 1, count: 2 }]),
  'Level 2': B(9, [{ type: 'add', digits: 2, rows: 5, count: 4, minus: true }, { type: 'mul', a: 3, b: 1, count: 3 }, { type: 'div', a: 2, b: 1, count: 3 }, { type: 'flash', digits: 2, rows: 4, count: 2, ms: 1000 }, { type: 'oral', op: 'x', a: 2, b: 1, count: 2 }]),
  'Level 3': B(10, [{ type: 'add', digits: 3, rows: 4, count: 4, minus: true }, { type: 'mul', a: 2, b: 2, count: 3 }, { type: 'div', a: 3, b: 1, count: 3 }, { type: 'flash', digits: 2, rows: 5, count: 2, ms: 900 }, { type: 'oral', op: 'x', a: 2, b: 1, count: 2 }]),
  'Level 4': B(10, [{ type: 'add', digits: 3, rows: 5, count: 4, minus: true }, { type: 'mul', a: 3, b: 2, count: 3 }, { type: 'div', a: 4, b: 1, count: 3 }, { type: 'flash', digits: 2, rows: 7, count: 2, ms: 800 }, { type: 'oral', op: 'x', a: 2, b: 2, count: 2 }]),
  'Level 5': B(11, [{ type: 'add', digits: 4, rows: 5, count: 4, minus: true }, { type: 'mul', a: 3, b: 2, count: 3 }, { type: 'div', a: 3, b: 2, count: 3 }, { type: 'flash', digits: 3, rows: 4, count: 2, ms: 800 }, { type: 'oral', op: 'x', a: 2, b: 2, count: 2 }]),
  'Level 6': B(12, [{ type: 'add', digits: 4, rows: 6, count: 4, minus: true }, { type: 'mul', a: 4, b: 2, count: 3 }, { type: 'div', a: 4, b: 2, count: 3 }, { type: 'flash', digits: 3, rows: 5, count: 2, ms: 700 }, { type: 'oral', op: 'x', a: 3, b: 1, count: 2 }]),
  Graduate: B(12, [{ type: 'add', digits: 5, rows: 6, count: 4, minus: true }, { type: 'mul', a: 4, b: 3, count: 3 }, { type: 'div', a: 5, b: 2, count: 3 }, { type: 'flash', digits: 3, rows: 7, count: 2, ms: 600 }, { type: 'oral', op: 'x', a: 3, b: 2, count: 2 }]),
  Master: B(14, [{ type: 'add', digits: 5, rows: 8, count: 4, minus: true }, { type: 'mul', a: 5, b: 3, count: 3 }, { type: 'div', a: 6, b: 3, count: 3 }, { type: 'flash', digits: 3, rows: 10, count: 2, ms: 500 }, { type: 'oral', op: 'x', a: 3, b: 2, count: 2 }]),
  Grandmaster: B(15, [{ type: 'add', digits: 6, rows: 10, count: 4, minus: true }, { type: 'mul', a: 6, b: 3, count: 3 }, { type: 'div', a: 7, b: 3, count: 3 }, { type: 'flash', digits: 4, rows: 10, count: 2, ms: 450 }, { type: 'oral', op: 'x', a: 3, b: 3, count: 2 }]),
});

/** Small seeded generator so tests (and a stored seed) give the same paper. */
export function seededRandom(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function intWithDigits(rand, digits) {
  if (digits <= 1) return 1 + Math.floor(rand() * 9);
  const lo = 10 ** (digits - 1);
  return lo + Math.floor(rand() * (9 * lo));
}

/** Rows that never go below zero, so every sum can be done on an abacus. */
function abacusRows(rand, digits, rows, minus) {
  const nums = [intWithDigits(rand, digits)];
  let total = nums[0];
  for (let i = 1; i < rows; i += 1) {
    const n = intWithDigits(rand, digits);
    if (minus && rand() < 0.4 && total - n >= 0) {
      nums.push(-n);
      total -= n;
    } else {
      nums.push(n);
      total += n;
    }
  }
  return { nums, total };
}

function makeQuestion(section, rand) {
  switch (section.type) {
    case 'add': {
      const { nums, total } = abacusRows(rand, section.digits, section.rows, section.minus);
      return { type: 'add', prompt: { nums }, answer: total };
    }
    case 'mul': {
      const a = intWithDigits(rand, section.a);
      const b = intWithDigits(rand, section.b);
      return { type: 'mul', prompt: { a, b, op: 'x' }, answer: a * b };
    }
    case 'div': {
      // Exact division: dividend has section.a digits, divisor section.b digits.
      for (let tries = 0; tries < 50; tries += 1) {
        const b = Math.max(2, intWithDigits(rand, section.b));
        const lo = 10 ** (section.a - 1);
        const hi = 10 ** section.a - 1;
        const qMin = Math.ceil(lo / b);
        const qMax = Math.floor(hi / b);
        if (qMax >= qMin && qMax >= 1) {
          const q = qMin + Math.floor(rand() * (qMax - qMin + 1));
          return { type: 'div', prompt: { a: q * b, b, op: '/' }, answer: q };
        }
      }
      return { type: 'div', prompt: { a: 8, b: 2, op: '/' }, answer: 4 };
    }
    case 'flash': {
      const { nums, total } = abacusRows(rand, section.digits, section.rows, false);
      return { type: 'flash', prompt: { nums, ms: section.ms }, answer: total };
    }
    case 'oral': {
      const a = intWithDigits(rand, section.a);
      const b = intWithDigits(rand, section.b);
      const op = section.op === 'x' ? 'x' : '+';
      return { type: 'oral', prompt: { a, b, op }, answer: op === 'x' ? a * b : a + b };
    }
    default:
      throw new Error(`Unknown section type: ${section.type}`);
  }
}

/** Builds a boss paper. Returns questions WITH answers: the server keeps the answers. */
export function generateBossPaper(level, seed) {
  const bp = BOSS_BLUEPRINTS[level];
  if (!bp) throw new Error('This level has no boss round.');
  const rand = seededRandom(seed);
  const questions = [];
  for (const section of bp.sections) {
    for (let i = 0; i < section.count; i += 1) questions.push(makeQuestion(section, rand));
  }
  return { level, minutes: bp.minutes, questions };
}

/** A checked oral set at the student's level (uses that level's oral section). */
export function generateOralSet(level, seed, size = ORAL_SET_SIZE) {
  const bp = BOSS_BLUEPRINTS[level] || BOSS_BLUEPRINTS['KA-1'];
  const oral = bp.sections.find((s) => s.type === 'oral');
  const rand = seededRandom(seed);
  const questions = [];
  for (let i = 0; i < size; i += 1) questions.push(makeQuestion(oral, rand));
  return { level, minutes: 10, questions };
}

/** What the browser may see: the prompts only, never the answers. */
export function publicQuestions(questions = []) {
  return questions.map((q, i) => ({ n: i + 1, type: q.type, prompt: q.prompt }));
}

/** Reads one typed answer as a whole number, or null when it is blank or not a number. */
export function parseAnswer(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().replace(/[,\s]/g, '');
  if (!/^-?\d{1,12}$/.test(s)) return null;
  return Number(s);
}

/**
 * Marks a paper on the server.
 * @returns {{correct:number, total:number, percent:number, passed:boolean, by_type:Object, marks:boolean[]}}
 */
export function gradePaper(questions = [], answers = [], passPercent = BOSS_PASS_PERCENT) {
  const marks = questions.map((q, i) => parseAnswer(Array.isArray(answers) ? answers[i] : undefined) === q.answer);
  const byType = {};
  questions.forEach((q, i) => {
    const t = (byType[q.type] ||= { correct: 0, total: 0 });
    t.total += 1;
    if (marks[i]) t.correct += 1;
  });
  const correct = marks.filter(Boolean).length;
  const total = questions.length;
  const percent = total > 0 ? Math.round((correct / total) * 1000) / 10 : 0;
  return { correct, total, percent, passed: total > 0 && percent >= passPercent, by_type: byType, marks };
}

/** The words read aloud for an oral question. */
export function oralSpeech(prompt) {
  if (!prompt) return '';
  return `${prompt.a} ${prompt.op === 'x' ? 'times' : 'plus'} ${prompt.b}`;
}

/* ------------------------------------------------------------------------ */
/* Seasons                                                                   */
/* ------------------------------------------------------------------------ */

export const SEASON_DAYS = 56; // 8 weeks

export const SEASON_THEMES = Object.freeze({
  space: { label: 'Space Season', icon: '🚀', item: 'helmet', itemLabel: 'Space helmet', colour: '#3C3489' },
  ocean: { label: 'Ocean Season', icon: '🌊', item: 'snorkel', itemLabel: 'Diving mask', colour: '#185FA5' },
  jungle: { label: 'Jungle Season', icon: '🌴', item: 'explorer', itemLabel: 'Explorer hat', colour: '#3B6D11' },
  arctic: { label: 'Arctic Season', icon: '❄️', item: 'scarf', itemLabel: 'Snow scarf', colour: '#0C447C' },
  desert: { label: 'Desert Season', icon: '🏜️', item: 'shades', itemLabel: 'Sun shades', colour: '#854F0B' },
  volcano: { label: 'Volcano Season', icon: '🌋', item: 'flame', itemLabel: 'Flame cape', colour: '#993C1D' },
});

export function isSeasonTheme(theme) {
  return Object.hasOwn(SEASON_THEMES, theme);
}

function toDate(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toIso(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(iso, days) {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
}

/** Last day of an 8-week season that starts on `startsOn`. */
export function seasonEnd(startsOn) {
  return addDays(startsOn, SEASON_DAYS - 1);
}

/**
 * The season window for a day: the themed season covering it, or else the
 * calendar month clipped so it never overlaps a themed season.
 * Mirrors public.season_bounds() in the migration.
 * @param {string} day ISO date
 * @param {Array<{starts_on:string, ends_on:string, status?:string}>} seasons
 */
export function seasonBounds(day, seasons = []) {
  const live = seasons.filter((s) => (s.status || 'scheduled') === 'scheduled');
  const themed = live.find((s) => s.starts_on <= day && day <= s.ends_on);
  if (themed) return { from: themed.starts_on, to: themed.ends_on, themed: true, season: themed };
  const d = toDate(day);
  const mFrom = toIso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)));
  const mTo = toIso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
  let from = mFrom;
  let to = mTo;
  for (const s of live) {
    if (s.ends_on < day && s.ends_on >= mFrom) from = from > addDays(s.ends_on, 1) ? from : addDays(s.ends_on, 1);
    if (s.starts_on > day && s.starts_on <= mTo) to = to < addDays(s.starts_on, -1) ? to : addDays(s.starts_on, -1);
  }
  return { from, to, themed: false, season: null };
}

/**
 * Checks a new season before it is saved (the server checks again).
 * @returns {string|null} an error message, or null when it is fine
 */
export function validateSeasonDraft({ name, theme, starts_on: startsOn } = {}, { today, seasons = [] } = {}) {
  if (!String(name || '').trim()) return 'Give the season a name.';
  if (String(name).trim().length > 60) return 'Keep the name under 60 characters.';
  if (!isSeasonTheme(theme)) return 'Choose a theme.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startsOn || ''))) return 'Choose a start date.';
  if (today && startsOn <= today) return 'A season must start tomorrow or later.';
  const endsOn = seasonEnd(startsOn);
  const clash = seasons.find((s) => (s.status || 'scheduled') === 'scheduled'
    && s.starts_on <= endsOn && startsOn <= s.ends_on);
  if (clash) return `It overlaps "${clash.name}".`;
  return null;
}
