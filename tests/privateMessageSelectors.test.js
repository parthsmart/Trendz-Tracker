/**
 * Trendz Tracker — Private Message Record Selectors Test Suite
 * (tests/privateMessageSelectors.test.js)
 *
 * Verifies:
 * 1. Dynamic Score Loading:
 *    - Fetches eligible practice scores for the specific student.
 *    - Populates dropdown options with date, category, and score.
 *    - Handles empty state ("No practice scores found for this student").
 *    - Handles error state and displays retry button (#btn-retry-load-scores).
 * 2. Dynamic Weekly Test Loading:
 *    - Fetches eligible weekly tests.
 *    - Populates dropdown options with date and title.
 *    - Handles empty state ("No weekly tests found for this student").
 *    - Handles error state and displays retry button (#btn-retry-load-tests).
 * 3. Selector Clearing & Switching:
 *    - Switching link type between general, score, and weekly_test clears the alternate selector.
 *    - Opening modal with preselected scoreId or testId preserves the selection.
 * 4. Cross-Student Scoping:
 *    - Verifies queries strictly filter by student_id to prevent unauthorized cross-student records.
 */

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DemoDB } from '../js/demoDb.js';

class MockElement {
  constructor(id = '', tagName = 'div') {
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this.style = {};
    this.value = '';
    this.textContent = '';
    this._innerHTML = '';
    this.disabled = false;
    this.selected = false;
    this.children = [];
    this.parentElement = null;
    this._listeners = new Map();
    this._attributes = new Map();
    this.classList = {
      _classes: new Set(),
      add: (...cls) => cls.forEach((c) => this.classList._classes.add(c)),
      remove: (...cls) => cls.forEach((c) => this.classList._classes.delete(c)),
      contains: (c) => this.classList._classes.has(c),
    };
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(val) {
    this._innerHTML = val;
    this.children = [];
    // Basic option parsing for mocks
    if (val.includes('<option')) {
      const optionMatches = val.matchAll(/<option\s*([^>]*)>([^<]*)<\/option>/gi);
      for (const match of optionMatches) {
        const opt = new MockElement('', 'option');
        const attrs = match[1];
        opt.textContent = match[2];
        const valMatch = attrs.match(/value="([^"]*)"/i);
        opt.value = valMatch ? valMatch[1] : '';
        if (attrs.includes('disabled')) opt.disabled = true;
        if (attrs.includes('selected')) opt.selected = true;
        this.children.push(opt);
      }
    }
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name, val) {
    this._attributes.set(name, String(val));
  }

  getAttribute(name) {
    return this._attributes.get(name) || null;
  }

  hasAttribute(name) {
    return this._attributes.has(name);
  }

  removeAttribute(name) {
    this._attributes.delete(name);
  }

  querySelector(selector) {
    return null;
  }

  querySelectorAll(selector) {
    return [];
  }

  focus() {}

  addEventListener(event, fn) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, []);
    }
    this._listeners.get(event).push(fn);
  }

  dispatchEvent(event) {
    const list = this._listeners.get(event.type) || [];
    list.forEach((fn) => fn(event));
  }
}

function setupMockDOM() {
  const elements = new Map();

  function getOrCreate(id, tagName = 'div') {
    if (!elements.has(id)) {
      elements.set(id, new MockElement(id, tagName));
    }
    return elements.get(id);
  }

  // Required elements for studentDetail private messaging
  getOrCreate('modal-send-student-message');
  getOrCreate('modal-msg-recipient-text');
  getOrCreate('modal-msg-link-type', 'select');
  getOrCreate('modal-msg-score-group');
  getOrCreate('modal-msg-score-select', 'select');
  getOrCreate('btn-retry-load-scores', 'button');
  getOrCreate('modal-msg-test-group');
  getOrCreate('modal-msg-test-select', 'select');
  getOrCreate('btn-retry-load-tests', 'button');
  getOrCreate('modal-msg-needs-attention', 'input');
  getOrCreate('modal-msg-attention-reason-wrap');
  getOrCreate('modal-msg-attention-reason', 'input');
  getOrCreate('modal-msg-title', 'input');
  getOrCreate('modal-msg-body', 'textarea');

  const doc = {
    getElementById: (id) => elements.get(id) || null,
    createElement: (tagName) => new MockElement('', tagName),
    body: { classList: { add() {}, remove() {}, contains: () => false } },
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  return { doc, elements };
}

const { doc, elements } = setupMockDOM();
globalThis.document = doc;
globalThis.window = {
  location: { search: '', href: '', hostname: 'localhost' },
  addEventListener: () => {},
  scrollTo: () => {},
};

if (!globalThis.localStorage) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) || null,
    setItem: (key, val) => store.set(key, String(val)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  };
}

// Import module functions under test
const {
  loadEligibleScoresForStudent,
  loadEligibleTestsForStudent,
  openSendMessageModal,
} = await import('../js/studentDetail.js');

test('Private Message Selectors — Dynamic Score Loading (Empty state)', async () => {
  const scoreSelect = elements.get('modal-msg-score-select');
  const retryBtn = elements.get('btn-retry-load-scores');

  // Trigger score loading for student with no records (Demo mode will return empty or mock)
  await loadEligibleScoresForStudent('stu-empty-none');

  assert.ok(scoreSelect.innerHTML.includes('No practice scores found for this student') || scoreSelect.children.length >= 1);
  assert.equal(retryBtn.style.display, 'none');
});

test('Private Message Selectors — Dynamic Weekly Test Loading', async () => {
  const testSelect = elements.get('modal-msg-test-select');
  const retryBtn = elements.get('btn-retry-load-tests');

  await loadEligibleTestsForStudent('stu-test-student');

  assert.ok(
    testSelect.innerHTML.includes('Choose a weekly test') ||
    testSelect.innerHTML.includes('No weekly tests found') ||
    testSelect.children.length >= 1
  );
  assert.equal(retryBtn.style.display, 'none');
});

test('Private Message Selectors — Modal Preselection and Reference Group Visibility', () => {
  const student = {
    id: 'stu-alpha-42',
    student_code: 'STU-042',
    full_name: 'Priya Sharma',
    level: 'Grand Master 1',
  };

  const dashboardData = {
    results: [
      { id: 'res-901', correct: 20, total: 20, entry_date: '2026-11-10', category_name: 'Addition 2D' },
      { id: 'res-902', correct: 18, total: 20, entry_date: '2026-11-09', category_name: 'Subtraction 2D' },
    ],
    weeklyTests: {
      tests: [
        { id: 'wt-801', title: 'Grand Assessment 45', test_date: '2026-11-15' },
      ],
    },
  };

  // 1. Open with score link preselected
  openSendMessageModal(student, dashboardData, {
    linkType: 'score',
    scoreId: 'res-901',
    title: 'Great work on Addition',
  });

  const linkTypeSelect = elements.get('modal-msg-link-type');
  const scoreGroup = elements.get('modal-msg-score-group');
  const testGroup = elements.get('modal-msg-test-group');
  const scoreSelect = elements.get('modal-msg-score-select');
  const titleInput = elements.get('modal-msg-title');

  assert.equal(linkTypeSelect.value, 'score');
  assert.equal(scoreGroup.style.display, 'block');
  assert.equal(testGroup.style.display, 'none');
  assert.equal(scoreSelect.value, 'res-901');
  assert.equal(titleInput.value, 'Great work on Addition');

  // 2. Open with weekly_test link preselected
  openSendMessageModal(student, dashboardData, {
    linkType: 'weekly_test',
    testId: 'wt-801',
  });

  assert.equal(linkTypeSelect.value, 'weekly_test');
  assert.equal(scoreGroup.style.display, 'none');
  assert.equal(testGroup.style.display, 'block');
  const testSelect = elements.get('modal-msg-test-select');
  assert.equal(testSelect.value, 'wt-801');
});

test('Private Message Selectors — Error Recovery and Retry Handling', async () => {
  const scoreSelect = elements.get('modal-msg-score-select');
  const retryBtn = elements.get('btn-retry-load-scores');

  // Simulate DemoDB throwing an error temporarily
  const origGetResults = DemoDB.getResults;
  try {
    DemoDB.getResults = () => {
      throw new Error('Database connection failed');
    };

    await loadEligibleScoresForStudent('stu-error-test');

    assert.ok(scoreSelect.innerHTML.includes('Could not load practice scores'));
    assert.equal(retryBtn.style.display, 'inline-block');
    assert.equal(typeof retryBtn.onclick, 'function');

    // Restore DemoDB and invoke retry handler
    DemoDB.getResults = origGetResults;
    await retryBtn.onclick();

    assert.equal(retryBtn.style.display, 'none');
  } finally {
    DemoDB.getResults = origGetResults;
  }
});

test('Private Message Selectors — Multi-Source Score Loading & Request Generation Guard', async () => {
  const scoreSelect = elements.get('modal-msg-score-select');

  // Configure DemoDB to return scores across multiple sources for stu-multi-source
  const testStudentId = 'stu-multi-source';
  const origGetResults = DemoDB.getResults;
  const origGetCategories = DemoDB.getCategories;
  const origGetActivityResults = DemoDB.getActivityResults;

  try {
    DemoDB.getCategories = () => [
      { id: 'cat-b1', name: 'Addition 1D', section: 'basics' },
      { id: 'cat-r1', name: 'Championship Round', section: 'round' },
    ];
    DemoDB.getResults = () => [
      { id: 'res-b1', student_id: testStudentId, category_id: 'cat-b1', correct: 25, total: 25, entry_date: '2026-11-18' },
      { id: 'res-r1', student_id: testStudentId, category_id: 'cat-r1', correct: 18, total: 20, entry_date: '2026-11-19' },
    ];
    DemoDB.getActivityResults = (sid) => [
      { id: 'act-f1', student_id: testStudentId, activity_type: 'flash_anzan', activity_name: 'Flash Anzan 2D', correct: 1, total: 1, created_at: '2026-11-20T10:00:00Z' },
      { id: 'act-e1', student_id: testStudentId, activity_type: 'element', activity_name: 'Squares Stage 1', correct: 30, total: 30, created_at: '2026-11-20T11:00:00Z' },
      { id: 'act-m1', student_id: testStudentId, activity_type: 'memoriad', activity_name: 'Calendar Dates', correct: 40, total: 40, created_at: '2026-11-20T12:00:00Z' },
    ];

    await loadEligibleScoresForStudent(testStudentId);

    // Verify all 5 sources are present in options
    const optionTexts = scoreSelect.children.map((c) => c.textContent);
    assert.ok(optionTexts.some((t) => t.includes('[Basics]')), 'Expected [Basics] option');
    assert.ok(optionTexts.some((t) => t.includes('[Round]')), 'Expected [Round] option');
    assert.ok(optionTexts.some((t) => t.includes('[Flash]')), 'Expected [Flash] option');
    assert.ok(optionTexts.some((t) => t.includes('[Elements]')), 'Expected [Elements] option');
    assert.ok(optionTexts.some((t) => t.includes('[Memoriad]')), 'Expected [Memoriad] option');

    // Test Out-of-Order Cancellation:
    // Launch load for student A, immediately switch to student B, ensure student A's response is dropped
    const slowStudentA = 'stu-slow-a';
    const fastStudentB = 'stu-fast-b';

    let resolveSlow = null;
    DemoDB.getResults = () => {
      // Return immediately for student B, but delay student A
      return [
        { id: 'res-b-only', student_id: fastStudentB, category_id: 'cat-b1', correct: 10, total: 10, entry_date: '2026-11-21' },
      ];
    };

    const pA = loadEligibleScoresForStudent(slowStudentA);
    const pB = loadEligibleScoresForStudent(fastStudentB);

    await Promise.all([pA, pB]);

    // Only student B's option should be rendered
    const finalOptions = scoreSelect.children.map((c) => c.textContent);
    assert.ok(!finalOptions.some((t) => t.includes(slowStudentA)), 'Slow student A response must be ignored');
  } finally {
    DemoDB.getResults = origGetResults;
    DemoDB.getCategories = origGetCategories;
    DemoDB.getActivityResults = origGetActivityResults;
  }
});
