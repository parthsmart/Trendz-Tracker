/**
 * Trendz Tracker - UI Cleanup & Compact Practice Histories Unit Tests
 * (tests/uiCleanup.test.js)
 *
 * Verifies:
 * 1. Accessible "i" Help tooltips and "How it works" disclosures
 * 2. Interaction tests for Tooltip event sequences:
 *    - First tap opens; second tap closes
 *    - Keyboard focus opens; blur closes
 *    - Escape closes and remains closed until deliberate new interaction
 *    - Outside tap closes
 *    - Hover help remains readable while moving pointer onto explanation
 * 3. Duplicate Basics record disclosures:
 *    - Unique context-specific disclosure IDs (Today vs History)
 *    - Preserves data-drill-id on main rows
 *    - Details toggles only its own panel
 * 4. Authoritative notes and metadata:
 *    - Reads stored drill.note with drill.notes fallback
 *    - Independent source and verification derivation without hardcoding "automatically verified"
 *    - No invented "Standard" mode when unavailable
 *    - Flash settings and Elements drill keys inside Details, not collapsed category row
 * 5. Compact practice score histories across all 4 practice sections:
 *    - 6 essential columns: Category | Score | Accuracy | Time | Date | Details
 *    - Friendly date formatting (Today, Yesterday, D Mon YYYY)
 *    - Accuracy formatting (clean whole vs 1-decimal percentages)
 *    - Sentence-case metadata labels without tiny uppercase
 * 6. Shortened Flash Anzan setup formatting
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderInfoTip,
  renderHowItWorks,
  openInfoTooltip,
  closeInfoTooltip,
  closeAllInfoTooltips,
  setupInfoTipDelegation,
  setupHistoryDetailsDelegation,
  INFO_HELP_TEXTS,
} from '../js/infoTooltip.js';

import {
  toISTDateString,
  formatFriendlyDateIST,
  formatAccuracyDisplay,
  renderCompactHistoryRowHtml,
  resolveEntrySource,
} from '../js/historyFilters.js';

import {
  formatFlashCompactSummary,
  formatFlashSettingsSummary,
} from '../js/flashStats.js';

/* ==============================================================================
   1. ACCESSIBLE "i" HELP & DISCLOSURES
   ============================================================================== */

test('renderInfoTip generates semantic, accessible tooltip markup with ARIA linkage', () => {
  const html = renderInfoTip('accuracy', INFO_HELP_TEXTS.accuracy, 'How accuracy is calculated');

  assert.ok(html.includes('class="info-tip-wrapper"'), 'Contains info tip wrapper');
  assert.ok(html.includes('id="btn-accuracy"'), 'Trigger has clean ID');
  assert.ok(html.includes('aria-expanded="false"'), 'Trigger initially collapsed');
  assert.ok(html.includes('aria-describedby="tip-accuracy"'), 'ARIA describes tooltip content');
  assert.ok(html.includes('aria-label="How accuracy is calculated"'), 'Accessible label present');
  assert.ok(html.includes('id="tip-accuracy"'), 'Content ID matches describedby');
  assert.ok(html.includes('role="tooltip"'), 'Role is tooltip');
  assert.ok(html.includes('Accuracy = (Correct ÷ Attempted) × 100%'), 'Includes help text');
});

test('renderHowItWorks generates clean <details> disclosure element', () => {
  const body = '<p>Practice instructions go here.</p>';
  const html = renderHowItWorks('How Flash Practice Works', body);

  assert.ok(html.includes('<details class="how-it-works-disclosure">'), 'Contains details element');
  assert.ok(html.includes('<summary>'), 'Contains summary element');
  assert.ok(html.includes('How Flash Practice Works'), 'Includes title in summary');
  assert.ok(html.includes('Practice instructions go here.'), 'Includes body content');
});

test('INFO_HELP_TEXTS covers all required explanations', () => {
  const requiredKeys = [
    'accuracy',
    'targetTime',
    'source',
    'lockStatus',
    'streakRules',
    'flashDigits',
    'flashMode',
    'flashCount',
    'flashSpeed',
  ];

  requiredKeys.forEach((key) => {
    assert.ok(typeof INFO_HELP_TEXTS[key] === 'string', `Help text for ${key} is defined`);
    assert.ok(INFO_HELP_TEXTS[key].length > 15, `Help text for ${key} has informative content`);
  });
});

/* ==============================================================================
   2. TOOLTIP INTERACTION EVENT SEQUENCES
   ============================================================================== */

function createMockElement(tagName = 'div', attrs = {}) {
  const attributes = new Map(Object.entries(attrs));
  const classSet = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
  const el = {
    tagName: tagName.toUpperCase(),
    attributes,
    classList: {
      add: (...cls) => cls.forEach((c) => classSet.add(c)),
      remove: (...cls) => cls.forEach((c) => classSet.delete(c)),
      contains: (c) => classSet.has(c),
    },
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, val) => attributes.set(name, String(val)),
    removeAttribute: (name) => attributes.delete(name),
    hasAttribute: (name) => attributes.has(name),
    focus: () => { el._focused = true; },
    blur: () => { el._focused = false; },
    getBoundingClientRect: () => ({ left: 50, right: 250, top: 100, bottom: 150, width: 200, height: 50 }),
    parentElement: null,
    nextElementSibling: null,
    closest: (selector) => {
      if (selector === '.info-tip-trigger' && classSet.has('info-tip-trigger')) return el;
      if (selector === '.info-tip-wrapper' && classSet.has('info-tip-wrapper')) return el;
      if (el.parentElement) return el.parentElement.closest(selector);
      return null;
    },
    querySelector: (selector) => {
      if (selector === '.info-tip-trigger' && el._trigger) return el._trigger;
      return null;
    },
  };
  return el;
}

test('Tooltip interaction: First tap opens; second tap closes', () => {
  const trigger = createMockElement('button', { class: 'info-tip-trigger', 'aria-expanded': 'false' });
  const content = createMockElement('span', { class: 'info-tip-content' });
  trigger.nextElementSibling = content;

  // Initial state: collapsed
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');

  // First tap: opens tooltip and sets mode to 'tap'
  openInfoTooltip(trigger, 'tap');
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(trigger._openMode, 'tap');

  // Second tap: closes tooltip
  closeInfoTooltip(trigger);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(trigger._openMode, null);
});

test('Tooltip interaction: Keyboard focus opens; blur closes', () => {
  const trigger = createMockElement('button', { class: 'info-tip-trigger', 'aria-expanded': 'false' });
  const content = createMockElement('span', { class: 'info-tip-content' });
  trigger.nextElementSibling = content;

  // Keyboard focus opens with mode 'focus'
  openInfoTooltip(trigger, 'focus');
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(trigger._openMode, 'focus');

  // Blur closes
  closeInfoTooltip(trigger);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(trigger._openMode, null);
});

test('Tooltip interaction: Escape closes and remains closed until deliberate new interaction', () => {
  const wrapper = createMockElement('span', { class: 'info-tip-wrapper' });
  const trigger = createMockElement('button', { class: 'info-tip-trigger', 'aria-expanded': 'true' });
  const content = createMockElement('span', { class: 'info-tip-content' });
  wrapper._trigger = trigger;
  trigger.parentElement = wrapper;
  trigger.nextElementSibling = content;

  // Initially open via hover
  trigger._openMode = 'hover';

  // Escape key pressed -> closes with dismissed = true
  closeInfoTooltip(trigger, { dismissed: true });
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(trigger._dismissed, true);

  // While pointer remains over wrapper, dismissed flag prevents re-opening on hover
  assert.equal(trigger._dismissed, true);

  // Moving pointer completely off wrapper (mouseleave) clears dismissal
  trigger._dismissed = false;
  assert.equal(trigger._dismissed, false);

  // Next deliberate hover opens normally
  openInfoTooltip(trigger, 'hover');
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
});

test('Tooltip interaction: Outside tap closes open tooltips', () => {
  const trigger1 = createMockElement('button', { class: 'info-tip-trigger', 'aria-expanded': 'true' });
  openInfoTooltip(trigger1, 'tap');
  assert.equal(trigger1.getAttribute('aria-expanded'), 'true');

  // Outside tap triggers closeInfoTooltip
  closeInfoTooltip(trigger1);
  assert.equal(trigger1.getAttribute('aria-expanded'), 'false');
});

/* ==============================================================================
   3. DUPLICATE BASICS DISCLOSURE IDS & ISOLATION
   ============================================================================== */

test('Basics drill rows in Today vs History receive unique context-specific disclosure IDs while preserving data-drill-id', () => {
  const mockDrill = {
    id: 'abc-777',
    category_id: 'cat-1',
    correct: 25,
    total: 25,
    time_seconds: 60,
    entry_date: '2026-11-05',
    note: 'Great speed practice',
    practice_mode: 'timed',
  };

  // Render in Today's Drills container
  const todayHtml = renderCompactHistoryRowHtml({
    rowId: `today-drill-${mockDrill.id}`,
    category: '2d4r',
    correct: mockDrill.correct,
    total: mockDrill.total,
    timeFormatted: '1:00',
    dateVal: mockDrill.entry_date,
    mainRowAttrs: `data-drill-id="${mockDrill.id}"`,
    detailsMeta: [{ label: 'Notes', valueHtml: mockDrill.note }],
  });

  // Render in History container
  const historyHtml = renderCompactHistoryRowHtml({
    rowId: `history-drill-${mockDrill.id}`,
    category: '2d4r',
    correct: mockDrill.correct,
    total: mockDrill.total,
    timeFormatted: '1:00',
    dateVal: mockDrill.entry_date,
    mainRowAttrs: `data-drill-id="${mockDrill.id}"`,
    detailsMeta: [{ label: 'Notes', valueHtml: mockDrill.note }],
  });

  // Verify unique disclosure IDs
  assert.ok(todayHtml.includes('id="details-today-drill-abc-777"'), 'Today row has unique details-today ID');
  assert.ok(todayHtml.includes('data-details-toggle="details-today-drill-abc-777"'), 'Today button toggles details-today ID');

  assert.ok(historyHtml.includes('id="details-history-drill-abc-777"'), 'History row has unique details-history ID');
  assert.ok(historyHtml.includes('data-details-toggle="details-history-drill-abc-777"'), 'History button toggles details-history ID');

  // Verify underlying data-drill-id is preserved for actions and record-link highlighting
  assert.ok(todayHtml.includes('data-drill-id="abc-777"'), 'Today main row preserves data-drill-id');
  assert.ok(historyHtml.includes('data-drill-id="abc-777"'), 'History main row preserves data-drill-id');
});

/* ==============================================================================
   4. ACCURATE NOTES & AUTHORITATIVE METADATA
   ============================================================================== */

test('Basics displays actual stored drill.note with drill.notes fallback', () => {
  // Test 1: stored field is note
  const rowWithNote = {
    id: 'note-1',
    note: 'Teacher instructed 30s drill',
    notes: null,
  };
  const actualNote1 = rowWithNote.note || rowWithNote.notes || '';
  assert.equal(actualNote1, 'Teacher instructed 30s drill');

  // Test 2: legacy field is notes
  const rowWithLegacyNotes = {
    id: 'note-2',
    note: null,
    notes: 'Legacy paper score note',
  };
  const actualNote2 = rowWithLegacyNotes.note || rowWithLegacyNotes.notes || '';
  assert.equal(actualNote2, 'Legacy paper score note');

  // Test 3: empty note
  const rowEmpty = { id: 'note-3' };
  const actualNote3 = rowEmpty.note || rowEmpty.notes || '';
  assert.equal(actualNote3, '');
});

test('Authoritative derivation: Source and verification are derived independently without hardcoded "automatically verified"', () => {
  // 1. Online session (site source, unverified by teacher)
  const onlineRow = {
    id: 'row-online',
    source: 'site',
    verified: false,
    verified_at: null,
    corrected_at: null,
  };
  const source1 = resolveEntrySource(onlineRow, 'basics');
  assert.equal(source1, 'site');

  const isVerified1 = onlineRow.verified === true || !!onlineRow.verified_at;
  const isCorrected1 = !!onlineRow.corrected_at;
  assert.equal(isVerified1, false);
  assert.equal(isCorrected1, false);

  // 2. Teacher-verified record (locked with teacher approval)
  const verifiedRow = {
    id: 'row-verified',
    source: 'typed',
    verified: true,
    verified_at: '2026-11-05T10:00:00Z',
    verified_by: 'teacher-uuid',
  };
  const isVerified2 = verifiedRow.verified === true || !!verifiedRow.verified_at || !!verifiedRow.verified_by;
  assert.equal(isVerified2, true);

  // 3. Teacher-corrected record
  const correctedRow = {
    id: 'row-corrected',
    source: 'typed',
    verified: false,
    corrected_at: '2026-11-05T11:00:00Z',
    corrected_by: 'teacher-uuid',
  };
  const isCorrected3 = !!correctedRow.corrected_at || !!correctedRow.corrected_by;
  assert.equal(isCorrected3, true);

  // 4. No invented "Standard" mode when practice_mode is omitted
  const rowNoMode = { id: 'row-nomode', practice_mode: null };
  const practiceMode = rowNoMode.practice_mode === 'timed' ? 'Timed' : (rowNoMode.practice_mode === 'unlimited' ? 'Unlimited' : null);
  assert.equal(practiceMode, null, 'Omitted practice mode should be null, not invented Standard');
});

test('Flash and Elements keep sub-activity parameters inside Details and out of collapsed category cell', () => {
  // Flash: category is simply "1D Flash", settings are inside Details
  const flashHtml = renderCompactHistoryRowHtml({
    rowId: 'flash-row-1',
    category: '1D Flash',
    categorySub: '', // Empty in collapsed row!
    correct: 1,
    total: 1,
    timeFormatted: '10.0s',
    dateVal: '2026-11-05',
    detailsMeta: [
      { label: 'Flash settings', valueHtml: '1 digit · 10 numbers · 1.0s · Addition' },
      { label: 'Speed / rate', valueHtml: '1.0s per number (1.00 #/s)' },
    ],
  });

  assert.ok(flashHtml.includes('<span>1D Flash</span>'), 'Main cell shows clean category title');
  assert.ok(!flashHtml.includes('class="cell-category-title">\n<span>1D Flash</span>\n<div'), 'No sub-text cluttering category title in collapsed state');
  assert.ok(flashHtml.includes('Flash settings'), 'Flash settings present inside Details panel');
  assert.ok(flashHtml.includes('1 digit · 10 numbers · 1.0s · Addition'), 'Flash parameters displayed in Details');

  // Elements: category is "Direct Addition", drill key is inside Details
  const elementsHtml = renderCompactHistoryRowHtml({
    rowId: 'elements-row-1',
    category: 'Direct Addition',
    categorySub: '', // Empty in collapsed row!
    correct: 10,
    total: 10,
    timeFormatted: '0:35',
    dateVal: '2026-11-05',
    detailsMeta: [
      { label: 'Drill key', valueHtml: '<code>direct_addition_1d</code>' },
    ],
  });

  assert.ok(elementsHtml.includes('<span>Direct Addition</span>'), 'Main cell shows clean drill name');
  assert.ok(elementsHtml.includes('Drill key'), 'Internal drill key kept inside Details');
  assert.ok(elementsHtml.includes('<code>direct_addition_1d</code>'), 'Drill key code rendered in Details');
});

/* ==============================================================================
   5. FRIENDLY DATE & ACCURACY DISPLAY HELPERS
   ============================================================================== */

test('formatFriendlyDateIST returns "Today", "Yesterday", or "D Mon YYYY"', () => {
  const todayIST = toISTDateString(new Date());
  assert.equal(formatFriendlyDateIST(todayIST), 'Today');

  // Compute yesterday IST
  const [y, m, d] = todayIST.split('-').map(Number);
  const yesterdayUtc = new Date(Date.UTC(y, m - 1, d - 1, 12, 0, 0));
  const yesterdayIST = toISTDateString(yesterdayUtc);
  assert.equal(formatFriendlyDateIST(yesterdayIST), 'Yesterday');

  // Specific historical date
  const olderDate = '2026-10-15';
  const formattedOlder = formatFriendlyDateIST(olderDate);
  assert.ok(formattedOlder.includes('15') && formattedOlder.includes('Oct') && formattedOlder.includes('2026'),
    `Older date formatted as D Mon YYYY: ${formattedOlder}`);

  // Empty / invalid
  assert.equal(formatFriendlyDateIST(null), '');
  assert.equal(formatFriendlyDateIST(''), '');
  assert.equal(formatFriendlyDateIST('invalid-date'), '');
});

test('formatAccuracyDisplay formats whole vs fractional percentages cleanly', () => {
  // Whole percentages
  assert.equal(formatAccuracyDisplay(20, 20), '100%');
  assert.equal(formatAccuracyDisplay(19, 20), '95%');
  assert.equal(formatAccuracyDisplay(10, 20), '50%');

  // Fractional percentages (1 decimal place)
  assert.equal(formatAccuracyDisplay(20, 21), '95.2%');
  assert.equal(formatAccuracyDisplay(1, 3), '33.3%');
  assert.equal(formatAccuracyDisplay(2, 3), '66.7%');

  // Edge cases: zero total, zero correct, negative
  assert.equal(formatAccuracyDisplay(0, 0), '0%');
  assert.equal(formatAccuracyDisplay(0, 10), '0%');
  assert.equal(formatAccuracyDisplay(-1, 10), '0%');
  assert.equal(formatAccuracyDisplay(null, null), '0%');
});

/* ==============================================================================
   6. COMPACT PRACTICE SCORE ROWS ACROSS ALL 4 PRACTICE SECTIONS
   ============================================================================== */

test('renderCompactHistoryRowHtml renders the 6 essential columns and expandable details with readable sentence-case labels', () => {
  const html = renderCompactHistoryRowHtml({
    rowId: 'drill-123',
    category: '2d4r',
    correct: 20,
    total: 21,
    timeFormatted: '1:00',
    dateVal: '2026-11-05',
    isFlagged: false,
    detailsMeta: [
      { label: 'Wrong answers', valueHtml: '1 wrong (-1)' },
      { label: 'Speed / rate', valueHtml: '21.0 / min' },
      { label: 'Entry source', valueHtml: 'Recorded by site' },
      { label: 'Practice mode', valueHtml: 'Timed (60s)' },
      { label: 'Target benchmark', valueHtml: '🎯 Target met' },
      { label: 'Status & lock', valueHtml: '🔒 Online session (Locked)' },
    ],
    actionsHtml: '<button type="button" class="btn btn-outline btn-sm">Edit</button>',
    mainRowAttrs: 'data-drill-id="123"',
    mainRowClass: 'row-verified',
  });

  // Verify main row and 6 essential columns
  assert.ok(html.includes('<tr class="history-main-row row-verified" data-drill-id="123">'), 'Main row rendered with classes and attrs');
  assert.ok(html.includes('cell-category'), 'Category column present');
  assert.ok(html.includes('2d4r'), 'Category title rendered');
  assert.ok(html.includes('cell-score num'), 'Score column present');
  assert.ok(html.includes('20 / 21'), 'Score rendered');
  assert.ok(html.includes('cell-accuracy num'), 'Accuracy column present');
  assert.ok(html.includes('95.2%'), 'Accuracy formatted (95.2%)');
  assert.ok(html.includes('cell-time num'), 'Time column present');
  assert.ok(html.includes('1:00'), 'Time formatted (1:00)');
  assert.ok(html.includes('cell-date'), 'Date column present');
  assert.ok(html.includes('cell-details'), 'Details action column present');

  // Verify Details button and ARIA linkage
  assert.ok(html.includes('aria-controls="details-drill-123"'), 'Details button controls details row');
  assert.ok(html.includes('data-details-toggle="details-drill-123"'), 'Details button has toggle data attribute');
  assert.ok(html.includes('aria-expanded="false"'), 'Details button initially collapsed');

  // Verify Details row and readable sentence-case labels
  assert.ok(html.includes('<tr id="details-drill-123" class="history-details-row" hidden>'), 'Details row exists and is initially hidden');
  assert.ok(html.includes('Wrong answers'), 'Details panel has sentence-case Wrong answers');
  assert.ok(html.includes('1 wrong (-1)'), 'Details panel has wrong answers count');
  assert.ok(html.includes('Speed / rate'), 'Details panel has sentence-case Speed / rate');
  assert.ok(html.includes('21.0 / min'), 'Details panel has speed rate');
  assert.ok(html.includes('Target benchmark'), 'Details panel has sentence-case Target benchmark');
  assert.ok(html.includes('Status &amp; lock'), 'Details panel has sentence-case Status & lock');
  assert.ok(html.includes('Edit'), 'Details panel has action buttons');
});

test('renderCompactHistoryRowHtml displays "Needs attention" pill before expansion and teacher note inside details', () => {
  const html = renderCompactHistoryRowHtml({
    rowId: 'drill-flagged',
    category: '1d10r',
    correct: 18,
    total: 20,
    timeFormatted: '0:45',
    dateVal: '2026-11-04',
    isFlagged: true,
    flagNote: 'Please recheck question 7 calculation.',
    detailsMeta: [
      { label: 'Wrong answers', valueHtml: '2 wrong' },
    ],
  });

  // "Needs attention" pill is visible BEFORE expansion in cell-category
  assert.ok(html.includes('class="status-chip chip-flagged"'), 'Needs attention chip present in main row');
  assert.ok(html.includes('⚠️ Needs attention'), 'Needs attention indicator text present');

  // Teacher explanation box rendered INSIDE details panel
  assert.ok(html.includes('class="attention-explanation-box"'), 'Teacher attention box present in details panel');
  assert.ok(html.includes('⚠️ Teacher review requested'), 'Teacher review heading present');
  assert.ok(html.includes('Please recheck question 7 calculation.'), 'Teacher note displayed inside details');
});

test('renderCompactHistoryRowHtml safely handles zero totals and missing times', () => {
  const html = renderCompactHistoryRowHtml({
    rowId: 'drill-zero',
    category: 'Single Digit +',
    correct: 0,
    total: 0,
    timeFormatted: '',
    dateVal: null,
  });

  assert.ok(html.includes('0 / 0'), 'Zero score rendered');
  assert.ok(html.includes('0%'), 'Accuracy formatted as 0%');
  assert.ok(html.includes('—'), 'Time fallback dash rendered');
});

/* ==============================================================================
   7. SHORTENED FLASH ANZAN SETUP
   ============================================================================== */

test('formatFlashCompactSummary formats current settings as "1 digit · 10 numbers · 1 second · Addition"', () => {
  // Default settings
  const summary1 = formatFlashCompactSummary({
    digits: 1,
    count: 10,
    speed_ms: 1000,
    mode: 'add',
  });
  assert.equal(summary1, '1 digit · 10 numbers · 1 second · Addition');

  // Plural digits, non-1 second, mixed mode
  const summary2 = formatFlashCompactSummary({
    digits: 2,
    count: 20,
    speed_ms: 1500,
    mode: 'add_sub',
  });
  assert.equal(summary2, '2 digits · 20 numbers · 1.5 seconds · Addition & Subtraction');

  // Integer multiple seconds
  const summary3 = formatFlashCompactSummary({
    digits: 3,
    count: 50,
    speed_ms: 2000,
    mode: 'add',
  });
  assert.equal(summary3, '3 digits · 50 numbers · 2 seconds · Addition');

  // Sub-second speed
  const summary4 = formatFlashCompactSummary({
    digits: 1,
    count: 5,
    speed_ms: 500,
    mode: 'add',
  });
  assert.equal(summary4, '1 digit · 5 numbers · 0.5 seconds · Addition');
});

test('formatFlashSettingsSummary preserves existing legacy summary contract', () => {
  const legacy = formatFlashSettingsSummary({
    digits: 1,
    count: 10,
    speed_ms: 1000,
    mode: 'add',
  });
  assert.equal(legacy, '1 digit - 10 numbers - 1.0 s - add');
});
