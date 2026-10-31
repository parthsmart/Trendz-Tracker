import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TABLE_DENSITY_STORAGE_KEY,
  getTableDensity,
  setTableDensity
} from '../js/tableDensity.js';

test('getTableDensity defaults to false (comfortable) when unset or storage throws', () => {
  const emptyStorage = { getItem: () => null };
  assert.equal(getTableDensity(emptyStorage), false);

  const throwingStorage = {
    getItem: () => {
      throw new Error('QuotaExceeded / Private mode');
    }
  };
  assert.equal(getTableDensity(throwingStorage), false);
});

test('setTableDensity persists compact state inside try/catch and handles errors gracefully', () => {
  const store = new Map();
  const mockStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, val) => store.set(key, val)
  };

  assert.equal(setTableDensity(true, mockStorage), true);
  assert.equal(store.get(TABLE_DENSITY_STORAGE_KEY), '1');
  assert.equal(getTableDensity(mockStorage), true);

  assert.equal(setTableDensity(false, mockStorage), false);
  assert.equal(store.get(TABLE_DENSITY_STORAGE_KEY), '0');
  assert.equal(getTableDensity(mockStorage), false);

  const brokenStorage = {
    setItem: () => {
      throw new Error('Storage disabled');
    }
  };
  assert.equal(setTableDensity(true, brokenStorage), true);
});
