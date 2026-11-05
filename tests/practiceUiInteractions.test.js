import test from 'node:test';
import assert from 'node:assert/strict';
import { setupInfoTipDelegation, setupHistoryDetailsDelegation, positionTooltip } from '../js/infoTooltip.js';
import { practiceRecordStatus } from '../js/historyFilters.js';

class Element {
  constructor(classes = '', parent = null) {
    this.classes = classes.split(' '); this.parent = parent;
    this.attributes = new Map(); this.style = {}; this.children = [];
    this.classList = { add() {}, remove() {} };
    if (parent) parent.children.push(this);
  }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  removeAttribute(key) { this.attributes.delete(key); }
  hasAttribute(key) { return this.attributes.has(key); }
  closest(selector) { return this.classes.includes(selector.slice(1)) ? this : this.parent?.closest(selector) || null; }
  contains(node) { return !!node && (node === this || this.children.some((child) => child.contains(node))); }
  querySelector(selector) { return this.children.find((node) => node.classes.includes(selector.slice(1))) || null; }
  getBoundingClientRect() { return this.rect || { left: 180, top: 20, right: 208, bottom: 48, width: 28, height: 28 }; }
}
function fixture() {
  const listeners = new Map(); const wrapper = new Element('info-tip-wrapper');
  const trigger = new Element('info-tip-trigger', wrapper); const content = new Element('info-tip-content', wrapper);
  trigger.nextElementSibling = content; trigger.setAttribute('aria-expanded', 'false');
  const root = {
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
    querySelectorAll() { return trigger.getAttribute('aria-expanded') === 'true' ? [trigger] : []; },
  };
  const emit = (type, target = trigger, options = {}) => {
    const event = { target, preventDefault() {}, stopPropagation() {}, ...options };
    for (const fn of listeners.get(type) || []) fn(event);
  };
  setupInfoTipDelegation(root);
  return { root, wrapper, trigger, content, emit };
}
test('real delegated touch event order: pointerdown, focusin, click; second tap and outside tap close', () => {
  const { trigger, emit } = fixture();
  const tap = () => { emit('pointerdown', trigger, { pointerType: 'touch' }); emit('focusin'); emit('click'); };
  tap(); assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  tap(); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  tap(); emit('pointerdown', new Element()); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});
test('delegated keyboard focus, Escape dismissal, blur and a fresh focus', () => {
  const { trigger, emit } = fixture();
  emit('keydown', trigger, { key: 'Tab' }); emit('focusin');
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  emit('keydown', trigger, { key: 'Escape' }); emit('focusin');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  emit('focusout'); emit('focusin'); assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  emit('focusout'); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});
test('hover stays open while crossing to explanation, and Escape stays dismissed within the wrapper', async () => {
  const { trigger, content, emit } = fixture();
  emit('pointerover', trigger, { relatedTarget: null, pointerType: 'mouse' });
  emit('pointerout', trigger, { relatedTarget: null, pointerType: 'mouse' });
  emit('pointerover', content, { relatedTarget: null, pointerType: 'mouse' });
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  emit('keydown', trigger, { key: 'Escape' });
  emit('pointerover', content, { relatedTarget: trigger, pointerType: 'mouse' });
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  emit('pointerout', content, { relatedTarget: null, pointerType: 'mouse' });
  emit('pointerover', trigger, { relatedTarget: null, pointerType: 'mouse' });
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
});
test('delegated Details controls resolve separate Today and History instances of one record', () => {
  const previous = globalThis.document; const panels = new Map(); let click;
  for (const id of ['details-today-drill-123', 'details-history-drill-123']) {
    const panel = new Element(); panel.setAttribute('hidden', ''); panels.set(id, panel);
  }
  globalThis.document = { addEventListener(type, fn) { if (type === 'click') click = fn; }, getElementById: (id) => panels.get(id) };
  try {
    setupHistoryDetailsDelegation();
    const button = new Element('btn-history-details'); button.setAttribute('data-details-toggle', 'details-history-drill-123');
    click({ target: button, preventDefault() {} });
    assert.equal(panels.get('details-history-drill-123').hasAttribute('hidden'), false);
    assert.equal(panels.get('details-today-drill-123').hasAttribute('hidden'), true);
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    click({ target: button, preventDefault() {} });
    assert.equal(panels.get('details-history-drill-123').hasAttribute('hidden'), true);
  } finally { globalThis.document = previous; }
});
test('legacy/source/review are independent, and read-only never implies teacher approval', () => {
  assert.match(practiceRecordStatus({}, { readOnly: true }), /Verification not recorded.*Read-only/s);
  assert.doesNotMatch(practiceRecordStatus({ source: 'site' }), /teacher|automatically verified/);
  assert.match(practiceRecordStatus({ source: 'site', verified: true }), /^Verified<br>/);
  assert.match(practiceRecordStatus({ verified_by: 'teacher' }), /Verified by teacher/);
  assert.match(practiceRecordStatus({ corrected_at: '2026-11-05', verified: true }), /Corrected by teacher/);
});
test('positioning clamps both axes and falls below a trigger near the top', () => {
  const previous = globalThis.window;
  globalThis.window = { innerWidth: 375, innerHeight: 812 };
  try {
    const trigger = new Element(); const content = new Element();
    trigger.rect = { left: 350, top: 2, right: 375, bottom: 30, width: 25, height: 28 };
    content.rect = { width: 290, height: 120 };
    positionTooltip(trigger, content);
    assert.equal(content.style.left, '73px'); assert.equal(content.style.top, '38px');
    trigger.rect = { left: 0, top: 790, bottom: 812, width: 20, height: 22 };
    positionTooltip(trigger, content);
    assert.equal(content.style.left, '12px'); assert.equal(content.style.top, '662px');
  } finally { globalThis.window = previous; }
});
