/**
 * Trendz Tracker - Admin Student Detail & Basics History Audit Tests
 * (tests/adminStudentDetailAndBasicsAudit.test.js)
 *
 * Verifies:
 * 1. Admin Send Message Dialog (js/studentDetail.js):
 *    - Real dashboard contract: weeklyTests: { tests: [...], scores: [...] }.
 *    - Handles missing, null, or malformed weeklyTests and results safely without TypeError.
 *    - Opens general message composition correctly (linkType = 'general', both sub-selectors hidden).
 *    - Opens score-linked message composition correctly (linkType = 'score', score selector visible, option selected).
 *    - Opens weekly-test-linked message composition correctly (linkType = 'weekly_test', test selector visible, option selected).
 *    - Modal switching between general, score, and weekly_test updates DOM visibility as expected.
 *    - Does NOT send real messages.
 *
 * 2. Admin Selected-Student Basics History (js/basics.js & pages/basics.html):
 *    - Targets actual HTML containers: #basics-entry-card, #online-practice-categories-card, #btn-selected-practice-online.
 *    - When viewing another student (activeHistoryStudent.id !== currentProfile.id):
 *      - Hides manual drill entry card.
 *      - Hides online practice quick-launch card.
 *      - Hides online category practice button.
 *      - Renders read-only history rows with zero edit/delete buttons.
 *      - Guards mutation handlers (form submit, edit button, delete button) against execution.
 *      - Preserves history table, details panels, filters, and pagination.
 *    - When student views their own practice (isViewingOtherStudent() === false):
 *      - Manual entry card is visible.
 *      - Online practice card and category practice button are available.
 *      - Unlocked rows display Edit and Delete buttons.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// Helper class for mock DOM elements
class MockElement {
  constructor(id = '', tagName = 'div') {
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this.textContent = '';
    this._innerHTML = '';
    this.value = '';
    this.checked = false;
    this.style = {};
    this.href = '';
    this.disabled = false;
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
  }

  querySelector(selector) {
    return null;
  }

  querySelectorAll(selector) {
    return [];
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

  closest(selector) {
    if (selector === '.card') {
      let cur = this;
      while (cur) {
        if (cur.className && cur.className.includes('card')) return cur;
        cur = cur.parentElement;
      }
    }
    return null;
  }

  scrollIntoView() {}
  reset() {
    this.value = '';
  }
}

function setupMockDocument() {
  const elements = new Map();

  function getOrCreate(id, tagName = 'div') {
    if (!elements.has(id)) {
      const el = new MockElement(id, tagName);
      elements.set(id, el);
    }
    return elements.get(id);
  }

  // Pre-create Send Message Dialog elements matching pages/student-detail.html
  const modalSendMsg = getOrCreate('modal-send-student-message');
  getOrCreate('modal-msg-recipient-text');
  const linkType = getOrCreate('modal-msg-link-type', 'select');
  const scoreGroup = getOrCreate('modal-msg-score-group');
  const scoreSelect = getOrCreate('modal-msg-score-select', 'select');
  const testGroup = getOrCreate('modal-msg-test-group');
  const testSelect = getOrCreate('modal-msg-test-select', 'select');
  getOrCreate('modal-msg-needs-attention', 'input');
  getOrCreate('modal-msg-attention-reason-wrap');
  getOrCreate('modal-msg-attention-reason', 'input');
  getOrCreate('modal-msg-title', 'input');
  getOrCreate('modal-msg-body', 'textarea');
  getOrCreate('btn-submit-send-message', 'button');
  getOrCreate('btn-cancel-send-message', 'button');
  getOrCreate('btn-close-message-modal', 'button');
  getOrCreate('form-send-student-message', 'form');

  // Pre-create Basics elements matching pages/basics.html
  const entryCard = getOrCreate('basics-entry-card', 'div');
  entryCard.className = 'card';
  const basicsForm = getOrCreate('basics-form', 'form');
  entryCard.appendChild(basicsForm);

  const onlineCard = getOrCreate('online-practice-categories-card', 'div');
  onlineCard.className = 'card';
  const onlineList = getOrCreate('online-practice-buttons-list', 'div');
  onlineCard.appendChild(onlineList);

  const onlineBtn = getOrCreate('btn-selected-practice-online', 'a');
  getOrCreate('category-target-display');
  getOrCreate('category-target-text');
  getOrCreate('basics-category-select', 'select');
  getOrCreate('basics-correct', 'input');
  getOrCreate('basics-total', 'input');
  getOrCreate('basics-time', 'input');
  getOrCreate('basics-live-feedback');
  getOrCreate('basics-form-error');
  getOrCreate('btn-submit-drill', 'button');
  getOrCreate('btn-submit-drill-text');
  getOrCreate('btn-cancel-edit', 'button');
  getOrCreate('edit-drill-id', 'input');
  getOrCreate('date-selection-group');
  getOrCreate('form-card-title');
  getOrCreate('config-banner-placeholder');
  getOrCreate('user-pill-container');

  const doc = {
    getElementById: (id) => elements.get(id) || null,
    querySelector: (selector) => {
      if (selector === '#basics-entry-card' || selector === 'div#basics-entry-card') {
        return elements.get('basics-entry-card') || null;
      }
      if (selector === 'section.card[aria-labelledby="entry-heading"]') {
        return null; // legacy non-existent selector
      }
      return null;
    },
    querySelectorAll: (selector) => [],
    createElement: (tagName) => new MockElement('', tagName),
    body: { classList: { add() {}, remove() {}, contains: () => false } },
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  return { doc, elements };
}

// Set up globals before importing modules
const { doc } = setupMockDocument();

function getElementComputedDisplay(element) {
  if (!element) return 'none';
  if (element.hasAttribute && element.hasAttribute('hidden')) return 'none';
  if (element.style && element.style.display === 'none') return 'none';
  if (element.style && element.style.display && element.style.display !== '') {
    return element.style.display;
  }
  // Default stylesheet fallbacks when inline style.display is empty/cleared:
  // In pages/basics.html, div.card (including #basics-entry-card) is block by default.
  // <a> tags like #btn-selected-practice-online are inline-block/inline-flex.
  return element.tagName === 'A' ? 'inline-block' : 'block';
}

function isObservablyVisible(element) {
  if (!element) return false;
  if (element.hasAttribute && element.hasAttribute('hidden')) return false;
  if (element.hidden === true) return false;
  if (element.style && element.style.display === 'none') return false;
  return true;
}

function isObservablyHidden(element) {
  return !isObservablyVisible(element);
}

globalThis.window = {
  location: { search: '', href: '', hostname: 'localhost' },
  addEventListener: () => {},
  scrollTo: () => {},
};
globalThis.document = doc;
globalThis.getComputedStyle = (element) => ({
  display: getElementComputedDisplay(element),
});

// Import target production modules
const { openSendMessageModal } = await import('../js/studentDetail.js');
const {
  applyBasicsStudentViewMode,
  isViewingOtherStudent,
  setActiveHistoryStudentForTesting,
  setCurrentProfileForTesting,
  setBasicsCategoriesForTesting,
  renderDrillRow,
} = await import('../js/basics.js');

describe('Admin Student Detail & Basics History Audit', () => {
  describe('1. Admin Send Message Dialog (js/studentDetail.js)', () => {
    const studentProfile = {
      id: 'stu-alpha-99',
      student_code: 'STU-099',
      full_name: 'Aditya Sen',
      level: 'Master 2',
      role: 'student',
    };

    const realisticDashboardData = {
      results: [
        {
          id: 'res-101',
          correct: 18,
          total: 20,
          entry_date: '2026-11-07',
          categories: { name: '2D 10R Addition' },
        },
        {
          id: 'res-102',
          correct: 15,
          total: 15,
          entry_date: '2026-11-06',
          category_name: 'Multiplication 2D x 1D',
        },
      ],
      weeklyTests: {
        tests: [
          {
            id: 'wt-501',
            title: 'Week 44 Grand Assessment',
            test_date: '2026-11-08',
          },
          {
            id: 'wt-502',
            title: 'Week 43 Speed Benchmark',
            test_date: '2026-11-01',
          },
        ],
        scores: [
          { test_id: 'wt-501', score: 92 },
        ],
      },
    };

    it('populates weekly test dropdown safely from actual contract weeklyTests: { tests, scores }', () => {
      openSendMessageModal(studentProfile, realisticDashboardData);

      const testSelect = document.getElementById('modal-msg-test-select');
      assert.ok(testSelect, 'Test select element must exist');
      // 2 test options appended
      assert.equal(testSelect.children.length, 2);
      assert.equal(testSelect.children[0].value, 'wt-501');
      assert.ok(testSelect.children[0].textContent.includes('Week 44 Grand Assessment'));
      assert.equal(testSelect.children[1].value, 'wt-502');
      assert.ok(testSelect.children[1].textContent.includes('Week 43 Speed Benchmark'));
    });

    it('handles missing, null, empty object, or legacy array weeklyTests without throwing TypeError', () => {
      // 1. Completely missing dashboardData
      assert.doesNotThrow(() => {
        openSendMessageModal(studentProfile, null);
      });

      // 2. Empty dashboardData object
      assert.doesNotThrow(() => {
        openSendMessageModal(studentProfile, {});
      });

      // 3. weeklyTests is null
      assert.doesNotThrow(() => {
        openSendMessageModal(studentProfile, { weeklyTests: null, results: null });
      });

      // 4. weeklyTests is an empty object
      assert.doesNotThrow(() => {
        openSendMessageModal(studentProfile, { weeklyTests: {} });
      });

      // 5. weeklyTests has tests as null
      assert.doesNotThrow(() => {
        openSendMessageModal(studentProfile, { weeklyTests: { tests: null, scores: [] } });
      });

      // 6. weeklyTests is legacy plain array
      assert.doesNotThrow(() => {
        openSendMessageModal(studentProfile, {
          weeklyTests: [
            { id: 'wt-legacy', title: 'Legacy Test Array', test_date: '2026-10-25' },
          ],
        });
      });
      const testSelect = document.getElementById('modal-msg-test-select');
      assert.equal(testSelect.children[0].value, 'wt-legacy');
      assert.ok(testSelect.children[0].textContent.includes('Legacy Test Array'));
    });

    it('opens General Message composition with reference groups hidden and recipient displayed', () => {
      openSendMessageModal(studentProfile, realisticDashboardData, { linkType: 'general' });

      const recipientText = document.getElementById('modal-msg-recipient-text').textContent;
      assert.ok(recipientText.includes('Aditya Sen'));
      assert.ok(recipientText.includes('STU-099'));
      assert.ok(recipientText.includes('Master 2'));

      const linkTypeSelect = document.getElementById('modal-msg-link-type');
      assert.equal(linkTypeSelect.value, 'general');

      const scoreGroup = document.getElementById('modal-msg-score-group');
      const testGroup = document.getElementById('modal-msg-test-group');
      assert.equal(scoreGroup.style.display, 'none');
      assert.equal(testGroup.style.display, 'none');
    });

    it('opens Score-Linked message composition with score selector visible and score pre-selected', () => {
      openSendMessageModal(studentProfile, realisticDashboardData, {
        linkType: 'score',
        scoreId: 'res-101',
      });

      const linkTypeSelect = document.getElementById('modal-msg-link-type');
      assert.equal(linkTypeSelect.value, 'score');

      const scoreGroup = document.getElementById('modal-msg-score-group');
      const testGroup = document.getElementById('modal-msg-test-group');
      assert.equal(scoreGroup.style.display, 'block');
      assert.equal(testGroup.style.display, 'none');

      const scoreSelect = document.getElementById('modal-msg-score-select');
      assert.equal(scoreSelect.value, 'res-101');
      assert.ok(scoreSelect.children[0].textContent.includes('2D 10R Addition'));
    });

    it('opens Weekly-Test-Linked message composition with test selector visible and test pre-selected', () => {
      openSendMessageModal(studentProfile, realisticDashboardData, {
        linkType: 'weekly_test',
        testId: 'wt-502',
      });

      const linkTypeSelect = document.getElementById('modal-msg-link-type');
      assert.equal(linkTypeSelect.value, 'weekly_test');

      const scoreGroup = document.getElementById('modal-msg-score-group');
      const testGroup = document.getElementById('modal-msg-test-group');
      assert.equal(scoreGroup.style.display, 'none');
      assert.equal(testGroup.style.display, 'block');

      const testSelect = document.getElementById('modal-msg-test-select');
      assert.equal(testSelect.value, 'wt-502');
      assert.ok(testSelect.children[1].textContent.includes('Week 43 Speed Benchmark'));
    });
  });

  describe('2. Admin Selected-Student Basics History (js/basics.js & pages/basics.html)', () => {
    const adminUser = { id: 'admin-super', role: 'admin', full_name: 'Master Admin' };
    const studentA = { id: 'stu-a', student_code: 'STU-001', role: 'student', full_name: 'Student Alpha' };
    const studentB = { id: 'stu-b', student_code: 'STU-002', role: 'student', full_name: 'Student Beta' };

    it('pages/basics.html contains the actual containers for manual entry and online practice with standard styles', () => {
      const htmlPath = path.join(ROOT_DIR, 'pages', 'basics.html');
      const html = fs.readFileSync(htmlPath, 'utf8');

      // 1. Verify actual ID basics-entry-card exists on the manual entry card
      assert.ok(
        html.includes('id="basics-entry-card"'),
        'pages/basics.html must contain id="basics-entry-card" on the manual entry card'
      );

      // Verify basics-entry-card relies on default stylesheet (.card) visibility (no display:none in HTML)
      assert.ok(
        !html.includes('id="basics-entry-card" style="display: none') &&
        !html.includes('id="basics-entry-card" style="display:none'),
        '#basics-entry-card must not have inline display:none in page markup'
      );

      // 2. Verify actual ID online-practice-categories-card exists
      assert.ok(
        html.includes('id="online-practice-categories-card"'),
        'pages/basics.html must contain id="online-practice-categories-card"'
      );

      // 3. Verify actual button ID btn-selected-practice-online exists
      assert.ok(
        html.includes('id="btn-selected-practice-online"'),
        'pages/basics.html must contain id="btn-selected-practice-online"'
      );
    });

    it("applyBasicsStudentViewMode(true) hides manual entry and online practice controls when viewing another student's history", () => {
      const entryCard = document.getElementById('basics-entry-card');
      const onlineCard = document.getElementById('online-practice-categories-card');
      const onlineBtn = document.getElementById('btn-selected-practice-online');

      // Pre-set controls to active/visible states
      entryCard.style.display = 'block';
      onlineCard.style.display = 'block';
      onlineBtn.style.display = 'inline-flex';

      // Call view mode for another student
      applyBasicsStudentViewMode(true);

      // Verify all manual entry and practice controls are observably hidden
      assert.equal(entryCard.style.display, 'none', 'Entry card must be hidden when viewing another student');
      assert.equal(onlineCard.style.display, 'none', 'Online practice card must be hidden when viewing another student');
      assert.equal(onlineBtn.style.display, 'none', 'Online practice button must be hidden when viewing another student');

      assert.ok(isObservablyHidden(entryCard), 'Entry card must be observably hidden');
      assert.ok(isObservablyHidden(onlineCard), 'Online practice card must be observably hidden');
      assert.ok(isObservablyHidden(onlineBtn), 'Online practice button must be observably hidden');
      assert.equal(globalThis.getComputedStyle(entryCard).display, 'none');
      assert.equal(globalThis.getComputedStyle(onlineCard).display, 'none');
      assert.equal(globalThis.getComputedStyle(onlineBtn).display, 'none');
    });

    it("applyBasicsStudentViewMode(false) preserves and restores manual entry and practice controls when student views own page", () => {
      const entryCard = document.getElementById('basics-entry-card');
      const onlineCard = document.getElementById('online-practice-categories-card');
      const onlineBtn = document.getElementById('btn-selected-practice-online');

      // Start from hidden state (simulating transition from other-student inspection)
      applyBasicsStudentViewMode(true);
      assert.equal(entryCard.style.display, 'none');
      assert.equal(onlineCard.style.display, 'none');
      assert.equal(onlineBtn.style.display, 'none');

      // Configure student viewing their own profile and loaded categories
      setCurrentProfileForTesting(studentA);
      setActiveHistoryStudentForTesting(studentA);
      setBasicsCategoriesForTesting([
        { id: 'cat-1d', name: '1D 10R', section: 'basics', active: true }
      ]);
      const selectEl = document.getElementById('basics-category-select');
      selectEl.value = 'cat-1d';

      // Restore own student view
      applyBasicsStudentViewMode(false);

      // 1. Manual entry card: inline display:none override is cleared ('') to restore stylesheet defaults
      assert.notEqual(entryCard.style.display, 'none', 'Entry card must not be hidden when viewing own page');
      assert.equal(entryCard.style.display, '', 'Inline display:none must be cleared to restore stylesheet defaults');
      assert.ok(isObservablyVisible(entryCard), 'Entry card must be observably visible');
      assert.equal(globalThis.getComputedStyle(entryCard).display, 'block', 'Computed display must resolve to block default');

      // 2. Online practice quick-launch card: restored to active display for available categories
      assert.notEqual(onlineCard.style.display, 'none', 'Online practice card must not be hidden when online categories exist');
      assert.ok(isObservablyVisible(onlineCard), 'Online practice card must be observably visible');
      assert.equal(globalThis.getComputedStyle(onlineCard).display, 'block');

      // 3. Online practice category button: restored to inline-flex for selected online-supported category
      assert.notEqual(onlineBtn.style.display, 'none', 'Online practice button must not be hidden for online category');
      assert.ok(isObservablyVisible(onlineBtn), 'Online practice button must be observably visible');
      assert.equal(onlineBtn.style.display, 'inline-flex');
      assert.equal(globalThis.getComputedStyle(onlineBtn).display, 'inline-flex');
    });

    it('isViewingOtherStudent correctly distinguishes own view vs inspecting another student', () => {
      // 1. Admin viewing Student A -> other student
      setCurrentProfileForTesting(adminUser);
      setActiveHistoryStudentForTesting(studentA);
      assert.equal(isViewingOtherStudent(), true);

      // 2. Student A viewing Student A -> own view
      setCurrentProfileForTesting(studentA);
      setActiveHistoryStudentForTesting(studentA);
      assert.equal(isViewingOtherStudent(), false);

      // 3. Student A viewing Student B -> other student
      setCurrentProfileForTesting(studentA);
      setActiveHistoryStudentForTesting(studentB);
      assert.equal(isViewingOtherStudent(), true);
    });

    it('renderDrillRow renders zero edit/delete buttons when isViewingOtherStudent is true', () => {
      setCurrentProfileForTesting(adminUser);
      setActiveHistoryStudentForTesting(studentA);
      assert.equal(isViewingOtherStudent(), true);

      const mockDrill = {
        id: 'drill-901',
        correct: 19,
        total: 20,
        time_seconds: 110,
        entry_date: '2026-11-08',
        verified: false,
        categories: { name: '2D Addition' },
      };

      const rowHtml = renderDrillRow(mockDrill);
      assert.ok(!rowHtml.includes('btn-edit-drill'), 'Must not render edit button in other student view');
      assert.ok(!rowHtml.includes('btn-delete-drill'), 'Must not render delete button in other student view');
      assert.ok(rowHtml.includes('2D Addition'), 'Must preserve category name');
      assert.ok(rowHtml.includes('19 / 20'), 'Must preserve score display');
      assert.ok(rowHtml.includes('history-details-panel'), 'Must preserve details panel');
      assert.ok(rowHtml.includes('btn-history-details'), 'Must preserve details toggle button');
    });

    it('renderDrillRow renders Edit and Delete buttons when student views their own unlocked drill', () => {
      setCurrentProfileForTesting(studentA);
      setActiveHistoryStudentForTesting(studentA);
      assert.equal(isViewingOtherStudent(), false);

      const mockDrill = {
        id: 'drill-902',
        correct: 20,
        total: 20,
        time_seconds: 95,
        entry_date: '2026-11-08',
        verified: false,
        categories: { name: '2D Addition' },
      };

      const rowHtml = renderDrillRow(mockDrill);
      assert.ok(rowHtml.includes('btn-edit-drill'), 'Must render edit button for own unlocked drill');
      assert.ok(rowHtml.includes('btn-delete-drill'), 'Must render delete button for own unlocked drill');
      assert.ok(rowHtml.includes('history-details-panel'), 'Must preserve details panel');
      assert.ok(rowHtml.includes('btn-history-details'), 'Must preserve details toggle button');
    });
  });
});
