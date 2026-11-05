import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SECTION_KINDS,
  MEMORIAD_MODULES,
  FLASH_MODES,
  sectionKindLabel,
  validateSections,
  toSectionRow,
  toRows
} from '../js/weeklySections.js';
import { DRILL_CATALOG_LIST } from '../js/drillCatalog.js';
import {
  renderKindOptionsHtml,
  renderSectionFieldsHtml,
  saveTestSectionsInPlace,
  executeSaveWeeklyTest
} from '../js/weeklyTests.js';

const mockBasicsCats = [
  { id: 'cat-b1', name: '1D 4R', section: 'basics' },
  { id: 'cat-b2', name: '2D 5R', section: 'basics' },
  { id: 'cat-b-unavail', name: 'Advanced Abacus 9D', section: 'basics' }
];

const mockRoundCats = [
  { id: 'cat-r1', name: 'ADD', section: 'round' },
  { id: 'cat-r2', name: 'MUL', section: 'round' }
];

const allMockCats = [...mockBasicsCats, ...mockRoundCats];
const enabledDrills = DRILL_CATALOG_LIST.filter((d) => d.enabled);

test('Production renderKindOptionsHtml generates valid HTML options for all 5 section kinds', () => {
  // Test offline mode: all 5 kinds enabled
  const offlineHtml = renderKindOptionsHtml('basics', false);
  assert.ok(offlineHtml.includes('value="basics"'));
  assert.ok(offlineHtml.includes('value="flash"'));
  assert.ok(offlineHtml.includes('value="elements"'));
  assert.ok(offlineHtml.includes('value="memoriad"'));
  assert.ok(offlineHtml.includes('value="round"'));
  assert.ok(!offlineHtml.includes('disabled'), 'Offline mode should not disable any kind');
  assert.ok(!offlineHtml.includes('undefined'), 'Must not contain undefined in value or label');
  assert.ok(offlineHtml.includes('selected'), 'Current kind must be selected');

  // Test online mode: round option disabled with clear restriction label
  const onlineHtml = renderKindOptionsHtml('elements', true);
  assert.ok(onlineHtml.includes('value="round" selected="" disabled') || onlineHtml.includes('value="round"  disabled'));
  assert.ok(onlineHtml.includes('Round scores are available for offline tests only for now'));
  assert.ok(onlineHtml.includes('value="elements" selected'));
  assert.ok(!onlineHtml.includes('undefined'));
});

test('Production renderSectionFieldsHtml renders valid parameter controls for all five section types', () => {
  // 1. Basics section
  const basicsSec = { kind: 'basics', category_id: 'cat-b1', seconds: 60 };
  const basicsHtml = renderSectionFieldsHtml(basicsSec, 0, {
    isOnline: true,
    isLocked: false,
    basicsCats: mockBasicsCats
  });
  assert.ok(basicsHtml.includes('sec-basics-cat'));
  assert.ok(basicsHtml.includes('sec-basics-sec'));
  assert.ok(basicsHtml.includes('value="cat-b1" selected'));
  assert.ok(basicsHtml.includes('1D 4R'));
  assert.ok(basicsHtml.includes('value="60" selected'));
  assert.ok(!basicsHtml.includes('undefined'));

  // 2. Round section (offline)
  const roundSec = { kind: 'round', category_id: 'cat-r1' };
  const roundHtml = renderSectionFieldsHtml(roundSec, 1, {
    isOnline: false,
    isLocked: false,
    roundCats: mockRoundCats
  });
  assert.ok(roundHtml.includes('sec-round-cat'));
  assert.ok(roundHtml.includes('value="cat-r1" selected'));
  assert.ok(roundHtml.includes('ADD'));
  assert.ok(!roundHtml.includes('undefined'));

  // 3. Elements section
  const elementsSec = { kind: 'elements', activity_key: 'day_codes' };
  const elementsHtml = renderSectionFieldsHtml(elementsSec, 2, {
    isOnline: true,
    isLocked: false,
    enabledDrills
  });
  assert.ok(elementsHtml.includes('sec-elements-key'));
  assert.ok(elementsHtml.includes('value="day_codes" selected'));
  assert.ok(elementsHtml.includes('Day Codes'));
  assert.ok(!elementsHtml.includes('undefined'));

  // 4. Memoriad section
  const memoriadSec = { kind: 'memoriad', activity_key: 'additions' };
  const memoriadHtml = renderSectionFieldsHtml(memoriadSec, 3, {
    isOnline: true,
    isLocked: false
  });
  assert.ok(memoriadHtml.includes('sec-memoriad-key'));
  assert.ok(memoriadHtml.includes('value="additions" selected'));
  assert.ok(memoriadHtml.includes('Mental Additions'));
  assert.ok(!memoriadHtml.includes('undefined'));

  // 5. Flash Anzan section
  const flashSec = {
    kind: 'flash',
    flash_digits: 2,
    flash_count: 30,
    flash_speed_ms: 600,
    flash_mode: 'add_sub',
    question_count: 5
  };
  const flashHtml = renderSectionFieldsHtml(flashSec, 4, {
    isOnline: true,
    isLocked: false
  });
  assert.ok(flashHtml.includes('sec-flash-digits'));
  assert.ok(flashHtml.includes('value="2"'));
  assert.ok(flashHtml.includes('sec-flash-count'));
  assert.ok(flashHtml.includes('value="30"'));
  assert.ok(flashHtml.includes('sec-flash-speed'));
  assert.ok(flashHtml.includes('value="0.6"'));
  assert.ok(flashHtml.includes('sec-flash-mode'));
  assert.ok(flashHtml.includes('value="add_sub" selected'));
  assert.ok(flashHtml.includes('Add &amp; Subtract') || flashHtml.includes('Add & Subtract'));
  assert.ok(flashHtml.includes('sec-flash-tries'));
  assert.ok(flashHtml.includes('value="5"'));
  assert.ok(!flashHtml.includes('undefined'));

  // Locked section controls have disabled attribute
  const lockedHtml = renderSectionFieldsHtml(basicsSec, 0, {
    isOnline: true,
    isLocked: true,
    basicsCats: mockBasicsCats
  });
  assert.ok(lockedHtml.includes('disabled'));
});

test('Valid Save reaches persistence and saves test and normalized sections atomically', async () => {
  let rpcCall = null;
  const mockSupabase = {
    rpc(fnName, params) {
      rpcCall = { fnName, params };
      return Promise.resolve({
        data: { ok: true, test_id: params.p_test_id || 'new-atomic-test-uuid' },
        error: null
      });
    }
  };

  const existingSections = [
    { id: 'sec-1', test_id: 'test-100', position: 1, kind: 'basics', category_id: 'cat-b1', seconds: 60 },
    { id: 'sec-2', test_id: 'test-100', position: 2, kind: 'flash', flash_digits: 1, flash_count: 10, flash_speed_ms: 1000, flash_mode: 'add', question_count: 1 }
  ];

  const updatedDraft = [
    { id: 'sec-1', kind: 'basics', category_id: 'cat-b1', seconds: 120 }, // updated duration
    { kind: 'elements', activity_key: 'day_codes' } // new section (sec-2 removed)
  ];

  const normalizedRows = toRows(updatedDraft, 'test-100');

  const testPayload = {
    title: 'Week 45 Updated Test',
    test_date: '2026-11-08',
    test_type: 'online'
  };

  // 1. Edit existing test
  const resEdit = await executeSaveWeeklyTest({
    supabase: mockSupabase,
    isConfigured: true,
    idVal: 'test-100',
    testPayload,
    normalizedSectionRows: normalizedRows,
    existingSections,
    lockedSectionIds: new Set()
  });

  assert.equal(resEdit.ok, true);
  assert.equal(resEdit.savedTestId, 'test-100');
  assert.equal(resEdit.isNew, false);
  assert.equal(rpcCall.fnName, 'save_weekly_test_sections_atomic');
  assert.equal(rpcCall.params.p_test_id, 'test-100');
  assert.deepEqual(rpcCall.params.p_test, testPayload);
  assert.equal(rpcCall.params.p_sections.length, 2);

  // 2. Create new test
  rpcCall = null;
  const resCreate = await executeSaveWeeklyTest({
    supabase: mockSupabase,
    isConfigured: true,
    idVal: null,
    testPayload,
    normalizedSectionRows: normalizedRows,
    existingSections: [],
    lockedSectionIds: new Set()
  });

  assert.equal(resCreate.ok, true);
  assert.equal(resCreate.savedTestId, 'new-atomic-test-uuid');
  assert.equal(resCreate.isNew, true);
  assert.equal(rpcCall.fnName, 'save_weekly_test_sections_atomic');
  assert.equal(rpcCall.params.p_test_id, null);
  assert.deepEqual(rpcCall.params.p_test, testPayload);
});

test('Section validation rejects invalid saves with meaningful error and prevents persistence', () => {
  // Missing category on basics
  const badBasics = [{ kind: 'basics', category_id: '', seconds: 60 }];
  const val1 = validateSections(badBasics, 'online', allMockCats);
  assert.equal(val1.valid, false);
  assert.match(val1.error, /Please select a Basics category/);

  // Online test with round category
  const onlineRound = [{ kind: 'round', category_id: 'cat-r1' }];
  const val2 = validateSections(onlineRound, 'online', allMockCats);
  assert.equal(val2.valid, false);
  assert.match(val2.error, /Round scores are available for offline tests only/);

  // Flash with invalid speed
  const badFlash = [{ kind: 'flash', flash_digits: 2, flash_count: 20, flash_speed_seconds: 6.0, flash_mode: 'add', question_count: 5 }];
  const val3 = validateSections(badFlash, 'online', allMockCats);
  assert.equal(val3.valid, false);
  assert.match(val3.error, /Speed must be between 0.2 s and 5.0 s/);
});

test('Failure demonstration: atomic path rejects missing RPC with MIGRATION_REQUIRED error without partial writes', async () => {
  const existingSections = [
    { id: 's-locked', test_id: 'test-200', position: 1, kind: 'basics', category_id: 'cat-b1', seconds: 60 },
    { id: 's-unlocked', test_id: 'test-200', position: 2, kind: 'elements', activity_key: 'day_codes' }
  ];

  // Case 1: PostgREST missing function PGRST202
  const mockPgrst202 = {
    rpc() {
      return Promise.resolve({
        data: null,
        error: {
          code: 'PGRST202',
          message: 'Could not find the function public.save_weekly_test_sections_atomic in schema cache'
        }
      });
    }
  };

  await assert.rejects(
    async () => {
      await executeSaveWeeklyTest({
        supabase: mockPgrst202,
        isConfigured: true,
        idVal: 'test-200',
        testPayload: { title: 'Update Without Migration' },
        normalizedSectionRows: toRows(existingSections, 'test-200'),
        existingSections,
        lockedSectionIds: new Set()
      });
    },
    (err) => {
      assert.equal(err.code, 'MIGRATION_REQUIRED');
      assert.ok(err.message.includes('13_phase16c_atomic_weekly_test_sections.sql'));
      return true;
    },
    'Missing RPC must throw MIGRATION_REQUIRED and not attempt partial REST fallback'
  );

  // Case 2: Postgres missing function 42883 on creation
  const mockPg42883 = {
    rpc() {
      return Promise.resolve({
        data: null,
        error: {
          code: '42883',
          message: 'function public.save_weekly_test_sections_atomic does not exist'
        }
      });
    }
  };

  await assert.rejects(
    async () => {
      await executeSaveWeeklyTest({
        supabase: mockPg42883,
        isConfigured: true,
        idVal: null,
        testPayload: { title: 'New Test Without Migration' },
        normalizedSectionRows: toRows(existingSections, 'test-new'),
        existingSections: [],
        lockedSectionIds: new Set()
      });
    },
    (err) => {
      assert.equal(err.code, 'MIGRATION_REQUIRED');
      return true;
    }
  );

  // Case 3: In-place utility preserves locked sections from deletion
  let deletedIds = [];
  const mockSupabaseCheckLock = {
    from() {
      return {
        update() { return { eq: () => Promise.resolve({ error: null }) }; },
        delete() {
          return {
            in(col, vals) {
              deletedIds = vals;
              return Promise.resolve({ error: null });
            }
          };
        },
        insert() { return Promise.resolve({ error: null }); }
      };
    }
  };

  const lockedIds = new Set(['s-locked']);
  await saveTestSectionsInPlace(mockSupabaseCheckLock, 'test-200', [], existingSections, lockedIds);
  assert.ok(!deletedIds.includes('s-locked'), 'Locked section must NEVER be deleted in fallback helper');
  assert.ok(deletedIds.includes('s-unlocked'), 'Unlocked removed section must be deleted');
});
