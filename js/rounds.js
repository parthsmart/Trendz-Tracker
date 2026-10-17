/**
 * Trendz Tracker - Admin Rounds Management Module
 * Listing, creating with IST date proposals, editing, and deletion protection.
 */

import { isSupabaseConfigured } from './config.js';
import { requireAuth } from './guard.js';
import { closeModal, openModal, setupModalListeners } from './modal.js';
import { getSupabase } from './supabaseClient.js';
import { showToast } from './toast.js';

let allRounds = [];
let roundResultCounts = new Map(); // round_number -> count

/**
 * Returns today's date in IST (Asia/Kolkata) as YYYY-MM-DD
 */
function getTodayISTDateString() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
  } catch {
    return new Date().toISOString().split('T')[0];
  }
}

/**
 * Format date into "3 Oct 2026"
 */
function formatDateDisplay(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

/**
 * Load all rounds and their score counts
 */
async function loadRounds() {
  const tbody = document.getElementById('rounds-table-body');
  const emptyState = document.getElementById('rounds-empty-state');
  const totalRoundsEl = document.getElementById('stat-total-rounds');
  const latestRoundEl = document.getElementById('stat-latest-round');

  tbody.innerHTML = '<tr><td colspan="5"><div class="skeleton-row"></div></td></tr>';

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();

      // 1. Fetch rounds ordered newest first
      const { data: rounds, error: roundsError } = await supabase
        .from('rounds')
        .select('*')
        .order('round_number', { ascending: false });

      if (roundsError) throw new Error(roundsError.message);
      allRounds = rounds || [];

      // 2. Fetch results count per round
      const { data: results, error: resultsError } = await supabase
        .from('results')
        .select('round_number')
        .not('round_number', 'is', null);

      if (!resultsError && results) {
        roundResultCounts.clear();
        results.forEach(r => {
          const count = roundResultCounts.get(r.round_number) || 0;
          roundResultCounts.set(r.round_number, count + 1);
        });
      }
    } else {
      // Demo Mode rounds
      allRounds = [
        { round_number: 244, round_date: '2026-10-03', round_type: 'Category wise' },
        { round_number: 243, round_date: '2026-10-02', round_type: 'Category wise' },
        { round_number: 242, round_date: '2026-10-01', round_type: 'Category wise' },
      ];
      roundResultCounts.set(244, 18);
      roundResultCounts.set(243, 24);
      roundResultCounts.set(242, 24);
    }

    if (totalRoundsEl) totalRoundsEl.textContent = allRounds.length;
    if (latestRoundEl) {
      latestRoundEl.textContent = allRounds.length > 0 ? `Round ${allRounds[0].round_number}` : 'None';
    }

    renderRoundsTable();
  } catch (err) {
    console.error('Error loading rounds:', err);
    showToast('error', 'Failed to load rounds: ' + err.message);
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; color: var(--color-danger); padding: var(--space-6);">
            <div style="margin-bottom: var(--space-3); font-weight: 500;">Failed to load rounds: ${err.message || 'Network error'}</div>
            <button type="button" id="btn-retry-load-rounds" class="btn btn-outline btn-sm">
              ↻ Try Again
            </button>
          </td>
        </tr>
      `;
      document.getElementById('btn-retry-load-rounds')?.addEventListener('click', () => {
        tbody.innerHTML = '<tr><td colspan="5"><div class="skeleton-row"></div></td></tr>';
        loadRounds();
      });
    }
  }
}

/**
 * Render the rounds table
 */
function renderRoundsTable() {
  const tbody = document.getElementById('rounds-table-body');
  const emptyState = document.getElementById('rounds-empty-state');

  if (allRounds.length === 0) {
    tbody.innerHTML = '';
    emptyState.style.display = 'flex';
    return;
  }

  emptyState.style.display = 'none';

  tbody.innerHTML = allRounds.map(r => {
    const count = roundResultCounts.get(r.round_number) || 0;
    const hasResults = count > 0;

    return `
      <tr>
        <td class="num" style="font-weight: 700; color: var(--text-main);">
          Round ${r.round_number}
        </td>
        <td style="color: var(--text-muted);">
          ${formatDateDisplay(r.round_date)}
        </td>
        <td>
          <span style="font-size: var(--text-xs); color: var(--text-dim); background-color: var(--bg-surface-subtle); padding: 2px 6px; border-radius: var(--radius-sm);">
            ${escapeHtml(r.round_type)}
          </span>
        </td>
        <td class="num">
          ${hasResults ? `
            <span style="font-weight: 600; color: var(--color-primary-text);">
              ${count} ${count === 1 ? 'score' : 'scores'}
            </span>
          ` : `
            <span style="color: var(--text-dim);">0 scores</span>
          `}
        </td>
        <td style="text-align: right;">
          <div style="display: inline-flex; gap: var(--space-2);">
            <button
              type="button"
              class="btn btn-outline btn-sm btn-edit-round"
              data-number="${r.round_number}"
              data-date="${r.round_date}"
              data-type="${escapeHtml(r.round_type)}"
              title="Edit round date and type"
            >
              Edit
            </button>
            <button
              type="button"
              class="btn btn-outline btn-sm btn-delete-round"
              data-number="${r.round_number}"
              data-has-results="${hasResults}"
              ${hasResults ? 'disabled title="Cannot delete round with recorded results"' : 'title="Delete empty round"'}
            >
              Delete
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  attachRoundActionListeners();
}

/**
 * Attach button listeners for edit and delete
 */
function attachRoundActionListeners() {
  // Edit round
  document.querySelectorAll('.btn-edit-round').forEach(btn => {
    btn.addEventListener('click', () => {
      const roundNumber = btn.getAttribute('data-number');
      const roundDate = btn.getAttribute('data-date');
      const roundType = btn.getAttribute('data-type');

      document.getElementById('edit-round-number-hidden').value = roundNumber;
      document.getElementById('edit-round-number-display').textContent = roundNumber;
      document.getElementById('edit-round-date').value = roundDate;
      document.getElementById('edit-round-type').value = roundType;
      document.getElementById('edit-round-error').style.display = 'none';

      openModal('edit-round-modal');
    });
  });

  // Delete round
  document.querySelectorAll('.btn-delete-round').forEach(btn => {
    btn.addEventListener('click', async () => {
      const hasResults = btn.getAttribute('data-has-results') === 'true';
      const roundNumber = parseInt(btn.getAttribute('data-number'), 10);

      if (hasResults) {
        showToast('error', 'Cannot delete a round that already has recorded results.');
        return;
      }

      if (!confirm(`Are you sure you want to delete empty Round ${roundNumber}?`)) return;

      btn.disabled = true;
      try {
        if (isSupabaseConfigured()) {
          const supabase = await getSupabase();
          const { error } = await supabase
            .from('rounds')
            .delete()
            .eq('round_number', roundNumber);

          if (error) throw new Error(error.message);
        } else {
          allRounds = allRounds.filter(r => r.round_number !== roundNumber);
        }

        showToast('success', `Round ${roundNumber} deleted.`);
        await loadRounds();
      } catch (err) {
        showToast('error', 'Failed to delete round: ' + err.message);
        btn.disabled = false;
      }
    });
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g, tag => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag));
}

/**
 * Initialize Admin Rounds Page
 */
async function initRounds() {
  const profile = await requireAuth(['admin']);
  if (!profile) return;

  const pillContainer = document.getElementById('user-pill-container');
  if (pillContainer) pillContainer.style.display = 'flex';

  setupModalListeners();

  // "Quick Next Round" button
  document.getElementById('btn-quick-next-round')?.addEventListener('click', () => {
    const highestRound = allRounds.reduce((max, r) => Math.max(max, r.round_number || 0), 0);
    const nextRoundNumber = highestRound + 1;
    const todayIST = getTodayISTDateString();

    document.getElementById('create-round-form').reset();
    document.getElementById('new-round-number').value = nextRoundNumber;
    document.getElementById('new-round-date').value = todayIST;
    document.getElementById('new-round-type').value = 'Category wise';
    document.getElementById('create-round-error').style.display = 'none';

    openModal('create-round-modal');
  });

  // "Custom Round" button
  document.getElementById('btn-open-create-round')?.addEventListener('click', () => {
    document.getElementById('create-round-form').reset();
    document.getElementById('new-round-date').value = getTodayISTDateString();
    document.getElementById('new-round-type').value = 'Category wise';
    document.getElementById('create-round-error').style.display = 'none';

    openModal('create-round-modal');
  });

  // Create Round submit
  document.getElementById('create-round-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('create-round-error');
    const submitBtn = document.getElementById('btn-submit-create-round');
    const btnText = document.getElementById('btn-create-round-text');

    errorEl.style.display = 'none';

    const round_number = parseInt(document.getElementById('new-round-number').value, 10);
    const round_date = document.getElementById('new-round-date').value;
    const round_type = document.getElementById('new-round-type').value.trim();

    if (isNaN(round_number) || round_number < 1) {
      errorEl.textContent = 'Please enter a valid round number.';
      errorEl.style.display = 'block';
      return;
    }
    if (!round_date) {
      errorEl.textContent = 'Please select a date.';
      errorEl.style.display = 'block';
      return;
    }

    submitBtn.disabled = true;
    btnText.innerHTML = '<span class="spinner" style="margin-right: 6px;"></span> Publishing...';

    try {
      if (isSupabaseConfigured()) {
        const supabase = await getSupabase();
        const { error } = await supabase
          .from('rounds')
          .insert([{ round_number, round_date, round_type }]);

        if (error) {
          if (error.message.includes('unique') || error.code === '23505') {
            throw new Error(`Round ${round_number} already exists.`);
          }
          throw new Error(error.message);
        }
      } else {
        if (allRounds.some(r => r.round_number === round_number)) {
          throw new Error(`Round ${round_number} already exists.`);
        }
        allRounds.unshift({ round_number, round_date, round_type });
      }

      showToast('success', `Round ${round_number} published successfully.`);
      closeModal('create-round-modal');
      await loadRounds();
    } catch (err) {
      errorEl.textContent = err.message || 'Failed to create round.';
      errorEl.style.display = 'block';
    } finally {
      submitBtn.disabled = false;
      btnText.textContent = 'Publish Round';
    }
  });

  // Edit Round submit
  document.getElementById('edit-round-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('edit-round-error');
    const submitBtn = document.getElementById('btn-submit-edit-round');
    const btnText = document.getElementById('btn-edit-round-text');

    errorEl.style.display = 'none';

    const round_number = parseInt(document.getElementById('edit-round-number-hidden').value, 10);
    const round_date = document.getElementById('edit-round-date').value;
    const round_type = document.getElementById('edit-round-type').value.trim();

    if (!round_date) {
      errorEl.textContent = 'Please enter a date.';
      errorEl.style.display = 'block';
      return;
    }

    submitBtn.disabled = true;
    btnText.innerHTML = '<span class="spinner" style="margin-right: 6px;"></span> Saving...';

    try {
      if (isSupabaseConfigured()) {
        const supabase = await getSupabase();
        const { error } = await supabase
          .from('rounds')
          .update({ round_date, round_type })
          .eq('round_number', round_number);

        if (error) throw new Error(error.message);
      } else {
        const target = allRounds.find(r => r.round_number === round_number);
        if (target) {
          target.round_date = round_date;
          target.round_type = round_type;
        }
      }

      showToast('success', `Round ${round_number} updated successfully.`);
      closeModal('edit-round-modal');
      await loadRounds();
    } catch (err) {
      errorEl.textContent = err.message || 'Failed to update round.';
      errorEl.style.display = 'block';
    } finally {
      submitBtn.disabled = false;
      btnText.textContent = 'Save Changes';
    }
  });

  // Initial load
  await loadRounds();
}

document.addEventListener('DOMContentLoaded', initRounds);
