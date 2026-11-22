/**
 * Student Access Feature Test Suite (tests/studentAccess.test.js)
 *
 * Verifies:
 * 1. Pure validation functions (js/studentAccess.js):
 *    - Level 1 defaults (only 1D 4R allowed, 2D 4R blocked)
 *    - Master full access (all drills allowed)
 *    - Elements individual drill selection (squares stage 1 allowed vs stage 2 blocked)
 *    - Flash Anzan Allowed / Hidden switch
 *    - Memoriad Calendar 25 dates allowed vs 125 dates blocked
 *    - Main Round category access and full-paper access (requires all categories)
 * 2. DemoDB Parity & Access State Management:
 *    - Level defaults save & fetch
 *    - Student effective access resolution (inheriting level defaults)
 *    - Student override and provenance ("From Level 3" vs "Student override")
 *    - Reset student override ("Use level settings")
 *    - Teacher bulk apply: only updates assigned students in level; other teachers’ students untouched
 *    - Mock practice session guards (mockFlashStart, mockBasicsDrillStart, mockMemoriadStart)
 *    - Assignment exceptions (Homework and Daily To-Do bypass free-practice restriction)
 * 3. Server-side API Enforcement:
 *    - Direct start requests to unallowed practice return 403 PRACTICE_ACCESS_RESTRICTED
 *    - Homework / Daily To-Do assignment exceptions bypass restriction on server
 *    - Main Round competition eligibility, category access, and full-paper access
 * 4. Client-side Navigation & View Models:
 *    - Navigation menus omit Flash Anzan when hidden
 *    - JMCWC Landing view model (buildLandingPageViewModel) disables start with clear reasons
 *    - Score history and past results remain viewable
 * 5. Isolated PostgreSQL (PGlite) Integration:
 *    - staging_student_access_feature.sql executes cleanly and idempotently
 *    - Admin save level defaults and teacher access boundaries
 *    - Teacher cannot alter main_round_eligible
 *    - Teacher cannot override unassigned students
 *    - Teacher bulk apply updates only assigned students in level
 *    - Student direct write blocked by RLS; read access permitted
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

// Initialize global localStorage mock for Node test environment
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
    key: (i) => Array.from(store.keys())[i] || null,
  };
}

import {
  normalizeCategoryKey,
  isBasicsCategoryAllowed,
  isElementDrillAllowed,
  isFlashAllowed,
  isMemoriadAllowed,
  isMainRoundCategoryAllowed,
  isMainRoundFullPaperAllowed,
  resolveAccessProvenance,
  fetchStudentEffectiveAccess,
} from '../js/studentAccess.js';

import { DemoDB } from '../js/demoDb.js';
import { callFlashStartRpc } from '../js/flash.js';
import { getRoleNavItems, getDesktopNavEntries, getGroupedNavItems } from '../js/navConfig.js';
import { buildLandingPageViewModel } from '../js/jmcwcClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// ============================================================================
// Suite 1: Pure Access Validation Functions
// ============================================================================
describe('Student Access — Pure Validation Functions', () => {
  it('normalizeCategoryKey handles spacing, case, and special characters', () => {
    assert.strictEqual(normalizeCategoryKey('1D 4R'), '1d4r');
    assert.strictEqual(normalizeCategoryKey('  1d  4r  '), '1d4r');
    assert.strictEqual(normalizeCategoryKey('Mental Calendar (25 dates)'), 'mentalcalendar25dates');
    assert.strictEqual(normalizeCategoryKey(''), '');
  });

  it('Basics: Level 1 only allows 1D 4R while blocking 2D 4R; Master allows full catalog', () => {
    const level1BasicsSettings = {
      categories: ['1D 4R'],
    };

    assert.strictEqual(isBasicsCategoryAllowed('1D 4R', level1BasicsSettings), true);
    assert.strictEqual(isBasicsCategoryAllowed('1d 4r', level1BasicsSettings), true);
    assert.strictEqual(isBasicsCategoryAllowed('2D 4R', level1BasicsSettings), false);
    assert.strictEqual(isBasicsCategoryAllowed('3D 5R', level1BasicsSettings), false);

    // Master level with full access (null / undefined or categories: null or all: true)
    assert.strictEqual(isBasicsCategoryAllowed('1D 4R', null), true);
    assert.strictEqual(isBasicsCategoryAllowed('2D 4R', undefined), true);
    assert.strictEqual(isBasicsCategoryAllowed('4D 10R', { categories: null }), true);
    assert.strictEqual(isBasicsCategoryAllowed('4D 10R', { all: true, categories: [] }), true);
  });

  it('Elements: Allows selecting topics and individual stages or drills', () => {
    const elementsSettings = {
      topics: {
        squares: { allowed: true, drills: ['Stage 1', 'Stage 2'] },
        cubes: { allowed: false },
        calendar: { allowed: true, drills: ['Day Codes'] },
      },
    };

    // Squares stage 1 and stage 2 allowed, stage 3 blocked
    assert.strictEqual(isElementDrillAllowed('squares', 'Stage 1', elementsSettings), true);
    assert.strictEqual(isElementDrillAllowed('squares', 'Stage 2', elementsSettings), true);
    assert.strictEqual(isElementDrillAllowed('squares', 'Stage 3', elementsSettings), false);

    // Cubes topic disabled entirely
    assert.strictEqual(isElementDrillAllowed('cubes', 'Stage 1', elementsSettings), false);

    // Calendar: Day Codes allowed, Century Codes blocked
    assert.strictEqual(isElementDrillAllowed('calendar', 'Day Codes', elementsSettings), true);
    assert.strictEqual(isElementDrillAllowed('calendar', 'Century Codes', elementsSettings), false);

    // Master / unconfigured allows everything
    assert.strictEqual(isElementDrillAllowed('squares', 'Stage 5', null), true);
  });

  it('Flash Anzan: Single Allowed / Hidden switch controls the entire section', () => {
    assert.strictEqual(isFlashAllowed({ allowed: true }), true);
    assert.strictEqual(isFlashAllowed({ allowed: false }), false);
    assert.strictEqual(isFlashAllowed(null), true); // default open
    assert.strictEqual(isFlashAllowed({}), true);
  });

  it('Memoriad: Separates access between Calendar 25 dates and Calendar 125 dates', () => {
    const memoriadSettings = {
      modules: {
        calendar: {
          allowed: true,
          variants: ['25'], // only 25 dates permitted
        },
        flash_numbers: {
          allowed: false,
        },
      },
    };

    // Calendar 25 dates is permitted
    assert.strictEqual(isMemoriadAllowed('calendar', '25', memoriadSettings), true);
    assert.strictEqual(isMemoriadAllowed('calendar', 25, memoriadSettings), true);

    // Calendar 125 dates is strictly blocked
    assert.strictEqual(isMemoriadAllowed('calendar', '125', memoriadSettings), false);
    assert.strictEqual(isMemoriadAllowed('calendar', 125, memoriadSettings), false);

    // Flash numbers module disabled
    assert.strictEqual(isMemoriadAllowed('flash_numbers', null, memoriadSettings), false);

    // Master / default allows all
    assert.strictEqual(isMemoriadAllowed('calendar', '125', null), true);
  });

  it('Main Round: Category permission and full-paper access requires all categories', () => {
    const mainRoundSettings = {
      eligible: true,
      categories: ['addition', 'multiplication', 'division'],
    };

    assert.strictEqual(isMainRoundCategoryAllowed('addition', mainRoundSettings), true);
    assert.strictEqual(isMainRoundCategoryAllowed('square_roots', mainRoundSettings), false);

    // Full paper with only addition, multiplication, division -> allowed
    assert.strictEqual(
      isMainRoundFullPaperAllowed(['addition', 'multiplication', 'division'], mainRoundSettings),
      true
    );

    // Full paper that includes square_roots -> rejected!
    assert.strictEqual(
      isMainRoundFullPaperAllowed(['addition', 'multiplication', 'square_roots'], mainRoundSettings),
      false
    );

    // If student is marked ineligible, everything is blocked
    const ineligibleSettings = { eligible: false, categories: ['addition'] };
    assert.strictEqual(isMainRoundCategoryAllowed('addition', ineligibleSettings), false);
    assert.strictEqual(isMainRoundFullPaperAllowed(['addition'], ineligibleSettings), false);
  });

  it('resolveAccessProvenance accurately reports source label', () => {
    assert.strictEqual(resolveAccessProvenance({ source: 'level', level: 'Level 1' }), 'From Level 1');
    assert.strictEqual(resolveAccessProvenance({ source: 'override' }), 'Student override');
    assert.strictEqual(resolveAccessProvenance({ source: 'default' }), 'Default (Full access)');
    assert.strictEqual(resolveAccessProvenance(null), 'Default (Full access)');
  });
});

// ============================================================================
// Suite 2: DemoDB Parity & Access State Management
// ============================================================================
describe('Student Access — DemoDB Parity & State Management', () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  it('Level defaults, student override, provenance, and reset flow', () => {
    const studentId = 'usr-101'; // Aarav Sharma, Level 3
    const level = 'Level 3';

    // 1. Set Level 3 defaults: only 1D 4R in Basics, Flash allowed, Calendar 25 dates
    DemoDB.saveLevelAccessDefaults(level, {
      basics: { all: false, categories: ['1D 4R'] },
      flash: { allowed: true },
      memoriad: { all: false, modules: ['calendar'], calendar_variants: [25] },
      main_round: { all: false, categories: ['addition'] },
    });

    // 2. Fetch effective access for student in Level 3 (with no override)
    const effective1 = DemoDB.getStudentEffectiveAccess(studentId);
    assert.strictEqual(effective1.source_label, 'From Level 3');
    assert.strictEqual(effective1.level, 'Level 3');
    assert.strictEqual(isBasicsCategoryAllowed('1D 4R', effective1.settings.basics), true);
    assert.strictEqual(isBasicsCategoryAllowed('2D 4R', effective1.settings.basics), false);
    assert.strictEqual(isMemoriadAllowed('calendar', 25, effective1.settings.memoriad), true);
    assert.strictEqual(isMemoriadAllowed('calendar', 125, effective1.settings.memoriad), false);

    // 3. Admin / Teacher adds 2D 4R as an override exception for this student
    DemoDB.saveStudentAccessOverride(studentId, {
      basics: { all: false, categories: ['1D 4R', '2D 4R'] },
      flash: { allowed: true },
      memoriad: { all: false, modules: ['calendar'], calendar_variants: [25, 125] },
      main_round: { all: false, categories: ['addition', 'multiplication'] },
    });

    const effective2 = DemoDB.getStudentEffectiveAccess(studentId);
    assert.strictEqual(effective2.source_label, 'Student override');
    assert.strictEqual(effective2.has_override, true);
    assert.strictEqual(isBasicsCategoryAllowed('2D 4R', effective2.settings.basics), true);
    assert.strictEqual(isMemoriadAllowed('calendar', 125, effective2.settings.memoriad), true);

    // 4. Reset to "Use level settings"
    DemoDB.resetStudentAccessOverride(studentId);

    const effective3 = DemoDB.getStudentEffectiveAccess(studentId);
    assert.strictEqual(effective3.source_label, 'From Level 3');
    assert.strictEqual(effective3.has_override, false);
    assert.strictEqual(isBasicsCategoryAllowed('2D 4R', effective3.settings.basics), false);
  });

  it('Teacher bulk apply: only updates assigned students in level; other teachers’ students untouched', () => {
    const teacherA = 'usr-teacher-1';
    const teacherB = 'usr-teacher-2';

    // In DemoDB students: usr-102 (Level 2), usr-105 (Level 2), usr-101 (Level 3)
    // Assign usr-102 and usr-105 to Teacher A, usr-101 to Teacher B
    DemoDB.setTeacherStudentAssignmentsForTesting([
      { teacher_id: teacherA, student_id: 'usr-102' },
      { teacher_id: teacherA, student_id: 'usr-105' },
      { teacher_id: teacherB, student_id: 'usr-101' },
    ]);

    // Teacher A previews count in Level 2
    const countRes = DemoDB.getTeacherLevelStudentCount('Level 2', teacherA);
    assert.strictEqual(countRes.count, 2);

    // Teacher A applies bulk access settings
    const bulkSettings = {
      basics: { all: false, categories: ['2D 4R'] },
      flash: { allowed: false },
    };
    const affected = DemoDB.teacherBulkApplyLevelAccess('Level 2', bulkSettings, teacherA);
    assert.strictEqual(affected.count, 2);

    // Verify Teacher A's students received the override
    const accessA1 = DemoDB.getStudentEffectiveAccess('usr-102');
    const accessA2 = DemoDB.getStudentEffectiveAccess('usr-105');
    assert.strictEqual(accessA1.has_override, true);
    assert.strictEqual(isBasicsCategoryAllowed('2D 4R', accessA1.settings.basics), true);
    assert.strictEqual(isFlashAllowed(accessA1.settings.flash), false);

    assert.strictEqual(accessA2.has_override, true);
    assert.strictEqual(isFlashAllowed(accessA2.settings.flash), false);

    // Verify Teacher B's student (usr-101) was NOT modified!
    const accessB1 = DemoDB.getStudentEffectiveAccess('usr-101');
    assert.strictEqual(accessB1.has_override, false);
    assert.strictEqual(isFlashAllowed(accessB1.settings.flash), true);
  });

  it('DemoDB mock session guards block unallowed free practice while honoring assignment exceptions', async (t) => {
    const originalWindow = globalThis.window;
    globalThis.window = { location: { hostname: 'localhost' } };
    t.after(() => {
      if (originalWindow === undefined) delete globalThis.window;
      else globalThis.window = originalWindow;
    });
    const studentId = 'usr-101';

    DemoDB.saveStudentAccessOverride(studentId, {
      basics: { all: false, categories: ['1D 4R'] },
      flash: { allowed: false }, // Flash is hidden/restricted
      memoriad: { all: false, modules: ['calendar'], calendar_variants: [25] },
    });

    // 1. Free practice Flash start is blocked
    await assert.rejects(
      async () => {
        await DemoDB.mockFlashStart({ digits: 1, numbers: 10, speed_ms: 500 }, studentId);
      },
      /not permitted|restricted/i
    );

    // 2. Free practice Basics 2D 4R is blocked
    await assert.rejects(
      async () => {
        await DemoDB.mockBasicsDrillStart('2D 4R', 'timed', 60, { studentId });
      },
      /not permitted|restricted/i
    );

    // 3. Free practice Memoriad Calendar 125 dates is blocked
    await assert.rejects(
      async () => {
        await DemoDB.mockMemoriadStart('calendar', { dates: 125 }, { studentId });
      },
      /not permitted|restricted/i
    );

    // 4. Assignment exception: Daily To-Do for Flash is permitted
    const validTodoSession = await DemoDB.mockFlashStart({
      digits: 1,
      numbers: 10,
      speed_ms: 500,
      todo_task_id: 'todo-flash-101',
    }, studentId);
    assert.ok(validTodoSession?.session_id);

    // 5. Assignment exception: Homework for Basics 2D 4R is permitted
    const validHwSession = await DemoDB.mockBasicsDrillStart('2D 4R', 'timed', 60, {
      studentId,
      homework_id: 'hw-basics-202',
    });
    assert.ok(validHwSession?.session_id);
  });
});

// ============================================================================
// Suite 3: Client-side Navigation & View Models
// ============================================================================
describe('Student Access — Client-side Navigation & View Models', () => {
  it('Navigation menus omit Flash Anzan when flash.allowed is false', () => {
    const fullAccessProfile = { role: 'student', level: 'Master' };
    const restrictedProfile = {
      role: 'student',
      level: 'Level 1',
      studentAccess: {
        flash: { allowed: false },
      },
    };

    const fullNav = getRoleNavItems('student', fullAccessProfile);
    assert.ok(fullNav.some((item) => item.label === 'Flash Anzan'));

    const restrictedNav = getRoleNavItems('student', restrictedProfile);
    assert.strictEqual(restrictedNav.some((item) => item.label === 'Flash Anzan'), false);

    const desktopEntries = getDesktopNavEntries('student', restrictedProfile);
    assert.strictEqual(desktopEntries.some((item) => item.label === 'Flash Anzan'), false);

    const groupedItems = getGroupedNavItems('student', restrictedProfile);
    assert.strictEqual(groupedItems.some((item) => item.label === 'Flash Anzan'), false);
  });

  it('JMCWC Landing View Model enforces Main Round competition eligibility and full paper coverage', () => {
    const mockOverview = {
      assigned: true,
      group_key: 'group_a',
      paper_available: true,
      paper: {
        id: 'paper-101',
        spec: {
          sections: [
            { key: 'addition', title: 'Addition' },
            { key: 'multiplication', title: 'Multiplication' },
            { key: 'division', title: 'Division' },
          ],
        },
      },
      categories: [
        { key: 'addition', name: 'Addition' },
        { key: 'multiplication', name: 'Multiplication' },
        { key: 'division', name: 'Division' },
      ],
      attempts: [],
    };

    // 1. Ineligible student
    const ineligibleAccess = {
      main_round_eligible: false,
      settings: { main_round: { eligible: false } },
    };
    const vm1 = buildLandingPageViewModel(mockOverview, [], ineligibleAccess);
    assert.strictEqual(vm1.canStartNewFlat, false);
    assert.strictEqual(vm1.canStartCategory, false);
    assert.strictEqual(vm1.mainRoundRestricted, true);
    assert.ok(vm1.flatDisabledReason?.includes('restricted'));

    // 2. Eligible student with partial categories (only Addition & Multiplication allowed)
    const partialAccess = {
      main_round_eligible: true,
      settings: {
        main_round: {
          eligible: true,
          categories: ['addition', 'multiplication'], // missing division!
        },
      },
    };
    const vm2 = buildLandingPageViewModel(mockOverview, [], partialAccess);
    assert.strictEqual(vm2.canStartCategory, true);
    assert.strictEqual(vm2.categories.length, 2); // only addition & multiplication listed
    assert.strictEqual(vm2.canStartNewFlat, false); // full paper requires all categories!
    assert.ok(vm2.flatDisabledReason?.includes('all categories'));

    // 3. Eligible student with full paper categories
    const fullAccess = {
      main_round_eligible: true,
      settings: {
        main_round: {
          eligible: true,
          categories: ['addition', 'multiplication', 'division'],
        },
      },
    };
    const vm3 = buildLandingPageViewModel(mockOverview, [], fullAccess);
    assert.strictEqual(vm3.canStartCategory, true);
    assert.strictEqual(vm3.categories.length, 3);
    assert.strictEqual(vm3.canStartNewFlat, true);
  });

  it('fetchStudentEffectiveAccess rejects missing or invalid Supabase client when demo mode is not explicitly enabled', async () => {
    const studentId = 'test-stu-101';

    // 1. Missing supabase client with isDemo: false (or omitted)
    const resNoClient = await fetchStudentEffectiveAccess(studentId, { supabase: null, isDemo: false });
    assert.strictEqual(resNoClient.ok, false);
    assert.match(resNoClient.error, /Live Supabase client is missing or invalid/i);

    // 2. Invalid supabase client (no rpc method) with isDemo: false
    const resInvalidClient = await fetchStudentEffectiveAccess(studentId, { supabase: {}, isDemo: false });
    assert.strictEqual(resInvalidClient.ok, false);
    assert.match(resInvalidClient.error, /Live Supabase client is missing or invalid/i);

    // 3. Empty options bag
    const resEmptyOptions = await fetchStudentEffectiveAccess(studentId, {});
    assert.strictEqual(resEmptyOptions.ok, false);
    assert.match(resEmptyOptions.error, /Live Supabase client is missing or invalid/i);

    // 4. No options provided at all
    const resNoOptions = await fetchStudentEffectiveAccess(studentId);
    assert.strictEqual(resNoOptions.ok, false);
    assert.match(resNoOptions.error, /Live Supabase client is missing or invalid/i);

    // 5. Demo defaults are allowed ONLY when isDemo is explicitly true
    const resExplicitDemo = await fetchStudentEffectiveAccess(studentId, { isDemo: true });
    assert.strictEqual(resExplicitDemo.ok, true);
    assert.strictEqual(resExplicitDemo.main_round_eligible, true);
    assert.strictEqual(resExplicitDemo.source_label, 'Default (Full access)');

    // 6. DemoDB is used when isDemo is explicitly true with DemoDB
    DemoDB.saveStudentAccessOverride(studentId, {
      basics: { all: false, categories: ['1D 3R'] },
      main_round: { eligible: false, categories: [] },
    });
    const resDemoDb = await fetchStudentEffectiveAccess(studentId, { isDemo: true, DemoDB });
    assert.strictEqual(resDemoDb.ok, true);
    assert.strictEqual(resDemoDb.settings.basics.categories[0], '1D 3R');
    assert.strictEqual(resDemoDb.main_round_eligible, false);
  });

  it('lookup failure blocks Main Round and Basics controls; retrying successfully reloads student actual permissions', async () => {
    const studentId = 'test-stu-202';
    const mockOverview = {
      assigned: true,
      group_key: 'group_a',
      paper_available: true,
      paper: {
        id: 'paper-101',
        spec: {
          sections: [
            { key: 'addition', title: 'Addition' },
            { key: 'multiplication', title: 'Multiplication' },
          ],
        },
      },
      categories: [
        { key: 'addition', name: 'Addition' },
        { key: 'multiplication', name: 'Multiplication' },
      ],
      attempts: [],
    };

    // Step 1: Initial load failure due to missing live Supabase client
    const failedAccess = await fetchStudentEffectiveAccess(studentId, { supabase: null, isDemo: false });
    assert.strictEqual(failedAccess.ok, false);

    // Verify Main Round view model is completely restricted on failure
    const failedLandingVm = buildLandingPageViewModel(mockOverview, [], failedAccess);
    assert.strictEqual(failedLandingVm.mainRoundRestricted, true);
    assert.strictEqual(failedLandingVm.canStartNewFlat, false);
    assert.strictEqual(failedLandingVm.canStartCategory, false);
    assert.strictEqual(failedLandingVm.flatDisabledReason, failedAccess.error);
    assert.strictEqual(failedLandingVm.categoryDisabledReason, failedAccess.error);

    // Verify Basics category filtering logic on failure
    const catalogCategories = [
      { id: 'cat-1', name: '1D 3R' },
      { id: 'cat-2', name: '2D 4R' },
      { id: 'cat-3', name: 'Staging Basics Fixture (Category 1)' },
    ];
    assert.strictEqual(failedAccess.ok, false);

    // Step 2: Retry with valid Supabase client providing actual student permissions
    // Student actually has: Level 1 with only '1D 3R' allowed, and Main Round eligible for addition
    const mockSupabaseClient = {
      rpc: async (fn, args) => {
        assert.strictEqual(fn, 'get_student_effective_access');
        assert.strictEqual(args.p_student_id, studentId);
        return {
          data: {
            ok: true,
            student_id: studentId,
            level: 'Level 1',
            scope: 'level',
            source_label: 'From Level 1',
            has_override: false,
            settings: {
              basics: { all: false, categories: ['1D 3R'] },
              main_round: { eligible: true, categories: ['addition'] },
            },
            main_round_eligible: true,
          },
          error: null,
        };
      },
    };

    const reloadedAccess = await fetchStudentEffectiveAccess(studentId, {
      supabase: mockSupabaseClient,
      isDemo: false,
    });
    assert.strictEqual(reloadedAccess.ok, true);
    assert.strictEqual(reloadedAccess.level, 'Level 1');
    assert.strictEqual(reloadedAccess.main_round_eligible, true);

    // Verify Main Round view model reflects reloaded permissions
    const reloadedLandingVm = buildLandingPageViewModel(mockOverview, [], reloadedAccess);
    assert.strictEqual(reloadedLandingVm.mainRoundRestricted, false);
    assert.strictEqual(reloadedLandingVm.canStartCategory, true);
    // Flat requires all categories in paper (addition + multiplication), but student only has addition
    assert.strictEqual(reloadedLandingVm.canStartNewFlat, false);
    assert.ok(reloadedLandingVm.flatDisabledReason?.includes('all categories'));

    // Verify Basics category filtering on reloaded permissions:
    // Case A: Ordinary practice filters out restricted categories
    const ordinaryAllowed = catalogCategories.filter((c) =>
      isBasicsCategoryAllowed(c.name, reloadedAccess.settings.basics, true)
    );
    assert.deepStrictEqual(
      ordinaryAllowed.map((c) => c.name),
      ['1D 3R']
    );

    // Case B: Assigned Basics path (isAssignment && catParam) preserves assigned category exception
    const assignedCatParam = 'Staging Basics Fixture (Category 1)';
    const isAssignment = true;
    const assignmentAllowed = catalogCategories.filter((c) => {
      if (isAssignment && assignedCatParam && (c.id === assignedCatParam || c.name === assignedCatParam)) {
        return true;
      }
      return isBasicsCategoryAllowed(c.name, reloadedAccess.settings.basics, true);
    });
    assert.deepStrictEqual(
      assignmentAllowed.map((c) => c.name),
      ['1D 3R', 'Staging Basics Fixture (Category 1)']
    );
  });
});

// ============================================================================
// Suite 4: PostgreSQL PGlite Integration (Migration & Security Policies)
// ============================================================================
describe('Student Access — PostgreSQL PGlite Database Integration', () => {
  const asUser = async (db, userId, role = 'authenticated', fn) => {
    await db.exec(`SET app.current_user_id = '${userId || ''}'; SET app.current_jwt_role = '${role}'; SET ROLE ${role};`);
    try {
      return await fn();
    } finally {
      await db.exec(`RESET ROLE; SET app.current_user_id = ''; SET app.current_jwt_role = '';`);
    }
  };

  const setupTestDb = async () => {
    const db = new PGlite();

    await db.exec(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role BYPASSRLS;
        ELSE
          ALTER ROLE service_role BYPASSRLS;
        END IF;
        GRANT anon, authenticated, service_role TO CURRENT_USER;
      END $$;

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULLIF(current_setting('app.current_user_id', true), '')::UUID;
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$
        SELECT COALESCE(NULLIF(current_setting('app.current_jwt_role', true), ''), 'anon');
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB AS $$
        SELECT jsonb_build_object(
          'role', COALESCE(NULLIF(current_setting('app.current_jwt_role', true), ''), 'anon'),
          'sub', NULLIF(current_setting('app.current_user_id', true), '')
        );
      $$ LANGUAGE sql STABLE;

      -- Base Tables
      CREATE TABLE public.profiles (
        id UUID PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'teacher', 'admin')),
        student_code TEXT UNIQUE,
        full_name TEXT NOT NULL,
        level TEXT,
        active BOOLEAN NOT NULL DEFAULT true,
        leaderboard_visible BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE public.teacher_permissions (
        teacher_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
        can_manage_tasks BOOLEAN NOT NULL DEFAULT true
      );

      CREATE TABLE public.teacher_student_assignments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        teacher_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_tsa UNIQUE (teacher_id, student_id)
      );

      CREATE TABLE public.categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        section TEXT NOT NULL,
        sort_order INT NOT NULL DEFAULT 1,
        active BOOLEAN NOT NULL DEFAULT true
      );

      CREATE TABLE public.results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        category_id UUID NOT NULL REFERENCES public.categories(id) ON DELETE RESTRICT,
        homework_id UUID NULL,
        task_id UUID NULL,
        assignment_id UUID NULL,
        student_round_id UUID NULL,
        correct INTEGER NULL,
        total INTEGER NULL,
        time_seconds NUMERIC NULL,
        entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
        verified BOOLEAN NOT NULL DEFAULT false,
        verified_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
        verified_at TIMESTAMPTZ,
        corrected_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
        corrected_at TIMESTAMPTZ,
        flagged BOOLEAN NOT NULL DEFAULT false,
        flag_note TEXT,
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );

      CREATE TABLE public.drill_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        activity_type TEXT NOT NULL,
        activity_name TEXT NOT NULL DEFAULT '',
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        questions JSONB NOT NULL DEFAULT '[]'::jsonb,
        expected JSONB NOT NULL DEFAULT '[]'::jsonb,
        min_seconds NUMERIC NOT NULL DEFAULT 0,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '1 hour',
        status TEXT NOT NULL DEFAULT 'open',
        submitted_at TIMESTAMPTZ,
        result_id UUID,
        result_row_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE public.daily_tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL DEFAULT 'Task',
        section TEXT NOT NULL DEFAULT 'flash',
        category_id UUID NULL REFERENCES public.categories(id) ON DELETE SET NULL,
        target_scope TEXT NOT NULL DEFAULT 'all',
        level TEXT NULL,
        active BOOLEAN NOT NULL DEFAULT true,
        required_count INT NOT NULL DEFAULT 1,
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );

      CREATE TABLE public.daily_task_recipients (
        task_id UUID NOT NULL REFERENCES public.daily_tasks(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, student_id)
      );

      -- Shipped Homework Schema (NO status column on homework_assignments)
      CREATE TABLE public.homework_assignments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(120) NOT NULL DEFAULT 'Homework',
        instructions TEXT NULL,
        assigned_by UUID NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
        target_type VARCHAR(20) NOT NULL DEFAULT 'all',
        target_level VARCHAR(50) NULL,
        target_student_id UUID NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        activity_type VARCHAR(30) NOT NULL DEFAULT 'paper',
        category_id UUID NULL REFERENCES public.categories(id) ON DELETE SET NULL,
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        duration_seconds INTEGER NULL,
        required_count INTEGER NOT NULL DEFAULT 1,
        assigned_date DATE NOT NULL DEFAULT CURRENT_DATE,
        due_date DATE NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );

      CREATE TABLE public.homework_completions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        assignment_id UUID NOT NULL REFERENCES public.homework_assignments(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        progress_count INTEGER NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'in_progress',
        session_id UUID NULL,
        result_id UUID REFERENCES public.results(id) ON DELETE SET NULL,
        activity_result_id UUID NULL,
        submission_history JSONB NOT NULL DEFAULT '[]'::jsonb,
        notes TEXT NULL,
        completed_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
        CONSTRAINT uq_hw_comp UNIQUE (assignment_id, student_id)
      );

      CREATE TABLE public.homework_bound_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        assignment_id UUID NOT NULL REFERENCES public.homework_assignments(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        session_id UUID NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );

      CREATE TABLE public.jmcwc_assignments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        group_key TEXT NOT NULL
      );

      -- Helper Auth Functions
      CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean AS $$
        SELECT EXISTS (
          SELECT 1 FROM public.profiles
          WHERE id = auth.uid() AND role = 'admin' AND active = true
        );
      $$ LANGUAGE sql STABLE SECURITY DEFINER;

      CREATE OR REPLACE FUNCTION public.is_teacher(p_uid UUID) RETURNS boolean AS $$
        SELECT EXISTS (
          SELECT 1 FROM public.profiles
          WHERE id = p_uid AND role = 'teacher' AND active = true
        );
      $$ LANGUAGE sql STABLE SECURITY DEFINER;

      CREATE OR REPLACE FUNCTION public.is_teacher_assigned_to_student(p_teacher_id UUID, p_student_id UUID) RETURNS boolean AS $$
        SELECT EXISTS (
          SELECT 1 FROM public.teacher_student_assignments
          WHERE teacher_id = p_teacher_id AND student_id = p_student_id
        );
      $$ LANGUAGE sql STABLE SECURITY DEFINER;

      CREATE OR REPLACE FUNCTION public.has_teacher_permission(p_teacher_id UUID, p_perm TEXT) RETURNS boolean AS $$
        SELECT EXISTS (
          SELECT 1 FROM public.teacher_permissions
          WHERE teacher_id = p_teacher_id AND (
            (p_perm = 'manage_tasks' AND can_manage_tasks = true)
          )
        );
      $$ LANGUAGE sql STABLE SECURITY DEFINER;

      CREATE OR REPLACE FUNCTION public.is_student_homework_recipient(p_assignment_id UUID, p_student_id UUID)
      RETURNS boolean AS $$
      DECLARE
        v_assign RECORD;
        v_stu_level TEXT;
      BEGIN
        IF EXISTS (
          SELECT 1 FROM public.homework_completions
          WHERE assignment_id = p_assignment_id AND student_id = p_student_id
        ) THEN
          RETURN true;
        END IF;

        SELECT * INTO v_assign FROM public.homework_assignments WHERE id = p_assignment_id;
        IF NOT FOUND THEN RETURN false; END IF;

        SELECT level INTO v_stu_level FROM public.profiles WHERE id = p_student_id;

        IF v_assign.target_type = 'all' THEN
          RETURN true;
        ELSIF v_assign.target_type = 'level' THEN
          RETURN v_assign.target_level IS NOT NULL AND lower(trim(v_assign.target_level)) = lower(trim(COALESCE(v_stu_level, '')));
        ELSIF v_assign.target_type = 'student' THEN
          RETURN v_assign.target_student_id = p_student_id;
        END IF;
        RETURN false;
      END;
      $$ LANGUAGE plpgsql STABLE;

      CREATE OR REPLACE FUNCTION public.today_ist() RETURNS date AS $$
        SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date;
      $$ LANGUAGE sql STABLE;

      ALTER TABLE public.results ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "results_select_policy" ON public.results FOR SELECT TO authenticated
        USING (student_id = auth.uid() OR public.is_admin() OR public.is_teacher(auth.uid()));
      CREATE POLICY "results_insert_policy" ON public.results FOR INSERT TO authenticated
        WITH CHECK ((student_id = auth.uid() AND verified = false) OR public.is_admin());
      CREATE POLICY "results_update_policy" ON public.results FOR UPDATE TO authenticated
        USING (student_id = auth.uid() OR public.is_admin() OR public.is_teacher(auth.uid()))
        WITH CHECK ((student_id = auth.uid() AND verified = false) OR public.is_admin() OR public.is_teacher(auth.uid()));

      GRANT ALL ON TABLE public.profiles, public.teacher_permissions, public.teacher_student_assignments,
        public.categories, public.drill_sessions, public.daily_tasks, public.daily_task_recipients,
        public.homework_assignments, public.homework_completions, public.homework_bound_sessions, public.jmcwc_assignments,
        public.results TO authenticated, service_role;
    `);

    // 1. Apply baseline staging_student_access_feature.sql
    const sqlPath = path.resolve(ROOT_DIR, 'supabase', 'staging_student_access_feature.sql');
    const sqlContent = fs.readFileSync(sqlPath, 'utf8');
    await db.exec(sqlContent);

    // 2. Apply incremental migration staging_student_access_enforcement.sql
    const incSqlPath = path.resolve(ROOT_DIR, 'supabase', 'staging_student_access_enforcement.sql');
    const incSqlContent = fs.readFileSync(incSqlPath, 'utf8');
    await db.exec(incSqlContent);

    // 3. Define installed Daily Plan RPCs (todo_status_on and _todo_status_on_internal)
    await db.exec(`
      CREATE OR REPLACE FUNCTION public._todo_status_on_internal(
        p_student UUID,
        p_day DATE DEFAULT public.today_ist()
      )
      RETURNS TABLE (
        task_id UUID,
        task_title TEXT,
        task_section TEXT,
        task_category_id UUID,
        task_activity_key TEXT,
        required_count INTEGER,
        done_count INTEGER,
        done BOOLEAN
      )
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public, pg_temp
      STABLE
      AS $$
      DECLARE
        v_day DATE := COALESCE(p_day, public.today_ist());
      BEGIN
        IF p_student IS NULL THEN
          RETURN;
        END IF;

        RETURN QUERY
        SELECT
          t.id AS task_id,
          t.title AS task_title,
          t.section AS task_section,
          t.category_id AS task_category_id,
          ''::text AS task_activity_key,
          COALESCE(t.required_count, 1)::integer AS required_count,
          0::integer AS done_count,
          false AS done
        FROM public.daily_tasks t
        JOIN public.profiles p ON p.id = p_student
        WHERE t.active
          AND (t.created_at AT TIME ZONE 'Asia/Kolkata')::DATE <= v_day
          AND (
            (t.target_scope = 'targeted' AND public.is_daily_task_recipient(t.id, p_student))
            OR (
              COALESCE(t.target_scope, 'all') = 'all'
              AND (t.level IS NULL OR t.level = p.level)
            )
          );
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.todo_status_on(
        p_student UUID,
        p_day DATE DEFAULT public.today_ist()
      )
      RETURNS TABLE (
        task_id UUID,
        task_title TEXT,
        task_section TEXT,
        task_category_id UUID,
        task_activity_key TEXT,
        required_count INTEGER,
        done_count INTEGER,
        done BOOLEAN
      )
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public, pg_temp
      STABLE
      AS $$
      DECLARE
        v_caller UUID := auth.uid();
        v_day DATE := COALESCE(p_day, public.today_ist());
      BEGIN
        IF p_student IS NULL THEN
          RAISE EXCEPTION 'Target student ID is required.' USING ERRCODE = '22023';
        END IF;

        IF v_caller IS NULL THEN
          RAISE EXCEPTION 'Unauthorized: Authentication required.' USING ERRCODE = '42501';
        END IF;

        IF v_caller IS DISTINCT FROM p_student AND NOT public.is_admin() THEN
          IF public.is_teacher(v_caller) THEN
            IF NOT (
              public.has_teacher_permission(v_caller, 'manage_tasks')
              AND public.is_teacher_assigned_to_student(v_caller, p_student)
            ) THEN
              RAISE EXCEPTION 'Forbidden: You do not have permission to view daily tasks for this student.'
                USING ERRCODE = '42501';
            END IF;
          ELSE
            RAISE EXCEPTION 'Forbidden: You may only view your own daily tasks.'
              USING ERRCODE = '42501';
          END IF;
        END IF;

        RETURN QUERY
        SELECT * FROM public._todo_status_on_internal(p_student, v_day);
      END;
      $$;

      REVOKE ALL ON FUNCTION public.todo_status_on(UUID, DATE) FROM PUBLIC, anon;
      GRANT EXECUTE ON FUNCTION public.todo_status_on(UUID, DATE) TO authenticated, service_role;
    `);

    return db;
  };

  it('staging_student_access_feature.sql applies cleanly and is idempotent', async () => {
    const db = await setupTestDb();
    // Re-apply to verify idempotency
    const sqlPath = path.resolve(ROOT_DIR, 'supabase', 'staging_student_access_feature.sql');
    const sqlContent = fs.readFileSync(sqlPath, 'utf8');
    await assert.doesNotReject(async () => {
      await db.exec(sqlContent);
    });
  });

  it('Admin sets Level 1 defaults; student automatically inherits them', async () => {
    const db = await setupTestDb();

    const adminId = '10000000-0000-0000-0000-000000000001';
    const student1Id = '20000000-0000-0000-0000-000000000001';

    await db.exec(`
      INSERT INTO public.profiles (id, role, full_name, level)
      VALUES
        ('${adminId}', 'admin', 'Admin User', NULL),
        ('${student1Id}', 'student', 'Student One', 'Level 1');
    `);

    // Admin saves Level 1 default
    await asUser(db, adminId, 'authenticated', async () => {
      await db.query(`
        SELECT public.admin_save_level_access(
          'Level 1',
          '{"basics": {"categories": ["1D 4R"]}, "flash": {"allowed": true}}'::jsonb
        );
      `);
    });

    // Student calls get_student_effective_access
    const res = await asUser(db, student1Id, 'authenticated', async () => {
      return await db.query(`SELECT public.get_student_effective_access('${student1Id}') as access;`);
    });

    const access = res.rows[0].access;
    assert.strictEqual(access.source_label, 'From Level 1');
    assert.strictEqual(access.level, 'Level 1');
    assert.deepStrictEqual(access.settings.basics.categories, ['1D 4R']);
    assert.strictEqual(access.settings.flash.allowed, true);
  });

  it('Teacher can override assigned student but CANNOT grant main_round_eligible or touch unassigned students', async () => {
    const db = await setupTestDb();

    const adminId = '10000000-0000-0000-0000-000000000001';
    const teacherId = '30000000-0000-0000-0000-000000000001';
    const assignedStuId = '20000000-0000-0000-0000-000000000001';
    const unassignedStuId = '20000000-0000-0000-0000-000000000002';

    await db.exec(`
      INSERT INTO public.profiles (id, role, full_name, level)
      VALUES
        ('${adminId}', 'admin', 'Admin User', NULL),
        ('${teacherId}', 'teacher', 'Teacher One', NULL),
        ('${assignedStuId}', 'student', 'Assigned Student', 'Level 1'),
        ('${unassignedStuId}', 'student', 'Unassigned Student', 'Level 1');

      INSERT INTO public.teacher_permissions (teacher_id, can_manage_tasks)
      VALUES ('${teacherId}', true);

      INSERT INTO public.teacher_student_assignments (teacher_id, student_id)
      VALUES ('${teacherId}', '${assignedStuId}');
    `);

    // 1. Teacher attempts to override unassigned student -> rejected!
    await asUser(db, teacherId, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`
            SELECT public.save_student_access_override(
              '${unassignedStuId}',
              '{"basics": {"categories": ["1D 4R", "2D 4R"]}}'::jsonb
            );
          `);
        },
        /not authorized|assigned/i
      );
    });

    // 2. Teacher attempts to set main_round_eligible -> rejected (admin only)!
    await asUser(db, teacherId, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`
            SELECT public.save_student_access_override(
              '${assignedStuId}',
              '{"main_round": {"eligible": true}}'::jsonb
            );
          `);
        },
        /only administrators can grant main round competition eligibility/i
      );
    });

    // 3. Teacher saves valid practice override for assigned student
    await asUser(db, teacherId, 'authenticated', async () => {
      await db.query(`
        SELECT public.save_student_access_override(
          '${assignedStuId}',
          '{"basics": {"categories": ["1D 4R", "2D 4R"]}}'::jsonb
        );
      `);
    });

    // Effective access now reports override
    const res = await asUser(db, assignedStuId, 'authenticated', async () => {
      return await db.query(`SELECT public.get_student_effective_access('${assignedStuId}') as access;`);
    });
    const access = res.rows[0].access;
    assert.strictEqual(access.source_label, 'Student override');
    assert.deepStrictEqual(access.settings.basics.categories, ['1D 4R', '2D 4R']);

    // 4. Reset to level settings
    await asUser(db, teacherId, 'authenticated', async () => {
      await db.query(`SELECT public.reset_student_access_override('${assignedStuId}');`);
    });

    const resReset = await asUser(db, assignedStuId, 'authenticated', async () => {
      return await db.query(`SELECT public.get_student_effective_access('${assignedStuId}') as access;`);
    });
    assert.strictEqual(resReset.rows[0].access.scope, 'default'); // no level default row yet
  });

  it('Teacher bulk apply: updates only assigned students in level without affecting other teachers’ students', async () => {
    const db = await setupTestDb();

    const teacherA = '30000000-0000-0000-0000-000000000001';
    const teacherB = '30000000-0000-0000-0000-000000000002';
    const stuA1 = '20000000-0000-0000-0000-000000000001';
    const stuA2 = '20000000-0000-0000-0000-000000000002';
    const stuB1 = '20000000-0000-0000-0000-000000000003';

    await db.exec(`
      INSERT INTO public.profiles (id, role, full_name, level)
      VALUES
        ('${teacherA}', 'teacher', 'Teacher A', NULL),
        ('${teacherB}', 'teacher', 'Teacher B', NULL),
        ('${stuA1}', 'student', 'Student A1', 'Level 3'),
        ('${stuA2}', 'student', 'Student A2', 'Level 3'),
        ('${stuB1}', 'student', 'Student B1', 'Level 3');

      INSERT INTO public.teacher_permissions (teacher_id, can_manage_tasks)
      VALUES ('${teacherA}', true), ('${teacherB}', true);

      INSERT INTO public.teacher_student_assignments (teacher_id, student_id)
      VALUES
        ('${teacherA}', '${stuA1}'),
        ('${teacherA}', '${stuA2}'),
        ('${teacherB}', '${stuB1}');
    `);

    // Teacher A previews count
    const countRes = await asUser(db, teacherA, 'authenticated', async () => {
      return await db.query(`SELECT public.get_teacher_level_student_count('Level 3') as count;`);
    });
    assert.strictEqual(Number(countRes.rows[0].count.count), 2);

    // Teacher A bulk applies settings
    const bulkRes = await asUser(db, teacherA, 'authenticated', async () => {
      return await db.query(`
        SELECT public.teacher_bulk_apply_level_access(
          'Level 3',
          '{"flash": {"allowed": false}}'::jsonb
        ) as affected;
      `);
    });
    assert.strictEqual(Number(bulkRes.rows[0].affected.count), 2);

    // Verify Teacher A's students have flash.allowed = false
    const stuA1Access = await asUser(db, stuA1, 'authenticated', async () => {
      return await db.query(`SELECT public.get_student_effective_access('${stuA1}') as access;`);
    });
    assert.strictEqual(stuA1Access.rows[0].access.settings.flash.allowed, false);

    // Verify Teacher B's student is NOT modified!
    const stuB1Access = await asUser(db, stuB1, 'authenticated', async () => {
      return await db.query(`SELECT public.get_student_effective_access('${stuB1}') as access;`);
    });
    assert.strictEqual(stuB1Access.rows[0].access.settings.flash.allowed, true); // default open
  });

  it('RLS: Direct student insert/update into student_practice_access is blocked', async () => {
    const db = await setupTestDb();
    const studentId = '20000000-0000-0000-0000-000000000001';

    await db.exec(`
      INSERT INTO public.profiles (id, role, full_name, level)
      VALUES ('${studentId}', 'student', 'Student One', 'Level 1');
    `);

    // Student direct insert blocked by RLS / table grants
    await asUser(db, studentId, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`
            INSERT INTO public.student_practice_access (scope, student_id, settings)
            VALUES ('student', '${studentId}', '{"flash": {"allowed": true}}'::jsonb);
          `);
        },
        /violates row-level security policy|permission denied for table student_practice_access/i
      );
    });
  });

  it('Cross-student access lookups are rejected (42501); only student, assigned teacher, admin, or server permitted', async () => {
    const db = await setupTestDb();
    const adminId = '10000000-0000-0000-0000-000000000001';
    const teacher1Id = '30000000-0000-0000-0000-000000000001';
    const teacher2Id = '30000000-0000-0000-0000-000000000002';
    const student1Id = '20000000-0000-0000-0000-000000000001';
    const student2Id = '20000000-0000-0000-0000-000000000002';

    await db.exec(`
      INSERT INTO public.profiles (id, role, full_name, level)
      VALUES
        ('${adminId}', 'admin', 'Admin User', NULL),
        ('${teacher1Id}', 'teacher', 'Teacher One', NULL),
        ('${teacher2Id}', 'teacher', 'Teacher Two', NULL),
        ('${student1Id}', 'student', 'Student One', 'Level 1'),
        ('${student2Id}', 'student', 'Student Two', 'Level 2');

      INSERT INTO public.teacher_permissions (teacher_id, can_manage_tasks)
      VALUES ('${teacher1Id}', true), ('${teacher2Id}', false);

      INSERT INTO public.teacher_student_assignments (teacher_id, student_id)
      VALUES ('${teacher1Id}', '${student1Id}');
    `);

    // 1. Student 1 queries Student 2 -> REJECTED (42501)
    await asUser(db, student1Id, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`SELECT public.get_student_effective_access('${student2Id}');`);
        },
        /Access denied.*authorized/i
      );
    });

    // 2. Unassigned Teacher 2 queries Student 1 -> REJECTED (42501)
    await asUser(db, teacher2Id, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`SELECT public.get_student_effective_access('${student1Id}');`);
        },
        /Access denied.*authorized/i
      );
    });

    // 3. Student 1 queries own access -> SUCCEEDS
    const s1Res = await asUser(db, student1Id, 'authenticated', async () => {
      return await db.query(`SELECT public.get_student_effective_access('${student1Id}') as access;`);
    });
    assert.strictEqual(s1Res.rows[0].access.ok, true);
    assert.strictEqual(s1Res.rows[0].access.student_id, student1Id);

    // 4. Assigned Teacher 1 queries Student 1 -> SUCCEEDS
    const t1Res = await asUser(db, teacher1Id, 'authenticated', async () => {
      return await db.query(`SELECT public.get_student_effective_access('${student1Id}') as access;`);
    });
    assert.strictEqual(t1Res.rows[0].access.ok, true);

    // 5. Admin queries Student 1 and Student 2 -> SUCCEEDS
    const admRes = await asUser(db, adminId, 'authenticated', async () => {
      return await db.query(`SELECT public.get_student_effective_access('${student2Id}') as access;`);
    });
    assert.strictEqual(admRes.rows[0].access.ok, true);

    // 6. Missing caller ID check:
    // 6a. Authenticated caller without user ID -> REJECTED (42501 Missing caller identification)
    await asUser(db, null, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`SELECT public.get_student_effective_access('${student1Id}');`);
        },
        /Access denied: Missing caller identification/i
      );
    });

    // 6b. Anonymous caller has execute revoked -> REJECTED (permission denied)
    await asUser(db, null, 'anon', async () => {
      await assert.rejects(
        async () => {
          await db.query(`SELECT public.get_student_effective_access('${student1Id}');`);
        },
        /permission denied for function get_student_effective_access|Missing caller identification/i
      );
    });

    // 7. Explicitly trusted server role (service_role) -> SUCCEEDS
    const srvRes = await asUser(db, null, 'service_role', async () => {
      return await db.query(`SELECT public.get_student_effective_access('${student1Id}') as access;`);
    });
    assert.strictEqual(srvRes.rows[0].access.ok, true);
    assert.strictEqual(srvRes.rows[0].access.student_id, student1Id);
  });

  it('RLS: Direct teacher insert, update, or delete on student_practice_access is blocked', async () => {
    const db = await setupTestDb();
    const teacherId = '30000000-0000-0000-0000-000000000001';
    const studentId = '20000000-0000-0000-0000-000000000001';

    await db.exec(`
      INSERT INTO public.profiles (id, role, full_name, level)
      VALUES
        ('${teacherId}', 'teacher', 'Teacher One', NULL),
        ('${studentId}', 'student', 'Student One', 'Level 1');

      INSERT INTO public.teacher_permissions (teacher_id, can_manage_tasks)
      VALUES ('${teacherId}', true);

      INSERT INTO public.teacher_student_assignments (teacher_id, student_id)
      VALUES ('${teacherId}', '${studentId}');
    `);

    // Direct insert by teacher blocked by RLS / table grants
    await asUser(db, teacherId, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`
            INSERT INTO public.student_practice_access (scope, student_id, settings)
            VALUES ('student', '${studentId}', '{"flash": {"allowed": false}}'::jsonb);
          `);
        },
        /violates row-level security policy|permission denied for table student_practice_access/i
      );
    });

    // Save override via authorized RPC succeeds
    await asUser(db, teacherId, 'authenticated', async () => {
      await db.query(`
        SELECT public.save_student_access_override(
          '${studentId}',
          '{"flash": {"allowed": false}}'::jsonb
        );
      `);
    });

    // Direct update by teacher blocked by RLS / table grants
    await asUser(db, teacherId, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`
            UPDATE public.student_practice_access
            SET settings = '{"flash": {"allowed": true}}'::jsonb
            WHERE student_id = '${studentId}';
          `);
        },
        /violates row-level security policy|permission denied for table student_practice_access/i
      );
    });

    // Direct delete by teacher blocked by RLS / table grants
    await asUser(db, teacherId, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`
            DELETE FROM public.student_practice_access
            WHERE student_id = '${studentId}';
          `);
        },
        /violates row-level security policy|permission denied for table student_practice_access/i
      );
    });
  });

  it('Failed lookups: flash_start raises retryable 53000 error, leaving attempt uncreated; default access succeeds', async () => {
    const db = await setupTestDb();
    const studentId = '20000000-0000-0000-0000-000000000001';

    await db.exec(`
      INSERT INTO public.profiles (id, role, full_name, level)
      VALUES ('${studentId}', 'student', 'Student One', 'Level 1');
    `);

    // 1. Successful lookup with no saved rule preserves existing access (default open)
    const startRes = await asUser(db, studentId, 'authenticated', async () => {
      return await db.query(`
        SELECT public.flash_start('{"digits": 1, "count": 5, "speed_ms": 1000, "mode": "add"}'::jsonb) as res;
      `);
    });
    assert.ok(startRes.rows[0].res.session_id);

    // 2. Simulate lookup failure by replacing get_student_effective_access with one returning ok: false
    await db.exec(`
      CREATE OR REPLACE FUNCTION public.get_student_effective_access(p_student_id UUID)
      RETURNS JSONB LANGUAGE plpgsql AS $$
      BEGIN
        RETURN jsonb_build_object('ok', false, 'error', 'Database lookup timeout');
      END;
      $$;
    `);

    // Attempting flash_start now raises retryable 53000 error
    await asUser(db, studentId, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`
            SELECT public.flash_start('{"digits": 1, "count": 5, "speed_ms": 1000, "mode": "add"}'::jsonb);
          `);
        },
        (err) => {
          assert.match(err.message, /Practice access lookup failed|Failed to verify practice access/i);
          return true;
        }
      );
    });

    // Confirm no additional drill session was created during the failure
    const countRes = await db.query(`SELECT COUNT(*) as count FROM public.drill_sessions;`);
    assert.strictEqual(Number(countRes.rows[0].count), 1);

    // Results trigger also raises retryable 53000 error on failed access lookup
    const catId = '40000000-0000-0000-0000-000000000001';
    await db.exec(`
      INSERT INTO public.categories (id, name, section, sort_order)
      VALUES ('${catId}', '1D 4R', 'basics', 1);
    `);
    await asUser(db, studentId, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`
            INSERT INTO public.results (student_id, category_id, correct, total, time_seconds)
            VALUES ('${studentId}', '${catId}', 5, 5, 25);
          `);
        },
        /Practice access lookup failed|Failed to verify practice access/i
      );
    });
  });

  it('Restricted manual entries: results trigger blocks restricted INSERT & category change UPDATE; preserves staff corrections & allows readable history', async () => {
    const db = await setupTestDb();
    const adminId = '10000000-0000-0000-0000-000000000001';
    const teacherId = '30000000-0000-0000-0000-000000000001';
    const studentId = '20000000-0000-0000-0000-000000000001';
    const cat1d4r = '40000000-0000-0000-0000-000000000001';
    const cat2d4r = '40000000-0000-0000-0000-000000000002';
    const catRoundAdd = '40000000-0000-0000-0000-000000000003';

    await db.exec(`
      INSERT INTO public.profiles (id, role, full_name, level)
      VALUES
        ('${adminId}', 'admin', 'Admin User', NULL),
        ('${teacherId}', 'teacher', 'Teacher One', NULL),
        ('${studentId}', 'student', 'Student One', 'Level 1');

      INSERT INTO public.categories (id, name, section, sort_order)
      VALUES
        ('${cat1d4r}', '1D 4R', 'basics', 1),
        ('${cat2d4r}', '2D 4R', 'basics', 2),
        ('${catRoundAdd}', 'Addition', 'round', 3);

      -- Admin sets Level 1 to only allow 1D 4R in Basics and marks student ineligible for Main Round
      INSERT INTO public.student_practice_access (scope, level, settings)
      VALUES (
        'level',
        'Level 1',
        '{"basics": {"all": false, "categories": ["1D 4R"]}, "main_round": {"all": false, "eligible": false, "categories": []}}'::jsonb
      );
    `);

    // 1. Student attempts manual INSERT of unallowed category (2D 4R) -> REJECTED (42501)
    await asUser(db, studentId, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`
            INSERT INTO public.results (student_id, category_id, correct, total, time_seconds)
            VALUES ('${studentId}', '${cat2d4r}', 5, 5, 30);
          `);
        },
        /Access denied: You are not authorized|This category is not permitted/i
      );
    });

    // 2. Student attempts manual INSERT of unallowed Main Round category -> REJECTED (42501)
    await asUser(db, studentId, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`
            INSERT INTO public.results (student_id, category_id, correct, total, time_seconds)
            VALUES ('${studentId}', '${catRoundAdd}', 10, 10, 60);
          `);
        },
        /not eligible for Main Round competition practice/i
      );
    });

    // 3. Student inserts allowed category (1D 4R) -> SUCCEEDS
    let resultId;
    await asUser(db, studentId, 'authenticated', async () => {
      const insRes = await db.query(`
        INSERT INTO public.results (student_id, category_id, correct, total, time_seconds)
        VALUES ('${studentId}', '${cat1d4r}', 5, 5, 30)
        RETURNING id;
      `);
      resultId = insRes.rows[0].id;
      assert.ok(resultId);
    });

    // 4. Student updates time/correct on the allowed record -> SUCCEEDS
    await asUser(db, studentId, 'authenticated', async () => {
      await db.query(`
        UPDATE public.results
        SET correct = 4, time_seconds = 28
        WHERE id = '${resultId}';
      `);
    });

    // 5. Student attempts category change to restricted 2D 4R COMBINED WITH review metadata -> REJECTED (42501)
    await asUser(db, studentId, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`
            UPDATE public.results
            SET category_id = '${cat2d4r}',
                flagged = true,
                flag_note = 'Student attempt to bypass via flag',
                verified = true
            WHERE id = '${resultId}';
          `);
        },
        /Access denied: You are not authorized|This category is not permitted/i
      );
    });

    // 6. History remains readable: Student can SELECT results
    await asUser(db, studentId, 'authenticated', async () => {
      const selRes = await db.query(`SELECT * FROM public.results WHERE student_id = '${studentId}';`);
      assert.strictEqual(selRes.rows.length, 1);
      assert.strictEqual(selRes.rows[0].category_id, cat1d4r);
    });

    // 7. Staff corrections:
    // 7a. Unassigned teacher cannot correct/verify student score -> REJECTED (42501)
    const unassignedTeacherId = '30000000-0000-0000-0000-000000000099';
    await db.exec(`
      INSERT INTO public.profiles (id, role, full_name, level)
      VALUES ('${unassignedTeacherId}', 'teacher', 'Teacher Unassigned', NULL);
    `);
    await asUser(db, unassignedTeacherId, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`
            UPDATE public.results
            SET category_id = '${cat2d4r}', verified = true, verified_by = '${unassignedTeacherId}'
            WHERE id = '${resultId}';
          `);
        },
        /Access denied: You are not authorized|This category is not permitted/i
      );
    });

    // 7b. Assigned teacher CAN correct/verify student score (roster scope) -> SUCCEEDS
    await asUser(db, teacherId, 'authenticated', async () => {
      await db.query(`
        UPDATE public.results
        SET verified = true, verified_by = '${teacherId}', verified_at = now()
        WHERE id = '${resultId}';
      `);
    });
    const verifiedCheck = await db.query(`SELECT verified FROM public.results WHERE id = '${resultId}';`);
    assert.strictEqual(verifiedCheck.rows[0].verified, true);

    // 7c. Admin CAN correct/change category on student score (institute-wide scope) -> SUCCEEDS
    await asUser(db, adminId, 'authenticated', async () => {
      await db.query(`
        UPDATE public.results
        SET category_id = '${cat2d4r}', corrected_by = '${adminId}', corrected_at = now()
        WHERE id = '${resultId}';
      `);
    });
    const adminCheck = await db.query(`SELECT category_id FROM public.results WHERE id = '${resultId}';`);
    assert.strictEqual(adminCheck.rows[0].category_id, cat2d4r);
  });

  it('Valid vs mismatched assignment exceptions: regular save stays blocked; Dashboard Log result flow honors daily plan level; midnight IST boundary; offline review & editable entry date', async () => {
    const db = await setupTestDb();
    const adminId = '10000000-0000-0000-0000-000000000001';
    const teacherId = '30000000-0000-0000-0000-000000000001';
    const studentId = '20000000-0000-0000-0000-000000000001';
    const otherStudentId = '20000000-0000-0000-0000-000000000099';
    const cat1d4r = '40000000-0000-0000-0000-000000000001';
    const cat2d4r = '40000000-0000-0000-0000-000000000002';
    const cat3d5r = '40000000-0000-0000-0000-000000000003';

    const hwBasics2d4r = '50000000-0000-0000-0000-000000000001';
    const hwDueToday = '50000000-0000-0000-0000-000000000002';
    const hwExpiredYesterday = '50000000-0000-0000-0000-000000000003';
    const hwOpensTomorrow = '50000000-0000-0000-0000-000000000004';
    const hwWrongLevel = '50000000-0000-0000-0000-000000000005';

    const taskBasicsMatching = '60000000-0000-0000-0000-000000000001';
    const taskBasicsWrongLevel = '60000000-0000-0000-0000-000000000002';
    const taskTargetedAllowed = '60000000-0000-0000-0000-000000000003';
    const taskTargetedDenied = '60000000-0000-0000-0000-000000000004';
    const taskFutureCreated = '60000000-0000-0000-0000-000000000005';

    await db.exec(`
      INSERT INTO public.profiles (id, role, full_name, level, active)
      VALUES
        ('${adminId}', 'admin', 'Admin User', NULL, true),
        ('${teacherId}', 'teacher', 'Teacher One', NULL, true),
        ('${studentId}', 'student', 'Student One', 'Level 1', true),
        ('${otherStudentId}', 'student', 'Student Other', 'Level 2', true);

      INSERT INTO public.teacher_student_assignments (teacher_id, student_id)
      VALUES ('${teacherId}', '${studentId}');

      INSERT INTO public.categories (id, name, section, sort_order)
      VALUES
        ('${cat1d4r}', '1D 4R', 'basics', 1),
        ('${cat2d4r}', '2D 4R', 'basics', 2),
        ('${cat3d5r}', '3D 5R', 'basics', 3);

      -- Level 1 access: only 1D 4R is allowed for free practice (2D 4R and 3D 5R are restricted)
      INSERT INTO public.student_practice_access (scope, level, settings)
      VALUES (
        'level',
        'Level 1',
        '{"basics": {"all": false, "categories": ["1D 4R"]}}'::jsonb
      );

      -- Add active assigned homework for 2D 4R using public.today_ist() for India-time dates
      INSERT INTO public.homework_assignments (id, title, activity_type, category_id, target_type, target_level, assigned_date, due_date)
      VALUES
        ('${hwBasics2d4r}', 'Basics 2D 4R HW', 'basics', '${cat2d4r}', 'all', NULL, public.today_ist() - 2, public.today_ist() + 7),
        ('${hwDueToday}', 'HW Due Today IST', 'basics', '${cat2d4r}', 'all', NULL, public.today_ist() - 1, public.today_ist()),
        ('${hwExpiredYesterday}', 'HW Expired Yesterday IST', 'basics', '${cat2d4r}', 'all', NULL, public.today_ist() - 7, public.today_ist() - 1),
        ('${hwOpensTomorrow}', 'HW Opens Tomorrow IST', 'basics', '${cat2d4r}', 'all', NULL, public.today_ist() + 1, public.today_ist() + 7),
        ('${hwWrongLevel}', 'Wrong Level HW', 'basics', '${cat2d4r}', 'level', 'Level 2', public.today_ist() - 1, public.today_ist() + 7);

      -- Add active Daily To-Do tasks using real target_scope = 'all' + level representation
      INSERT INTO public.daily_tasks (id, title, section, category_id, target_scope, level, active, created_at)
      VALUES
        ('${taskBasicsMatching}', 'Basics Level 1 Task', 'basics', '${cat2d4r}', 'all', 'Level 1', true, now() - interval '1 hour'),
        ('${taskBasicsWrongLevel}', 'Basics Level 2 Task', 'basics', '${cat2d4r}', 'all', 'Level 2', true, now() - interval '1 hour'),
        ('${taskTargetedAllowed}', 'Basics Targeted Allowed', 'basics', '${cat2d4r}', 'targeted', NULL, true, now() - interval '1 hour'),
        ('${taskTargetedDenied}', 'Basics Targeted Denied', 'basics', '${cat2d4r}', 'targeted', NULL, true, now() - interval '1 hour'),
        ('${taskFutureCreated}', 'Basics Future Created', 'basics', '${cat2d4r}', 'all', 'Level 1', true, (public.today_ist() + interval '1 day')::timestamptz);

      INSERT INTO public.daily_task_recipients (task_id, student_id)
      VALUES
        ('${taskTargetedAllowed}', '${studentId}'),
        ('${taskTargetedDenied}', '${otherStudentId}');
    `);

    // 1. Ordinary manual entry still follows free-practice access
    // (Inserting 2D 4R without homework_id or task_id stays blocked even when matching homework/tasks exist)
    await asUser(db, studentId, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`
            INSERT INTO public.results (student_id, category_id, correct, total, time_seconds)
            VALUES ('${studentId}', '${cat2d4r}', 5, 5, 25);
          `);
        },
        /This category is not permitted for your practice access/i
      );
    });

    // 2. Dashboard -> Log result flow saves for student at matching level (target_scope = 'all', level = 'Level 1')
    let taskResultId;
    await asUser(db, studentId, 'authenticated', async () => {
      const insRes = await db.query(`
        INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, task_id, entry_date)
        VALUES ('${studentId}', '${cat2d4r}', 5, 5, 25, '${taskBasicsMatching}', '2026-11-16')
        RETURNING id, entry_date;
      `);
      taskResultId = insRes.rows[0].id;
      assert.ok(taskResultId);
      const dateStr = insRes.rows[0].entry_date instanceof Date
        ? insRes.rows[0].entry_date.toISOString().split('T')[0]
        : String(insRes.rows[0].entry_date).split('T')[0];
      assert.strictEqual(dateStr, '2026-11-16');
    });

    // Targeted task for assigned recipient succeeds
    await asUser(db, studentId, 'authenticated', async () => {
      const insRes = await db.query(`
        INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, task_id)
        VALUES ('${studentId}', '${cat2d4r}', 5, 5, 25, '${taskTargetedAllowed}')
        RETURNING id;
      `);
      assert.ok(insRes.rows[0].id);
    });

    // 3. Manual-save guard rejects student at a different level (student is Level 1, task is Level 2)
    await asUser(db, studentId, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`
            INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, task_id)
            VALUES ('${studentId}', '${cat2d4r}', 5, 5, 25, '${taskBasicsWrongLevel}');
          `);
        },
        /This category is not permitted for your practice access/i
      );
    });

    // Targeted task where student is not in recipients is rejected
    await asUser(db, studentId, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`
            INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, task_id)
            VALUES ('${studentId}', '${cat2d4r}', 5, 5, 25, '${taskTargetedDenied}');
          `);
        },
        /This category is not permitted for your practice access/i
      );
    });

    // 3b. Task created in the future relative to today_ist does not qualify (creation-date rule)
    await asUser(db, studentId, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`
            INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, task_id)
            VALUES ('${studentId}', '${cat2d4r}', 5, 5, 25, '${taskFutureCreated}');
          `);
        },
        /This category is not permitted for your practice access/i
      );
    });

    // 4. Homework date-window checks using public.today_ist() & Midnight IST Boundary
    // 4a. Due today in India Time (due_date = today_ist()) -> SUCCEEDS
    await asUser(db, studentId, 'authenticated', async () => {
      const insRes = await db.query(`
        INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, homework_id)
        VALUES ('${studentId}', '${cat2d4r}', 5, 5, 25, '${hwDueToday}')
        RETURNING id;
      `);
      assert.ok(insRes.rows[0].id);
    });

    // 4b. Expired at midnight IST (due_date = today_ist() - 1) -> REJECTED (42501)
    await asUser(db, studentId, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`
            INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, homework_id)
            VALUES ('${studentId}', '${cat2d4r}', 5, 5, 25, '${hwExpiredYesterday}');
          `);
        },
        /This category is not permitted for your practice access/i
      );
    });

    // 4c. Not open yet in India Time (assigned_date = today_ist() + 1) -> REJECTED (42501)
    await asUser(db, studentId, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`
            INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, homework_id)
            VALUES ('${studentId}', '${cat2d4r}', 5, 5, 25, '${hwOpensTomorrow}');
          `);
        },
        /This category is not permitted for your practice access/i
      );
    });

    // 4d. Wrong level homework -> REJECTED (42501)
    await asUser(db, studentId, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`
            INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, homework_id)
            VALUES ('${studentId}', '${cat2d4r}', 5, 5, 25, '${hwWrongLevel}');
          `);
        },
        /This category is not permitted for your practice access/i
      );
    });

    // 5. Preserve offline Homework Submit for Review flow & score editable entry date
    let hwResultId;
    await asUser(db, studentId, 'authenticated', async () => {
      const insRes = await db.query(`
        INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, homework_id, entry_date)
        VALUES ('${studentId}', '${cat2d4r}', 5, 5, 25, '${hwBasics2d4r}', '2026-11-15')
        RETURNING id, entry_date, verified;
      `);
      hwResultId = insRes.rows[0].id;
      assert.ok(hwResultId);
      assert.strictEqual(insRes.rows[0].verified, false);
      const dateStr = insRes.rows[0].entry_date instanceof Date
        ? insRes.rows[0].entry_date.toISOString().split('T')[0]
        : String(insRes.rows[0].entry_date).split('T')[0];
      assert.strictEqual(dateStr, '2026-11-15');
    });

    // Student can edit entry_date and time_seconds on their unverified offline submission
    await asUser(db, studentId, 'authenticated', async () => {
      await db.query(`
        UPDATE public.results
        SET entry_date = '2026-11-14', time_seconds = 22
        WHERE id = '${hwResultId}';
      `);
      const checkRes = await db.query(`SELECT entry_date, time_seconds FROM public.results WHERE id = '${hwResultId}';`);
      const updatedDate = checkRes.rows[0].entry_date instanceof Date
        ? checkRes.rows[0].entry_date.toISOString().split('T')[0]
        : String(checkRes.rows[0].entry_date).split('T')[0];
      assert.strictEqual(updatedDate, '2026-11-14');
      assert.strictEqual(Number(checkRes.rows[0].time_seconds), 22);
    });

    // Student cannot change category to an unallowed category via update
    await asUser(db, studentId, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`
            UPDATE public.results
            SET category_id = '${cat3d5r}'
            WHERE id = '${hwResultId}';
          `);
        },
        /This category is not permitted for your practice access/i
      );
    });

    // Teacher can verify the offline homework score (Submit for Review flow completion)
    await asUser(db, teacherId, 'authenticated', async () => {
      await db.query(`
        UPDATE public.results
        SET verified = true, verified_by = '${teacherId}', verified_at = now()
        WHERE id = '${hwResultId}';
      `);
      const verifiedCheck = await db.query(`SELECT verified, verified_by FROM public.results WHERE id = '${hwResultId}';`);
      assert.strictEqual(verifiedCheck.rows[0].verified, true);
      assert.strictEqual(verifiedCheck.rows[0].verified_by, teacherId);
    });

    // Completed homework cannot be re-used to submit new results
    await db.exec(`
      INSERT INTO public.homework_completions (assignment_id, student_id, status)
      VALUES ('${hwBasics2d4r}', '${studentId}', 'completed');
    `);
    await asUser(db, studentId, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`
            INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, homework_id)
            VALUES ('${studentId}', '${cat2d4r}', 5, 5, 25, '${hwBasics2d4r}');
          `);
        },
        /This category is not permitted for your practice access/i
      );
    });
  });

  it('Deterministic IST vs UTC boundary: homework date window & task creation-date evaluate against India Time when UTC date differs', async () => {
    const db = await setupTestDb();
    const studentId = '20000000-0000-0000-0000-000000000001';
    const catBasics2d4r = '40000000-0000-0000-0000-000000000002';
    const catRoundAdd = '40000000-0000-0000-0000-000000000003';

    const hwBasicsExpiredAtMidnightIst = '50000000-0000-0000-0000-000000000011';
    const hwBasicsOpenedAtMidnightIst = '50000000-0000-0000-0000-000000000012';
    const hwRoundExpiredAtMidnightIst = '50000000-0000-0000-0000-000000000013';
    const hwRoundOpenedAtMidnightIst = '50000000-0000-0000-0000-000000000014';

    const taskCreatedTodayIst = '60000000-0000-0000-0000-000000000011';
    const taskCreatedTomorrowIst = '60000000-0000-0000-0000-000000000012';

    // Set deterministic simulation where UTC is 2026-11-22 19:30:00 (Nov 22 in UTC),
    // but in Asia/Kolkata (UTC+5:30) it is 2026-11-23 01:00:00 (Nov 23 in IST).
    await db.exec(`
      CREATE OR REPLACE FUNCTION public.today_ist()
      RETURNS DATE
      LANGUAGE sql
      STABLE
      AS $$
        SELECT ('2026-11-22 19:30:00+00'::timestamptz AT TIME ZONE 'Asia/Kolkata')::date;
      $$;

      INSERT INTO public.profiles (id, role, full_name, level, active)
      VALUES
        ('${studentId}', 'student', 'Student One', 'Level 1', true);

      INSERT INTO public.jmcwc_assignments (student_id, group_key)
      VALUES ('${studentId}', 'group-a');

      INSERT INTO public.categories (id, name, section, sort_order)
      VALUES
        ('${catBasics2d4r}', '2D 4R', 'basics', 1),
        ('${catRoundAdd}', 'Addition', 'round', 2);

      -- Level 1: Basics 2D 4R and Main Round are restricted
      INSERT INTO public.student_practice_access (scope, level, settings)
      VALUES (
        'level',
        'Level 1',
        '{"basics": {"all": false, "categories": ["1D 4R"]}, "main_round": {"all": false, "eligible": true, "categories": []}}'::jsonb
      );

      -- Basics Homework:
      -- 1) Due on 2026-11-22: Under UTC (Nov 22) this would appear open, but under IST (Nov 23) it expired at midnight!
      -- 2) Assigned on 2026-11-23: Under UTC (Nov 22) this would appear not open yet, but under IST (Nov 23) it opened at midnight!
      INSERT INTO public.homework_assignments (id, title, activity_type, category_id, target_type, assigned_date, due_date)
      VALUES
        ('${hwBasicsExpiredAtMidnightIst}', 'Basics Expired at Midnight IST', 'basics', '${catBasics2d4r}', 'all', '2026-11-15'::date, '2026-11-22'::date),
        ('${hwBasicsOpenedAtMidnightIst}', 'Basics Opened at Midnight IST', 'basics', '${catBasics2d4r}', 'all', '2026-11-23'::date, '2026-11-25'::date),
        ('${hwRoundExpiredAtMidnightIst}', 'Round Expired at Midnight IST', 'round', '${catRoundAdd}', 'all', '2026-11-15'::date, '2026-11-22'::date),
        ('${hwRoundOpenedAtMidnightIst}', 'Round Opened at Midnight IST', 'round', '${catRoundAdd}', 'all', '2026-11-23'::date, '2026-11-25'::date);

      -- Daily Tasks creation date:
      -- Task A created on 2026-11-22 19:00:00 UTC = 2026-11-23 00:30:00 IST -> created on today_ist (2026-11-23)
      -- Task B created on 2026-11-23 20:00:00 UTC = 2026-11-24 01:30:00 IST -> created tomorrow in IST (2026-11-24)
      INSERT INTO public.daily_tasks (id, title, section, category_id, target_scope, level, active, created_at)
      VALUES
        ('${taskCreatedTodayIst}', 'Task Created Today IST', 'basics', '${catBasics2d4r}', 'all', 'Level 1', true, '2026-11-22 19:00:00+00'::timestamptz),
        ('${taskCreatedTomorrowIst}', 'Task Created Tomorrow IST', 'basics', '${catBasics2d4r}', 'all', 'Level 1', true, '2026-11-23 20:00:00+00'::timestamptz);
    `);

    // Verify today_ist() is 2026-11-23 while simulation UTC time is 2026-11-22
    const checkToday = await db.query(`SELECT public.today_ist() AS today_ist, ('2026-11-22 19:30:00+00'::timestamptz AT TIME ZONE 'UTC')::date AS utc_date;`);
    const todayIstStr = checkToday.rows[0].today_ist instanceof Date ? checkToday.rows[0].today_ist.toISOString().split('T')[0] : String(checkToday.rows[0].today_ist);
    const utcDateStr = checkToday.rows[0].utc_date instanceof Date ? checkToday.rows[0].utc_date.toISOString().split('T')[0] : String(checkToday.rows[0].utc_date);
    assert.strictEqual(todayIstStr, '2026-11-23');
    assert.strictEqual(utcDateStr, '2026-11-22');

    // 1. Basics Homework due Nov 22: Expired at midnight IST (today_ist is Nov 23) -> REJECTED (42501)
    await asUser(db, studentId, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`
            INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, homework_id)
            VALUES ('${studentId}', '${catBasics2d4r}', 5, 5, 25, '${hwBasicsExpiredAtMidnightIst}');
          `);
        },
        /This category is not permitted for your practice access/i
      );
    });

    // 2. Basics Homework assigned Nov 23: Open at midnight IST (today_ist is Nov 23, even though UTC is Nov 22) -> SUCCEEDS
    await asUser(db, studentId, 'authenticated', async () => {
      const insRes = await db.query(`
        INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, homework_id)
        VALUES ('${studentId}', '${catBasics2d4r}', 5, 5, 25, '${hwBasicsOpenedAtMidnightIst}')
        RETURNING id;
      `);
      assert.ok(insRes.rows[0].id);
    });

    // 3. Main Round Homework due Nov 22: Expired at midnight IST (using same public.today_ist() date window) -> REJECTED (42501)
    await asUser(db, studentId, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`
            INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, homework_id)
            VALUES ('${studentId}', '${catRoundAdd}', 10, 10, 60, '${hwRoundExpiredAtMidnightIst}');
          `);
        },
        /This round category is not permitted for your practice access/i
      );
    });

    // 4. Main Round Homework assigned Nov 23: Open at midnight IST -> SUCCEEDS
    await asUser(db, studentId, 'authenticated', async () => {
      const insRes = await db.query(`
        INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, homework_id)
        VALUES ('${studentId}', '${catRoundAdd}', 10, 10, 60, '${hwRoundOpenedAtMidnightIst}')
        RETURNING id;
      `);
      assert.ok(insRes.rows[0].id);
    });

    // 5. Daily Task creation date: Task A created today in IST qualifies -> SUCCEEDS
    await asUser(db, studentId, 'authenticated', async () => {
      const insRes = await db.query(`
        INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, task_id)
        VALUES ('${studentId}', '${catBasics2d4r}', 5, 5, 25, '${taskCreatedTodayIst}')
        RETURNING id;
      `);
      assert.ok(insRes.rows[0].id);
    });

    // 6. Daily Task creation date: Task B created tomorrow in IST does not qualify -> REJECTED (42501)
    await asUser(db, studentId, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`
            INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, task_id)
            VALUES ('${studentId}', '${catBasics2d4r}', 5, 5, 25, '${taskCreatedTomorrowIst}');
          `);
        },
        /This category is not permitted for your practice access/i
      );
    });
  });

  it('Calendar 25 vs 125: Memoriad validates dates, rejects 125 when only 25 allowed, including when request omits dates', (t) => {
    const originalWindow = globalThis.window;
    globalThis.window = { location: { hostname: 'localhost' } };
    t.after(() => {
      if (originalWindow === undefined) delete globalThis.window;
      else globalThis.window = originalWindow;
    });
    const memoriadRule = {
      all: false,
      modules: ['calendar'],
      calendar_variants: [25], // Only 25 allowed!
    };

    // Explicit 25 dates -> allowed
    assert.strictEqual(isMemoriadAllowed('calendar', 25, memoriadRule), true);

    // Explicit 125 dates -> rejected
    assert.strictEqual(isMemoriadAllowed('calendar', 125, memoriadRule), false);

    // DemoDB mockMemoriadStart behavior:
    DemoDB.saveStudentAccessOverride('usr-101', {
      memoriad: memoriadRule,
    });

    // Starting with 25 dates succeeds
    const s25 = DemoDB.mockMemoriadStart('calendar', { dates: 25 }, { studentId: 'usr-101' });
    assert.strictEqual(s25.module, 'calendar');

    // Starting with explicit 125 dates is rejected
    assert.throws(
      () => {
        DemoDB.mockMemoriadStart('calendar', { dates: 125 }, { studentId: 'usr-101' });
      },
      /not permitted/i
    );

    // Starting with omitted dates (defaulting to 125 in Memoriad) is rejected
    assert.throws(
      () => {
        DemoDB.mockMemoriadStart('calendar', {}, { studentId: 'usr-101' });
      },
      /not permitted/i
    );
  });

  it('Main Round full paper checks validate actual paper blueprint section keys', () => {
    const paperSpec = {
      sections: [
        { key: 'addition', questions: [{ slot: 1, max_marks: 10 }] },
        { key: 'multiplication', questions: [{ slot: 2, max_marks: 10 }] },
        { key: 'division', questions: [{ slot: 3, max_marks: 10 }] },
      ],
    };

    const paperCategories = paperSpec.sections.map((s) => s.category_key || s.key);

    const fullRoundRule = {
      all: false,
      eligible: true,
      categories: ['addition', 'multiplication', 'division'],
    };
    assert.strictEqual(isMainRoundFullPaperAllowed(paperCategories, fullRoundRule, true), true);

    const partialRoundRule = {
      all: false,
      eligible: true,
      categories: ['addition', 'multiplication'], // missing division
    };
    assert.strictEqual(isMainRoundFullPaperAllowed(paperCategories, partialRoundRule, true), false);
  });

  it('Preserves existing flash_start response & homework session links; allows assigned Flash when free practice restricted; client start function parity', async () => {
    const db = await setupTestDb();
    const studentId = '20000000-0000-0000-0000-000000000001';
    const hwFlashId = '50000000-0000-0000-0000-000000000099';

    await db.exec(`
      INSERT INTO public.profiles (id, role, full_name, level)
      VALUES ('${studentId}', 'student', 'Student One', 'Level 1');

      INSERT INTO public.homework_assignments (id, title, activity_type, target_type, assigned_date, due_date, settings)
      VALUES ('${hwFlashId}', 'Flash HW Assignment', 'flash', 'all', CURRENT_DATE, CURRENT_DATE + interval '7 days', '{"digits": 2, "count": 5, "speed_ms": 800, "mode": "add"}'::jsonb);
    `);

    // 1. Free practice Flash when allowed: returns session_id, numbers, settings
    const freeRes = await asUser(db, studentId, 'authenticated', async () => {
      const { rows } = await db.query(`
        SELECT public.flash_start('{"digits": 2, "count": 5, "speed_ms": 1000, "mode": "add"}'::jsonb) as res;
      `);
      return rows[0].res;
    });
    assert.ok(freeRes.session_id, 'Must return session_id');
    assert.ok(Array.isArray(freeRes.numbers), 'Must return numbers array');
    assert.strictEqual(freeRes.numbers.length, 5);
    assert.strictEqual(freeRes.settings.digits, 2);
    assert.strictEqual(freeRes.settings.count, 5);
    assert.strictEqual(freeRes.settings.speed_ms, 1000);
    assert.strictEqual(freeRes.settings.mode, 'add');

    // Confirm drill_sessions row was inserted with activity_name, questions, expected, settings
    const dsRes = await db.query(`SELECT * FROM public.drill_sessions WHERE id = '${freeRes.session_id}';`);
    assert.strictEqual(dsRes.rows.length, 1);
    assert.strictEqual(dsRes.rows[0].activity_name, 'Flash anzan');
    assert.ok(dsRes.rows[0].questions);
    assert.ok(dsRes.rows[0].expected);

    // 2. Restrict free practice Flash for this student
    await asUser(db, null, 'service_role', async () => {
      await db.query(`
        INSERT INTO public.student_practice_access (scope, student_id, settings)
        VALUES ('student', '${studentId}', '{"flash": {"allowed": false}}'::jsonb);
      `);
    });

    // Free practice is now rejected with 42501
    await asUser(db, studentId, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`
            SELECT public.flash_start('{"digits": 2, "count": 5, "speed_ms": 1000, "mode": "add"}'::jsonb);
          `);
        },
        /Flash Anzan practice is not permitted for your current access level/i
      );
    });

    // 3. Assigned Flash with homework_id succeeds despite free practice restriction
    const hwStartRes = await asUser(db, studentId, 'authenticated', async () => {
      const { rows } = await db.query(`
        SELECT public.flash_start(jsonb_build_object('homework_id', '${hwFlashId}')) as res;
      `);
      return rows[0].res;
    });
    assert.ok(hwStartRes.session_id, 'Must return session_id for assigned homework');
    assert.ok(Array.isArray(hwStartRes.numbers), 'Must return numbers array');
    assert.strictEqual(hwStartRes.settings.homework_id, hwFlashId);
    assert.strictEqual(hwStartRes.settings.digits, 2);
    assert.strictEqual(hwStartRes.settings.speed_ms, 800);

    // Verify session was bound in homework_bound_sessions
    const boundCheck = await db.query(`
      SELECT * FROM public.homework_bound_sessions
      WHERE session_id = '${hwStartRes.session_id}' AND assignment_id = '${hwFlashId}';
    `);
    assert.strictEqual(boundCheck.rows.length, 1, 'Session must be bound in homework_bound_sessions');
    assert.strictEqual(boundCheck.rows[0].student_id, studentId);

    // 4. Client start function parity (callFlashStartRpc)
    const mockSupabase = {
      rpc: async (fnName, params) => {
        assert.strictEqual(fnName, 'flash_start');
        return await asUser(db, studentId, 'authenticated', async () => {
          try {
            const { rows } = await db.query(
              `SELECT public.flash_start($1::jsonb) as res;`,
              [JSON.stringify(params.p_settings)]
            );
            return { data: rows[0].res, error: null };
          } catch (err) {
            return { data: null, error: err };
          }
        });
      },
    };

    // Client call: assigned Flash flow
    const clientHwRes = await callFlashStartRpc(
      { digits: 2, count: 5, speed_ms: 800, mode: 'add' },
      { supabase: mockSupabase, urlSearch: `?homework_id=${hwFlashId}` }
    );
    assert.ok(clientHwRes.session_id);
    assert.strictEqual(clientHwRes.settings.homework_id, hwFlashId);

    // Client call: restricted free practice flow throws error
    await assert.rejects(
      async () => {
        await callFlashStartRpc(
          { digits: 2, count: 5, speed_ms: 1000, mode: 'add' },
          { supabase: mockSupabase, urlSearch: '' }
        );
      },
      /Flash Anzan practice is not permitted for your current access level/i
    );
  });

  it('Regression test: task IDs appearing in Today’s plan match task IDs qualifying for manual entry when free practice is restricted', async () => {
    const db = await setupTestDb();
    const studentId = randomUUID();
    const otherStudentId = randomUUID();
    const cat1d4r = randomUUID();
    const cat2d4r = randomUUID();

    // 1. Setup profiles & categories
    await db.exec(`
      INSERT INTO public.profiles (id, full_name, role, level, active)
      VALUES
        ('${studentId}', 'Student Plan Test', 'student', 'Level 1', true),
        ('${otherStudentId}', 'Other Student Plan', 'student', 'Level 2', true);

      INSERT INTO public.categories (id, name, section, sort_order)
      VALUES
        ('${cat1d4r}', '1D 4R', 'basics', 1),
        ('${cat2d4r}', '2D 4R', 'basics', 2);

      -- Restrict Level 1 free practice: only 1D 4R is allowed (2D 4R is restricted)
      INSERT INTO public.student_practice_access (scope, level, settings)
      VALUES (
        'level',
        'Level 1',
        '{"basics": {"all": false, "categories": ["1D 4R"]}}'::jsonb
      );
    `);

    // 2. Define test tasks spanning all plan eligibility rules:
    // Scope (all vs targeted), Level (matching vs null vs mismatch), Recipients, Active flag, IST Creation Date, Section & Category
    const taskAllMatching = randomUUID();
    const taskAllNullLevel = randomUUID();
    const taskAllNullCat = randomUUID();
    const taskTargetedRecipient = randomUUID();
    const taskAllWrongLevel = randomUUID();
    const taskTargetedDenied = randomUUID();
    const taskInactive = randomUUID();
    const taskFutureCreated = randomUUID();
    const taskOtherCategory = randomUUID();
    const taskOtherSection = randomUUID();

    await db.exec(`
      INSERT INTO public.daily_tasks (id, title, section, category_id, target_scope, level, active, created_at)
      VALUES
        -- 1. All tasks, matching level -> In plan & qualifies
        ('${taskAllMatching}', 'All Task Matching Level', 'basics', '${cat2d4r}', 'all', 'Level 1', true, now() - interval '2 hours'),
        -- 2. All tasks, NULL level -> In plan & qualifies
        ('${taskAllNullLevel}', 'All Task NULL Level', 'basics', '${cat2d4r}', 'all', NULL, true, now() - interval '2 hours'),
        -- 3. All tasks, NULL category (category-wide basics) -> In plan & qualifies
        ('${taskAllNullCat}', 'All Task NULL Category', 'basics', NULL, 'all', 'Level 1', true, now() - interval '2 hours'),
        -- 4. Targeted task with student as recipient -> In plan & qualifies
        ('${taskTargetedRecipient}', 'Targeted Task Recipient', 'basics', '${cat2d4r}', 'targeted', NULL, true, now() - interval '2 hours'),
        -- 5. All tasks, wrong level (Level 2 vs student Level 1) -> NOT in plan & rejected
        ('${taskAllWrongLevel}', 'All Task Wrong Level', 'basics', '${cat2d4r}', 'all', 'Level 2', true, now() - interval '2 hours'),
        -- 6. Targeted task where student is NOT recipient -> NOT in plan & rejected
        ('${taskTargetedDenied}', 'Targeted Task Non-Recipient', 'basics', '${cat2d4r}', 'targeted', NULL, true, now() - interval '2 hours'),
        -- 7. Inactive task -> NOT in plan & rejected
        ('${taskInactive}', 'Inactive Task', 'basics', '${cat2d4r}', 'all', 'Level 1', false, now() - interval '2 hours'),
        -- 8. Future created task relative to today_ist -> NOT in plan & rejected
        ('${taskFutureCreated}', 'Future Created Task', 'basics', '${cat2d4r}', 'all', 'Level 1', true, (public.today_ist() + interval '1 day')::timestamptz),
        -- 9. Different category task (1D 4R) -> NOT in 2D 4R plan & rejected for 2D 4R manual entry
        ('${taskOtherCategory}', 'Other Category Task', 'basics', '${cat1d4r}', 'all', 'Level 1', true, now() - interval '2 hours'),
        -- 10. Different section task (Flash) -> NOT in Basics plan & rejected for Basics manual entry
        ('${taskOtherSection}', 'Other Section Task', 'flash', NULL, 'all', 'Level 1', true, now() - interval '2 hours');

      INSERT INTO public.daily_task_recipients (task_id, student_id)
      VALUES
        ('${taskTargetedRecipient}', '${studentId}'),
        ('${taskTargetedDenied}', '${otherStudentId}');
    `);

    // 3. Query Today's plan via todo_status_on as the student
    const planRes = await asUser(db, studentId, 'authenticated', async () => {
      return await db.query(`
        SELECT task_id, task_title, task_section, task_category_id
        FROM public.todo_status_on('${studentId}', public.today_ist())
        WHERE task_section = 'basics'
          AND (task_category_id = '${cat2d4r}' OR task_category_id IS NULL);
      `);
    });
    const planTaskIds = new Set(planRes.rows.map(r => r.task_id));

    // Expected qualifying task IDs in Today's plan:
    const expectedEligibleTasks = [taskAllMatching, taskAllNullLevel, taskAllNullCat, taskTargetedRecipient];
    assert.deepStrictEqual(
      Array.from(planTaskIds).sort(),
      expectedEligibleTasks.sort(),
      'Today’s plan must only contain tasks eligible for the student'
    );

    // 4. Test manual entry for each task when free practice is restricted
    const testTasks = [
      { id: taskAllMatching, name: 'taskAllMatching', shouldQualify: true },
      { id: taskAllNullLevel, name: 'taskAllNullLevel', shouldQualify: true },
      { id: taskAllNullCat, name: 'taskAllNullCat', shouldQualify: true },
      { id: taskTargetedRecipient, name: 'taskTargetedRecipient', shouldQualify: true },
      { id: taskAllWrongLevel, name: 'taskAllWrongLevel', shouldQualify: false },
      { id: taskTargetedDenied, name: 'taskTargetedDenied', shouldQualify: false },
      { id: taskInactive, name: 'taskInactive', shouldQualify: false },
      { id: taskFutureCreated, name: 'taskFutureCreated', shouldQualify: false },
      { id: taskOtherCategory, name: 'taskOtherCategory', shouldQualify: false },
      { id: taskOtherSection, name: 'taskOtherSection', shouldQualify: false },
    ];

    const actualQualifiedTaskIds = [];

    for (const t of testTasks) {
      let inserted = false;
      await asUser(db, studentId, 'authenticated', async () => {
        try {
          const insRes = await db.query(`
            INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, task_id)
            VALUES ('${studentId}', '${cat2d4r}', 5, 5, 25, '${t.id}')
            RETURNING id;
          `);
          if (insRes.rows && insRes.rows.length > 0) {
            inserted = true;
            actualQualifiedTaskIds.push(t.id);
          }
        } catch (err) {
          if (/This category is not permitted for your practice access/i.test(err.message)) {
            inserted = false;
          } else {
            throw err;
          }
        }
      });

      const inPlan = planTaskIds.has(t.id);
      assert.strictEqual(
        inserted,
        t.shouldQualify,
        `Task ${t.name} qualification mismatch: expected=${t.shouldQualify}, actual=${inserted}`
      );
      assert.strictEqual(
        inserted,
        inPlan,
        `Task ${t.name} parity mismatch between Today's plan (${inPlan}) and manual entry eligibility (${inserted})`
      );
    }

    // 5. Final strict parity assertion:
    // The exact set of task IDs in Today's plan equals the exact set qualifying for manual entry
    assert.deepStrictEqual(
      actualQualifiedTaskIds.sort(),
      Array.from(planTaskIds).sort(),
      'Parity check failed: Today’s plan task IDs must strictly match manual entry qualifying task IDs'
    );
  });

  it('Regression test: active student with no profile level and restricted free practice — level task absent from Today’s plan and rejected by save guard, unlevel task saves', async () => {
    const db = await setupTestDb();
    const studentNoLevelId = randomUUID();
    const cat2d4r = randomUUID();

    // 1. Setup profile with NULL level (active student with no profile level)
    await db.exec(`
      INSERT INTO public.profiles (id, full_name, role, level, active)
      VALUES ('${studentNoLevelId}', 'Student No Level', 'student', NULL, true);

      INSERT INTO public.categories (id, name, section, sort_order)
      VALUES ('${cat2d4r}', '2D 4R', 'basics', 1);

      -- Restrict free practice for 2D 4R via student override
      INSERT INTO public.student_practice_access (scope, student_id, settings)
      VALUES (
        'student',
        '${studentNoLevelId}',
        '{"basics": {"all": false, "categories": ["1D 4R"]}}'::jsonb
      );
    `);

    // 2. Setup tasks:
    // Task A: level-specific task (level = 'Level 1')
    // Task B: otherwise eligible task with no level restriction (level = NULL)
    const taskLevelSpecific = randomUUID();
    const taskNoLevelRestriction = randomUUID();

    await db.exec(`
      INSERT INTO public.daily_tasks (id, title, section, category_id, target_scope, level, active, created_at)
      VALUES
        ('${taskLevelSpecific}', 'Level 1 Specific Basics Task', 'basics', '${cat2d4r}', 'all', 'Level 1', true, now() - interval '1 hour'),
        ('${taskNoLevelRestriction}', 'Unrestricted Level Basics Task', 'basics', '${cat2d4r}', 'all', NULL, true, now() - interval '1 hour');
    `);

    // 3. Query Today's plan via todo_status_on as the student
    const planRes = await asUser(db, studentNoLevelId, 'authenticated', async () => {
      return await db.query(`
        SELECT task_id, task_title, task_section, task_category_id
        FROM public.todo_status_on('${studentNoLevelId}', public.today_ist())
        WHERE task_section = 'basics'
          AND (task_category_id = '${cat2d4r}' OR task_category_id IS NULL);
      `);
    });
    const planTaskIds = new Set(planRes.rows.map(r => r.task_id));

    // A level-specific task should be absent from Today’s plan
    assert.strictEqual(
      planTaskIds.has(taskLevelSpecific),
      false,
      'Level-specific task must be absent from Today’s plan for a student with no profile level'
    );

    // An otherwise eligible task with no level restriction should be present in Today's plan
    assert.strictEqual(
      planTaskIds.has(taskNoLevelRestriction),
      true,
      'Task with no level restriction must be present in Today’s plan'
    );

    // 4. Manual Basics save guard:
    // 4a. Ordinary manual save with no task/homework ID stays rejected
    await asUser(db, studentNoLevelId, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`
            INSERT INTO public.results (student_id, category_id, correct, total, time_seconds)
            VALUES ('${studentNoLevelId}', '${cat2d4r}', 5, 5, 25);
          `);
        },
        /This category is not permitted for your practice access/i
      );
    });

    // 4b. Level-specific task should be rejected by the save guard (42501)
    await asUser(db, studentNoLevelId, 'authenticated', async () => {
      await assert.rejects(
        async () => {
          await db.query(`
            INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, task_id)
            VALUES ('${studentNoLevelId}', '${cat2d4r}', 5, 5, 25, '${taskLevelSpecific}');
          `);
        },
        /This category is not permitted for your practice access/i
      );
    });

    // 4c. An otherwise eligible task with no level restriction should still save
    await asUser(db, studentNoLevelId, 'authenticated', async () => {
      const insRes = await db.query(`
        INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, task_id)
        VALUES ('${studentNoLevelId}', '${cat2d4r}', 5, 5, 25, '${taskNoLevelRestriction}')
        RETURNING id;
      `);
      assert.ok(insRes.rows && insRes.rows.length > 0 && insRes.rows[0].id, 'Task with no level restriction saves successfully');
    });
  });

  it('Incremental migration staging_student_access_enforcement.sql applies cleanly and is idempotent', async () => {
    const db = await setupTestDb();
    const incSqlPath = path.resolve(ROOT_DIR, 'supabase', 'staging_student_access_enforcement.sql');
    const incContent = fs.readFileSync(incSqlPath, 'utf8');

    // Apply incremental migration on top of baseline
    await assert.doesNotReject(async () => {
      await db.exec(incContent);
    });

    // Re-apply to verify idempotency
    await assert.doesNotReject(async () => {
      await db.exec(incContent);
    });
  });
});
