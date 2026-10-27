import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getEmailReportConfig, getCronSecret } from '../api/_configHelper.js';
import {
  buildWeeklyEmail,
  formatWeekRangeIST,
  escapeHtml,
  buildMilestoneMessage,
} from '../api/_reportEmail.js';
import { verifyCronAuthorizationHeader, sanitizeReportError } from '../api/weekly-report.js';
import {
  buildMonthlyReportPdfBytes,
  getMonthlyReportPdfFilename,
} from '../js/monthlyReportData.js';

describe('formatWeekRangeIST', () => {
  it('formats same-month week ranges cleanly (e.g. 12-18 Oct 2026)', () => {
    assert.equal(formatWeekRangeIST('2026-10-12', '2026-10-18'), '12-18 Oct 2026');
  });

  it('formats cross-month week ranges in the same year', () => {
    assert.equal(formatWeekRangeIST('2026-09-28', '2026-10-04'), '28 Sep-4 Oct 2026');
  });

  it('formats cross-year week ranges', () => {
    assert.equal(formatWeekRangeIST('2025-12-29', '2026-01-04'), '29 Dec 2025-4 Jan 2026');
  });
});

describe('buildWeeklyEmail', () => {
  const sampleData = {
    week_start: '2026-10-12',
    week_end: '2026-10-18',
    generated_on: '2026-10-18',
    summary: {
      active_students: 5,
      students_with_entries: 4,
      accuracy: 92.8,
    },
    students: [
      {
        code: 'STU002',
        name: 'Zoya Khan',
        level: 'Level 3',
        practice_days: 5,
        entries: 19,
        accuracy: 91.5,
        qpm: 16.8,
        streak: 12,
        points: 115,
      },
      {
        code: 'STU001',
        name: 'Aarav Patel',
        level: 'Level 2',
        practice_days: 6,
        entries: 24,
        accuracy: 94.2,
        qpm: 18.4,
        streak: 50,
        points: 140,
      },
      {
        code: 'STU003',
        name: 'Bhavya Nair',
        level: 'Level 2',
        practice_days: 4,
        entries: 12,
        accuracy: 90.0,
        qpm: 15.1,
        streak: 8,
        points: 95,
      },
    ],
    needs_attention: [
      {
        code: 'STU004',
        name: 'Rohan Desai',
        level: 'Level 2',
        last_entry: '2026-10-09',
        days_ago: 9,
      },
      {
        code: 'STU005',
        name: 'Meera Iyer',
        level: 'Level 1',
        last_entry: null,
        days_ago: null,
      },
    ],
    milestones: [
      {
        code: 'STU001',
        name: 'Aarav Patel',
        level: 'Level 2',
        milestone: 50,
        streak: 50,
      },
    ],
    sessions: [
      {
        date: '2026-10-14',
        title: 'Wednesday Speed Batch',
        type: 'regular',
        present: 4,
        absent: 1,
        excused: 0,
      },
    ],
    weekly_tests: [
      {
        date: '2026-10-17',
        title: 'October Week 3 Mock Test',
        scores: 4,
      },
    ],
  };

  it('builds exact subject line and preserves section ordering in HTML and plain text', () => {
    const { subject, html, text } = buildWeeklyEmail(sampleData);

    assert.equal(subject, 'Trendz Tracker weekly report: 12-18 Oct 2026');

    // Verify section ordering in HTML
    const idxSummary = html.indexOf('Students who practised:');
    const idxNeedsAttention = html.indexOf('Needs attention');
    const idxMilestones = html.indexOf('Streak milestones this week');
    const idxStudents = html.indexOf('Student practice &amp; points');
    const idxSessions = html.indexOf('Sessions this week');
    const idxWeeklyTests = html.indexOf('Weekly tests this week');

    assert.ok(idxSummary >= 0, 'Summary section must exist');
    assert.ok(idxNeedsAttention > idxSummary, 'Needs attention must follow summary');
    assert.ok(idxMilestones > idxNeedsAttention, 'Milestones must follow needs attention');
    assert.ok(idxStudents > idxMilestones, 'Students table must follow milestones');
    assert.ok(idxSessions > idxStudents, 'Sessions must follow students table');
    assert.ok(idxWeeklyTests > idxSessions, 'Weekly tests must follow sessions');

    // Verify section ordering in Plain Text
    const txtSummary = text.indexOf('SUMMARY: Students who practised: 4 of 5');
    const txtAttention = text.indexOf('NEEDS ATTENTION');
    const txtMilestones = text.indexOf('STREAK MILESTONES THIS WEEK');
    const txtStudents = text.indexOf('STUDENTS');
    const txtSessions = text.indexOf('SESSIONS THIS WEEK');
    const txtTests = text.indexOf('WEEKLY TESTS THIS WEEK');

    assert.ok(txtSummary >= 0);
    assert.ok(txtAttention > txtSummary);
    assert.ok(txtMilestones > txtAttention);
    assert.ok(txtStudents > txtMilestones);
    assert.ok(txtSessions > txtStudents);
    assert.ok(txtTests > txtSessions);

    // Needs attention formatting: days since last entry or "no entries yet"
    assert.ok(html.includes('9 days since last entry'));
    assert.ok(html.includes('no entries yet'));
    assert.ok(text.includes('9 days since last entry'));
    assert.ok(text.includes('no entries yet'));

    // Students sorted by level then name: Aarav Patel (Level 2) -> Bhavya Nair (Level 2) -> Zoya Khan (Level 3)
    const posAarav = html.indexOf('Aarav Patel');
    const posBhavya = html.indexOf('Bhavya Nair');
    const posZoya = html.indexOf('Zoya Khan');
    assert.ok(posAarav > 0 && posBhavya > posAarav && posZoya > posBhavya);
  });

  it('escapes HTML special characters in user-provided fields', () => {
    const malicious = {
      ...sampleData,
      students: [
        {
          code: 'STU<script>',
          name: '<img src=x onerror=alert(1)>',
          level: 'Level "1"',
          practice_days: 3,
          entries: 5,
          accuracy: 80,
          qpm: 10,
          streak: 3,
          points: 30,
        },
      ],
    };

    const { html } = buildWeeklyEmail(malicious);
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<img src=x'));
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.equal(escapeHtml(`A & B < C > D "E" 'F'`), 'A &amp; B &lt; C &gt; D &quot;E&quot; &#39;F&#39;');
  });

  it('includes score-sheet mirror status and warns when > 3 days old or never built', () => {
    // 1. Up-to-date mirror (built 1 day ago)
    const freshEmail = buildWeeklyEmail({
      ...sampleData,
      backup: {
        last_google_at: '2026-10-18',
        last_export_at: '2026-10-17',
        days_since_backup: 0,
        mirror: {
          up_to_date: 5,
          total: 5,
          last_built_at: '2026-10-17',
          days_since_built: 1,
        },
      },
    });
    assert.ok(freshEmail.text.includes('Score-sheet mirror: 5 of 5 up to date | Last built: 17 Oct 2026'));
    assert.ok(!freshEmail.text.includes('Warning: Score-sheet mirror'));
    assert.ok(freshEmail.html.includes('5 of 5 up to date'));
    assert.ok(freshEmail.html.includes('17 Oct 2026'));

    // 2. Stale mirror (> 3 days old, e.g. 5 days old)
    const staleEmail = buildWeeklyEmail({
      ...sampleData,
      backup: {
        last_google_at: '2026-10-18',
        mirror: {
          up_to_date: 3,
          total: 5,
          last_built_at: '2026-10-13',
        },
      },
    });
    assert.ok(staleEmail.text.includes('Score-sheet mirror: 3 of 5 up to date | Last built: 13 Oct 2026'));
    assert.ok(staleEmail.text.includes('Warning: Score-sheet mirror last built 5 days ago.'));
    assert.ok(staleEmail.html.includes('Score-sheet mirror last built 5 days ago.'));

    // 3. Never built mirror
    const neverBuiltEmail = buildWeeklyEmail({
      ...sampleData,
      backup: {
        last_google_at: '2026-10-18',
        mirror: {
          up_to_date: 0,
          total: 5,
          last_built_at: null,
        },
      },
    });
    assert.ok(neverBuiltEmail.text.includes('Score-sheet mirror: 0 of 5 up to date | Last built: Never'));
    assert.ok(neverBuiltEmail.text.includes('Warning: Score-sheet mirror has never been built.'));
    assert.ok(neverBuiltEmail.html.includes('Score-sheet mirror has never been built.'));
  });
});

describe('buildMilestoneMessage', () => {
  it('builds a congratulatory message without phone numbers', () => {
    const msg = buildMilestoneMessage({
      full_name: 'Aarav Patel',
      level: 'Level 2',
      milestone: 50,
      current_streak: 50,
    });
    assert.ok(msg.includes('Aarav Patel'));
    assert.ok(msg.includes('50-day practice streak'));
  });
});

describe('configHelper & weekly-report auth helpers', () => {
  it('validates email report config and uses default fromEmail when optional env is omitted', () => {
    assert.throws(() => getEmailReportConfig({}), /RESEND_API_KEY/);
    assert.throws(
      () => getEmailReportConfig({ RESEND_API_KEY: 're_1234567890', REPORT_TO_EMAIL: 'invalid' }),
      /REPORT_TO_EMAIL/
    );

    const cfg = getEmailReportConfig({
      RESEND_API_KEY: 're_1234567890',
      REPORT_TO_EMAIL: 'coach@trendzabacus.com',
    });
    assert.equal(cfg.toEmail, 'coach@trendzabacus.com');
    assert.equal(cfg.fromEmail, 'Trendz Tracker <onboarding@resend.dev>');
  });

  it('validates CRON_SECRET and compares bearer headers in constant time', () => {
    assert.throws(() => getCronSecret({}), /CRON_SECRET/);
    assert.equal(getCronSecret({ CRON_SECRET: 'super-secret-cron-token' }), 'super-secret-cron-token');

    assert.equal(verifyCronAuthorizationHeader('Bearer secret-123', 'secret-123'), true);
    assert.equal(verifyCronAuthorizationHeader('Bearer secret-123', 'secret-124'), false);
    assert.equal(verifyCronAuthorizationHeader('secret-123', 'secret-123'), false);
    assert.equal(verifyCronAuthorizationHeader('', 'secret-123'), false);

    const scrubbed = sanitizeReportError(
      new Error('Resend failed with key re_abc123456789 and secret my-secret-token'),
      ['my-secret-token']
    );
    assert.ok(!scrubbed.includes('re_abc123456789'));
    assert.ok(!scrubbed.includes('my-secret-token'));
  });
});

describe('buildMonthlyReportPdfBytes & getMonthlyReportPdfFilename', () => {
  it('generates a valid PDF 1.4 byte array and clean filename from student_month_report data', () => {
    const sampleReport = {
      student: { name: 'Aarav Patel', code: 'STU001', level: 'Level 2' },
      month_start: '2026-10-01',
      month_end: '2026-10-31',
      days_elapsed: 19,
      practice: {
        entries: 24,
        correct: 452,
        total: 480,
        accuracy: 94.2,
        qpm: 18.4,
        rounds: 8,
        practice_days: 15,
      },
      previous: {
        entries: 20,
        accuracy: 91.5,
        qpm: 16.9,
        practice_days: 14,
      },
      streak: { current: 50, best: 50 },
      attendance: { present: 7, absent: 1, excused: 0, percent: 87.5 },
      points: 420,
      weeks: [{ week_start: '2026-10-12', entries: 8, accuracy: 95.0 }],
      categories: [
        { name: '2 Digit 5 Rows', section: 'round', entries: 6, accuracy: 88.5, wrong: 7 },
      ],
      targets: { measured: 10, met: 8 },
      weekly_tests: [
        {
          title: 'Oct Week 2 Mock',
          date: '2026-10-11',
          category: '2 Digit 5 Rows',
          correct: 48,
          total: 50,
          time_seconds: 175,
        },
      ],
    };

    const filename = getMonthlyReportPdfFilename(sampleReport);
    assert.equal(filename, 'Trendz-Monthly-Report-STU001-2026-10.pdf');

    const pdfBytes = buildMonthlyReportPdfBytes(sampleReport);
    assert.ok(pdfBytes instanceof Uint8Array);
    assert.ok(pdfBytes.byteLength > 500);

    const pdfText = new TextDecoder().decode(pdfBytes);
    assert.ok(pdfText.startsWith('%PDF-1.4\n'));
    assert.ok(pdfText.trimEnd().endsWith('%%EOF'));
    assert.ok(pdfText.includes('Monthly Report - October 2026'));
    assert.ok(pdfText.includes('Aarav Patel'));
    assert.ok(pdfText.includes('STU001'));
    assert.ok(pdfText.includes('94.2%'));
    assert.ok(pdfText.includes('8 of 10 met target'));
  });

  it('handles empty report object gracefully without throwing', () => {
    const pdfBytes = buildMonthlyReportPdfBytes({});
    const pdfText = new TextDecoder().decode(pdfBytes);
    assert.ok(pdfText.startsWith('%PDF-1.4\n'));
    assert.ok(pdfText.trimEnd().endsWith('%%EOF'));
  });
});

