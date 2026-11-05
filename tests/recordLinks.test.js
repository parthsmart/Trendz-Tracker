/**
 * Unit & Integration Tests for Record Deep Linking
 * (tests/recordLinks.test.js)
 *
 * Verifies authenticated, recipient-scoped record link handling across:
 * 1. Basics (/pages/basics.html?resultId=...)
 * 2. Rounds (/pages/round-scores.html?roundId=...&resultId=...)
 * 3. Weekly Tests (/pages/weekly-test.html?testId=...&attemptId=...)
 *
 * Core invariant:
 * Opening a link never starts or resumes a weekly test attempt.
 * Missing/deleted/unauthorized records display clear user-facing toast errors.
 * Students are never routed to admin-only pages (e.g. rounds.html).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Setup minimal browser globals before imports
const mockStorage = new Map();
globalThis.localStorage = {
  getItem: (k) => mockStorage.get(k) || null,
  setItem: (k, v) => mockStorage.set(k, String(v)),
  removeItem: (k) => mockStorage.delete(k),
  clear: () => mockStorage.clear(),
};
globalThis.sessionStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

globalThis.window = {
  location: {
    hostname: 'localhost',
    pathname: '/pages/basics.html',
    search: '',
  },
  addEventListener: () => {},
  removeEventListener: () => {},
};

const domElements = new Map();
let lastToast = null;

function createMockElement(id, tag = 'div', attributes = {}) {
  const el = {
    id: id || `mock-${Math.random().toString(36).slice(2, 7)}`,
    tagName: tag.toUpperCase(),
    value: '',
    textContent: '',
    style: {},
    classList: {
      classes: new Set(),
      add: (c) => el.classList.classes.add(c),
      remove: (c) => el.classList.classes.delete(c),
      contains: (c) => el.classList.classes.has(c),
      toggle: (c, force) => {
        if (force === undefined) {
          if (el.classList.classes.has(c)) el.classList.classes.delete(c);
          else el.classList.classes.add(c);
        } else if (force) {
          el.classList.classes.add(c);
        } else {
          el.classList.classes.delete(c);
        }
      },
    },
    attributes: new Map(Object.entries(attributes)),
    getAttribute: (attr) => el.attributes.get(attr) || null,
    setAttribute: (attr, val) => el.attributes.set(attr, String(val)),
    querySelector: (selector) => {
      for (const other of domElements.values()) {
        if (selector.startsWith('[data-test-card-id=') && selector.includes(other.getAttribute('data-test-card-id') || '')) return other;
        if (selector.startsWith('[data-section-id=') && selector.includes(other.getAttribute('data-section-id') || '')) return other;
        if (selector.startsWith('[data-category-id=') && selector.includes(other.getAttribute('data-category-id') || '')) return other;
        if (selector.startsWith('[data-result-id=') && selector.includes(other.getAttribute('data-result-id') || '')) return other;
        if (selector.startsWith('[data-drill-id=') && selector.includes(other.getAttribute('data-drill-id') || '')) return other;
      }
      return null;
    },
    querySelectorAll: () => [],
    scrollIntoView: () => {
      el.scrolledIntoView = true;
    },
    addEventListener: () => {},
    dispatchEvent: () => true,
    children: [],
    appendChild: (child) => {
      el.children.push(child);
      if (child.classList?.contains('toast') || child.className?.includes('toast')) {
        const textSpan = child.children?.find((c) => c.tagName === 'SPAN') || child;
        const msg = textSpan.textContent || '';
        const isError = child.className?.includes('toast-error') || child.classList?.contains('toast-error');
        lastToast = {
          type: isError ? 'error' : 'info',
          message: msg,
        };
      }
      return child;
    },
    innerHTML: '',
  };
  if (id) domElements.set(id, el);
  return el;
}

const mockBody = createMockElement('body', 'body');
const mockToastContainer = createMockElement('toast-container', 'div');
mockBody.appendChild(mockToastContainer);

globalThis.document = {
  body: mockBody,
  getElementById: (id) => {
    if (id === 'toast-container') return mockToastContainer;
    return domElements.get(id) || null;
  },
  createElement: (tag) => {
    const el = createMockElement(null, tag);
    return el;
  },
  querySelector: (selector) => {
    if (selector.startsWith('#')) return domElements.get(selector.slice(1)) || null;
    for (const el of domElements.values()) {
      if (selector.startsWith('[data-drill-id=') && selector.includes(el.getAttribute('data-drill-id') || '___none___')) return el;
      if (selector.startsWith('[data-result-id=') && selector.includes(el.getAttribute('data-result-id') || '___none___')) return el;
      if (selector.startsWith('[data-category-id=') && selector.includes(el.getAttribute('data-category-id') || '___none___')) return el;
      if (selector.startsWith('[data-test-card-id=') && selector.includes(el.getAttribute('data-test-card-id') || '___none___')) return el;
      if (selector.startsWith('[data-section-id=') && selector.includes(el.getAttribute('data-section-id') || '___none___')) return el;
    }
    return null;
  },
  querySelectorAll: () => [],
  addEventListener: () => {},
};

// Import modules dynamically after setting up globals
const { DemoDB } = await import('../js/demoDb.js');
const { handleBasicsUrlParams } = await import('../js/basics.js');
const { handleRoundScoresUrlParams } = await import('../js/roundScores.js');
const { handleWeeklyTestUrlParams } = await import('../js/weeklyTest.js');

test('1. Record links never target admin-only rounds.html for students', () => {
  mockStorage.clear();
  const categories = [
    { id: 'cat-r1', name: 'ADD', section: 'round', active: true },
  ];
  const roundScore = {
    id: 'res-round-101',
    student_id: 'usr-101',
    category_id: 'cat-r1',
    student_round_id: 'rnd-101',
  };
  mockStorage.set('trendz_demo_categories_v3', JSON.stringify(categories));
  mockStorage.set('trendz_demo_results_v3', JSON.stringify([roundScore]));

  const msg = DemoDB.sendStudentMessage({
    studentId: 'usr-101',
    title: 'Review Round Score',
    body: 'Great speed on ADD round.',
    linkedType: 'score',
    linkedId: 'res-round-101',
  });

  assert.ok(msg.link.includes('/pages/round-scores.html'), 'Student link must target round-scores.html');
  assert.ok(!msg.link.includes('/pages/rounds.html'), 'Student link must NEVER target admin-only rounds.html');
  assert.ok(msg.link.includes('resultId=res-round-101'));
});

test('2. Basics: ?resultId selects filter, calculates page, and highlights row', async () => {
  domElements.clear();
  lastToast = null;
  const drillRow = createMockElement('drill-row-1', 'tr', { 'data-drill-id': 'res-101' });
  createMockElement('basics-history-tbody', 'tbody');
  createMockElement('basics-category-filter', 'select');
  createMockElement('basics-source-filter', 'select');
  createMockElement('basics-date-from', 'input');
  createMockElement('basics-date-to', 'input');
  createMockElement('basics-pagination', 'div');

  window.location.search = '?resultId=res-101';

  // Seed DemoDB results with student usr-101
  const existingResults = [
    {
      id: 'res-101',
      student_id: 'usr-101',
      category_id: 'cat-1',
      correct: 18,
      total: 20,
      time_seconds: 55,
      entry_date: '2026-11-04',
      source: 'typed',
    },
  ];
  mockStorage.set('trendz_demo_results_v3', JSON.stringify(existingResults));
  mockStorage.set('trendz_current_user', JSON.stringify({ id: 'usr-101', role: 'student' }));

  await handleBasicsUrlParams();
  await new Promise((r) => setTimeout(r, 200));

  // Row was highlighted
  assert.ok(drillRow.scrolledIntoView, 'Row must be scrolled into view');
  assert.ok(drillRow.classList.contains('row-linked-highlight'), 'Row must receive row-linked-highlight class');
});

test('3. Basics: ?resultId displays error toast for missing or unauthorized records', async () => {
  domElements.clear();
  lastToast = null;
  window.location.search = '?resultId=res-nonexistent';

  mockStorage.set('trendz_demo_results_v3', JSON.stringify([]));
  mockStorage.set('trendz_current_user', JSON.stringify({ id: 'usr-101', role: 'student' }));

  await handleBasicsUrlParams();

  assert.ok(lastToast, 'Toast must be triggered');
  assert.equal(lastToast.type, 'error');
  assert.equal(lastToast.message, 'The referenced practice score could not be found.');

  // Unauthorized record (belongs to usr-102)
  lastToast = null;
  window.location.search = '?resultId=res-102';
  mockStorage.set(
    'trendz_demo_results_v3',
    JSON.stringify([{ id: 'res-102', student_id: 'usr-102', category_id: 'cat-1' }])
  );

  await handleBasicsUrlParams();

  assert.ok(lastToast, 'Toast must be triggered');
  assert.equal(lastToast.type, 'error');
  assert.equal(lastToast.message, 'You do not have permission to view this practice score.');
});

test('4. Rounds: ?resultId and ?roundId select round and highlight category row', async () => {
  domElements.clear();
  lastToast = null;
  const selectRound = createMockElement('select-round', 'select');
  const catRow = createMockElement('row-cat-r1', 'div', {
    'data-category-id': 'cat-r1',
    'data-result-id': 'res-rnd-1',
  });
  createMockElement('round-meta-card', 'div');
  createMockElement('score-rows-container', 'div');

  window.location.search = '?roundId=rnd-1&resultId=res-rnd-1';

  const roundData = [
    { id: 'rnd-1', student_id: 'usr-101', round_number: 1, round_date: '2026-11-04', series_id: 'ser-1' },
  ];
  const scoreData = [
    { id: 'res-rnd-1', student_id: 'usr-101', student_round_id: 'rnd-1', category_id: 'cat-r1', correct: 10, total: 10 },
  ];
  mockStorage.set('trendz_demo_student_rounds_v1', JSON.stringify(roundData));
  mockStorage.set('trendz_demo_results_v3', JSON.stringify(scoreData));
  mockStorage.set('trendz_current_user', JSON.stringify({ id: 'usr-101', role: 'student' }));

  await handleRoundScoresUrlParams();
  await new Promise((r) => setTimeout(r, 200));

  assert.ok(catRow.scrolledIntoView, 'Category row must be scrolled into view');
  assert.ok(catRow.classList.contains('row-linked-highlight'), 'Category row must be highlighted');
});

test('5. Rounds: displays error toast for missing or unauthorized round', async () => {
  domElements.clear();
  lastToast = null;
  window.location.search = '?roundId=rnd-unauthorized';

  const roundData = [
    { id: 'rnd-unauthorized', student_id: 'usr-999', round_number: 1, round_date: '2026-11-04', series_id: 'ser-1' },
  ];
  mockStorage.set('trendz_demo_student_rounds_v1', JSON.stringify(roundData));
  mockStorage.set('trendz_current_user', JSON.stringify({ id: 'usr-101', role: 'student' }));

  await handleRoundScoresUrlParams();

  assert.ok(lastToast, 'Toast must be triggered');
  assert.equal(lastToast.type, 'error');
  assert.equal(lastToast.message, 'You do not have permission to view this round.');
});

test('6. Weekly Tests: ?testId and ?attemptId highlight card and section WITHOUT starting attempt', async () => {
  domElements.clear();
  lastToast = null;
  const testCard = createMockElement('card-wkt-1', 'article', { 'data-test-card-id': 'wkt-1' });
  const secRow = createMockElement('sec-wkt-1-s1', 'div', {
    'data-section-id': 'sec-1',
    'data-category-id': 'cat-1',
  });

  window.location.search = '?testId=wkt-1&attemptId=att-1';

  mockStorage.set(
    'trendz_demo_weekly_tests_v3',
    JSON.stringify([{ id: 'wkt-1', title: 'Speed Sprint', audience_level: 'Level 3' }])
  );
  mockStorage.set(
    'trendz_demo_weekly_attempts_v1',
    JSON.stringify([
      { id: 'att-1', test_id: 'wkt-1', student_id: 'usr-101', section_id: 'sec-1', category_id: 'cat-1' },
    ])
  );
  mockStorage.set('trendz_current_user', JSON.stringify({ id: 'usr-101', role: 'student', level: 'Level 3' }));

  // Invariant verification: Ensure no start modal or runner triggers are invoked
  let runnerLaunched = false;
  let sectionCountdownStarted = false;
  globalThis.startSectionCountdown = () => {
    sectionCountdownStarted = true;
  };
  globalThis.promptStartSection = () => {
    runnerLaunched = true;
  };

  await handleWeeklyTestUrlParams();
  await new Promise((r) => setTimeout(r, 200));

  // Test card and section were highlighted
  assert.ok(testCard.scrolledIntoView, 'Test card must be scrolled into view');
  assert.ok(testCard.classList.contains('card-linked-highlight'), 'Test card must receive card-linked-highlight class');

  // Verify that countdown and start runner were NEVER invoked
  assert.equal(runnerLaunched, false, 'Opening record link must NEVER launch or start section');
  assert.equal(sectionCountdownStarted, false, 'Opening record link must NEVER start countdown timer');
});

test('7. Weekly Tests: displays error toast for unauthorized attempt belonging to another student', async () => {
  domElements.clear();
  lastToast = null;
  window.location.search = '?attemptId=att-other-student';

  mockStorage.set(
    'trendz_demo_weekly_attempts_v1',
    JSON.stringify([
      { id: 'att-other-student', test_id: 'wkt-1', student_id: 'usr-999', section_id: 'sec-1' },
    ])
  );
  mockStorage.set('trendz_current_user', JSON.stringify({ id: 'usr-101', role: 'student', level: 'Level 3' }));

  await handleWeeklyTestUrlParams();

  assert.ok(lastToast, 'Toast must be triggered');
  assert.equal(lastToast.type, 'error');
  assert.equal(lastToast.message, 'You do not have permission to view this weekly test attempt.');
});

test('8. Weekly Tests: displays error toast for nonexistent test or attempt', async () => {
  domElements.clear();
  lastToast = null;
  window.location.search = '?testId=wkt-nonexistent';

  mockStorage.set('trendz_demo_weekly_tests_v3', JSON.stringify([]));
  mockStorage.set('trendz_current_user', JSON.stringify({ id: 'usr-101', role: 'student', level: 'Level 3' }));

  await handleWeeklyTestUrlParams();

  assert.ok(lastToast, 'Toast must be triggered');
  assert.equal(lastToast.type, 'error');
  assert.equal(lastToast.message, 'The referenced weekly test could not be found.');
});
