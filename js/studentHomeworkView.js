/**
 * Trendz Tracker — Student Homework View Module (js/studentHomeworkView.js)
 *
 * Renders "Today's Homework" and homework history on /pages/student.html:
 * - Strictly isolated from daily streaks, shields, and streak calculations
 * - Shows title, instructions, assigner, type, progress vs required, duration/due date
 * - Provides direct "Practice online" links with ?homework_id= parameter
 * - Online drills CANNOT be self-certified with "Mark Done"
 * - Offline / paper drills submit honest 'pending_review' status for teacher verification
 * - Preserves complete recipient history with Today / History view toggles
 */

import {
  fetchStudentHomework,
  submitHomeworkCompletion,
  formatHomeworkTypeLabel,
} from './homeworkData.js';
import { showToast } from './toast.js';

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Returns practice link for an activity type including the homework_id parameter.
 */
export function getPracticeLinkForActivity(type, settings = {}, hwId = null) {
  const hwParam = hwId ? `&homework_id=${encodeURIComponent(hwId)}` : '';
  const hwFirstParam = hwId ? `?homework_id=${encodeURIComponent(hwId)}` : '';

  switch (type) {
    case 'basics':
      if (settings?.category_id) {
        return `/pages/basics-practice.html?cat=${encodeURIComponent(settings.category_id)}&seconds=${settings.duration_seconds || 60}${hwParam}`;
      }
      return `/pages/basics.html${hwFirstParam}`;
    case 'flash': {
      const q = new URLSearchParams();
      if (hwId) q.set('homework_id', hwId);
      if (settings?.digits) q.set('digits', settings.digits);
      if (settings?.count) q.set('count', settings.count);
      if (settings?.speed_ms) q.set('speed', settings.speed_ms);
      if (settings?.mode) q.set('mode', settings.mode);
      const qs = q.toString();
      return `/pages/flash.html${qs ? `?${qs}` : ''}`;
    }
    case 'element':
      if (settings?.drill) {
        return `/pages/element-drill.html?drill=${encodeURIComponent(settings.drill)}${hwParam}`;
      }
      return `/pages/elements.html${hwFirstParam}`;
    case 'memoriad':
      if (settings?.module) {
        const datesParam = settings.dates ? `&dates=${encodeURIComponent(settings.dates)}` : '';
        return `/pages/memoriad-play.html?module=${encodeURIComponent(settings.module)}${datesParam}${hwParam}`;
      }
      return `/pages/memoriad.html${hwFirstParam}`;
    case 'round':
      return `/pages/round-scores.html${hwFirstParam}`;
    default:
      return null;
  }
}

/**
 * Renders a single homework assignment item HTML
 */
export function renderHomeworkItemHtml(item) {
  const isDone = Boolean(item.isCompleted);
  const isPending = Boolean(item.isPendingReview);
  const required = Number(item.required_count) || 1;
  const current = Number(item.progressCount) || (isDone ? required : 0);
  const assignerName = item.assigner?.full_name || 'Teacher';
  const typeLabel = formatHomeworkTypeLabel(item.activity_type);
  const mergedSettings = {
    ...item.settings,
    category_id: item.category_id || item.settings?.category_id,
    duration_seconds: item.duration_seconds || item.settings?.duration_seconds,
  };
  const practiceLink = getPracticeLinkForActivity(item.activity_type, mergedSettings, item.id);

  let actionHtml = '';
  if (isDone) {
    actionHtml = `
      <span class="badge" style="background: #ecfdf5; color: #047857; font-weight: 700; font-size: 11px;">
        ✓ Completed
      </span>
    `;
  } else if (isPending) {
    actionHtml = `
      <span class="badge" style="background: #fef3c7; color: #92400e; font-weight: 700; font-size: 11px;">
        ⏳ Pending Review
      </span>
    `;
  } else if (practiceLink) {
    // Online graded practice MUST be completed via runner, NOT self-certified
    actionHtml = `
      <a href="${escapeHtml(practiceLink)}" class="btn btn-primary btn-sm" style="text-decoration: none; padding: 4px 10px; font-size: var(--text-xs);">
        Practice online &rarr;
      </a>
    `;
  } else {
    // Offline / paper homework submits for honest review
    actionHtml = `
      <button
        type="button"
        class="btn btn-outline btn-sm btn-submit-hw-offline"
        data-hw-id="${escapeHtml(item.id)}"
        style="padding: 4px 10px; font-size: var(--text-xs);"
      >
        Submit for Review &uarr;
      </button>
    `;
  }

  const dueDateText = item.due_date ? `Due: ${escapeHtml(item.due_date)}` : 'No due date';
  const assignedDateText = item.assigned_date ? `Assigned: ${escapeHtml(item.assigned_date)}` : '';

  return `
    <div
      class="card homework-item-card ${isDone ? 'hw-done' : ''} ${isPending ? 'hw-pending' : ''}"
      data-hw-id="${escapeHtml(item.id)}"
      style="padding: var(--space-3) var(--space-4); margin-bottom: var(--space-3); border: 1px solid ${isDone ? 'var(--color-primary-soft, #d1fae5)' : isPending ? '#fde68a' : 'var(--border-hairline)'}; border-radius: var(--radius-md); background: ${isDone ? '#f0fdf4' : isPending ? '#fffbeb' : 'var(--bg-surface)'};"
    >
      <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-3); flex-wrap: wrap;">
        <div style="flex: 1; min-width: 200px;">
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 4px;">
            <span style="font-weight: 700; font-size: var(--text-sm); color: var(--text-main);">
              ${escapeHtml(item.title)}
            </span>
            <span class="badge" style="font-size: 10px; font-weight: 600;">
              ${escapeHtml(typeLabel)}
            </span>
            <span style="font-size: 11px; color: var(--text-muted);">
              Assigned by ${escapeHtml(assignerName)}
            </span>
          </div>

          ${
            item.instructions
              ? `<div style="font-size: var(--text-xs); color: var(--text-muted); margin-bottom: 6px;">
                  ${escapeHtml(item.instructions)}
                </div>`
              : ''
          }

          <div style="display: flex; align-items: center; gap: var(--space-3); font-size: 11px; color: var(--text-dim);">
            <span>Progress: <strong class="num">${current} of ${required}</strong> completed</span>
            <span>&bull;</span>
            <span class="num">${dueDateText}</span>
            ${assignedDateText ? `<span>&bull;</span><span class="num">${assignedDateText}</span>` : ''}
          </div>
        </div>

        <div style="display: flex; align-items: center; gap: var(--space-2);">
          ${actionHtml}
        </div>
      </div>
    </div>
  `;
}

/**
 * Loads and renders student homework on the student dashboard.
 *
 * @param {string} studentId
 * @param {string|null} studentLevel
 */
export async function loadAndRenderStudentHomework(studentId, studentLevel = null) {
  const container = document.getElementById('homework-list-container');
  const badge = document.getElementById('homework-progress-badge');
  const historyBtn = document.getElementById('btn-toggle-hw-history');
  const historyContainer = document.getElementById('hw-history-list');

  if (!container) return;

  try {
    const items = await fetchStudentHomework(studentId, studentLevel);

    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    // Active items: incomplete, pending, or assigned today
    const activeItems = items.filter((i) => !i.isCompleted || i.assigned_date === todayIST);
    const completedCount = activeItems.filter((i) => i.isCompleted).length;
    const totalCount = activeItems.length;

    if (badge) {
      if (totalCount === 0) {
        badge.textContent = 'None assigned';
        badge.style.color = 'var(--text-muted)';
        badge.style.background = 'var(--bg-surface-subtle)';
      } else if (completedCount === totalCount) {
        badge.textContent = `All completed (${completedCount}/${totalCount})`;
        badge.style.color = '#047857';
        badge.style.background = '#ecfdf5';
      } else {
        badge.textContent = `${completedCount} of ${totalCount} done`;
        badge.style.color = 'var(--color-primary)';
        badge.style.background = 'var(--color-primary-soft, #eff6ff)';
      }
    }

    if (activeItems.length === 0) {
      container.innerHTML = `
        <div style="padding: var(--space-3); color: var(--text-muted); font-size: var(--text-xs); text-align: center;">
          No active homework for today. Great job!
        </div>
      `;
    } else {
      container.innerHTML = activeItems.map((item) => renderHomeworkItemHtml(item)).join('');
    }

    // Attach offline submit handlers
    container.querySelectorAll('.btn-submit-hw-offline').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const hwId = btn.getAttribute('data-hw-id');
        if (!hwId) return;

        btn.disabled = true;
        btn.textContent = 'Submitting...';

        try {
          await submitHomeworkCompletion(hwId, {
            notes: 'Submitted by student for teacher review',
          });

          showToast('success', 'Homework submitted for teacher review.');
          await loadAndRenderStudentHomework(studentId, studentLevel);
        } catch (err) {
          console.error('Failed to submit offline homework:', err);
          showToast('error', err.message || 'Could not submit homework.');
          btn.disabled = false;
          btn.textContent = 'Submit for Review ↑';
        }
      });
    });

    // Setup history toggle
    if (historyBtn && historyContainer) {
      historyBtn.onclick = () => {
        const isShown = historyContainer.style.display === 'block';
        historyContainer.style.display = isShown ? 'none' : 'block';
        historyBtn.setAttribute('aria-expanded', isShown ? 'false' : 'true');
        historyBtn.innerHTML = isShown
          ? 'View Homework History &darr;'
          : 'Hide Homework History &uarr;';

        if (!isShown) {
          renderHomeworkHistory(historyContainer, items);
        }
      };
    }

    return items;
  } catch (err) {
    console.error('Failed to load student homework:', err);
    container.innerHTML = `
      <div style="padding: var(--space-3); color: var(--color-danger); font-size: var(--text-xs);">
        Could not load homework: ${escapeHtml(err.message || 'Database error')}
      </div>
    `;
    return [];
  }
}

export function renderHomeworkHistory(container, items = []) {
  if (items.length === 0) {
    container.innerHTML = `
      <div style="font-size: var(--text-xs); color: var(--text-muted); padding: var(--space-2);">
        No past homework recorded yet.
      </div>
    `;
    return;
  }

  container.innerHTML = items.map((item) => renderHomeworkItemHtml(item)).join('');
}
