import test from 'node:test';
import assert from 'node:assert/strict';
import { BASICS_MODES, initialBasicsMode, initializeBasicsExperience } from '../js/basicsExperience.js';

test('normal visits open online; existing Today category links open the paper form', () => {
  assert.equal(initialBasicsMode(''), 'online');
  assert.equal(initialBasicsMode('?cat=cat-bas-1'), 'paper');
  assert.equal(initialBasicsMode('?category_id=cat-bas-2'), 'paper');
  assert.equal(initialBasicsMode('?cat=cat-bas-1&view=online'), 'paper');
  assert.equal(initialBasicsMode('?view=history'), 'history');
  assert.equal(initialBasicsMode('?view=invalid'), 'online');
});

function fixture() {
  const nodes = new Map();
  for (const mode of BASICS_MODES) {
    for (const type of ['tab', 'panel']) {
      const node = {
        attrs: {}, listeners: {}, hidden: false, tabIndex: 0,
        setAttribute(key, value) { this.attrs[key] = value; },
        addEventListener(key, callback) { this.listeners[key] = callback; },
        focus() { this.focused = true; },
      };
      nodes.set(`basics-${type}-${mode}`, node);
    }
  }
  return { getElementById: id => nodes.get(id) };
}

test('only the selected panel is exposed and mode switches do not replace form content', () => {
  const root = fixture();
  const paper = root.getElementById('basics-panel-paper');
  paper.unsavedValue = '28';
  const view = initializeBasicsExperience(root);
  assert.equal(paper.hidden, true);
  view.show('paper');
  assert.equal(paper.hidden, false);
  assert.equal(root.getElementById('basics-panel-online').hidden, true);
  assert.equal(root.getElementById('basics-tab-paper').attrs['aria-selected'], 'true');
  assert.equal(root.getElementById('basics-tab-paper').tabIndex, 0);
  assert.equal(root.getElementById('basics-tab-online').tabIndex, -1);
  view.show('history');
  view.show('paper');
  assert.equal(paper.unsavedValue, '28');
});

test('keyboard arrows wrap between tabs and Home/End move focus to the correct panel', () => {
  const root = fixture();
  initializeBasicsExperience(root);
  let prevented = 0;
  const key = (mode, value) => root.getElementById(`basics-tab-${mode}`).listeners.keydown({
    key: value, preventDefault() { prevented++; }
  });
  key('online', 'ArrowLeft');
  assert.equal(root.getElementById('basics-tab-history').focused, true);
  assert.equal(root.getElementById('basics-panel-history').hidden, false);
  key('history', 'Home');
  assert.equal(root.getElementById('basics-panel-online').hidden, false);
  key('online', 'End');
  assert.equal(root.getElementById('basics-panel-history').hidden, false);
  key('history', 'ArrowRight');
  assert.equal(root.getElementById('basics-panel-online').hidden, false);
  assert.equal(prevented, 4);
});
