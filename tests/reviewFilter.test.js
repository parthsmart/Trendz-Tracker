/**
 * Unit Tests for Admin Review Filter & PostgREST Inner Join Safety (tests/reviewFilter.test.js)
 *
 * Verifies that:
 * 1. Filtering by section ('basics', 'round') enforces !inner join on category so parent rows are filtered at DB level.
 * 2. 'all' section preserves left join without !inner so uncategorized entries remain visible.
 * 3. In-memory / DemoDB filtering correctly excludes Main Round entries when Basics is selected,
 *    and excludes Basics when Main Round is selected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) || null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

import {
  buildReviewCategoryEmbed,
  buildReviewSelectColumns,
} from '../js/review.js';
import { DemoDB } from '../js/demoDb.js';

test('buildReviewCategoryEmbed adds !inner when section is basics or round', () => {
  const basicsEmbed = buildReviewCategoryEmbed('basics');
  assert.equal(
    basicsEmbed,
    'category:categories!results_category_id_fkey!inner(id, name, section, sort_order)',
    'Expected !inner on category relation when filtering by basics section'
  );

  const roundEmbed = buildReviewCategoryEmbed('round');
  assert.equal(
    roundEmbed,
    'category:categories!results_category_id_fkey!inner(id, name, section, sort_order)',
    'Expected !inner on category relation when filtering by round section'
  );
});

test('buildReviewCategoryEmbed preserves standard left join (no !inner) when section is all or omitted', () => {
  const allEmbed = buildReviewCategoryEmbed('all');
  assert.equal(
    allEmbed,
    'category:categories!results_category_id_fkey(id, name, section, sort_order)',
    'Expected left join (no !inner) when section is all'
  );

  const emptyEmbed = buildReviewCategoryEmbed('');
  assert.equal(
    emptyEmbed,
    'category:categories!results_category_id_fkey(id, name, section, sort_order)',
    'Expected left join (no !inner) when section is empty string'
  );

  const nullEmbed = buildReviewCategoryEmbed(null);
  assert.equal(
    nullEmbed,
    'category:categories!results_category_id_fkey(id, name, section, sort_order)',
    'Expected left join (no !inner) when section is null'
  );
});

test('buildReviewSelectColumns embeds target fields and category relation properly', () => {
  const basicsCols = buildReviewSelectColumns({ section: 'basics', includeTargetFields: true });
  assert.ok(basicsCols.includes('min_accuracy'), 'Should include target columns when requested');
  assert.ok(basicsCols.includes('category:categories!results_category_id_fkey!inner'), 'Should enforce !inner for basics');

  const allColsFallback = buildReviewSelectColumns({ section: 'all', includeTargetFields: false });
  assert.ok(!allColsFallback.includes('min_accuracy'), 'Should omit target columns when includeTargetFields is false');
  assert.ok(!allColsFallback.includes('!inner'), 'Should not have !inner when section is all');
});

test('DemoDB.getReviewEntries excludes Main Round when filtering by basics, and excludes Basics when filtering by round', () => {
  // 1. Filter by section = 'basics'
  const basicsRes = DemoDB.getReviewEntries({
    section: 'basics',
    status: 'all',
  });
  assert.ok(basicsRes.entries.length > 0, 'Expected some basics review entries in DemoDB');
  basicsRes.entries.forEach((e) => {
    assert.equal(e.category.section, 'basics', `Expected only basics entries, found: ${e.category.section}`);
  });

  // 2. Filter by section = 'round'
  const roundRes = DemoDB.getReviewEntries({
    section: 'round',
    status: 'all',
  });
  if (roundRes.entries.length > 0) {
    roundRes.entries.forEach((e) => {
      assert.equal(e.category.section, 'round', `Expected only round entries, found: ${e.category.section}`);
    });
  }

  // 3. Filter by section = 'all'
  const allRes = DemoDB.getReviewEntries({
    section: 'all',
    status: 'all',
  });
  assert.ok(allRes.entries.length >= basicsRes.entries.length, 'All section count must be >= basics count');
});
