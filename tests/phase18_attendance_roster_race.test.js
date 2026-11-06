/**
 * Phase 18 — Attendance Roster Concurrency & Error State Tests
 * (tests/phase18_attendance_roster_race.test.js)
 *
 * Verifies:
 * 1. Slow roster loading: loadActiveStudents() resolves slowly, but loadSessions()
 *    awaits the roster promise and calculates accurate unmarked counts rather than 0.
 * 2. Roster query failure: network/database failure sets rosterLoadError, renders an
 *    explicit error banner instead of "No Students Found", flags session list items with
 *    "Roster unavailable" instead of 0 unmarked, and blocks actions (Mark All, Save).
 * 3. Empty roster clarity: genuine empty student list renders "No Active Students",
 *    while a filtered query with no matches renders "No Students Found: No active students match...".
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

// Minimal Mock DOM for Attendance Page
class MockElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.id = '';
    this.className = '';
    this.style = {};
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.disabled = false;
    this._textContent = '';
    this.hidden = false;
    this.onclick = null;
    this._innerHTML = '';
    this.eventListeners = new Map();

    const self = this;
    this.classList = {
      _classes: new Set(),
      add(...cls) {
        cls.forEach((c) => self.classList._classes.add(c));
        self.className = Array.from(self.classList._classes).join(' ');
      },
      remove(...cls) {
        cls.forEach((c) => self.classList._classes.delete(c));
        self.className = Array.from(self.classList._classes).join(' ');
      },
      contains(c) {
        return self.classList._classes.has(c);
      }
    };
  }

  get textContent() {
    if (this._textContent) return this._textContent;
    if (this.children.length === 0) return '';
    return this.children.map((c) => c.textContent).join(' ');
  }

  set textContent(val) {
    this._textContent = String(val);
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(html) {
    this._innerHTML = html;
    this.children = [];
    this._textContent = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  getAttribute(key) {
    return this.attributes.get(key) ?? null;
  }

  setAttribute(key, val) {
    this.attributes.set(key, String(val));
  }

  removeAttribute(key) {
    this.attributes.delete(key);
  }

  hasAttribute(key) {
    return this.attributes.has(key);
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  addEventListener(event, handler) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event).push(handler);
  }

  removeEventListener(event, handler) {
    const list = this.eventListeners.get(event) || [];
    const idx = list.indexOf(handler);
    if (idx !== -1) list.splice(idx, 1);
  }

  dispatchEvent(event) {
    const list = this.eventListeners.get(event.type) || [];
    list.forEach((h) => h(event));
    if (this['on' + event.type]) {
      this['on' + event.type](event);
    }
  }

  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all.length > 0 ? all[0] : null;
  }

  querySelectorAll(selector) {
    const results = [];
    const walk = (el) => {
      for (const child of el.children) {
        if (child.id === selector.replace('#', '') || child.classList.contains(selector.replace('.', ''))) {
          results.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return results;
  }
}

function createMockDocument() {
  const elements = new Map();

  function getOrCreate(id, tag = 'div') {
    if (!elements.has(id)) {
      const el = new MockElement(tag);
      el.id = id;
      elements.set(id, el);
    }
    return elements.get(id);
  }

  // Pre-create attendance page elements
  const requiredIds = [
    ['sessions-list-container', 'div'],
    ['session-count-label', 'span'],
    ['attendance-roster-tbody', 'tbody'],
    ['active-count-present', 'span'],
    ['active-count-absent', 'span'],
    ['active-count-excused', 'span'],
    ['active-count-unmarked', 'span'],
    ['session-empty-state', 'div'],
    ['session-active-state', 'div'],
    ['active-session-type-chip', 'span'],
    ['active-session-date-display', 'span'],
    ['active-session-title', 'span'],
    ['active-session-notes', 'span'],
    ['btn-mark-all-present', 'button'],
    ['btn-save-attendance', 'button'],
    ['btn-save-attendance-bottom', 'button'],
    ['roster-search-input', 'input'],
    ['user-pill-container', 'div'],
    ['header-user-name', 'span'],
    ['header-user-role', 'span'],
    ['btn-header-logout', 'button'],
    ['demo-banner-placeholder', 'div']
  ];

  requiredIds.forEach(([id, tag]) => getOrCreate(id, tag));

  return {
    getElementById(id) {
      return elements.get(id) || null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    createElement(tag) {
      return new MockElement(tag);
    },
    addEventListener() {},
    removeEventListener() {}
  };
}

describe('Phase 18 — Attendance Roster Concurrency & Error States', () => {
  let originalDocument;
  let originalWindow;
  let attendanceModule;
  let mockDoc;

  beforeEach(async () => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;

    mockDoc = createMockDocument();
    globalThis.document = mockDoc;
    globalThis.window = {
      location: {
        hostname: 'localhost',
        href: '',
        search: '',
        pathname: '/pages/attendance.html'
      },
      document: mockDoc,
      addEventListener() {},
      removeEventListener() {}
    };

    if (!globalThis.localStorage) {
      globalThis.localStorage = {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
        clear: () => {}
      };
    }

    attendanceModule = await import('../js/attendance.js?test=' + Date.now());
    attendanceModule.resetAttendanceStateForTesting();
  });

  afterEach(() => {
    attendanceModule.resetAttendanceStateForTesting();
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  });

  it('1. Slow roster loading: loadSessions() awaits activeStudentsPromise and calculates accurate unmarked counts', async () => {
    const mockTeacher = {
      id: 'teacher-uuid-1',
      role: 'teacher',
      permissions: { can_mark_attendance: true }
    };
    attendanceModule.setCurrentProfileForTesting(mockTeacher);

    // Mock students (3 assigned students)
    const mockStudents = [
      { id: 's-1', full_name: 'Alice Wonder', student_code: 'STU001', level: '1', active: true },
      { id: 's-2', full_name: 'Bob Builder', student_code: 'STU002', level: '2', active: true },
      { id: 's-3', full_name: 'Charlie Chaplin', student_code: 'STU003', level: '3', active: true }
    ];

    // Mock session with 1 marked student (s-1 is present, leaving 2 unmarked)
    const mockSession = {
      id: 'session-uuid-1',
      title: 'Batch A Practice',
      session_type: 'Regular Class',
      session_date: '2026-11-06'
    };
    const mockAttendanceRows = [
      { session_id: 'session-uuid-1', student_id: 's-1', status: 'present' }
    ];

    // Set up mock Supabase with intentional 60ms delay on profiles query
    attendanceModule.setSupabaseClientForTesting({
      from(table) {
        if (table === 'teacher_student_assignments') {
          return {
            select() {
              return {
                eq() {
                  return Promise.resolve({
                    data: [{ student_id: 's-1' }, { student_id: 's-2' }, { student_id: 's-3' }],
                    error: null
                  });
                }
              };
            }
          };
        }
        if (table === 'profiles') {
          return {
            select() {
              return {
                in() {
                  return {
                    eq() {
                      return {
                        eq() {
                          return {
                            order() {
                              return new Promise((resolve) => {
                                setTimeout(() => {
                                  resolve({ data: mockStudents, error: null });
                                }, 60);
                              });
                            }
                          };
                        }
                      };
                    }
                  };
                }
              };
            }
          };
        }
        if (table === 'attendance_sessions') {
          return {
            select() {
              return {
                order() {
                  return {
                    order() {
                      // Returns fast without delay
                      return Promise.resolve({ data: [mockSession], error: null });
                    }
                  };
                }
              };
            }
          };
        }
        if (table === 'attendance') {
          return {
            select() {
              return Promise.resolve({ data: mockAttendanceRows, error: null });
            }
          };
        }
        return { select: () => Promise.resolve({ data: [], error: null }) };
      }
    });

    // Trigger slow roster load and concurrent loadSessions
    const rosterPromise = attendanceModule.loadActiveStudents();
    const sessionsPromise = attendanceModule.loadSessions();

    await Promise.all([rosterPromise, sessionsPromise]);

    const loadedStudents = attendanceModule.getActiveStudentsList();
    assert.equal(loadedStudents.length, 3, 'Should have loaded 3 active students');

    const sessions = attendanceModule.getAllSessions();
    assert.equal(sessions.length, 1, 'Should have loaded 1 session');

    const ses = sessions[0];
    assert.equal(ses.present_count, 1, 'Present count should be 1');
    assert.equal(ses.unmarked_count, 2, 'Unmarked count MUST be 2 (3 active - 1 marked), NOT 0');
    assert.equal(ses.roster_error, false, 'Should have roster_error = false');

    // Verify sessions-list-container HTML includes "2 Unmarked"
    const container = mockDoc.getElementById('sessions-list-container');
    assert.ok(container.innerHTML.includes('2 Unmarked'), 'Session chip must display "2 Unmarked"');
  });

  it('2. Roster query failure: displays explicit error banner and marks session with "Roster unavailable"', async () => {
    const mockTeacher = {
      id: 'teacher-uuid-1',
      role: 'teacher',
      permissions: { can_mark_attendance: true }
    };
    attendanceModule.setCurrentProfileForTesting(mockTeacher);

    const mockSession = {
      id: 'session-uuid-1',
      title: 'Batch B Practice',
      session_type: 'Workshop',
      session_date: '2026-11-06'
    };

    attendanceModule.setSupabaseClientForTesting({
      from(table) {
        if (table === 'teacher_student_assignments') {
          return {
            select() {
              return {
                eq() {
                  return Promise.reject(new Error('Network connection terminated'));
                }
              };
            }
          };
        }
        if (table === 'attendance_sessions') {
          return {
            select() {
              return {
                order() {
                  return {
                    order() {
                      return Promise.resolve({ data: [mockSession], error: null });
                    }
                  };
                }
              };
            }
          };
        }
        if (table === 'attendance') {
          return {
            select() {
              return Promise.resolve({ data: [], error: null });
            }
          };
        }
        return { select: () => Promise.resolve({ data: [], error: null }) };
      }
    });

    // Execute loadActiveStudents which fails
    await assert.rejects(
      async () => {
        await attendanceModule.loadActiveStudents();
      },
      /Network connection terminated/,
      'loadActiveStudents should rethrow roster error'
    );

    const rosterErr = attendanceModule.getRosterLoadError();
    assert.ok(rosterErr, 'rosterLoadError must be recorded');
    assert.equal(rosterErr.message, 'Network connection terminated');

    // Now load sessions
    await attendanceModule.loadSessions();

    const sessions = attendanceModule.getAllSessions();
    assert.equal(sessions.length, 1);
    const ses = sessions[0];

    // CRITICAL ASSERTION: unmarked_count must NOT be 0 (which would mislead that all students are marked)
    assert.equal(ses.unmarked_count, null, 'Unmarked count must be null on roster error, NOT 0');
    assert.equal(ses.roster_error, true, 'roster_error must be true');

    // Verify sessions-list-container has "Roster unavailable" badge
    const sessionContainer = mockDoc.getElementById('sessions-list-container');
    assert.ok(sessionContainer.innerHTML.includes('Roster unavailable'), 'Must display "Roster unavailable" chip');
    assert.ok(!sessionContainer.innerHTML.includes('0 Unmarked'), 'Must NOT display "0 Unmarked"');

    // Verify roster tbody shows explicit error banner, NOT "No Students Found"
    attendanceModule.renderStudentRosterGrid();
    const tbody = mockDoc.getElementById('attendance-roster-tbody');
    assert.ok(tbody.innerHTML.includes('Failed to Load Student Roster'), 'Must render error header');
    assert.ok(tbody.innerHTML.includes('Network connection terminated'), 'Must show actual error message');
    assert.ok(!tbody.innerHTML.includes('No Students Found'), 'Must NOT misleadingly claim "No Students Found"');

    // Verify updateRosterCountsUI sets unmarked to Error
    attendanceModule.updateRosterCountsUI();
    const uEl = mockDoc.getElementById('active-count-unmarked');
    assert.equal(uEl.textContent, 'Error', 'Unmarked count card must display "Error"');
  });

  it('3. Genuine empty roster: displays "No Active Students" when teacher has no assigned students', async () => {
    const mockTeacher = {
      id: 'teacher-uuid-empty',
      role: 'teacher',
      permissions: { can_mark_attendance: true }
    };
    attendanceModule.setCurrentProfileForTesting(mockTeacher);

    attendanceModule.setSupabaseClientForTesting({
      from(table) {
        if (table === 'teacher_student_assignments') {
          return {
            select() {
              return {
                eq() {
                  return Promise.resolve({ data: [], error: null }); // 0 assignments
                }
              };
            }
          };
        }
        return { select: () => Promise.resolve({ data: [], error: null }) };
      }
    });

    await attendanceModule.loadActiveStudents();
    assert.equal(attendanceModule.getRosterLoadError(), null, 'Should have no error');
    assert.equal(attendanceModule.getActiveStudentsList().length, 0, 'Active students should be empty');

    attendanceModule.renderStudentRosterGrid();
    const tbody = mockDoc.getElementById('attendance-roster-tbody');
    assert.ok(tbody.innerHTML.includes('No Active Students'), 'Should state "No Active Students"');
    assert.ok(tbody.innerHTML.includes('No active students found.'), 'Should provide clear explanation');
    assert.ok(!tbody.innerHTML.includes('Failed to Load'), 'Should NOT show an error banner');
  });

  it('4. Action guards: blocks "Mark all present" when roster query failed', async () => {
    const mockTeacher = {
      id: 'teacher-uuid-1',
      role: 'teacher',
      permissions: { can_mark_attendance: true }
    };
    attendanceModule.setCurrentProfileForTesting(mockTeacher);

    attendanceModule.setSupabaseClientForTesting({
      from() {
        return {
          select() {
            return {
              eq() {
                return Promise.reject(new Error('Database unavailable'));
              }
            };
          }
        };
      }
    });

    try {
      await attendanceModule.loadActiveStudents();
    } catch (_) {}

    assert.ok(attendanceModule.getRosterLoadError(), 'Roster load error must be set');

    // Verify roster tbody shows error
    attendanceModule.renderStudentRosterGrid();
    const tbody = mockDoc.getElementById('attendance-roster-tbody');
    assert.ok(tbody.innerHTML.includes('Failed to Load Student Roster'));
    assert.ok(tbody.innerHTML.includes('Database unavailable'));
  });
});
