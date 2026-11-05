/**
 * Unit Tests for Practice Score History Filtering, Sorting, and Pagination
 * (tests/historyFilters.test.js)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  toISTDateString,
  resolveEntrySource,
  renderSourceChipHtml,
  computeAccuracyPct,
  filterAndSortHistory,
  paginateHistory,
  fetchAllRowsBatched,
} from '../js/historyFilters.js';

test('toISTDateString correctly converts UTC timestamps to Indian Standard Time (UTC+5:30)', () => {
  // 2026-11-04 20:00:00 UTC is 2026-11-05 01:30:00 IST
  const lateUtc = '2026-11-04T20:00:00Z';
  assert.equal(toISTDateString(lateUtc), '2026-11-05');

  // Direct YYYY-MM-DD string is preserved as-is
  assert.equal(toISTDateString('2026-11-04'), '2026-11-04');

  // Empty or invalid inputs
  assert.equal(toISTDateString(null), '');
  assert.equal(toISTDateString(''), '');
  assert.equal(toISTDateString('invalid-date'), '');
});

test('resolveEntrySource classifies source strictly by explicit value or verified session UUID', () => {
  // 1. Explicit source
  assert.equal(resolveEntrySource({ id: 'r1', source: 'typed' }, 'basics'), 'typed');
  assert.equal(resolveEntrySource({ id: 'r2', source: 'site' }, 'basics'), 'site');
  assert.equal(resolveEntrySource({ id: 'r3', source: 'online' }, 'basics'), 'site');

  // 2. Verified session UUID in settings or top-level session_id
  const validUUID = 'c6a7e0e8-3e4b-4b2a-8c5e-0c1d2e3f4a5b';
  assert.equal(
    resolveEntrySource({ id: 'f1', settings: { session_id: validUUID } }, 'flash'),
    'site'
  );
  assert.equal(
    resolveEntrySource({ id: 'e1', session_id: validUUID }, 'elements'),
    'site'
  );

  // 3. Ambiguous records without explicit source or verified session UUID -> 'legacy' across all four sections
  assert.equal(resolveEntrySource({ id: 'b_legacy', source: null }, 'basics'), 'legacy');
  assert.equal(resolveEntrySource({ id: 'b_empty', source: '' }, 'basics'), 'legacy');

  // Interactive drill with activity_type and settings but NO verified session UUID must NOT be guessed as site-recorded
  const ambiguousFlash = {
    id: 'f_ambiguous',
    activity_type: 'flash_anzan',
    settings: { digits: 2, count: 5 },
  };
  assert.equal(resolveEntrySource(ambiguousFlash, 'flash'), 'legacy');

  // Arbitrary non-UUID session_id must NOT qualify as verified
  const invalidSessionFlash = {
    id: 'f_invalid_session',
    session_id: 'session-xyz-123',
  };
  assert.equal(resolveEntrySource(invalidSessionFlash, 'flash'), 'legacy');
});

test('renderSourceChipHtml renders accurate badges for site, typed, and legacy', () => {
  const siteChip = renderSourceChipHtml('site');
  assert.match(siteChip, /chip-verified/);
  assert.match(siteChip, /Recorded by site/);

  const typedChip = renderSourceChipHtml('typed');
  assert.match(typedChip, /chip-unverified/);
  assert.match(typedChip, /Typed/);

  const legacyChip = renderSourceChipHtml('legacy');
  assert.match(legacyChip, /Legacy \/ Unspecified/);
});

test('fetchAllRowsBatched handles multi-page retrieval across configured limits', async () => {
  // Case A: 40 records with batchSize 15 (15, 15, 10, 0 -> terminates on empty batch when no count metadata)
  const totalRecordsA = 40;
  const mockDatabaseA = Array.from({ length: totalRecordsA }, (_, i) => ({
    id: `item-${i + 1}`,
    val: i + 1,
  }));

  const fetchCallsA = [];
  const fetchPageFnA = async (from, to) => {
    fetchCallsA.push({ from, to });
    return mockDatabaseA.slice(from, to + 1);
  };

  const resultsA = await fetchAllRowsBatched(fetchPageFnA, { batchSize: 15 });
  assert.equal(resultsA.length, 40);
  assert.equal(resultsA[0].id, 'item-1');
  assert.equal(resultsA[39].id, 'item-40');
  assert.deepEqual(fetchCallsA, [
    { from: 0, to: 14 },
    { from: 15, to: 29 },
    { from: 30, to: 44 },
    { from: 40, to: 54 }, // returns 0 items, confirming completion
  ]);

  // Case B: Exactly 45 records (15, 15, 15, 0 -> terminates when empty batch returned)
  const mockDatabaseB = Array.from({ length: 45 }, (_, i) => ({ id: `b-${i}` }));
  const fetchCallsB = [];
  const resultsB = await fetchAllRowsBatched(async (from, to) => {
    fetchCallsB.push({ from, to });
    return mockDatabaseB.slice(from, to + 1);
  }, { batchSize: 15 });

  assert.equal(resultsB.length, 45);
  assert.equal(fetchCallsB.length, 4);

  // Case C: Server returns { data, count } metadata -> terminates as soon as allRows.length >= totalCount
  const mockDatabaseC = Array.from({ length: 40 }, (_, i) => ({ id: `c-${i}` }));
  const fetchCallsC = [];
  const resultsC = await fetchAllRowsBatched(async (from, to) => {
    fetchCallsC.push({ from, to });
    return {
      data: mockDatabaseC.slice(from, to + 1),
      count: 40,
    };
  }, { batchSize: 15 });

  assert.equal(resultsC.length, 40);
  assert.deepEqual(fetchCallsC, [
    { from: 0, to: 14 },
    { from: 15, to: 29 },
    { from: 30, to: 44 }, // count: 40 reached, stops immediately without extra empty call
  ]);
});

test('fetchAllRowsBatched handles server response limit smaller than requested batch size', async () => {
  // Reproduction: 250 available records, batchSize requested is 1000,
  // but server enforces a lower response limit of 100 records per call.
  const totalRecords = 250;
  const SERVER_PAGE_CAP = 100;
  const mockDb = Array.from({ length: totalRecords }, (_, i) => ({ id: `rec-${i + 1}` }));

  const calls = [];
  const fetchFn = async (from, to) => {
    calls.push({ from, to });
    // Server honors the range query up to its internal cap
    const requestedSlice = mockDb.slice(from, to + 1);
    const cappedSlice = requestedSlice.slice(0, SERVER_PAGE_CAP);
    return cappedSlice;
  };

  const results = await fetchAllRowsBatched(fetchFn, { batchSize: 1000 });

  assert.equal(results.length, 250);
  assert.equal(results[0].id, 'rec-1');
  assert.equal(results[249].id, 'rec-250');

  // Verify that fetch advances by the actual number of rows received (100, 100, 50, then 0 to confirm end)
  assert.deepEqual(calls, [
    { from: 0, to: 999 },      // returns 100 items (0..99)
    { from: 100, to: 1099 },   // returns 100 items (100..199)
    { from: 200, to: 1199 },   // returns 50 items (200..249)
    { from: 250, to: 1249 },   // returns 0 items -> server confirms completion
  ]);
});

test('fetchAllRowsBatched throws an error and never silently truncates when safety maxRows is exceeded', async () => {
  // Infinite generator that never returns an empty batch
  const infiniteFetcher = async (from, to) => {
    return Array.from({ length: to - from + 1 }, (_, i) => ({ id: `row-${from + i}` }));
  };

  await assert.rejects(
    async () => {
      await fetchAllRowsBatched(infiniteFetcher, { batchSize: 50, maxRows: 150 });
    },
    (err) => {
      assert.match(err.message, /History retrieval reached safety limit of 150 rows/);
      assert.match(err.message, /Incomplete history cannot be returned/);
      return true;
    }
  );
});

test('computeAccuracyPct handles zero totals safely and computes accurate percentages', () => {
  assert.equal(computeAccuracyPct(0, 0), 0);
  assert.equal(computeAccuracyPct(5, 0), 0);
  assert.equal(computeAccuracyPct(0, 10), 0);
  assert.equal(computeAccuracyPct(10, 10), 100);
  assert.equal(computeAccuracyPct(7, 10), 70);
  assert.equal(computeAccuracyPct(1, 3), (1 / 3) * 100);
});

test('filterAndSortHistory filters by IST date range inclusively', () => {
  const rows = [
    { id: '1', entry_date: '2026-11-01', correct: 10, total: 10 },
    { id: '2', entry_date: '2026-11-03', correct: 8, total: 10 },
    { id: '3', entry_date: '2026-11-05', correct: 9, total: 10 },
    { id: '4', entry_date: '2026-11-07', correct: 10, total: 10 },
  ];

  const filtered = filterAndSortHistory(rows, {
    dateFrom: '2026-11-03',
    dateTo: '2026-11-05',
  }, { sectionKind: 'basics' });

  assert.equal(filtered.length, 2);
  assert.deepEqual(filtered.map((r) => r.id), ['3', '2']); // newest first by default
});

test('filterAndSortHistory filters Basics by category and Flash Anzan by digits', () => {
  const basicsRows = [
    { id: 'b1', category_id: 'cat-1', correct: 10, total: 10 },
    { id: 'b2', category_id: 'cat-2', correct: 9, total: 10 },
  ];
  const filteredBasics = filterAndSortHistory(basicsRows, {
    category: 'cat-1',
  }, { sectionKind: 'basics' });
  assert.equal(filteredBasics.length, 1);
  assert.equal(filteredBasics[0].id, 'b1');

  const flashRows = [
    { id: 'f1', created_at: '2026-11-05T12:00:00Z', settings: { digits: 1 }, correct: 1, total: 1 },
    { id: 'f2', created_at: '2026-11-05T11:00:00Z', settings: { digits: 3 }, correct: 1, total: 1 },
    { id: 'f3', created_at: '2026-11-05T10:00:00Z', settings: { digits: 1 }, correct: 0, total: 1 },
  ];
  const filteredFlash = filterAndSortHistory(flashRows, {
    category: '1',
  }, { sectionKind: 'flash' });
  assert.equal(filteredFlash.length, 2);
  assert.deepEqual(filteredFlash.map((r) => r.id), ['f1', 'f3']);
});

test('filterAndSortHistory deterministic sorting: accuracy_desc and accuracy_asc with tie-breaking', () => {
  const rows = [
    { id: 'a', created_at: '2026-11-05T10:00:00Z', correct: 5, total: 10 }, // 50%
    { id: 'b', created_at: '2026-11-05T11:00:00Z', correct: 10, total: 10 }, // 100%
    { id: 'c', created_at: '2026-11-05T12:00:00Z', correct: 8, total: 10 }, // 80%
    { id: 'd', created_at: '2026-11-05T09:00:00Z', correct: 10, total: 10 }, // 100% (older than b)
  ];

  const highestAcc = filterAndSortHistory(rows, { sort: 'accuracy_desc' }, { sectionKind: 'basics' });
  // 100% (b: 11:00, then d: 09:00), then 80% (c), then 50% (a)
  assert.deepEqual(highestAcc.map((r) => r.id), ['b', 'd', 'c', 'a']);

  const lowestAcc = filterAndSortHistory(rows, { sort: 'accuracy_asc' }, { sectionKind: 'basics' });
  // 50% (a), then 80% (c), then 100% (b, d)
  assert.deepEqual(lowestAcc.map((r) => r.id), ['a', 'c', 'b', 'd']);
});

test('paginateHistory returns proper slices and navigation metadata', () => {
  const items = Array.from({ length: 45 }, (_, i) => ({ id: `row-${i + 1}` }));

  // Page 1 of 20
  const p1 = paginateHistory(items, { page: 1, pageSize: 20 });
  assert.equal(p1.page, 1);
  assert.equal(p1.totalPages, 3);
  assert.equal(p1.totalCount, 45);
  assert.equal(p1.items.length, 20);
  assert.equal(p1.items[0].id, 'row-1');
  assert.equal(p1.items[19].id, 'row-20');

  // Page 3 of 20 (has remaining 5 items)
  const p3 = paginateHistory(items, { page: 3, pageSize: 20 });
  assert.equal(p3.page, 3);
  assert.equal(p3.items.length, 5);
  assert.equal(p3.items[4].id, 'row-45');

  // Clamping out-of-range page
  const pOver = paginateHistory(items, { page: 99, pageSize: 20 });
  assert.equal(pOver.page, 3);
});
