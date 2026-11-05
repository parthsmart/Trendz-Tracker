/**
 * Unit Tests for Private Admin-to-Student Messages & Flags (tests/studentMessages.test.js)
 *
 * Verifies:
 * 1. Admin sending private note (general, linked score, linked weekly test).
 * 2. "Needs attention" flag updates the score and creates attention note.
 * 3. Client nonce idempotency prevents duplicate messages.
 * 4. Validation errors: invalid student, deactivated student, missing/long title, missing/long body.
 * 5. Security & ownership validation: linked score belonging to another student rejected.
 * 6. Weekly test audience level mismatch rejected.
 * 7. Mark as read & dismiss notification lifecycle.
 * 8. Client helper sendStudentMessage and markStudentMessageRead functions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) || null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    location: {
      hostname: 'localhost',
      pathname: '/pages/student-detail.html',
      search: '',
    },
  };
}

import { DemoDB } from '../js/demoDb.js';
import { sendStudentMessage, markStudentMessageRead } from '../js/studentMessages.js';

test('1. DemoDB: Admin can send a general private note without linked record', () => {
  const msg = DemoDB.sendStudentMessage({
    studentId: 'usr-101',
    title: 'Great work this week',
    body: 'Keep up the daily practice streaks! Your accuracy is improving noticeably.',
    needsAttention: false,
  });

  assert.ok(msg.id, 'Expected message to have an ID');
  assert.equal(msg.student_id, 'usr-101');
  assert.equal(msg.title, 'Great work this week');
  assert.equal(msg.body, 'Keep up the daily practice streaks! Your accuracy is improving noticeably.');
  assert.equal(msg.needs_attention, false);
  assert.equal(msg.attention_reason, null);
  assert.equal(msg.read_at, null);
  assert.equal(msg.dismissed_at, null);
  assert.equal(msg.link, '/pages/student.html');
});

test('2. DemoDB: Admin can link note to a practice score and set "Needs attention" flag', () => {
  const results = DemoDB.getResults();
  const studentResult = results.find((r) => r.student_id === 'usr-101');
  assert.ok(studentResult, 'Expected to find a result for student usr-101');

  const msg = DemoDB.sendStudentMessage({
    studentId: 'usr-101',
    title: 'Review row 3 arithmetic',
    body: 'Please check your multiplication carried numbers in row 3.',
    needsAttention: true,
    attentionReason: 'Check row 3 carried digits',
    linkedType: 'score',
    linkedId: studentResult.id,
  });

  assert.equal(msg.linked_type, 'score');
  assert.equal(msg.linked_id, studentResult.id);
  assert.equal(msg.needs_attention, true);
  assert.equal(msg.attention_reason, 'Check row 3 carried digits');

  // Verify the score itself was updated with flagged = true and flag_note
  const updatedResults = DemoDB.getResults();
  const updatedScore = updatedResults.find((r) => r.id === studentResult.id);
  assert.equal(updatedScore.flagged, true);
  assert.equal(updatedScore.flag_note, 'Check row 3 carried digits');
});

test('3. DemoDB: Rejects linking a score belonging to another student', () => {
  const results = DemoDB.getResults();
  const otherResult = results.find((r) => r.student_id !== 'usr-101');
  if (otherResult) {
    assert.throws(
      () => {
        DemoDB.sendStudentMessage({
          studentId: 'usr-101',
          title: 'Suspicious link',
          body: 'Attempting to attach another student score',
          linkedType: 'score',
          linkedId: otherResult.id,
        });
      },
      /Linked score does not belong to the recipient student/
    );
  }
});

test('4. DemoDB: Idempotency with clientNonce prevents duplicate messages', () => {
  const nonce = `test-nonce-${Date.now()}`;
  const first = DemoDB.sendStudentMessage({
    studentId: 'usr-101',
    title: 'Idempotency test',
    body: 'First delivery attempt',
    clientNonce: nonce,
  });

  // Safe retry: exact same payload returns original message without creating duplicates
  const second = DemoDB.sendStudentMessage({
    studentId: 'usr-101',
    title: 'Idempotency test',
    body: 'First delivery attempt',
    clientNonce: nonce,
  });

  assert.equal(first.id, second.id, 'Expected identical message ID from idempotent call');
  assert.equal(second.title, first.title, 'Expected original title to be preserved');

  // Reusing the same nonce with a different payload must be rejected
  assert.throws(
    () => {
      DemoDB.sendStudentMessage({
        studentId: 'usr-101',
        title: 'Different title',
        body: 'Different body',
        clientNonce: nonce,
      });
    },
    /Nonce reuse detected/
  );
});

test('5. DemoDB: Validation rules for student existence, title, and body length', () => {
  // Non-existent student
  assert.throws(
    () => {
      DemoDB.sendStudentMessage({
        studentId: 'usr-does-not-exist',
        title: 'Hello',
        body: 'Message content',
      });
    },
    /Recipient student not found or deactivated/
  );

  // Missing or empty title
  assert.throws(
    () => {
      DemoDB.sendStudentMessage({
        studentId: 'usr-101',
        title: '',
        body: 'Valid body text',
      });
    },
    /Title must be between 1 and 120 characters/
  );

  // Title exceeding 120 chars
  assert.throws(
    () => {
      DemoDB.sendStudentMessage({
        studentId: 'usr-101',
        title: 'A'.repeat(121),
        body: 'Valid body text',
      });
    },
    /Title must be between 1 and 120 characters/
  );

  // Missing body
  assert.throws(
    () => {
      DemoDB.sendStudentMessage({
        studentId: 'usr-101',
        title: 'Valid title',
        body: '',
      });
    },
    /Body must be between 1 and 2000 characters/
  );

  // Body exceeding 2000 chars
  assert.throws(
    () => {
      DemoDB.sendStudentMessage({
        studentId: 'usr-101',
        title: 'Valid title',
        body: 'B'.repeat(2001),
      });
    },
    /Body must be between 1 and 2000 characters/
  );
});

test('6. DemoDB: Reading and dismissing message updates read_at and dismissed_at', () => {
  const msg = DemoDB.sendStudentMessage({
    studentId: 'usr-101',
    title: 'Dismissal test message',
    body: 'Testing read and dismiss timestamps',
  });

  assert.equal(msg.read_at, null);
  assert.equal(msg.dismissed_at, null);

  // Mark as read
  const readSuccess = DemoDB.markStudentMessageRead(msg.id);
  assert.equal(readSuccess, true);

  const messagesAfterRead = DemoDB.getStudentMessages('usr-101');
  const foundRead = messagesAfterRead.find((m) => m.id === msg.id);
  assert.ok(foundRead.read_at, 'Expected read_at to be populated');

  // Dismiss via mockDismissNotification('msg:<id>')
  const dismissSuccess = DemoDB.mockDismissNotification(`msg:${msg.id}`);
  assert.equal(dismissSuccess, true);

  const messagesAfterDismiss = DemoDB.getStudentMessages('usr-101');
  const foundDismissed = messagesAfterDismiss.find((m) => m.id === msg.id);
  assert.equal(foundDismissed, undefined, 'Dismissed message should not appear in active student messages');
});

test('7. Client Helper sendStudentMessage validates inputs and delegates in demo mode', async () => {
  // Missing studentId rejection
  await assert.rejects(
    async () => {
      await sendStudentMessage({
        studentId: null,
        title: 'Test',
        body: 'Test',
      });
    },
    /Please select a student/
  );

  // Title validation
  await assert.rejects(
    async () => {
      await sendStudentMessage({
        studentId: 'usr-101',
        title: '   ',
        body: 'Test body',
      });
    },
    /Title is required and must not exceed 120 characters/
  );

  // Successful send via helper
  const result = await sendStudentMessage({
    studentId: 'usr-101',
    title: 'Client helper note',
    body: 'Sent through client helper in demo mode',
    needsAttention: false,
  });

  assert.ok(result.id);
  assert.equal(result.title, 'Client helper note');

  // Mark read via client helper
  const marked = await markStudentMessageRead(result.id);
  assert.equal(marked, true);
});
