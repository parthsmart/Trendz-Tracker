import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SECTION_KINDS,
  MEMORIAD_MODULES,
  sectionKindLabel,
  speedSecondsToMs,
  speedMsToSecondsText,
  sectionSummary,
  validateSections,
  toRows
} from '../js/weeklySections.js';

const mockCategories = [
  { id: 'cat-b1', name: '1d 4r', group_name: 'basics' },
  { id: 'cat-b2', name: '2d 5r', group_name: 'basics' },
  { id: 'cat-b-unsupported', name: 'Cube Root Special', group_name: 'basics' },
  { id: 'cat-r1', name: 'ADD', group_name: 'round' },
  { id: 'cat-r2', name: 'MUL', group_name: 'round' }
];

const lookup = { categories: mockCategories };

test('SECTION_KINDS and MEMORIAD_MODULES expose expected kinds and modules', () => {
  assert.deepEqual(SECTION_KINDS, ['basics', 'flash', 'elements', 'memoriad', 'round']);
  assert.equal(MEMORIAD_MODULES.length, 4);
  assert.equal(sectionKindLabel('basics'), 'Basics');
  assert.equal(sectionKindLabel('flash'), 'Flash Anzan');
  assert.equal(sectionKindLabel('elements'), 'Elements');
  assert.equal(sectionKindLabel('memoriad'), 'Memoriad');
  assert.equal(sectionKindLabel('round'), 'Round scores');
});

test('speedSecondsToMs and speedMsToSecondsText convert without floating-point drift', () => {
  assert.equal(speedSecondsToMs(0.2), 200);
  assert.equal(speedSecondsToMs('0.3'), 300);
  assert.equal(speedSecondsToMs(0.5), 500);
  assert.equal(speedSecondsToMs(0.7), 700);
  assert.equal(speedSecondsToMs(1.4), 1400);
  assert.equal(speedSecondsToMs(2.3), 2300);
  assert.equal(speedSecondsToMs(5), 5000);

  assert.equal(speedMsToSecondsText(200), '0.2');
  assert.equal(speedMsToSecondsText(500), '0.5');
  assert.equal(speedMsToSecondsText(1000), '1');
  assert.equal(speedMsToSecondsText(1250), '1.25');
});

test('sectionSummary formats every section kind clearly in plain English', () => {
  assert.equal(
    sectionSummary({ kind: 'basics', category_id: 'cat-b1', seconds: 120 }, lookup),
    'Basics: 1d 4r, 2 minutes'
  );
  assert.equal(
    sectionSummary({ kind: 'basics', name: '1D 4R', seconds: null }, lookup),
    'Basics: 1D 4R'
  );
  assert.equal(
    sectionSummary({
      kind: 'flash',
      flash_digits: 1,
      flash_count: 50,
      flash_speed_ms: 500,
      flash_mode: 'add',
      question_count: 5
    }),
    'Flash: 1 digit, 50 numbers, 0.5 s, add only, 5 tries'
  );
  assert.equal(
    sectionSummary({
      kind: 'flash',
      flash_digits: 2,
      flash_count: 25,
      flash_speed_seconds: 1.2,
      flash_mode: 'add_sub',
      question_count: 1
    }),
    'Flash: 2 digits, 25 numbers, 1.2 s, add & sub, 1 try'
  );
  assert.equal(
    sectionSummary({ kind: 'elements', activity_key: 'day_codes' }),
    'Elements: Day Codes'
  );
  assert.equal(
    sectionSummary({ kind: 'memoriad', activity_key: 'additions' }),
    'Memoriad: Mental Additions'
  );
  assert.equal(
    sectionSummary({ kind: 'round', category_id: 'cat-r1' }, lookup),
    'Round: ADD'
  );
});

test('validateSections accepts valid mixed sections for online and offline tests', () => {
  const onlineSections = [
    { kind: 'basics', category_id: 'cat-b1', seconds: 120 },
    { kind: 'flash', flash_digits: 1, flash_count: 50, flash_speed_seconds: 0.5, flash_mode: 'add', question_count: 5 },
    { kind: 'elements', activity_key: 'day_codes' },
    { kind: 'memoriad', activity_key: 'additions' }
  ];
  const resOnline = validateSections(onlineSections, 'online', lookup);
  assert.equal(resOnline.valid, true);
  assert.equal(resOnline.error, null);

  // Offline allows 0 sections and also allows round + basics without seconds
  assert.equal(validateSections([], 'offline', lookup).valid, true);
  const offlineSections = [
    { kind: 'basics', category_id: 'cat-b1', seconds: null },
    { kind: 'round', category_id: 'cat-r1' },
    { kind: 'flash', flash_digits: 2, flash_count: 20, flash_speed_ms: 800, flash_mode: 'add_sub', question_count: 3 }
  ];
  assert.equal(validateSections(offlineSections, 'offline', lookup).valid, true);
});

test('validateSections rejects invalid shapes, round in online tests, and duplicates', () => {
  // Empty online test
  assert.equal(validateSections([], 'online', lookup).valid, false);

  // Round in online test
  const roundInOnline = validateSections(
    [{ kind: 'round', category_id: 'cat-r1' }],
    'online',
    lookup
  );
  assert.equal(roundInOnline.valid, false);
  assert.match(roundInOnline.error, /Round scores are available for offline tests only/i);

  // Online basics missing seconds
  const onlineBasicsNoSeconds = validateSections(
    [{ kind: 'basics', category_id: 'cat-b1', seconds: null }],
    'online',
    lookup
  );
  assert.equal(onlineBasicsNoSeconds.valid, false);

  // Duplicate category
  const dupCat = validateSections(
    [
      { kind: 'basics', category_id: 'cat-b1', seconds: 60 },
      { kind: 'basics', category_id: 'cat-b1', seconds: 120 }
    ],
    'online',
    lookup
  );
  assert.equal(dupCat.valid, false);

  // Duplicate elements activity_key
  const dupElem = validateSections(
    [
      { kind: 'elements', activity_key: 'day_codes' },
      { kind: 'elements', activity_key: 'day_codes' }
    ],
    'online',
    lookup
  );
  assert.equal(dupElem.valid, false);

  // Flash with different settings is allowed, identical settings rejected
  const diffFlash = validateSections(
    [
      { kind: 'flash', flash_digits: 1, flash_count: 50, flash_speed_ms: 500, flash_mode: 'add', question_count: 5 },
      { kind: 'flash', flash_digits: 2, flash_count: 50, flash_speed_ms: 500, flash_mode: 'add', question_count: 5 }
    ],
    'online',
    lookup
  );
  assert.equal(diffFlash.valid, true);

  const sameFlash = validateSections(
    [
      { kind: 'flash', flash_digits: 1, flash_count: 50, flash_speed_ms: 500, flash_mode: 'add', question_count: 5 },
      { kind: 'flash', flash_digits: 1, flash_count: 50, flash_speed_seconds: 0.5, flash_mode: 'add', question_count: 5 }
    ],
    'online',
    lookup
  );
  assert.equal(sameFlash.valid, false);

  // Disabled elements drill ('modulo') rejected
  const disabledDrill = validateSections(
    [{ kind: 'elements', activity_key: 'modulo' }],
    'online',
    lookup
  );
  assert.equal(disabledDrill.valid, false);
});

test('toRows shapes clean database payloads per section kind', () => {
  const input = [
    { kind: 'basics', category_id: 'cat-b1', seconds: 120, activity_key: 'ignored' },
    { kind: 'flash', flash_digits: 2, flash_count: 40, flash_speed_seconds: 0.7, flash_mode: 'add_sub', question_count: 4 },
    { kind: 'elements', activity_key: 'tables_1_to_30', seconds: 60 },
    { kind: 'memoriad', activity_key: 'calendar' },
    { kind: 'round', category_id: 'cat-r1', seconds: 120 }
  ];

  const rows = toRows(input, 'test-123');
  assert.equal(rows.length, 5);

  assert.deepEqual(rows[0], {
    test_id: 'test-123',
    position: 1,
    kind: 'basics',
    category_id: 'cat-b1',
    activity_key: null,
    seconds: 120,
    flash_digits: null,
    flash_count: null,
    flash_speed_ms: null,
    flash_mode: null,
    question_count: null
  });

  assert.deepEqual(rows[1], {
    test_id: 'test-123',
    position: 2,
    kind: 'flash',
    category_id: null,
    activity_key: null,
    seconds: null,
    flash_digits: 2,
    flash_count: 40,
    flash_speed_ms: 700,
    flash_mode: 'add_sub',
    question_count: 4
  });

  assert.equal(rows[2].kind, 'elements');
  assert.equal(rows[2].activity_key, 'tables_1_to_30');
  assert.equal(rows[2].seconds, null);

  assert.equal(rows[3].kind, 'memoriad');
  assert.equal(rows[3].activity_key, 'calendar');

  assert.equal(rows[4].kind, 'round');
  assert.equal(rows[4].category_id, 'cat-r1');
  assert.equal(rows[4].seconds, null);
});
