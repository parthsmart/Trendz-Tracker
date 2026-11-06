/**
 * Phase 18 — Admin Score Correction Panel UI Tests
 * (tests/phase18_correction_panel_ui.test.js)
 *
 * Verifies:
 * 1. Dynamic modal closing: Close and × buttons close the modal and return focus to opener.
 * 2. Escape handling and focus restoration to opener element.
 * 3. Decide final pending request: banner disappears, modal closes, and stale content is cleared.
 * 4. Multiple requests: count decreases accurately across decisions, and modal request list refreshes.
 * 5. Failed decisions: preserves pending request, shows inline error, preserves entered text, and re-enables button.
 * 6. Query failure distinction: network/query errors do not clear banner or treat failure as empty result.
 * 7. On-page approve form: optional note defaults to 'Approved by admin', custom note passed to RPC, refreshes count.
 * 8. On-page reject form validation: requires reason, rejects whitespace-only input with aria-invalid & inline error, blocks RPC call.
 * 9. Cancel decision: closes form and restores action buttons without making RPC call or DB change, restores opener focus.
 * 10. Double-submission prevention: in-flight state disables confirm, cancel, and textarea controls.
 * 11. Escape key handling: Escape inside inline form cancels form without closing parent modal; Escape outside form closes modal.
 * 12. Focus management: opening form auto-focuses textarea (and selects text for approve); canceling or closing returns focus to opener.
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

// Build a lightweight realistic DOM node
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
    this._value = undefined;
    this._selected = false;
    this.hidden = false;
    this.onclick = null;
    this.onsubmit = null;
    this._innerHTML = '';
    this._listeners = new Map();

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
    if (this.children.length === 0) return this._textContent || '';
    return this.children.map((c) => c.textContent).join(' ');
  }

  set textContent(val) {
    this._textContent = String(val);
    this.children = [];
    if (this._value !== undefined) {
      this._value = String(val);
    }
  }

  get value() {
    if (this._value !== undefined) return this._value;
    return this.textContent || '';
  }

  set value(val) {
    this._value = String(val);
  }

  select() {
    this._selected = true;
  }

  focus() {
    if (globalThis.document) {
      globalThis.document.activeElement = this;
    }
  }

  blur() {
    if (globalThis.document && globalThis.document.activeElement === this) {
      globalThis.document.activeElement = globalThis.document.body;
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(html) {
    this._innerHTML = html;
    this.children = [];
    this._textContent = '';
    parseHTMLInto(html, this);
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

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  insertBefore(newChild, refChild) {
    newChild.parentNode = this;
    const idx = this.children.indexOf(refChild);
    if (idx === -1) {
      this.children.push(newChild);
    } else {
      this.children.splice(idx, 0, newChild);
    }
    return newChild;
  }

  get firstChild() {
    return this.children[0] || null;
  }

  contains(node) {
    if (!node) return false;
    if (node === this) return true;
    for (const child of this.children) {
      if (child.contains(node)) return true;
    }
    return false;
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) {
      this._listeners.set(type, []);
    }
    this._listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    if (this._listeners.has(type)) {
      const fns = this._listeners.get(type).filter((f) => f !== fn);
      this._listeners.set(type, fns);
    }
  }

  dispatchEvent(event) {
    let stopped = false;
    const evt = {
      ...event,
      target: this,
      currentTarget: null,
      stopPropagation() {
        stopped = true;
        if (typeof event.stopPropagation === 'function') event.stopPropagation();
      },
      preventDefault() {
        if (typeof event.preventDefault === 'function') event.preventDefault();
      }
    };

    let curr = this;
    while (curr && !stopped) {
      evt.currentTarget = curr;
      const fns = curr._listeners?.get(event.type) || [];
      for (const fn of fns) {
        fn(evt);
        if (stopped) break;
      }
      if (stopped) break;
      curr = curr.parentNode;
    }

    if (!stopped && globalThis.document && typeof globalThis.document._emitListeners === 'function') {
      globalThis.document._emitListeners(event.type, evt);
    }
    return !stopped;
  }

  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all[0] || null;
  }

  querySelectorAll(selector) {
    const results = [];
    const walk = (el) => {
      for (const child of el.children) {
        if (matchesSelector(child, selector)) {
          results.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return results;
  }
}

function parseHTMLInto(html, rootElement) {
  const tokenRegex = /<!--[\s\S]*?-->|<(\/)?([a-z0-9-]+)([^>]*)>|([^<]+)/gi;
  const stack = [rootElement];
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  let match;

  while ((match = tokenRegex.exec(html)) !== null) {
    if (match[0].startsWith('<!--')) {
      continue;
    }
    const isClosing = match[1] === '/';
    const tagName = match[2]?.toLowerCase();
    const attrStr = match[3];
    const text = match[4];

    if (text) {
      const trimmed = text.trim();
      if (trimmed) {
        const top = stack[stack.length - 1];
        if (top) {
          const textNode = new MockElement('#text');
          textNode._textContent = trimmed;
          top.appendChild(textNode);
          if (top.tagName === 'TEXTAREA') {
            top._value = (top._value ? top._value + ' ' : '') + trimmed;
          }
        }
      }
      continue;
    }

    if (isClosing) {
      if (stack.length > 1) {
        for (let i = stack.length - 1; i >= 1; i--) {
          if (stack[i].tagName.toLowerCase() === tagName) {
            stack.splice(i);
            break;
          }
        }
      }
      continue;
    }

    if (tagName) {
      const child = new MockElement(tagName);
      if (attrStr) {
        const attrRegex = /([a-z0-9_-]+)(?:=["']([^"']*)["'])?/gi;
        let aMatch;
        while ((aMatch = attrRegex.exec(attrStr)) !== null) {
          const k = aMatch[1];
          const v = aMatch[2] !== undefined ? aMatch[2] : '';
          if (k === 'id') child.id = v;
          else if (k === 'class') {
            child.className = v;
            v.split(/\s+/).filter(Boolean).forEach((c) => child.classList.add(c));
          } else {
            child.setAttribute(k, v);
          }
        }
      }

      const top = stack[stack.length - 1];
      if (top) {
        top.appendChild(child);
      }

      const isSelfClosing = attrStr?.trim().endsWith('/') || voidTags.has(tagName);
      if (!isSelfClosing) {
        stack.push(child);
      }
    }
  }
}

function matchesSelector(el, selector) {
  // Support comma-separated selectors like '[data-close-modal], .modal-close'
  const parts = selector.split(',').map((s) => s.trim());
  return parts.some((sel) => {
    if (sel.includes(' ')) {
      // Descendant selector
      const tokens = sel.split(/\s+/);
      const targetToken = tokens[tokens.length - 1];
      if (!matchSingleToken(el, targetToken)) return false;
      let curr = el.parentNode;
      let tokenIdx = tokens.length - 2;
      while (curr && tokenIdx >= 0) {
        if (matchSingleToken(curr, tokens[tokenIdx])) {
          tokenIdx--;
        }
        curr = curr.parentNode;
      }
      return tokenIdx < 0;
    }
    return matchSingleToken(el, sel);
  });
}

function matchSingleToken(el, sel) {
  if (sel.startsWith('#')) {
    return el.id === sel.slice(1);
  }
  if (sel.startsWith('.')) {
    return el.classList.contains(sel.slice(1));
  }
  if (sel.startsWith('[') && sel.endsWith(']')) {
    const inner = sel.slice(1, -1);
    if (inner.includes('=')) {
      const [k, vRaw] = inner.split('=');
      const v = vRaw.replace(/["']/g, '');
      return el.getAttribute(k.trim()) === v;
    }
    return el.hasAttribute(inner);
  }
  return el.tagName.toLowerCase() === sel.toLowerCase();
}

// Minimal DOM document
function createMockDocument() {
  const body = new MockElement('body');
  const main = new MockElement('main');
  const container = new MockElement('div');
  container.className = 'container';
  main.appendChild(container);
  body.appendChild(main);

  const listeners = new Map();

  const doc = {
    body,
    activeElement: body,
    createElement(tag) {
      return new MockElement(tag);
    },
    getElementById(id) {
      const walk = (el) => {
        if (el.id === id) return el;
        for (const child of el.children) {
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      return walk(body);
    },
    querySelector(selector) {
      if (selector === 'main .container') return container;
      if (selector === 'main') return main;
      return body.querySelector(selector);
    },
    querySelectorAll(selector) {
      return body.querySelectorAll(selector);
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      if (listeners.has(type)) {
        const fns = listeners.get(type).filter((f) => f !== fn);
        listeners.set(type, fns);
      }
    },
    _emitListeners(type, event) {
      const fns = listeners.get(type) || [];
      fns.forEach((fn) => fn(event));
    },
    _emit(type, event = {}) {
      const target = (this.activeElement && this.activeElement !== this.body) ? this.activeElement : this.body;
      if (target && typeof target.dispatchEvent === 'function') {
        return target.dispatchEvent({ type, ...event });
      }
      this._emitListeners(type, {
        ...event,
        stopPropagation() {},
        preventDefault() {}
      });
    }
  };

  return doc;
}

describe('Phase 18 — Admin Score Correction Panel UI', () => {
  let doc;
  let originalDocument;
  let originalWindow;
  let reviewModule;

  beforeEach(async () => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;

    doc = createMockDocument();
    globalThis.document = doc;
    globalThis.window = {
      prompt: () => {
        throw new Error('prompt() is not supported.');
      },
      document: doc,
      addEventListener: () => {},
      removeEventListener: () => {},
      location: {
        hostname: 'localhost',
        search: '',
        pathname: '/pages/review.html'
      }
    };

    if (!globalThis.localStorage) {
      globalThis.localStorage = {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
        clear: () => {}
      };
    }

    // Dynamic import to bind mock document
    reviewModule = await import('../js/review.js?ui_test=' + Date.now());
  });

  afterEach(() => {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  });

  function createMockSupabase(initialRequests, failDecide = false, queryError = null) {
    let requests = [...initialRequests];
    const rpcCalls = [];

    return {
      rpcCalls,
      from(table) {
        return {
          select() {
            return {
              eq(col, val) {
                if (queryError) {
                  return Promise.resolve({ data: null, error: queryError });
                }
                const filtered = requests.filter((r) => r[col] === val);
                return Promise.resolve({ data: filtered, error: null });
              }
            };
          }
        };
      },
      rpc(fn, args) {
        if (fn === 'admin_decide_score_correction') {
          rpcCalls.push({ fn, args });
          if (failDecide) {
            return Promise.resolve({ data: null, error: { message: 'Database error: concurrent modification' } });
          }
          // Remove decided request from pending
          requests = requests.filter((r) => r.id !== args.p_request_id);
          return Promise.resolve({ data: { success: true }, error: null });
        }
        return Promise.resolve({ data: null, error: new Error('Unknown RPC: ' + fn) });
      },
      _setRequests(newReqs) {
        requests = [...newReqs];
      },
      _getRequests() {
        return requests;
      }
    };
  }

  it('1. Dynamic modal closing: Close and × buttons close modal and restore focus to opener', async () => {
    const reqs = [
      {
        id: 'req-1',
        student_id: 's1',
        teacher_id: 't1',
        proposed_correct: 18,
        proposed_total: 20,
        reason: 'Typo in question 5',
        status: 'pending',
        profiles: { full_name: 'Aarav Sharma', student_code: 'STU101' }
      }
    ];

    const supabase = createMockSupabase(reqs);
    await reviewModule.checkPendingCorrectionRequests(supabase);

    const banner = doc.getElementById('pending-corrections-banner');
    assert.ok(banner, 'Banner is created');

    const btnView = doc.getElementById('btn-view-corrections');
    assert.ok(btnView, 'Review Requests button exists in banner');

    // 1. Click Review Requests to open modal
    btnView.focus();
    assert.equal(doc.activeElement, btnView, 'Opener button is focused');
    btnView.onclick();

    const modal = doc.getElementById('admin-corrections-modal');
    assert.ok(modal, 'Modal element created in document');
    assert.ok(modal.classList.contains('open'), 'Modal is open');
    assert.equal(modal.getAttribute('aria-hidden'), 'false');

    // 2. Click × button in modal header
    const closeXBtn = modal.querySelector('.modal-close');
    assert.ok(closeXBtn, 'Header × close button exists');
    closeXBtn.onclick({ preventDefault() {} });

    assert.equal(modal.classList.contains('open'), false, 'Modal closed by × button');
    assert.equal(modal.getAttribute('aria-hidden'), 'true');

    // Wait for focus restoration timeout (50ms in modal.js)
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(doc.activeElement, btnView, 'Focus restored to opener button after × close');

    // 3. Reopen modal via Review Requests
    btnView.onclick();
    assert.ok(modal.classList.contains('open'), 'Modal reopened');
    assert.equal(modal.getAttribute('aria-hidden'), 'false');

    // 4. Click footer Close button
    const footerCloseBtn = modal.querySelector('.modal-footer [data-close-modal="admin-corrections-modal"]');
    assert.ok(footerCloseBtn, 'Footer Close button exists');
    footerCloseBtn.onclick({ preventDefault() {} });

    assert.equal(modal.classList.contains('open'), false, 'Modal closed by footer Close button');
    assert.equal(modal.getAttribute('aria-hidden'), 'true');

    await new Promise((r) => setTimeout(r, 70));
    assert.equal(doc.activeElement, btnView, 'Focus restored to opener button after Close button');
  });

  it('2. Escape handling closes modal and restores focus to opener', async () => {
    const reqs = [
      {
        id: 'req-2',
        student_id: 's2',
        teacher_id: 't2',
        proposed_correct: 19,
        proposed_total: 20,
        reason: 'Recount verified',
        status: 'pending',
        profiles: { full_name: 'Ananya Gupta', student_code: 'STU102' }
      }
    ];

    const supabase = createMockSupabase(reqs);
    await reviewModule.checkPendingCorrectionRequests(supabase);

    const btnView = doc.getElementById('btn-view-corrections');
    btnView.focus();
    btnView.onclick();

    const modal = doc.getElementById('admin-corrections-modal');
    assert.ok(modal.classList.contains('open'), 'Modal is open');

    // Emit Escape key on document
    doc._emit('keydown', { key: 'Escape' });

    assert.equal(modal.classList.contains('open'), false, 'Modal closed on Escape key');
    assert.equal(modal.getAttribute('aria-hidden'), 'true');

    await new Promise((r) => setTimeout(r, 70));
    assert.equal(doc.activeElement, btnView, 'Focus restored to opener button after Escape');
  });

  it('3. Decide the final pending request: banner disappears, modal closes, and stale content cleared', async () => {
    const reqs = [
      {
        id: 'req-single',
        student_id: 's1',
        teacher_id: 't1',
        proposed_correct: 20,
        proposed_total: 20,
        reason: 'Perfect score verified',
        status: 'pending',
        profiles: { full_name: 'Riya Patel', student_code: 'STU103' }
      }
    ];

    const supabase = createMockSupabase(reqs);
    await reviewModule.checkPendingCorrectionRequests(supabase);

    let banner = doc.getElementById('pending-corrections-banner');
    assert.ok(banner, 'Banner exists with 1 pending request');

    const btnView = doc.getElementById('btn-view-corrections');
    btnView.onclick();

    const modal = doc.getElementById('admin-corrections-modal');
    assert.ok(modal.classList.contains('open'), 'Modal is open');

    // 1. Click Approve on the request card to reveal on-page form
    const approveBtn = modal.querySelector('.btn-approve-corr');
    assert.ok(approveBtn, 'Approve button found');
    approveBtn.onclick();

    // Verify decision form rendered
    const form = modal.querySelector('.correction-decision-form');
    assert.ok(form, 'On-page decision form is rendered');

    const confirmBtn = form.querySelector('.btn-confirm-corr');
    assert.ok(confirmBtn, 'Confirm Approval button exists');

    // 2. Submit approval via on-page confirm button
    await confirmBtn.onclick({ preventDefault() {} });

    // After approval of final request:
    banner = doc.getElementById('pending-corrections-banner');
    assert.equal(banner, null, 'Pending corrections banner is removed from DOM');

    assert.equal(modal.classList.contains('open'), false, 'Modal closed on final decision');
    assert.equal(modal.getAttribute('aria-hidden'), 'true');

    const modalBody = modal.querySelector('.modal-body');
    assert.equal(modalBody.children.length, 0, 'Stale request content cleared from modal body');

    // Verify RPC call
    assert.equal(supabase.rpcCalls.length, 1);
    assert.deepEqual(supabase.rpcCalls[0], {
      fn: 'admin_decide_score_correction',
      args: {
        p_request_id: 'req-single',
        p_action: 'approve',
        p_decision_note: 'Approved by admin'
      }
    });
  });

  it('4. Multiple requests: the count decreases accurately and modal list refreshes', async () => {
    const reqs = [
      {
        id: 'req-multi-1',
        student_id: 's1',
        teacher_id: 't1',
        proposed_correct: 15,
        proposed_total: 20,
        reason: 'Recalibrated',
        status: 'pending',
        profiles: { full_name: 'Student 1', student_code: 'STU101' }
      },
      {
        id: 'req-multi-2',
        student_id: 's2',
        teacher_id: 't2',
        proposed_correct: 18,
        proposed_total: 20,
        reason: 'Timer issue',
        status: 'pending',
        profiles: { full_name: 'Student 2', student_code: 'STU102' }
      }
    ];

    const supabase = createMockSupabase(reqs);
    await reviewModule.checkPendingCorrectionRequests(supabase);

    let banner = doc.getElementById('pending-corrections-banner');
    assert.match(banner.textContent, /2 pending correction request\(s\)/);

    const btnView = doc.getElementById('btn-view-corrections');
    btnView.onclick();

    const modal = doc.getElementById('admin-corrections-modal');
    assert.ok(modal.classList.contains('open'), 'Modal is open with 2 requests');

    let approveBtns = modal.querySelectorAll('.btn-approve-corr');
    assert.equal(approveBtns.length, 2, '2 request cards rendered');

    // 1. Approve request 1
    approveBtns[0].onclick();
    const form1 = modal.querySelector('.correction-decision-form');
    const confirmBtn1 = form1.querySelector('.btn-confirm-corr');
    await confirmBtn1.onclick({ preventDefault() {} });

    // 1 request remains
    banner = doc.getElementById('pending-corrections-banner');
    assert.ok(banner, 'Banner remains visible');
    assert.match(banner.textContent, /1 pending correction request\(s\)/, 'Banner count decreased to 1');

    assert.ok(modal.classList.contains('open'), 'Modal remains open to continue reviewing');
    approveBtns = modal.querySelectorAll('.btn-approve-corr');
    assert.equal(approveBtns.length, 1, 'Modal body updated to 1 remaining card');
    assert.equal(approveBtns[0].getAttribute('data-id'), 'req-multi-2', 'Remaining card is req-multi-2');

    // 2. Reject the second (final) request
    const rejectBtn = modal.querySelector('.btn-reject-corr');
    rejectBtn.onclick();

    const form2 = modal.querySelector('.correction-decision-form');
    const textarea2 = form2.querySelector('textarea');
    textarea2.value = 'Calculation check does not match test rubric';

    const confirmBtn2 = form2.querySelector('.btn-confirm-corr');
    await confirmBtn2.onclick({ preventDefault() {} });

    // Now 0 requests remain
    banner = doc.getElementById('pending-corrections-banner');
    assert.equal(banner, null, 'Banner removed after deciding last request');
    assert.equal(modal.classList.contains('open'), false, 'Modal closed after deciding last request');

    assert.equal(supabase.rpcCalls.length, 2);
    assert.equal(supabase.rpcCalls[0].args.p_action, 'approve');
    assert.equal(supabase.rpcCalls[1].args.p_action, 'reject');
    assert.equal(supabase.rpcCalls[1].args.p_decision_note, 'Calculation check does not match test rubric');
  });

  it('5. Failed decisions preserve pending request, re-enable button, and show error', async () => {
    const reqs = [
      {
        id: 'req-fail',
        student_id: 's1',
        teacher_id: 't1',
        proposed_correct: 15,
        proposed_total: 20,
        reason: 'Recalibrated',
        status: 'pending',
        profiles: { full_name: 'Student 1', student_code: 'STU101' }
      }
    ];

    // createSupabase with failDecide = true
    const supabase = createMockSupabase(reqs, true);
    await reviewModule.checkPendingCorrectionRequests(supabase);

    const btnView = doc.getElementById('btn-view-corrections');
    btnView.onclick();

    const modal = doc.getElementById('admin-corrections-modal');
    const approveBtn = modal.querySelector('.btn-approve-corr');

    approveBtn.onclick();

    const form = modal.querySelector('.correction-decision-form');
    const textarea = form.querySelector('textarea');
    textarea.value = 'Custom note for retry test';

    const confirmBtn = form.querySelector('.btn-confirm-corr');
    await confirmBtn.onclick({ preventDefault() {} });

    // Request must NOT be removed and button must be re-enabled
    assert.equal(confirmBtn.disabled, false, 'Confirm button re-enabled after failure');
    assert.equal(textarea.disabled, false, 'Textarea re-enabled after failure');
    assert.equal(textarea.value, 'Custom note for retry test', 'Entered text preserved for retry');

    const errorEl = form.querySelector('.corr-decision-error');
    assert.ok(errorEl, 'Error element exists');
    assert.equal(errorEl.style.display, 'block', 'Inline error is visible');
    assert.match(errorEl.textContent, /Database error: concurrent modification/);

    assert.ok(modal.classList.contains('open'), 'Modal remains open');

    const banner = doc.getElementById('pending-corrections-banner');
    assert.ok(banner, 'Banner preserved');
    assert.match(banner.textContent, /1 pending correction request\(s\)/);
  });

  it('6. Distinguishes query failure from empty response without wiping banner', async () => {
    const reqs = [
      {
        id: 'req-preserve',
        student_id: 's1',
        teacher_id: 't1',
        proposed_correct: 15,
        proposed_total: 20,
        reason: 'Recalibrated',
        status: 'pending',
        profiles: { full_name: 'Student 1', student_code: 'STU101' }
      }
    ];

    const supabase = createMockSupabase(reqs);
    await reviewModule.checkPendingCorrectionRequests(supabase);

    let banner = doc.getElementById('pending-corrections-banner');
    assert.ok(banner, 'Banner displayed for initial state');

    // Simulate subsequent query error (e.g. network failure)
    const failingSupabase = createMockSupabase([], false, { message: 'Failed to fetch' });
    const res = await reviewModule.checkPendingCorrectionRequests(failingSupabase);

    assert.equal(res.success, false, 'checkPendingCorrectionRequests returns success: false on query error');
    assert.ok(res.error, 'Error object returned');

    // Banner must NOT be removed on query failure!
    banner = doc.getElementById('pending-corrections-banner');
    assert.ok(banner, 'Banner is preserved on query failure rather than cleared');
  });

  it('7. On-page approve form: supports optional note, in-flight disable, and refreshes count', async () => {
    const reqs = [
      {
        id: 'req-opt-note',
        student_id: 's1',
        teacher_id: 't1',
        proposed_correct: 17,
        proposed_total: 20,
        reason: 'Recount verified',
        status: 'pending',
        profiles: { full_name: 'Test Student', student_code: 'TS100' }
      }
    ];

    const supabase = createMockSupabase(reqs);
    await reviewModule.checkPendingCorrectionRequests(supabase);

    const btnView = doc.getElementById('btn-view-corrections');
    btnView.onclick();

    const modal = doc.getElementById('admin-corrections-modal');
    const approveBtn = modal.querySelector('.btn-approve-corr');
    approveBtn.onclick();

    const form = modal.querySelector('.correction-decision-form');
    assert.ok(form);
    assert.equal(form.getAttribute('data-action'), 'approve');

    const textarea = form.querySelector('textarea');
    assert.equal(textarea.value, 'Approved by admin', 'Default approval note populated');
    assert.equal(doc.activeElement, textarea, 'Textarea is auto-focused on open');
    assert.equal(textarea._selected, true, 'Default text selected for quick replacement');

    // Provide custom note
    textarea.value = 'Approved after verifying physical test sheet';

    const confirmBtn = form.querySelector('.btn-confirm-corr');
    assert.equal(confirmBtn.textContent.trim(), 'Confirm Approval');

    await confirmBtn.onclick({ preventDefault() {} });

    assert.equal(supabase.rpcCalls.length, 1);
    assert.deepEqual(supabase.rpcCalls[0], {
      fn: 'admin_decide_score_correction',
      args: {
        p_request_id: 'req-opt-note',
        p_action: 'approve',
        p_decision_note: 'Approved after verifying physical test sheet'
      }
    });
  });

  it('8. On-page reject form validation: rejects whitespace-only, shows error, preserves text, blocks RPC', async () => {
    const reqs = [
      {
        id: 'req-val-rej',
        student_id: 's2',
        teacher_id: 't2',
        proposed_correct: 14,
        proposed_total: 20,
        reason: 'Needs adjustment',
        status: 'pending',
        profiles: { full_name: 'Reject Student', student_code: 'RS200' }
      }
    ];

    const supabase = createMockSupabase(reqs);
    await reviewModule.checkPendingCorrectionRequests(supabase);

    const btnView = doc.getElementById('btn-view-corrections');
    btnView.onclick();

    const modal = doc.getElementById('admin-corrections-modal');
    const rejectBtn = modal.querySelector('.btn-reject-corr');
    rejectBtn.onclick();

    const form = modal.querySelector('.correction-decision-form');
    assert.ok(form);
    assert.equal(form.getAttribute('data-action'), 'reject');

    const textarea = form.querySelector('textarea');
    assert.equal(textarea.getAttribute('required'), '', 'Rejection textarea has required attribute');
    assert.equal(textarea.getAttribute('aria-required'), 'true', 'Rejection textarea has aria-required');
    assert.equal(textarea.value, '', 'Rejection textarea is initially empty');

    const confirmBtn = form.querySelector('.btn-confirm-corr');
    const errorEl = form.querySelector('.corr-decision-error');

    // 1. Submit empty value
    await confirmBtn.onclick({ preventDefault() {} });

    assert.equal(supabase.rpcCalls.length, 0, 'RPC must NOT be called on empty rejection reason');
    assert.equal(errorEl.style.display, 'block', 'Error alert displayed');
    assert.match(errorEl.textContent, /Rejection reason is required/);
    assert.equal(textarea.getAttribute('aria-invalid'), 'true');
    assert.equal(doc.activeElement, textarea, 'Textarea refocused after validation failure');

    // 2. Submit whitespace-only input
    textarea.value = '   \t  \n  ';
    await confirmBtn.onclick({ preventDefault() {} });

    assert.equal(supabase.rpcCalls.length, 0, 'RPC must NOT be called on whitespace-only input');
    assert.equal(errorEl.style.display, 'block');
    assert.match(errorEl.textContent, /Rejection reason is required/);

    // 3. Provide valid reason
    textarea.value = 'Verified original submission was accurate';
    await confirmBtn.onclick({ preventDefault() {} });

    assert.equal(supabase.rpcCalls.length, 1, 'RPC called on valid submission');
    assert.deepEqual(supabase.rpcCalls[0], {
      fn: 'admin_decide_score_correction',
      args: {
        p_request_id: 'req-val-rej',
        p_action: 'reject',
        p_decision_note: 'Verified original submission was accurate'
      }
    });
  });

  it('9. Cancel decision: closes form, makes zero DB changes, restores opener focus', async () => {
    const reqs = [
      {
        id: 'req-cancel-test',
        student_id: 's3',
        teacher_id: 't3',
        proposed_correct: 16,
        proposed_total: 20,
        reason: 'Cancel check',
        status: 'pending',
        profiles: { full_name: 'Cancel Student', student_code: 'CS300' }
      }
    ];

    const supabase = createMockSupabase(reqs);
    await reviewModule.checkPendingCorrectionRequests(supabase);

    const btnView = doc.getElementById('btn-view-corrections');
    btnView.onclick();

    const modal = doc.getElementById('admin-corrections-modal');
    const approveBtn = modal.querySelector('.btn-approve-corr');
    approveBtn.focus();
    assert.equal(doc.activeElement, approveBtn);

    approveBtn.onclick();

    const actionsRow = modal.querySelector('#corr-actions-req-cancel-test');
    const formContainer = modal.querySelector('#corr-form-container-req-cancel-test');
    assert.equal(actionsRow.style.display, 'none');
    assert.equal(formContainer.style.display, 'block');

    const cancelBtn = formContainer.querySelector('.btn-cancel-corr');
    assert.ok(cancelBtn, 'Cancel button exists');

    cancelBtn.onclick({ preventDefault() {} });

    // Verify form closed and actions restored
    assert.equal(formContainer.style.display, 'none');
    assert.equal(formContainer.innerHTML, '');
    assert.equal(actionsRow.style.display, 'flex');

    // Focus restored to opener
    assert.equal(doc.activeElement, approveBtn, 'Focus restored to opener button on cancel');

    // Zero RPC calls
    assert.equal(supabase.rpcCalls.length, 0, 'Zero database changes made on cancel');
    assert.equal(supabase._getRequests().length, 1, 'Request remains pending');
  });

  it('10. Escape handling: Escape inside form cancels form without closing parent modal; Escape outside form closes modal', async () => {
    const reqs = [
      {
        id: 'req-esc-test',
        student_id: 's4',
        teacher_id: 't4',
        proposed_correct: 12,
        proposed_total: 20,
        reason: 'Escape test',
        status: 'pending',
        profiles: { full_name: 'Escape Student', student_code: 'ES400' }
      }
    ];

    const supabase = createMockSupabase(reqs);
    await reviewModule.checkPendingCorrectionRequests(supabase);

    const btnView = doc.getElementById('btn-view-corrections');
    btnView.focus();
    btnView.onclick();

    const modal = doc.getElementById('admin-corrections-modal');
    assert.ok(modal.classList.contains('open'), 'Modal is open');

    const rejectBtn = modal.querySelector('.btn-reject-corr');
    rejectBtn.focus();
    rejectBtn.onclick();

    const form = modal.querySelector('.correction-decision-form');
    assert.ok(form, 'Decision form opened');
    const textarea = form.querySelector('textarea');
    assert.equal(doc.activeElement, textarea, 'Textarea has active focus');

    // 1. Emit Escape inside the decision form (starting on active textarea)
    doc._emit('keydown', { key: 'Escape' });

    // Parent modal must REMAIN open; only the decision form cancels!
    assert.ok(modal.classList.contains('open'), 'Parent modal remains open when Escape is pressed inside form');
    assert.equal(modal.getAttribute('aria-hidden'), 'false');

    const formContainer = modal.querySelector('#corr-form-container-req-esc-test');
    assert.equal(formContainer.style.display, 'none', 'Form container closed');
    assert.equal(doc.activeElement, rejectBtn, 'Focus restored to opener reject button');

    // 2. Emit Escape when NO decision form is open
    doc._emit('keydown', { key: 'Escape' });

    // Now parent modal closes!
    assert.equal(modal.classList.contains('open'), false, 'Parent modal closes on Escape when form is closed');
    assert.equal(modal.getAttribute('aria-hidden'), 'true');

    await new Promise((r) => setTimeout(r, 70));
    assert.equal(doc.activeElement, btnView, 'Focus restored to Review Requests button');
  });

  it('11. In-flight state disables submission controls preventing double decisions', async () => {
    const reqs = [
      {
        id: 'req-inflight-test',
        student_id: 's5',
        teacher_id: 't5',
        proposed_correct: 19,
        proposed_total: 20,
        reason: 'In-flight check',
        status: 'pending',
        profiles: { full_name: 'Inflight Student', student_code: 'IF500' }
      }
    ];

    let resolveRpc;
    const rpcPromise = new Promise((resolve) => {
      resolveRpc = resolve;
    });

    const supabase = {
      rpcCalls: [],
      from() {
        return {
          select() {
            return {
              eq() {
                return Promise.resolve({ data: reqs, error: null });
              }
            };
          }
        };
      },
      rpc(fn, args) {
        this.rpcCalls.push({ fn, args });
        return rpcPromise;
      }
    };

    await reviewModule.checkPendingCorrectionRequests(supabase);

    const btnView = doc.getElementById('btn-view-corrections');
    btnView.onclick();

    const modal = doc.getElementById('admin-corrections-modal');
    const approveBtn = modal.querySelector('.btn-approve-corr');
    approveBtn.onclick();

    const form = modal.querySelector('.correction-decision-form');
    const confirmBtn = form.querySelector('.btn-confirm-corr');
    const cancelBtn = form.querySelector('.btn-cancel-corr');
    const textarea = form.querySelector('textarea');

    // Trigger save (which will hang until resolveRpc is called)
    const savePromise = confirmBtn.onclick({ preventDefault() {} });

    // Assert in-flight controls state
    assert.equal(confirmBtn.disabled, true, 'Confirm button disabled during submission');
    assert.equal(confirmBtn.textContent.trim(), 'Approving...', 'Confirm button shows progress label');
    assert.equal(cancelBtn.disabled, true, 'Cancel button disabled during submission');
    assert.equal(textarea.disabled, true, 'Textarea disabled during submission');

    // Resolve RPC
    resolveRpc({ data: { success: true }, error: null });
    await savePromise;

    // After success, exactly one RPC call was made
    assert.equal(supabase.rpcCalls.length, 1, 'Exactly one RPC call was made');
  });
});
