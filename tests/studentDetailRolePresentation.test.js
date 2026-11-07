/**
 * Regression Tests for Admin & Teacher Role Presentation
 * (tests/studentDetailRolePresentation.test.js)
 *
 * Verifies:
 * 1. pages/student-detail.html starts in a neutral hidden/loading state before role verification.
 * 2. Real application functions (renderHeaderUser, renderRoleContext) from js/studentDetail.js
 *    are executed to verify admin presentation and mutation button visibility.
 * 3. Real application functions from js/studentDetail.js are executed to verify teacher presentation,
 *    read-only context, and hiding of mutation actions.
 * 4. review.js, attendance.js, and settings.js derive role labels dynamically from verified profile.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// Helper to simulate mock DOM element
class MockElement {
  constructor(id = '', tagName = 'div') {
    this.id = id;
    this.tagName = tagName;
    this.textContent = '';
    this.innerHTML = '';
    this.style = {};
    this.href = '';
    this.disabled = false;
  }
  addEventListener() {}
  removeEventListener() {}
}

function createMockDocument() {
  const elements = new Map();

  function getOrCreate(id, tagName = 'div') {
    if (!elements.has(id)) {
      elements.set(id, new MockElement(id, tagName));
    }
    return elements.get(id);
  }

  // Pre-populate known IDs from student-detail.html
  [
    'user-pill-container',
    'header-user-name',
    'header-user-role',
    'role-context-banner',
    'role-context-banner-text',
    'btn-back-overview',
    'btn-edit-student-profile',
    'btn-send-student-message',
    'btn-student-change-history',
    'btn-monthly-report',
    'btn-review-entries',
    'btn-header-logout',
    'demo-banner-placeholder',
  ].forEach((id) => getOrCreate(id));

  return {
    getElementById: (id) => elements.get(id) || null,
    addEventListener: () => {},
    elements,
  };
}

// Setup browser globals before importing application module
globalThis.window = {
  location: { search: '', href: '', hostname: 'localhost' },
  addEventListener: () => {},
};
globalThis.document = createMockDocument();

// Import real application functions
const { renderHeaderUser, renderRoleContext } = await import('../js/studentDetail.js');

test('1. Static HTML in pages/student-detail.html uses neutral hidden/loading state before role verification', () => {
  const htmlPath = path.join(ROOT_DIR, 'pages', 'student-detail.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  // Verify header-user-role is not hardcoded to Admin or Teacher
  const roleMatch = html.match(/<span id="header-user-role"[^>]*>([^<]+)<\/span>/);
  assert.ok(roleMatch, 'Must find header-user-role span');
  assert.equal(roleMatch[1].trim(), '&mdash;', 'Static header role in student-detail.html must use neutral dash placeholder');

  // Verify header name is loading
  const nameMatch = html.match(/<span id="header-user-name"[^>]*>([^<]+)<\/span>/);
  assert.ok(nameMatch, 'Must find header-user-name span');
  assert.equal(nameMatch[1].trim(), 'Loading...', 'Static header name must show Loading...');

  // Verify role context banner is hidden by default
  const bannerMatch = html.match(/<div class="teacher-readonly-banner" id="role-context-banner" style="([^"]*)"/);
  assert.ok(bannerMatch, 'Must find role-context-banner');
  assert.ok(bannerMatch[1].includes('display: none;'), 'Role context banner must be display: none before role verification');

  // Verify banner text is neutral placeholder
  assert.ok(html.includes('Loading access context...'), 'Banner text must show neutral loading state');
});

test('2. Admin role presentation: executes actual application functions to render admin UI', () => {
  const mockDoc = createMockDocument();
  globalThis.document = mockDoc;

  const adminProfile = {
    id: 'admin-1',
    full_name: 'Coach Sharma',
    role: 'admin',
    active: true,
  };

  const container = document.getElementById('user-pill-container');
  const nameEl = document.getElementById('header-user-name');
  const roleEl = document.getElementById('header-user-role');
  const banner = document.getElementById('role-context-banner');
  const bannerText = document.getElementById('role-context-banner-text');
  const backBtn = document.getElementById('btn-back-overview');
  const editProfileBtn = document.getElementById('btn-edit-student-profile');
  const sendMsgBtn = document.getElementById('btn-send-student-message');
  const auditBtn = document.getElementById('btn-student-change-history');

  // Initially hidden / neutral
  banner.style.display = 'none';

  // Execute actual production functions
  renderHeaderUser(adminProfile);
  renderRoleContext(adminProfile);

  // Assert actual production rendering
  assert.equal(container.style.display, 'flex', 'User pill container must be shown');
  assert.equal(nameEl.textContent, 'Coach Sharma', 'Admin name must display full_name');
  assert.equal(roleEl.textContent, 'Admin', 'Admin role must display Admin');
  assert.equal(banner.style.display, 'flex', 'Banner must be displayed for verified admin');
  assert.equal(bannerText.innerHTML, 'Viewing as administrator');
  assert.equal(backBtn.href, '/pages/admin.html');
  assert.equal(backBtn.textContent, '← Back to Overview');
  assert.equal(editProfileBtn.style.display, '', 'Edit profile button must be visible for admin');
  assert.equal(sendMsgBtn.style.display, '', 'Send message button must be visible for admin');
  assert.equal(auditBtn.style.display, '', 'Audit change history button must be visible for admin');
});

test('3. Teacher role presentation: executes actual application functions to render teacher UI and enforce read-only', () => {
  const mockDoc = createMockDocument();
  globalThis.document = mockDoc;

  const teacherProfile = {
    id: 'teacher-1',
    full_name: 'Priya Patel',
    role: 'teacher',
    active: true,
  };

  const container = document.getElementById('user-pill-container');
  const nameEl = document.getElementById('header-user-name');
  const roleEl = document.getElementById('header-user-role');
  const banner = document.getElementById('role-context-banner');
  const bannerText = document.getElementById('role-context-banner-text');
  const backBtn = document.getElementById('btn-back-overview');
  const editProfileBtn = document.getElementById('btn-edit-student-profile');
  const sendMsgBtn = document.getElementById('btn-send-student-message');
  const auditBtn = document.getElementById('btn-student-change-history');

  // Initially hidden / neutral
  banner.style.display = 'none';

  // Execute actual production functions
  renderHeaderUser(teacherProfile);
  renderRoleContext(teacherProfile);

  // Assert actual production rendering
  assert.equal(container.style.display, 'flex', 'User pill container must be shown');
  assert.equal(nameEl.textContent, 'Priya Patel', 'Teacher name must display full_name');
  assert.equal(roleEl.textContent, 'Teacher', 'Teacher role must display Teacher');
  assert.equal(banner.style.display, 'flex', 'Banner must be displayed for verified teacher');
  assert.equal(bannerText.innerHTML, 'Viewing as teacher &mdash; read-only');
  assert.equal(backBtn.href, '/pages/teacher.html');
  assert.equal(backBtn.textContent, '← Back to Teacher Workspace');
  assert.equal(editProfileBtn.style.display, 'none', 'Edit profile button must be hidden for teacher');
  assert.equal(sendMsgBtn.style.display, 'none', 'Send message button must be hidden for teacher');
  assert.equal(auditBtn.style.display, 'none', 'Audit change history button must be hidden for teacher');
});

test('4. review.js, attendance.js, and settings.js derive role label dynamically', () => {
  const reviewSrc = fs.readFileSync(path.join(ROOT_DIR, 'js', 'review.js'), 'utf8');
  assert.ok(!reviewSrc.includes("roleEl.textContent = 'Teacher';"), 'review.js must not hardcode Teacher role');
  assert.ok(reviewSrc.includes("profile.role === 'admin' ? 'Admin' :"), 'review.js must derive role dynamically');

  const attSrc = fs.readFileSync(path.join(ROOT_DIR, 'js', 'attendance.js'), 'utf8');
  assert.ok(!attSrc.includes("roleEl.textContent = 'Teacher';"), 'attendance.js must not hardcode Teacher role');
  assert.ok(attSrc.includes("profile.role === 'admin' ? 'Admin' :"), 'attendance.js must derive role dynamically');

  const setSrc = fs.readFileSync(path.join(ROOT_DIR, 'js', 'settings.js'), 'utf8');
  assert.ok(!setSrc.includes("profile.student_code || 'Teacher';"), 'settings.js must not fallback to Teacher role');
  assert.ok(setSrc.includes("profile.role === 'admin' ? 'Admin' : 'Teacher'"), 'settings.js must derive role dynamically');
});
