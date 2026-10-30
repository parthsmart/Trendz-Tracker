/**
 * Trendz Tracker - Student Weekly Test Controller (js/weeklyTest.js)
 *
 * Phase 13a:
 * - Calls `my_weekly_tests()` (or DemoDB.mockMyWeeklyTests in Demo Mode).
 * - Groups tests via `groupTests(tests)` into "Available now", "Upcoming", and "Past".
 * - Online test cards show title, date, opening/closing window (India time; "All day (India time)" when empty),
 *   notes, and section cards in position order with category, duration, status chip ("To do", "Done: 18 of 20",
 *   or "Missed"), and a "Start" button when status is "To do" and the test is 'open'.
 * - Offline test cards show date, "With your trainer", and scores once entered (category, correct out of total,
 *   "Entered by teacher").
 * - Past tests show per-section scores with the shared score colour (js/scoreColors.js).
 * - Clicking "Start" shows a confirmation modal:
 *   "You can take this section only once. If you leave the page, the section is lost."
 * - Starting calls `/api/weekly-test` (`action: 'start'`), sets a `beforeunload` warning while the section is running,
 *   and opens the timed one-question-at-a-time player (fixed section time).
 * - When time runs out or the student finishes, sends `submit`. If sending fails, keeps answers in memory and shows
 *   "Try sending again" until the section expires.
 * - Results screen shows: correct out of attempted, accuracy, time, "Saved as part of <test title>",
 *   and either "Next section" or "Test complete".
 */

import { requireAuth } from './guard.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { isDemoMode } from './demoDb.js';
import { showToast } from './toast.js';
import { getScoreFeedback } from './scoreColors.js';
import { formatSectionDuration } from './basicsSupport.js';
import {
  sectionStatusLabel,
  isSectionStartable,
  nextSection,
  windowText,
  groupTests,
} from './weeklyTestView.js';
import { createDrillPlayer, computeRemainingSeconds } from './drillPlayer.js';
import { formatDisplayDateIST, formatSecondsToTime } from './stats.js';
import { openModal, closeModal, setupModalListeners, setupAdminNav } from './modal.js';

let currentProfile = null;
let myTests = [];

// Active running section state
let pendingStartRequest = null; // { testId, testTitle, categoryId, categoryName, seconds }
let activeTestId = null;
let activeTestTitle = '';
let activeCategoryId = null;
let activeCategoryName = '';
let activeSessionId = null;
let activeSeconds = 60;
let activeExpiresAtMs = 0;
let activePlayer = null;
let roundTimerId = null;
let countdownEndMs = 0;
let sectionRunning = false;
let roundEnded = false;
let isSubmitting = false;
let pendingSubmissionAnswers = null;

async function getAccessToken() {
  if (!isSupabaseConfigured()) return null;
  const supabase = await getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token || null;
}

function formatSecondsToMMSS(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const mins = Math.floor(s / 60);
  const rem = s % 60;
  return `${mins}:${String(rem).padStart(2, '0')}`;
}

async function initStudentWeeklyTestPage() {
  currentProfile = await requireAuth(['student']);
  if (!currentProfile) return;

  renderHeaderUser(currentProfile);
  setupAdminNav();
  setupModalListeners();

  if (isDemoMode()) {
    renderDemoBanner();
  }

  setupBeforeUnloadGuard();
  setupStartModalHandlers();
  setupPlayerHandlers();
  setupResultsHandlers();

  await loadMyWeeklyTests();
}

function setupBeforeUnloadGuard() {
  window.addEventListener('beforeunload', (e) => {
    if (sectionRunning) {
      e.preventDefault();
      e.returnValue =
        'You are currently taking a weekly test section. If you leave the page, this section is lost.';
      return e.returnValue;
    }
  });
}

function showErrorBanner(msg) {
  const banner = document.getElementById('weekly-test-error-banner');
  if (!banner) return;
  if (!msg) {
    banner.style.display = 'none';
    banner.textContent = '';
  } else {
    banner.textContent = msg;
    banner.style.display = 'block';
  }
}

function showScreen(screenId) {
  ['screen-list', 'screen-player', 'screen-results'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.style.display = id === screenId ? 'block' : 'none';
    }
  });
}

async function loadMyWeeklyTests() {
  const container = document.getElementById('weekly-tests-content');
  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase.rpc('my_weekly_tests');
      if (error) throw error;
      myTests = Array.isArray(data) ? data : [];
    } else if (isDemoMode() && DemoDB && DemoDB.mockMyWeeklyTests) {
      myTests = DemoDB.mockMyWeeklyTests(currentProfile.id);
    } else {
      myTests = [];
    }

    renderWeeklyTestsGroups();
  } catch (err) {
    console.error('Failed to load my_weekly_tests:', err);
    if (container) {
      container.innerHTML = `
        <div class="card" style="padding: var(--space-6); color: var(--color-danger); text-align: center;">
          Could not load weekly tests: ${escapeHtml(err.message || 'Unknown error')}
        </div>
      `;
    }
  }
}

function renderWeeklyTestsGroups() {
  const container = document.getElementById('weekly-tests-content');
  if (!container) return;

  const { availableNow, upcoming, past } = groupTests(myTests);

  if (availableNow.length === 0 && upcoming.length === 0 && past.length === 0) {
    container.innerHTML = `
      <div class="card" style="text-align: center; padding: var(--space-8); color: var(--text-muted);">
        <div style="font-size: 2rem; margin-bottom: var(--space-2);" aria-hidden="true">📝</div>
        <h2 style="font-size: var(--text-lg); color: var(--text-main); margin-bottom: var(--space-1);">
          No weekly tests yet
        </h2>
        <p style="font-size: var(--text-sm); margin: 0;">
          When your trainer schedules an online or offline weekly test for your level, it will appear here.
        </p>
      </div>
    `;
    return;
  }

  let html = '';

  if (availableNow.length > 0) {
    html += `
      <div style="margin-bottom: var(--space-6);">
        <div style="display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-3);">
          <h2 style="font-size: var(--text-lg); margin: 0;">Available now</h2>
          <span class="status-chip chip-verified" style="font-size: 11px;">${availableNow.length}</span>
        </div>
        <div style="display: flex; flex-direction: column; gap: var(--space-4);">
          ${availableNow.map((test) => renderTestCard(test, 'available')).join('')}
        </div>
      </div>
    `;
  }

  if (upcoming.length > 0) {
    html += `
      <div style="margin-bottom: var(--space-6);">
        <div style="display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-3);">
          <h2 style="font-size: var(--text-lg); margin: 0;">Upcoming</h2>
          <span class="status-chip chip-unverified" style="font-size: 11px;">${upcoming.length}</span>
        </div>
        <div style="display: flex; flex-direction: column; gap: var(--space-4);">
          ${upcoming.map((test) => renderTestCard(test, 'upcoming')).join('')}
        </div>
      </div>
    `;
  }

  if (past.length > 0) {
    html += `
      <div style="margin-bottom: var(--space-6);">
        <div style="display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-3);">
          <h2 style="font-size: var(--text-lg); margin: 0;">Past</h2>
          <span class="status-chip chip-unverified" style="font-size: 11px;">${past.length}</span>
        </div>
        <div style="display: flex; flex-direction: column; gap: var(--space-4);">
          ${past.map((test) => renderTestCard(test, 'past')).join('')}
        </div>
      </div>
    `;
  }

  container.innerHTML = html;

  // Bind "Start" buttons on startable online sections
  container.querySelectorAll('.btn-start-test-section').forEach((btn) => {
    btn.onclick = () => {
      const testId = btn.getAttribute('data-test-id');
      const testTitle = btn.getAttribute('data-test-title');
      const categoryId = btn.getAttribute('data-category-id');
      const categoryName = btn.getAttribute('data-category-name');
      const seconds = Number(btn.getAttribute('data-seconds')) || 60;

      promptStartSection({
        testId,
        testTitle,
        categoryId,
        categoryName,
        seconds,
      });
    };
  });
}

function renderTestCard(test, groupKind) {
  const isOnline = String(test.type || test.test_type || 'offline').toLowerCase() === 'online';
  const dateLabel = formatDisplayDateIST(test.test_date);
  const state = String(test.state || '').toLowerCase();

  if (isOnline) {
    const winLabel = windowText(test.opens_at, test.closes_at);
    const sections = Array.isArray(test.sections)
      ? [...test.sections].sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0))
      : [];

    const borderStyle =
      groupKind === 'available'
        ? 'border-left: 4px solid var(--color-primary);'
        : '';

    return `
      <article class="card" style="padding: var(--space-5); ${borderStyle}">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-3);">
          <div>
            <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
              <h3 style="font-size: var(--text-base); font-weight: 700; margin: 0;">
                ${escapeHtml(test.title)}
              </h3>
              <span class="status-chip" style="background: #DBEAFE; color: #1E40AF; font-size: 11px;">
                Online
              </span>
            </div>
            <div style="font-size: var(--text-xs); color: var(--text-muted); margin-top: 4px;">
              <span class="num" style="font-weight: 600;">${escapeHtml(dateLabel)}</span>
              &middot;
              <span>Window: ${escapeHtml(winLabel)}</span>
            </div>
            ${
              test.notes
                ? `<p style="font-size: var(--text-xs); color: var(--text-dim); margin: 6px 0 0 0;">${escapeHtml(test.notes)}</p>`
                : ''
            }
          </div>
        </div>

        <!-- Online Sections List in Position Order -->
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: var(--space-3); margin-top: var(--space-3);">
          ${sections
            .map((sec, idx) => {
              const statusText = sectionStatusLabel(sec, state);
              const startable = isSectionStartable(sec, state);
              const durLabel = formatSectionDuration(sec.seconds);
              const hasScore =
                sec.attempt === 'submitted' &&
                sec.total !== null &&
                sec.total !== undefined &&
                Number(sec.total) > 0;
              const fb = hasScore ? getScoreFeedback(sec.correct, sec.total) : null;

              let chipHtml = '';
              if (statusText.startsWith('Done:')) {
                if (fb) {
                  chipHtml = `
                    <span class="status-chip ${fb.badgeClass}" style="color: ${fb.colorVar}; background: ${fb.bgVar}; font-size: 11px;">
                      ${escapeHtml(statusText)} &middot; ${escapeHtml(fb.wrongText)}
                    </span>
                  `;
                } else {
                  chipHtml = `<span class="status-chip chip-verified" style="font-size: 11px;">${escapeHtml(statusText)}</span>`;
                }
              } else if (statusText === 'Missed') {
                chipHtml = `<span class="status-chip chip-flagged" style="font-size: 11px;">Missed</span>`;
              } else {
                chipHtml = `<span class="status-chip chip-unverified" style="font-size: 11px;">To do</span>`;
              }

              return `
                <div style="padding: var(--space-3) var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--bg-surface-subtle); display: flex; flex-direction: column; justify-content: space-between; gap: var(--space-3);">
                  <div>
                    <div style="display: flex; justify-content: space-between; align-items: center; gap: var(--space-2);">
                      <span style="font-weight: 700; font-size: var(--text-sm); color: var(--text-main);">
                        ${idx + 1}. ${escapeHtml(sec.name)}
                      </span>
                      <span class="num" style="font-size: 11px; color: var(--text-muted); font-weight: 600;">
                        ${escapeHtml(durLabel)}
                      </span>
                    </div>
                    <div style="margin-top: var(--space-2); display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                      ${chipHtml}
                      ${
                        hasScore && sec.time_seconds != null
                          ? `<span class="num" style="font-size: 11px; color: var(--text-muted);">(${escapeHtml(formatSecondsToTime(sec.time_seconds))})</span>`
                          : ''
                      }
                    </div>
                  </div>

                  ${
                    startable
                      ? `
                        <button
                          type="button"
                          class="btn btn-primary btn-sm btn-start-test-section"
                          data-test-id="${escapeHtml(test.id)}"
                          data-test-title="${escapeHtml(test.title)}"
                          data-category-id="${escapeHtml(sec.category_id)}"
                          data-category-name="${escapeHtml(sec.name)}"
                          data-seconds="${Number(sec.seconds) || 60}"
                          style="width: 100%; justify-content: center;"
                        >
                          Start
                        </button>
                      `
                      : ''
                  }
                </div>
              `;
            })
            .join('')}
        </div>
      </article>
    `;
  }

  // Offline Test Card
  const scores = Array.isArray(test.scores) ? test.scores : [];
  return `
    <article class="card" style="padding: var(--space-5);">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: var(--space-2);">
        <div>
          <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
            <h3 style="font-size: var(--text-base); font-weight: 700; margin: 0;">
              ${escapeHtml(test.title)}
            </h3>
            <span class="status-chip chip-unverified" style="font-size: 11px;">
              With your trainer
            </span>
          </div>
          <div style="font-size: var(--text-xs); color: var(--text-muted); margin-top: 4px;">
            <span class="num" style="font-weight: 600;">${escapeHtml(dateLabel)}</span>
            &middot; Offline assessment
          </div>
          ${
            test.notes
              ? `<p style="font-size: var(--text-xs); color: var(--text-dim); margin: 6px 0 0 0;">${escapeHtml(test.notes)}</p>`
              : ''
          }
        </div>
      </div>

      ${
        scores.length > 0
          ? `
            <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--space-3); margin-top: var(--space-3);">
              ${scores
                .map((sc) => {
                  const fb = getScoreFeedback(sc.correct, sc.total);
                  const sourceLabel =
                    sc.source === 'online' ? 'Online' : 'Entered by teacher';
                  return `
                    <div style="padding: var(--space-3) var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--bg-surface-subtle);">
                      <div style="display: flex; justify-content: space-between; align-items: center; gap: var(--space-2);">
                        <span style="font-weight: 700; font-size: var(--text-sm); color: var(--text-main);">
                          ${escapeHtml(sc.category)}
                        </span>
                        <span class="status-chip ${fb.badgeClass}" style="color: ${fb.colorVar}; background: ${fb.bgVar}; font-size: 11px;">
                          ${sc.correct} of ${sc.total} &middot; ${escapeHtml(fb.wrongText)}
                        </span>
                      </div>
                      <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 6px; font-size: 11px; color: var(--text-muted);">
                        <span>${escapeHtml(sourceLabel)}</span>
                        ${
                          sc.time_seconds != null
                            ? `<span class="num">${escapeHtml(formatSecondsToTime(sc.time_seconds))}</span>`
                            : ''
                        }
                      </div>
                    </div>
                  `;
                })
                .join('')}
            </div>
          `
          : `
            <p style="font-size: var(--text-xs); color: var(--text-muted); margin: var(--space-3) 0 0 0;">
              Scores will appear here once entered by your trainer.
            </p>
          `
      }
    </article>
  `;
}

// ============================================================================
// START SECTION CONFIRMATION & TIMED PLAYER
// ============================================================================

function promptStartSection({ testId, testTitle, categoryId, categoryName, seconds }) {
  pendingStartRequest = { testId, testTitle, categoryId, categoryName, seconds };
  const summaryEl = document.getElementById('start-section-modal-summary');
  if (summaryEl) {
    summaryEl.textContent = `${testTitle} — ${categoryName} (${formatSectionDuration(seconds)})`;
  }
  openModal('start-section-modal');
}

function setupStartModalHandlers() {
  const btnConfirm = document.getElementById('btn-confirm-start-section');
  if (!btnConfirm) return;

  btnConfirm.onclick = async () => {
    if (!pendingStartRequest) return;
    const reqInfo = { ...pendingStartRequest };
    btnConfirm.disabled = true;

    try {
      closeModal('start-section-modal');
      await startWeeklyTestSection(reqInfo);
    } finally {
      btnConfirm.disabled = false;
    }
  };
}

async function startWeeklyTestSection({ testId, testTitle, categoryId, categoryName, seconds }) {
  showErrorBanner('');

  try {
    let payload = null;

    if (isSupabaseConfigured()) {
      const token = await getAccessToken();
      const resp = await fetch('/api/weekly-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          action: 'start',
          test_id: testId,
          category_id: categoryId,
        }),
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(data.error || 'Could not start this weekly test section.');
      }
      payload = data;
    } else if (isDemoMode() && DemoDB && DemoDB.mockStartWeeklyTestSection) {
      payload = DemoDB.mockStartWeeklyTestSection(currentProfile.id, testId, categoryId);
    } else {
      throw new Error('Database connection is not configured.');
    }

    activeTestId = testId;
    activeTestTitle = payload.title || testTitle || 'Weekly Test';
    activeCategoryId = categoryId;
    activeCategoryName = payload.category_name || categoryName;
    activeSessionId = payload.session_id;
    activeSeconds = Number(payload.seconds || seconds || 60);
    activeExpiresAtMs = Date.now() + (activeSeconds + 60) * 1000;

    roundEnded = false;
    sectionRunning = true;
    pendingSubmissionAnswers = null;

    const retryBox = document.getElementById('player-submit-retry-box');
    const answerForm = document.getElementById('player-answer-form');
    if (retryBox) retryBox.style.display = 'none';
    if (answerForm) answerForm.style.display = 'flex';

    const testBadgeEl = document.getElementById('player-test-badge');
    const catBadgeEl = document.getElementById('player-category-badge');
    if (testBadgeEl) testBadgeEl.textContent = activeTestTitle;
    if (catBadgeEl) catBadgeEl.textContent = activeCategoryName;

    activePlayer = createDrillPlayer(payload.questions || [], {
      mode: 'timed',
      revisitSkipped: false,
    });

    showScreen('screen-player');
    startSectionCountdown();
    renderCurrentPlayerQuestion();
  } catch (err) {
    console.error('Failed to start weekly test section:', err);
    showErrorBanner(err.message || 'Could not start weekly test section.');
    showToast('error', err.message || 'Could not start weekly test section.');
    await loadMyWeeklyTests();
  }
}

function startSectionCountdown() {
  stopSectionCountdown();
  const nowPerf = performance.now();
  countdownEndMs = nowPerf + Number(activeSeconds) * 1000;

  const stopwatchEl = document.getElementById('player-stopwatch');
  const fillEl = document.getElementById('player-progress-bar-fill');

  if (stopwatchEl) stopwatchEl.textContent = formatSecondsToMMSS(activeSeconds);
  if (fillEl) fillEl.style.width = '100%';

  roundTimerId = window.setInterval(() => {
    if (roundEnded) return;
    const tick = computeRemainingSeconds(
      countdownEndMs,
      performance.now(),
      Number(activeSeconds)
    );
    if (stopwatchEl) {
      stopwatchEl.textContent = formatSecondsToMMSS(tick.remainingSeconds);
    }
    if (fillEl) {
      fillEl.style.width = `${tick.progressPercent.toFixed(1)}%`;
    }
    if (tick.expired) {
      handleSectionTimeUp();
    }
  }, 250);
}

function stopSectionCountdown() {
  if (roundTimerId !== null) {
    clearInterval(roundTimerId);
    roundTimerId = null;
  }
}

function renderCurrentPlayerQuestion() {
  if (!activePlayer) return;
  const state = activePlayer.getState();

  const answeredLabelEl = document.getElementById('player-answered-label');
  if (answeredLabelEl) {
    answeredLabelEl.textContent = `Answered ${state.attemptedCount}`;
  }

  if (state.isFinished) {
    roundEnded = true;
    stopSectionCountdown();
    const finalAnswers = activePlayer.finish();
    if (finalAnswers !== null) {
      submitWeeklyTestSection(finalAnswers);
    }
    return;
  }

  const stageEl = document.getElementById('player-question-stage');
  const inputEl = document.getElementById('player-answer-input');
  const q = state.currentQuestion;

  if (stageEl && q) {
    if (typeof q === 'object' && Array.isArray(q.rows)) {
      const rowsHtml = q.rows
        .map((num) => {
          const sign = num < 0 ? '-' : '+';
          const mag = Math.abs(Number(num));
          return `
            <div style="display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-4); width: 140px; padding: 2px 0; font-size: 1.65rem; font-weight: 800; font-variant-numeric: tabular-nums; line-height: 1.25;">
              <span style="color: ${num < 0 ? 'var(--color-score-warning)' : 'var(--text-muted)'}; font-weight: 700;">${sign}</span>
              <span style="text-align: right; color: var(--text-main);">${mag}</span>
            </div>
          `;
        })
        .join('');

      stageEl.innerHTML = `
        <div style="display: inline-flex; flex-direction: column; align-items: center; padding: var(--space-2) var(--space-4);">
          ${rowsHtml}
          <div style="width: 156px; border-bottom: 3px solid var(--text-main); margin-top: var(--space-2);" aria-hidden="true"></div>
        </div>
      `;
    } else {
      const promptText =
        typeof q === 'object' && q !== null ? String(q.text || '') : String(q ?? '');
      stageEl.innerHTML = `
        <div style="font-size: 2.25rem; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--text-main); text-align: center; padding: var(--space-4);">
          ${escapeHtml(promptText)}
        </div>
      `;
    }
  }

  if (inputEl) {
    inputEl.value = '';
    inputEl.disabled = false;
    inputEl.focus();
  }
}

function handleSectionTimeUp() {
  if (roundEnded || !activePlayer) return;
  roundEnded = true;
  stopSectionCountdown();

  const reachedAnswers = activePlayer.finish();
  if (reachedAnswers === null) return;
  submitWeeklyTestSection(reachedAnswers);
}

function setupPlayerHandlers() {
  const form = document.getElementById('player-answer-form');
  const inputEl = document.getElementById('player-answer-input');
  const skipBtn = document.getElementById('btn-player-skip');
  const finishBtn = document.getElementById('btn-player-finish');
  const retryBtn = document.getElementById('btn-retry-submit');

  if (form) {
    form.onsubmit = (e) => {
      e.preventDefault();
      if (roundEnded || !activePlayer || isSubmitting) return;
      const val = inputEl ? inputEl.value.trim() : '';
      if (!val) {
        if (inputEl) inputEl.focus();
        return;
      }
      activePlayer.submitCurrent(val);
      renderCurrentPlayerQuestion();
    };
  }

  if (skipBtn) {
    skipBtn.onclick = () => {
      if (roundEnded || !activePlayer || isSubmitting) return;
      activePlayer.skipCurrent();
      renderCurrentPlayerQuestion();
    };
  }

  if (finishBtn) {
    finishBtn.onclick = () => {
      if (roundEnded || !activePlayer || isSubmitting) return;
      const reachedCount = activePlayer.getAttemptedCount();
      const confirmMsg =
        reachedCount === 0
          ? 'You have not answered any questions yet. Submit this section with 0 answers (you cannot take it again)?'
          : `Finish this section early and submit the ${reachedCount} ${
              reachedCount === 1 ? 'question' : 'questions'
            } you have answered?`;

      if (!window.confirm(confirmMsg)) {
        if (inputEl) inputEl.focus();
        return;
      }

      roundEnded = true;
      stopSectionCountdown();
      const reachedAnswers = activePlayer.finish();
      if (reachedAnswers !== null) {
        submitWeeklyTestSection(reachedAnswers);
      }
    };
  }

  if (retryBtn) {
    retryBtn.onclick = () => {
      if (!pendingSubmissionAnswers || isSubmitting) return;
      if (Date.now() > activeExpiresAtMs) {
        showToast('error', 'The submission window for this section has expired.');
        sectionRunning = false;
        showScreen('screen-list');
        loadMyWeeklyTests();
        return;
      }
      submitWeeklyTestSection(pendingSubmissionAnswers);
    };
  }
}

async function submitWeeklyTestSection(answersArray) {
  if (isSubmitting) return;
  isSubmitting = true;
  pendingSubmissionAnswers = answersArray;

  const inputEl = document.getElementById('player-answer-input');
  const answerForm = document.getElementById('player-answer-form');
  const retryBox = document.getElementById('player-submit-retry-box');
  const retryMsg = document.getElementById('player-submit-retry-msg');
  const retryBtn = document.getElementById('btn-retry-submit');

  if (inputEl) inputEl.disabled = true;
  if (retryBtn) retryBtn.disabled = true;

  try {
    let resultPayload = null;

    if (isSupabaseConfigured()) {
      const token = await getAccessToken();
      const resp = await fetch('/api/weekly-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          action: 'submit',
          session_id: activeSessionId,
          answers: answersArray,
        }),
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(data.error || 'Could not submit weekly test section.');
      }
      resultPayload = data;
    } else if (isDemoMode() && DemoDB && DemoDB.mockSubmitWeeklyTestSection) {
      resultPayload = DemoDB.mockSubmitWeeklyTestSection(
        currentProfile.id,
        activeSessionId,
        answersArray
      );
    } else {
      throw new Error('Database connection is not configured.');
    }

    sectionRunning = false;
    pendingSubmissionAnswers = null;

    // Reload tests so `nextSection(sections)` reflects the updated attempt status
    await loadMyWeeklyTests();
    renderSectionResultsScreen(resultPayload);
  } catch (err) {
    console.error('Failed to submit weekly test section:', err);
    if (answerForm) answerForm.style.display = 'none';
    if (retryBox) retryBox.style.display = 'block';

    const expired = Date.now() > activeExpiresAtMs;
    if (retryMsg) {
      retryMsg.textContent = expired
        ? 'The submission window for this section has expired.'
        : `${err.message || 'Could not send your section answers.'} Your answers are still safe in memory.`;
    }
    if (retryBtn) {
      retryBtn.style.display = expired ? 'none' : 'inline-flex';
      retryBtn.disabled = false;
    }
  } finally {
    isSubmitting = false;
  }
}

function renderSectionResultsScreen(result) {
  const correct = Number(result?.correct) || 0;
  const attempted = Number(result?.attempted) || 0;
  const accuracy = Number(result?.accuracy) || 0;
  const usedSeconds = Number(result?.used_seconds) || activeSeconds;

  const savedBadgeEl = document.getElementById('results-saved-badge');
  const headlineEl = document.getElementById('results-headline');
  const subheadlineEl = document.getElementById('results-subheadline');
  const scoreTextEl = document.getElementById('results-score-text');
  const accTextEl = document.getElementById('results-accuracy-text');
  const timeTextEl = document.getElementById('results-time-text');
  const nextSecBtn = document.getElementById('btn-results-next-section');
  const backBtn = document.getElementById('btn-results-back-list');

  if (savedBadgeEl) {
    savedBadgeEl.textContent = `Saved as part of ${activeTestTitle}`;
  }
  if (headlineEl) {
    headlineEl.textContent = `${correct} out of ${attempted}`;
  }
  if (scoreTextEl) {
    scoreTextEl.textContent = `${correct} out of ${attempted}`;
  }
  if (accTextEl) {
    accTextEl.textContent = `${accuracy}%`;
  }
  if (timeTextEl) {
    timeTextEl.textContent = formatSecondsToTime(usedSeconds);
  }

  // Check if there is a next "To do" section in this test
  const updatedTest = myTests.find((t) => t.id === activeTestId);
  const nextTodoSec =
    updatedTest && String(updatedTest.state).toLowerCase() === 'open'
      ? nextSection(updatedTest.sections || [])
      : null;

  if (nextTodoSec) {
    if (subheadlineEl) {
      subheadlineEl.textContent = `${activeCategoryName} complete · Up next: ${nextTodoSec.name} (${formatSectionDuration(
        nextTodoSec.seconds
      )})`;
    }
    if (nextSecBtn) {
      nextSecBtn.style.display = 'inline-flex';
      nextSecBtn.textContent = `Next section: ${nextTodoSec.name} →`;
      nextSecBtn.onclick = () => {
        promptStartSection({
          testId: updatedTest.id,
          testTitle: updatedTest.title,
          categoryId: nextTodoSec.category_id,
          categoryName: nextTodoSec.name,
          seconds: Number(nextTodoSec.seconds) || 60,
        });
      };
    }
    if (backBtn) {
      backBtn.textContent = 'Back to Weekly Tests';
    }
  } else {
    if (subheadlineEl) {
      subheadlineEl.textContent = 'Test complete';
    }
    if (nextSecBtn) {
      nextSecBtn.style.display = 'none';
    }
    if (backBtn) {
      backBtn.textContent = 'Test complete — View Weekly Tests';
    }
  }

  showScreen('screen-results');
}

function setupResultsHandlers() {
  const backBtn = document.getElementById('btn-results-back-list');
  if (backBtn) {
    backBtn.onclick = async () => {
      showScreen('screen-list');
      await loadMyWeeklyTests();
    };
  }
}

function renderHeaderUser(profile) {
  const container = document.getElementById('user-pill-container');
  const nameEl = document.getElementById('header-user-name');
  const codeEl = document.getElementById('header-user-code');

  if (nameEl) nameEl.textContent = profile.full_name || 'Student';
  if (codeEl) codeEl.textContent = profile.student_code || '';
  if (container) container.style.display = 'flex';
}

function renderDemoBanner() {
  const placeholder = document.getElementById('config-banner-placeholder');
  if (!placeholder) return;
  placeholder.innerHTML = `
    <div class="banner banner-warning" style="margin-bottom: var(--space-5);" role="alert">
      <strong>Demo Mode Active:</strong> You are exploring with mock data on localhost/preview. Supabase credentials are not configured.
    </div>
  `;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

document.addEventListener('DOMContentLoaded', initStudentWeeklyTestPage);
