import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import {
  NO_LEVEL_FILTER,
  STAFF_LEVELS,
  STUDENT_LEVELS,
  levelFilterOptionsHtml,
  levelOptionsHtml,
  matchesLevelFilter,
  normalizeLevel,
  sortLevels,
  upgradeLegacyLevel,
  validateLevel,
} from '../shared/levels.js';
import { upgradeProfileLevels } from '../scripts/restoreFromBackup.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = path.join(root, 'supabase/migrations/21_standard_student_levels.sql');

const EXPECTED = [
  'KA-1', 'KA-2', 'KA-3',
  'Level 1', 'Level 2', 'Level 3', 'Level 4', 'Level 5', 'Level 6',
  'Graduate', 'Master', 'Grandmaster',
];

describe('STUDENT_LEVELS — the one level list', () => {
  it('is exactly the approved list, in order, and frozen', () => {
    assert.deepEqual([...STUDENT_LEVELS], EXPECTED);
    assert.ok(Object.isFrozen(STUDENT_LEVELS));
    assert.deepEqual([...STAFF_LEVELS], ['Teacher', 'Admin']);
  });

  it('matches the list in the database migration', () => {
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    const fn = sql.slice(sql.indexOf('is_standard_student_level'), sql.indexOf('$function$;'));
    const inSql = [...fn.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(inSql, EXPECTED);
  });

  it('dropdown options follow the list order', () => {
    const html = levelOptionsHtml({ blankLabel: 'No level' });
    const values = [...html.matchAll(/value="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(values, ['', ...EXPECTED]);
    const filter = levelFilterOptionsHtml({ allLabel: 'All Levels' });
    const fValues = [...filter.matchAll(/value="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(fValues, ['', ...EXPECTED, NO_LEVEL_FILTER]);
  });

  it('no page still hard-codes an old level option', () => {
    const pages = fs.readdirSync(path.join(root, 'pages')).filter((f) => f.endsWith('.html'));
    for (const page of pages) {
      const html = fs.readFileSync(path.join(root, 'pages', page), 'utf8');
      assert.doesNotMatch(html, /<option value="(Level \d|Master|Junior \d)"/, page);
    }
  });
});

describe('normalizeLevel / validateLevel', () => {
  it('accepts loose spellings and returns the canonical level', () => {
    assert.equal(normalizeLevel('ka 1'), 'KA-1');
    assert.equal(normalizeLevel('KA2'), 'KA-2');
    assert.equal(normalizeLevel(' ka-3 '), 'KA-3');
    assert.equal(normalizeLevel('level6'), 'Level 6');
    assert.equal(normalizeLevel('L4'), 'Level 4');
    assert.equal(normalizeLevel('2'), 'Level 2');
    assert.equal(normalizeLevel('GRAND MASTER'), 'Grandmaster');
    assert.equal(normalizeLevel('graduate'), 'Graduate');
  });

  it('rejects anything outside the list', () => {
    for (const bad of ['Junior 1', 'Junior 2', 'Level 7', 'KA-4', '0', 'Senior', 'Foundation']) {
      assert.equal(normalizeLevel(bad), null, bad);
      assert.ok(validateLevel(bad).error, bad);
    }
  });

  it('only allows staff levels when asked', () => {
    assert.equal(normalizeLevel('Teacher'), null);
    assert.equal(normalizeLevel('teacher', { allowStaff: true }), 'Teacher');
    assert.equal(normalizeLevel('ADMIN', { allowStaff: true }), 'Admin');
  });

  it('blank means no level', () => {
    assert.deepEqual(validateLevel(''), { value: null });
    assert.deepEqual(validateLevel('   '), { value: null });
    assert.deepEqual(validateLevel(null), { value: null });
    assert.deepEqual(validateLevel('master'), { value: 'Master' });
  });

  it('sorts by list order with unknown values last', () => {
    assert.deepEqual(sortLevels(['Master', 'Junior 2', 'KA-1', 'Level 10', 'Level 2']), [
      'KA-1', 'Level 2', 'Master', 'Junior 2', 'Level 10',
    ]);
  });

  it('level filter handles all, one level, and no level', () => {
    assert.equal(matchesLevelFilter('Level 3', ''), true);
    assert.equal(matchesLevelFilter('Level 3', 'Level 3'), true);
    assert.equal(matchesLevelFilter('Level 3', 'Level 4'), false);
    assert.equal(matchesLevelFilter(null, NO_LEVEL_FILTER), true);
    assert.equal(matchesLevelFilter('  ', NO_LEVEL_FILTER), true);
    assert.equal(matchesLevelFilter('KA-1', NO_LEVEL_FILTER), false);
  });
});

describe('approved mapping for old levels', () => {
  it('upgradeLegacyLevel follows the owner-approved mapping', () => {
    assert.equal(upgradeLegacyLevel('2', 'student'), 'Level 2');
    assert.equal(upgradeLegacyLevel('Teacher', 'student'), 'Level 1');
    assert.equal(upgradeLegacyLevel('Junior 1', 'student'), null);
    assert.equal(upgradeLegacyLevel('Junior 2', 'student'), null);
    assert.equal(upgradeLegacyLevel('Master', 'student'), 'Master');
    assert.equal(upgradeLegacyLevel('Level 5', 'student'), 'Level 5');
    assert.equal(upgradeLegacyLevel(null, 'student'), null);
    assert.equal(upgradeLegacyLevel('Teacher', 'teacher'), 'Teacher');
    assert.equal(upgradeLegacyLevel(null, 'admin'), null);
  });

  it('restoring an old backup maps profile levels the same way', () => {
    const rows = [
      { id: 'a', role: 'student', level: 'Junior 2' },
      { id: 'b', role: 'student', level: '2' },
      { id: 'c', role: 'student', level: 'Teacher' },
      { id: 'd', role: 'teacher', level: 'Teacher' },
      { id: 'e', role: 'student', level: 'Master' },
    ];
    assert.deepEqual(upgradeProfileLevels(rows).map((r) => r.level), [null, 'Level 2', 'Level 1', 'Teacher', 'Master']);
    assert.equal(upgradeProfileLevels(rows)[4], rows[4], 'unchanged rows are passed through');
  });
});

describe('migration 21 on a copy of the live level values', () => {
  async function freshDb() {
    const db = new PGlite();
    await db.exec(`
      CREATE TABLE public.profiles (
        id serial PRIMARY KEY,
        student_code text,
        role text NOT NULL,
        level text
      );
    `);
    return db;
  }

  it('moves every live value by the approved mapping and adds the check', async () => {
    const db = await freshDb();
    await db.exec(`
      INSERT INTO public.profiles (student_code, role, level) VALUES
        ('ADM', 'admin', NULL),
        ('STU101', 'student', '2'),
        ('STUD_07', 'student', 'Junior 1'),
        ('J2', 'student', 'Junior 2'),
        ('L3', 'student', 'Level 3'),
        ('L4', 'student', 'Level 4'),
        ('L5', 'student', 'Level 5'),
        ('M', 'student', 'Master'),
        ('M2', 'student', 'master '),
        ('TEACH_01', 'student', 'Teacher'),
        ('STUD_16', 'student', NULL),
        ('TCH01', 'teacher', 'Teacher');
    `);
    await db.exec(fs.readFileSync(MIGRATION, 'utf8'));
    const { rows } = await db.query('SELECT student_code, level FROM public.profiles ORDER BY id');
    assert.deepEqual(Object.fromEntries(rows.map((r) => [r.student_code, r.level])), {
      ADM: null,
      STU101: 'Level 2',
      STUD_07: null,
      J2: null,
      L3: 'Level 3',
      L4: 'Level 4',
      L5: 'Level 5',
      M: 'Master',
      M2: 'Master',
      TEACH_01: 'Level 1',
      STUD_16: null,
      TCH01: 'Teacher',
    });

    for (const level of EXPECTED) {
      await db.query("UPDATE public.profiles SET level = $1 WHERE student_code = 'L3'", [level]);
    }
    await assert.rejects(db.query("UPDATE public.profiles SET level = 'Junior 2' WHERE student_code = 'L3'"));
    await assert.rejects(db.query("UPDATE public.profiles SET level = 'Teacher' WHERE student_code = 'L3'"));
    await db.query("UPDATE public.profiles SET level = 'Admin' WHERE student_code = 'ADM'");
    await db.close();
  });

  it('stops instead of guessing when an unknown value is present', async () => {
    const db = await freshDb();
    await db.exec(`INSERT INTO public.profiles (student_code, role, level) VALUES ('X', 'student', 'Foundation');`);
    await assert.rejects(db.exec(fs.readFileSync(MIGRATION, 'utf8')), /need a decision first: Foundation/);
    const { rows } = await db.query('SELECT level FROM public.profiles');
    assert.equal(rows[0].level, 'Foundation');
    await db.close();
  });
});
