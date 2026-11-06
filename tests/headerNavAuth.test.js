/**
 * Unit Tests for Header Navigation Role Safety & Authorization Boundaries
 * (tests/headerNavAuth.test.js)
 *
 * Verifies that:
 * 1. setupHeaderNavigation never infers 'admin' from page URL or existing markup.
 * 2. Unauthenticated or unverified calls leave privileged navigation hidden and empty.
 * 3. Student profiles receive ONLY student navigation and never admin links or data-nav-role="admin".
 * 4. setupAdminNav safely bails out when called with a student profile or unverified context.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { setupHeaderNavigation } from '../js/headerNav.js';
import { setupAdminNav } from '../js/modal.js';
import { PROFILE_CACHE_KEY } from '../js/profileCache.js';

class MockElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.id = '';
    this.className = '';
    this._innerHTML = '';
    this.textContent = '';
    this.hidden = false;
    this.dataset = {};
    this.addEventListener = () => {};
    this.removeEventListener = () => {};
    this.focus = () => {};
    const classes = new Set();
    this.classList = {
      add: (...cls) => cls.forEach((c) => classes.add(c)),
      remove: (...cls) => cls.forEach((c) => classes.delete(c)),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        if (force === true) {
          classes.add(c);
          return true;
        }
        if (force === false) {
          classes.delete(c);
          return false;
        }
        if (classes.has(c)) {
          classes.delete(c);
          return false;
        }
        classes.add(c);
        return true;
      },
    };
  }

  getAttribute(name) {
    if (name === 'id') return this.id || null;
    if (name === 'class') return this.className || null;
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name, val) {
    if (name === 'id') this.id = String(val);
    else if (name === 'class') this.className = String(val);
    else this.attributes.set(name, String(val));
  }

  removeAttribute(name) {
    if (name === 'id') this.id = '';
    else if (name === 'class') this.className = '';
    else this.attributes.delete(name);
  }

  appendChild(child) {
    if (!child) return child;
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(newChild, refChild) {
    if (!newChild) return newChild;
    newChild.parentNode = this;
    const idx = this.children.indexOf(refChild);
    if (idx === -1) {
      this.children.push(newChild);
    } else {
      this.children.splice(idx, 0, newChild);
    }
    return newChild;
  }

  remove() {
    if (this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      if (idx !== -1) {
        this.parentNode.children.splice(idx, 1);
      }
      this.parentNode = null;
    }
  }

  set innerHTML(html) {
    this._innerHTML = html;
    this.children = [];
    if (!html) return;

    // Simple tag extractor for mock DOM
    const tagRegex = /<([a-zA-Z0-9-]+)([^>]*)>([\s\S]*?)<\/\1>|<([a-zA-Z0-9-]+)([^>]*)\/?>/g;
    let match;
    while ((match = tagRegex.exec(html)) !== null) {
      const tagName = match[1] || match[4];
      const rawAttrs = match[2] || match[5] || '';
      const inner = match[3] || '';

      const child = new MockElement(tagName);
      // parse attributes
      const attrRegex = /([a-zA-Z0-9_-]+)(?:=["']([^"']*)["'])?/g;
      let attrMatch;
      while ((attrMatch = attrRegex.exec(rawAttrs)) !== null) {
        const k = attrMatch[1];
        const v = attrMatch[2] !== undefined ? attrMatch[2] : '';
        if (k === 'id') child.id = v;
        else if (k === 'class') child.className = v;
        else child.setAttribute(k, v);
      }

      if (inner && !/<[a-zA-Z0-9-]/.test(inner)) {
        child.textContent = inner;
      } else if (inner) {
        child.innerHTML = inner;
      }

      this.appendChild(child);
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  querySelector(selector) {
    return this._findFirst((el) => matchesSelector(el, selector));
  }

  querySelectorAll(selector) {
    const results = [];
    this._findAll((el) => matchesSelector(el, selector), results);
    return results;
  }

  _findFirst(predicate) {
    for (const child of this.children) {
      if (predicate(child)) return child;
      const found = child._findFirst(predicate);
      if (found) return found;
    }
    return null;
  }

  _findAll(predicate, results) {
    for (const child of this.children) {
      if (predicate(child)) results.push(child);
      child._findAll(predicate, results);
    }
  }
}

function matchesSelector(el, sel) {
  if (!el || !sel) return false;
  if (sel.startsWith('#')) {
    return el.id === sel.slice(1);
  }
  if (sel.startsWith('.')) {
    return (el.className || '').split(/\s+/).includes(sel.slice(1));
  }
  if (sel === 'header' || sel === 'nav' || sel === 'div' || sel === 'button' || sel === 'a') {
    return el.tagName.toLowerCase() === sel;
  }
  return false;
}

function setupMockDom(pathname = '/pages/notifications.html') {
  const root = new MockElement('html');
  const body = new MockElement('body');
  root.appendChild(body);

  const header = new MockElement('header');
  header.className = 'app-header';
  body.appendChild(header);

  const headerInner = new MockElement('div');
  headerInner.className = 'header-inner';
  header.appendChild(headerInner);

  const brandZone = new MockElement('a');
  brandZone.className = 'brand-zone';
  headerInner.appendChild(brandZone);

  const navZone = new MockElement('nav');
  navZone.className = 'nav-zone';
  navZone.id = 'student-nav-zone';
  headerInner.appendChild(navZone);

  const actionsZone = new MockElement('div');
  actionsZone.className = 'actions-zone';
  headerInner.appendChild(actionsZone);

  const userPill = new MockElement('div');
  userPill.id = 'user-pill-container';
  actionsZone.appendChild(userPill);

  const nameEl = new MockElement('span');
  nameEl.id = 'header-user-name';
  userPill.appendChild(nameEl);

  const logoutBtn = new MockElement('button');
  logoutBtn.id = 'btn-header-logout';
  actionsZone.appendChild(logoutBtn);

  const storageMap = new Map();
  const mockStorage = {
    getItem: (k) => storageMap.get(k) || null,
    setItem: (k, v) => storageMap.set(k, String(v)),
    removeItem: (k) => storageMap.delete(k),
    clear: () => storageMap.clear(),
  };

  global.window = {
    location: { pathname, href: `http://localhost:3000${pathname}` },
    sessionStorage: mockStorage,
    localStorage: mockStorage,
    innerWidth: 1200,
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  global.document = {
    body,
    querySelector: (sel) => root.querySelector(sel),
    querySelectorAll: (sel) => root.querySelectorAll(sel),
    getElementById: (id) => root.querySelector(`#${id}`),
    createElement: (tag) => new MockElement(tag),
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  return { root, header, navZone, mockStorage };
}

test('setupHeaderNavigation with null profile does not infer admin role or render privileged links', () => {
  const { header } = setupMockDom('/pages/admin.html');

  setupHeaderNavigation(null);

  assert.equal(header.getAttribute('data-nav-role'), null);
  assert.equal(document.getElementById('admin-nav-zone'), null);
  assert.equal(document.getElementById('btn-header-nav-menu'), null);
});

test('setupHeaderNavigation on student alerts page with student profile renders student nav', () => {
  const { header, navZone } = setupMockDom('/pages/notifications.html');

  const studentProfile = {
    id: 'stu-123',
    role: 'student',
    full_name: 'Ananya Sharma',
    student_code: 'STU101',
    level: 'Junior 1',
  };

  setupHeaderNavigation(studentProfile);

  assert.equal(header.getAttribute('data-nav-role'), 'student');
  assert.equal(navZone.id, 'student-nav-zone');
  assert.ok(navZone.innerHTML.includes('/pages/student.html'), 'Student nav includes student home');
  assert.ok(!navZone.innerHTML.includes('/pages/admin.html'), 'Student nav must not link to /pages/admin.html');
  assert.ok(!navZone.innerHTML.includes('/pages/review.html'), 'Student nav must not link to /pages/review.html');
  assert.ok(!navZone.innerHTML.includes('/pages/backup.html'), 'Student nav must not link to /pages/backup.html');
});

test('setupHeaderNavigation with admin profile renders admin nav', () => {
  const { header, navZone } = setupMockDom('/pages/admin.html');

  const adminProfile = {
    id: 'adm-001',
    role: 'admin',
    full_name: 'Master Teacher',
    student_code: 'ADMIN01',
    level: 'Instructor',
  };

  setupHeaderNavigation(adminProfile);

  assert.equal(header.getAttribute('data-nav-role'), 'admin');
  assert.equal(navZone.id, 'admin-nav-zone');
  assert.ok(navZone.innerHTML.includes('/pages/admin.html'), 'Admin nav must link to /pages/admin.html');
  assert.ok(navZone.innerHTML.includes('/pages/review.html'), 'Admin nav must link to /pages/review.html');
});

test('setupAdminNav bails out when called with student profile on shared/student pages', () => {
  const { header } = setupMockDom('/pages/notifications.html');

  const studentProfile = {
    id: 'stu-123',
    role: 'student',
    full_name: 'Student User',
  };

  setupHeaderNavigation(studentProfile);
  assert.equal(header.getAttribute('data-nav-role'), 'student');

  setupAdminNav(studentProfile);

  // Role must remain 'student' and never switch to 'admin'
  assert.equal(header.getAttribute('data-nav-role'), 'student');
  assert.equal(document.getElementById('admin-nav-zone'), null);
});

test('setupAdminNav bails out when called without arguments and no admin profile in cache', () => {
  const { header } = setupMockDom('/pages/notifications.html');

  setupAdminNav();

  assert.equal(header.getAttribute('data-nav-role'), null);
  assert.equal(document.getElementById('admin-nav-zone'), null);
});

test('setupHeaderNavigation with teacher profile renders teacher nav and never admin nav', () => {
  const { header, navZone } = setupMockDom('/pages/teacher.html');

  const teacherProfile = {
    id: 'tch-001',
    role: 'teacher',
    full_name: 'Anita Sharma',
    student_code: 'TCH01',
    level: 'Teacher',
  };

  setupHeaderNavigation(teacherProfile);

  assert.equal(header.getAttribute('data-nav-role'), 'teacher');
  assert.equal(navZone.id, 'teacher-nav-zone');
  assert.ok(navZone.innerHTML.includes('/pages/teacher.html'), 'Teacher nav must link to /pages/teacher.html');
  assert.ok(!navZone.innerHTML.includes('/pages/teachers.html'), 'Teacher nav must not link to teacher admin page');
  assert.ok(!navZone.innerHTML.includes('/pages/settings.html'), 'Teacher nav must not link to settings hub');
  assert.ok(!navZone.innerHTML.includes('/pages/backup.html'), 'Teacher nav must not link to backup');
  assert.equal(document.getElementById('admin-nav-zone'), null);
});

test('setupAdminNav bails out when called with teacher profile', () => {
  const { header } = setupMockDom('/pages/notifications.html');

  const teacherProfile = {
    id: 'tch-001',
    role: 'teacher',
    full_name: 'Teacher User',
  };

  setupHeaderNavigation(teacherProfile);
  assert.equal(header.getAttribute('data-nav-role'), 'teacher');

  setupAdminNav(teacherProfile);

  // Role must remain 'teacher' and never elevate to 'admin'
  assert.equal(header.getAttribute('data-nav-role'), 'teacher');
  assert.equal(document.getElementById('admin-nav-zone'), null);
});
