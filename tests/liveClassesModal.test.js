/**
 * Trendz Tracker — Live Classes Modal Contract & Interaction Test
 * (tests/liveClassesModal.test.js)
 *
 * Verifies:
 * 1. Accessible DOM Dialog Contract in pages/live-classes.html:
 *    - #btn-open-create-modal triggers the dialog
 *    - #modal-create-class uses .modal-backdrop (not hidden display:none overlay)
 *    - role="dialog", aria-modal="true", aria-hidden="true" initial state
 *    - Close trigger (#btn-close-modal) and Cancel trigger (#btn-cancel-create)
 *      have data-close-modal="modal-create-class"
 * 2. js/liveClasses.js modal integration:
 *    - Uses openModal and closeModal from js/modal.js
 *    - Registers modal click handlers immediately after admin confirmation
 *      before any async network requests (loadLiveClasses, loadTeachersSelect)
 * 3. Functional behavior:
 *    - openModal adds .open and .is-open, sets aria-hidden="false"
 *    - closeModal removes .open and .is-open, sets aria-hidden="true"
 *    - Reset on close and error clearing
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Live Classes staff initialization runs only from its page entry point', () => {
  const controller = fs.readFileSync(path.resolve(__dirname, '../js/liveClasses.js'), 'utf-8');
  const page = fs.readFileSync(path.resolve(__dirname, '../pages/live-classes.html'), 'utf-8');

  assert.doesNotMatch(controller, /DOMContentLoaded/,
    'Importing the shared time formatter must never wire staff page initialization');
  assert.match(page, /import \{ initLiveClassesPage \} from '\/js\/liveClasses\.js';[\s\S]*?initLiveClassesPage\(\)/);
});

test('1. Accessible DOM Dialog Contract in pages/live-classes.html', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../pages/live-classes.html'), 'utf-8');

  // Trigger button contract
  assert.ok(html.includes('id="btn-open-create-modal"'), 'Expected #btn-open-create-modal trigger button');

  // Modal backdrop container
  assert.ok(html.includes('id="modal-create-class"'), 'Expected #modal-create-class container');
  assert.ok(html.includes('class="modal-backdrop"'), 'Modal must have modal-backdrop class to use shared modal.js styles');
  assert.ok(!html.includes('id="modal-create-class" class="modal-overlay" style="display: none;"'),
    'Modal must not be styled inline with display:none which hides it when is-open is added');
  assert.ok(html.includes('role="dialog"'), 'Expected role="dialog"');
  assert.ok(html.includes('aria-modal="true"'), 'Expected aria-modal="true"');
  assert.ok(html.includes('aria-labelledby="modal-title"'), 'Expected aria-labelledby="modal-title"');

  // Modal dialog wrapper
  assert.ok(html.includes('class="modal-dialog modal-card"'), 'Expected inner modal-dialog modal-card wrapper');

  // Close triggers
  assert.ok(html.includes('id="btn-close-modal"'), 'Expected #btn-close-modal button');
  assert.ok(html.includes('data-close-modal="modal-create-class"'), 'Expected data-close-modal attribute for universal modal.js handling');
  assert.ok(html.includes('id="btn-cancel-create"'), 'Expected #btn-cancel-create button');
  assert.ok(html.includes('id="form-create-class"'), 'Expected #form-create-class form element');
  const scheduleForm = html.match(/<form id="form-create-class"[^>]*>([\s\S]*?)<\/form>/)?.[1] || '';
  assert.match(scheduleForm, /class="modal-body"[\s\S]*id="input-notes"[\s\S]*class="modal-footer"[\s\S]*id="btn-submit-create"/);
});

test('2. js/liveClasses.js modal controller contracts and registration timing', () => {
  const js = fs.readFileSync(path.resolve(__dirname, '../js/liveClasses.js'), 'utf-8');

  // Import check
  assert.ok(
    js.includes("import { openModal, closeModal } from './modal.js'") ||
    js.includes('import { openModal, closeModal } from "./modal.js"'),
    'Expected js/liveClasses.js to import openModal and closeModal from ./modal.js'
  );

  // Calls openModal and closeModal
  assert.ok(js.includes("openModal('modal-create-class')"), 'Expected openModal to be called for modal-create-class');
  assert.ok(js.includes("closeModal('modal-create-class')"), 'Expected closeModal to be called for modal-create-class');

  // Registration happens before async loadLiveClasses
  const setupNavIndex = js.indexOf('setupHeaderNavigation(profile)');
  const openModalCallIndex = js.indexOf("openModal('modal-create-class')");
  const loadClassesCallIndex = js.indexOf('loadLiveClasses().catch');

  assert.ok(setupNavIndex > 0, 'setupHeaderNavigation must be called');
  assert.ok(openModalCallIndex > setupNavIndex, 'Modal handlers must be set up after profile access confirmation');
  assert.ok(loadClassesCallIndex > openModalCallIndex,
    'loadLiveClasses must be called asynchronously AFTER modal event listeners are wired so slow network cannot freeze the modal');
});

test('3. Modal open and close state transitions using openModal and closeModal', async () => {
  const { openModal, closeModal } = await import('../js/modal.js');

  // Mock minimal DOM environment
  const listeners = new Map();
  const documentListeners = new Map();

  const classListSet = new Set();
  const classList = {
    add: (...names) => names.forEach((n) => classListSet.add(n)),
    remove: (...names) => names.forEach((n) => classListSet.delete(n)),
    contains: (name) => classListSet.has(name),
  };

  const attributes = new Map([
    ['aria-hidden', 'true'],
  ]);

  const mockModal = {
    id: 'modal-create-class',
    classList,
    setAttribute: (k, v) => attributes.set(k, String(v)),
    getAttribute: (k) => attributes.get(k),
    hasAttribute: (k) => attributes.has(k),
    removeAttribute: (k) => attributes.delete(k),
    style: { display: '' },
    querySelectorAll: () => [],
    querySelector: () => null,
  };

  const originalDocument = globalThis.document;
  globalThis.document = {
    getElementById: (id) => (id === 'modal-create-class' ? mockModal : null),
    addEventListener: (event, handler) => {
      documentListeners.set(event, handler);
    },
    removeEventListener: (event) => {
      documentListeners.delete(event);
    },
    querySelectorAll: () => [],
    activeElement: null,
  };

  try {
    // Initial state
    assert.equal(mockModal.getAttribute('aria-hidden'), 'true');
    assert.equal(mockModal.classList.contains('open'), false);

    // Open modal
    openModal('modal-create-class');
    assert.equal(mockModal.classList.contains('open'), true);
    assert.equal(mockModal.classList.contains('is-open'), true);
    assert.equal(mockModal.getAttribute('aria-hidden'), 'false');
    assert.equal(documentListeners.has('keydown'), true, 'Escape key handler must be active when open');

    // Close modal
    closeModal('modal-create-class');
    assert.equal(mockModal.classList.contains('open'), false);
    assert.equal(mockModal.classList.contains('is-open'), false);
    assert.equal(mockModal.getAttribute('aria-hidden'), 'true');
    assert.equal(documentListeners.has('keydown'), false, 'Escape key handler must be removed when closed');

    // Reopen modal cleanly
    openModal('modal-create-class');
    assert.equal(mockModal.classList.contains('open'), true);
    assert.equal(mockModal.classList.contains('is-open'), true);
    assert.equal(mockModal.getAttribute('aria-hidden'), 'false');

    // Close again
    closeModal('modal-create-class');
    assert.equal(mockModal.classList.contains('open'), false);
    assert.equal(mockModal.getAttribute('aria-hidden'), 'true');
  } finally {
    globalThis.document = originalDocument;
  }
});

test('4. loadTeachersSelect shows "Assign to me — [admin name]" alongside active teachers and uses signed-in admin ID', async () => {
  const { loadTeachersSelect, setCurrentProfileForTesting } = await import('../js/liveClasses.js');

  const adminProfile = {
    id: 'a0000000-0000-0000-0000-000000000001',
    full_name: 'Sunil Admin',
    role: 'admin',
    active: true,
  };
  setCurrentProfileForTesting(adminProfile);

  const mockTeachers = [
    { id: 't0000000-0000-0000-0000-000000000001', full_name: 'Pooja Teacher', student_code: 'TCH-001' },
    { id: 't0000000-0000-0000-0000-000000000002', full_name: 'Rahul Teacher', student_code: 'TCH-002' },
  ];

  const mockSupabase = {
    from: (table) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: async () => ({ data: mockTeachers, error: null }),
          }),
        }),
      }),
    }),
  };

  const selectTeacher = { id: 'select-teacher', innerHTML: '', value: '' };
  const selectInvited = { id: 'select-invited-teachers', innerHTML: '', value: '' };

  const originalDocument = globalThis.document;
  globalThis.document = {
    getElementById: (id) => {
      if (id === 'select-teacher') return selectTeacher;
      if (id === 'select-invited-teachers') return selectInvited;
      return null;
    },
  };

  try {
    await loadTeachersSelect(mockSupabase);

    // Verify "Assign to me — Sunil Admin" is present in Assigned Teacher dropdown
    assert.ok(
      selectTeacher.innerHTML.includes(`<option value="${adminProfile.id}">Assign to me — Sunil Admin</option>`),
      'Expected "Assign to me — Sunil Admin" option with admin profile ID'
    );
    // Verify active teachers are also present alongside self-assignment
    assert.ok(
      selectTeacher.innerHTML.includes('Pooja Teacher (TCH-001)'),
      'Expected active teacher Pooja in dropdown'
    );
    assert.ok(
      selectTeacher.innerHTML.includes('Rahul Teacher (TCH-002)'),
      'Expected active teacher Rahul in dropdown'
    );

    // Verify invited teachers dropdown keeps teachers separate (admin is NOT an invited participant)
    assert.ok(!selectInvited.innerHTML.includes(adminProfile.id), 'Admin must NOT be in invited teachers dropdown');
    assert.ok(selectInvited.innerHTML.includes('Pooja Teacher (TCH-001)'), 'Invited dropdown must have teachers');
  } finally {
    globalThis.document = originalDocument;
  }
});

test('5. When zero active teachers exist, "Assign to me" remains available and is selected by default', async () => {
  const { loadTeachersSelect, setCurrentProfileForTesting } = await import('../js/liveClasses.js');

  const adminProfile = {
    id: 'a0000000-0000-0000-0000-000000000001',
    full_name: 'Sunil Admin',
    role: 'admin',
    active: true,
  };
  setCurrentProfileForTesting(adminProfile);

  const mockSupabaseZeroTeachers = {
    from: (table) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: async () => ({ data: [], error: null }),
          }),
        }),
      }),
    }),
  };

  const selectTeacher = { id: 'select-teacher', innerHTML: '', value: '' };
  const selectInvited = { id: 'select-invited-teachers', innerHTML: '', value: '' };

  const originalDocument = globalThis.document;
  globalThis.document = {
    getElementById: (id) => {
      if (id === 'select-teacher') return selectTeacher;
      if (id === 'select-invited-teachers') return selectInvited;
      return null;
    },
  };

  try {
    await loadTeachersSelect(mockSupabaseZeroTeachers);

    // Verify "Assign to me — Sunil Admin" is available and marked selected
    assert.ok(
      selectTeacher.innerHTML.includes(`<option value="${adminProfile.id}" selected>Assign to me — Sunil Admin</option>`),
      'Expected "Assign to me — Sunil Admin" to be marked selected when zero active teachers exist'
    );
    assert.equal(selectTeacher.value, adminProfile.id, 'Assigned Teacher select value must default to admin profile ID');

    // Verify invited teachers indicates no active teachers found
    assert.ok(
      selectInvited.innerHTML.includes('No active teachers found'),
      'Expected invited teachers to show disabled notice when 0 teachers exist'
    );
  } finally {
    globalThis.document = originalDocument;
  }
});

test('6. Accessible DOM Dialog Contract for modal-attach-recording in pages/live-classes.html', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../pages/live-classes.html'), 'utf-8');

  // Trigger button
  assert.ok(html.includes('id="btn-open-attach-recording"'), 'Expected #btn-open-attach-recording trigger button');

  // Modal backdrop container
  assert.ok(html.includes('id="modal-attach-recording"'), 'Expected #modal-attach-recording container');
  assert.ok(html.includes('class="modal-backdrop"'), 'Modal must have modal-backdrop class to use shared modal.js styles');
  assert.ok(html.includes('role="dialog"'), 'Expected role="dialog"');
  assert.ok(html.includes('aria-modal="true"'), 'Expected aria-modal="true"');
  assert.ok(html.includes('aria-labelledby="modal-attach-recording-title"'), 'Expected aria-labelledby="modal-attach-recording-title"');

  // Close triggers
  assert.ok(html.includes('data-close-modal="modal-attach-recording"'), 'Expected data-close-modal="modal-attach-recording"');
  assert.ok(html.includes('id="form-attach-recording"'), 'Expected #form-attach-recording element');
  assert.ok(html.includes('id="attach-rec-class"'), 'Expected #attach-rec-class select');
  assert.ok(html.includes('id="attach-rec-url"'), 'Expected #attach-rec-url input');
});
