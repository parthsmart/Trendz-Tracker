/**
 * Trendz Tracker — Practice Highest Records UI Component (js/practiceRecordsCard.js)
 *
 * Renders the "Highest records ever" section for:
 * - Basics (/pages/basics.html)
 * - Flash Anzan (/pages/flash.html)
 * - Elements (/pages/elements.html)
 * - Memoriad (/pages/memoriad.html)
 *
 * Features:
 * - Category / Discipline & Settings summary
 * - Highest score or clean "No record yet" invitation
 * - Record holder permitted display name(s)
 * - Shared tie indicators for genuine ties
 * - "⭐ You hold this record!" badge when current student holds or shares the record
 * - "Attempt online" / "Set the record" button
 * - Basics duration selector pills (30s, 60s default, 120s, 300s)
 * - Accessible info popover explaining strict comparability, verification, and privacy rules
 */

import {
  BASICS_RECORD_DURATIONS,
  DEFAULT_BASICS_RECORD_DURATION,
  FLASH_RECORD_SPEEDS,
  DEFAULT_FLASH_RECORD_SPEED_MS,
  DEFAULT_FLASH_RECORD_MODE,
  loadPracticeHighestRecords,
} from './practiceRecords.js';

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
 * Returns accessible explanation text for the info popover
 */
export function getRecordsRulesExplanation(section) {
  const commonRules =
    'Only completed online drills or teacher-verified paper drills are eligible. Students with private or inactive accounts are excluded from All Students leaderboards, but can always view their own personal bests. Display names follow student privacy settings.';

  switch (section) {
    case 'basics':
      return `Basics rankings compare drills within the exact same category and fixed duration (30s, 60s, 120s, or 300s). Sorted by most correct answers, with fewest errors as tie-breaker. Genuine ties share the record. ${commonRules}`;
    case 'flash':
      return `Flash Anzan rankings evaluate the longest correctly completed sequence at each digit level (1 to 5 digits) at the chosen speed and mode. Equal counts share the record. Genuine ties share the record. ${commonRules}`;
    case 'element':
      return `Elements rankings compare attempts on the exact same worksheet drill configuration. Sorted by highest score, with fastest completion time as tie-breaker. Genuine ties share the record. ${commonRules}`;
    case 'memoriad':
      return `Memoriad rankings compare attempts within each standard competition module (Calendar, Additions, Multiplications, Square Roots). Sorted by highest official score and elapsed time. Genuine ties share the record. ${commonRules}`;
    default:
      return commonRules;
  }
}

/**
 * Basics category id from a record's attempt link (basics-practice.html?cat=...).
 */
function basicsCategoryIdOf(record) {
  const m = /[?&]cat=([^&]+)/.exec(String(record.attemptUrl || ''));
  return m ? decodeURIComponent(m[1]) : '';
}

/**
 * Basics drills are grouped like the Elements page: Add & Sub, Multiplication, Division.
 * Category names follow the "2d4r" / "2dx1d" / "3dby1d" or "3d/1d" pattern.
 */
export function basicsRecordGroupOf(title) {
  const t = String(title || '').toLowerCase();
  if (/by|\/|÷/.test(t)) return 'Division';
  if (/\dd\s*[x×*]\s*\d/.test(t) || /mult/.test(t)) return 'Multiplication';
  return 'Addition & Subtraction';
}

/**
 * Renders the HTML markup for a single record card.
 */
export function renderRecordCardHtml(record) {
  const isHeldByMe = Boolean(record.isHeldByMe);
  const hasRecord = Boolean(record.hasRecord);
  const isMyBest = record.view === 'my_best' || record.scoreDisplay === 'No personal record yet';

  let holdersHtml = '';
  if (isMyBest) {
    holdersHtml = hasRecord
      ? `<div class="record-card-holder-row"><span>Personal Record:</span> <span class="record-holder-name">${escapeHtml(record.holders?.[0]?.display_name || 'You')}</span></div>`
      : '<div class="record-card-holder-row"><span>No personal record yet</span></div>';
  } else if (hasRecord && Array.isArray(record.holders) && record.holders.length > 0) {
    const names = record.holders.map((h) => escapeHtml(h.display_name)).join(', ');
    const label = record.holders.length > 1 ? 'Record holders (Tied)' : 'Record holder';
    holdersHtml = `<div class="record-card-holder-row"><span>${label}:</span> <span class="record-holder-name">${names}</span></div>`;
  } else if (!hasRecord) {
    holdersHtml = '<div class="record-card-holder-row"><span>No holder yet &mdash; be the first!</span></div>';
  }

  const youHoldItBadge = isHeldByMe
    ? `<span class="record-you-hold-badge"><span aria-hidden="true">⭐</span> <span>${isMyBest ? 'Your Personal Best' : (record.holders?.length > 1 ? 'You share this record!' : 'You hold this record!')}</span></span>`
    : '';

  const scoreClass = hasRecord ? 'record-score-active' : 'record-score-empty';
  const emptyScoreText = isMyBest ? 'No personal record yet' : 'No record yet';
  const headerScoreLabel = hasRecord ? (isMyBest ? 'Personal Best' : 'Highest Record') : 'Status';

  const attemptBtn = record.section === 'flash'
    ? `<button
        type="button"
        class="btn btn-primary btn-sm btn-flash-attempt-record"
        data-digits="${record.rawSettings?.digits || record.digits || 1}"
        data-count="${record.rawSettings?.count || record.count || 10}"
        data-speed="${record.rawSettings?.speed_ms || record.speed_ms || DEFAULT_FLASH_RECORD_SPEED_MS}"
        data-mode="${record.rawSettings?.mode || record.mode || DEFAULT_FLASH_RECORD_MODE}"
      >${escapeHtml(record.attemptLabel || 'Attempt online')} &rarr;</button>`
    : `<a href="${escapeHtml(record.attemptUrl || '#')}" class="btn ${isHeldByMe ? 'btn-outline' : 'btn-primary'} btn-sm">${escapeHtml(record.attemptLabel || 'Attempt online')} &rarr;</a>`;

  // Basics: "Log" opens the paper-drill form below with this category selected.
  const catId = record.section === 'basics' ? basicsCategoryIdOf(record) : '';
  const logBtn = catId
    ? `<button type="button" class="btn btn-outline btn-sm btn-records-log" data-cat="${escapeHtml(catId)}" title="Log a paper drill for ${escapeHtml(record.title)}">Log</button>`
    : '';

  return `
    <div
      class="card record-card ${isHeldByMe ? 'record-card-mine' : ''}"
      data-record-id="${escapeHtml(record.id)}"
      data-record-title="${escapeHtml(String(record.title || '').toLowerCase())}"
    >
      <div class="record-card-top">
        <h4 class="record-card-title">${escapeHtml(record.title)}</h4>
        <span class="record-card-tag">${escapeHtml(record.settingsSummary || '')}</span>
      </div>
      ${youHoldItBadge}
      <div class="record-card-score">
        <span class="record-card-score-label">${headerScoreLabel}</span>
        <span class="${scoreClass} num">${hasRecord ? escapeHtml(record.scoreDisplay) : emptyScoreText}</span>
      </div>
      ${holdersHtml}
      <div class="record-card-acts">${attemptBtn}${logBtn}</div>
    </div>
  `;
}

/**
 * Initializes the Highest Records UI inside a container element.
 *
 * @param {HTMLElement} containerEl
 * @param {'basics'|'element'|'flash'|'memoriad'} section
 * @param {Object|null} callerProfile
 * @param {Object} [options]
 */
export async function setupPracticeRecordsSection(
  containerEl,
  section,
  callerProfile = null,
  options = {}
) {
  if (!containerEl) return;

  let currentView = options.defaultView || 'all';
  let currentDuration = options.defaultDuration || DEFAULT_BASICS_RECORD_DURATION;
  let currentSpeedMs = options.defaultSpeedMs || DEFAULT_FLASH_RECORD_SPEED_MS;
  let currentMode = options.defaultMode || DEFAULT_FLASH_RECORD_MODE;

  function renderSkeleton() {
    containerEl.innerHTML = `
      <div class="card" style="margin-bottom: var(--space-5); padding: var(--space-4) var(--space-5);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-3);">
          <div class="skeleton-row" style="width: 200px; height: 24px;"></div>
          <div class="skeleton-row" style="width: 120px; height: 24px;"></div>
        </div>
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: var(--space-3);">
          <div class="skeleton-row" style="height: 140px;"></div>
          <div class="skeleton-row" style="height: 140px;"></div>
          <div class="skeleton-row" style="height: 140px;"></div>
        </div>
      </div>
    `;
  }

  async function loadAndRender() {
    renderSkeleton();

    try {
      const queryOptions = {
        view: currentView,
        durationSeconds: currentDuration,
        speed_ms: currentSpeedMs,
        mode: currentMode,
        ...(section === 'flash' ? { format: 'per_digit' } : {}),
      };

      const records = await loadPracticeHighestRecords(
        section,
        queryOptions,
        callerProfile
      );

      const speedSec = (currentSpeedMs / 1000).toFixed(1);
      const sectionTitle =
        section === 'basics'
          ? 'Highest Records Ever'
          : section === 'flash'
            ? `Highest Records Ever — Best at ${speedSec}s`
            : section === 'element'
              ? 'Highest Records Ever — Elements'
              : 'Highest Records Ever — Memoriad';

      const sectionSubtitle =
        section === 'basics'
          ? 'All-time best scores across standard timed online & verified drills.'
          : section === 'flash'
            ? `Longest correctly completed sequence at ${speedSec}s (${currentMode === 'add_sub' ? 'Add & Subtract' : 'Addition'}).`
            : section === 'element'
              ? 'All-time best scores across standard Elements worksheet drills.'
              : 'All-time best scores across Memoriad competition modules.';

      const popoverContent = getRecordsRulesExplanation(section);

      // View toggle: All Students | My Best
      const viewToggleHtml = `
        <div class="records-view-toggle" role="radiogroup" aria-label="Records scope" style="display: inline-flex; background: var(--bg-surface-soft, #f1f5f9); padding: 2px; border-radius: var(--radius-sm, 6px); border: 1px solid var(--border-hairline, #e2e8f0);">
          <button
            type="button"
            class="btn-view-toggle btn-view-all ${currentView === 'all' ? 'active' : ''}"
            data-view="all"
            aria-pressed="${currentView === 'all' ? 'true' : 'false'}"
            style="padding: 2px 8px; font-size: var(--text-xs); font-weight: 600; border-radius: 4px; border: none; cursor: pointer; background: ${currentView === 'all' ? 'var(--color-surface, #fff)' : 'transparent'}; color: ${currentView === 'all' ? 'var(--color-primary, #4338ca)' : 'var(--text-muted, #64748b)'}; box-shadow: ${currentView === 'all' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none'};"
          >
            All Students
          </button>
          <button
            type="button"
            class="btn-view-toggle btn-view-my-best ${currentView === 'my_best' ? 'active' : ''}"
            data-view="my_best"
            aria-pressed="${currentView === 'my_best' ? 'true' : 'false'}"
            style="padding: 2px 8px; font-size: var(--text-xs); font-weight: 600; border-radius: 4px; border: none; cursor: pointer; background: ${currentView === 'my_best' ? 'var(--color-surface, #fff)' : 'transparent'}; color: ${currentView === 'my_best' ? 'var(--color-primary, #4338ca)' : 'var(--text-muted, #64748b)'}; box-shadow: ${currentView === 'my_best' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none'};"
          >
            My Best
          </button>
        </div>
      `;

      // Specific section filters
      let sectionFiltersHtml = '';
      if (section === 'basics') {
        sectionFiltersHtml = `
          <div class="basics-duration-pills" role="radiogroup" aria-label="Select record duration" style="display: inline-flex; gap: 3px; flex-wrap: wrap;">
            ${BASICS_RECORD_DURATIONS.map(
              (sec) => `
              <button
                type="button"
                class="btn btn-sm ${sec === currentDuration ? 'btn-primary' : 'btn-outline'} btn-duration-pill"
                data-seconds="${sec}"
                aria-pressed="${sec === currentDuration ? 'true' : 'false'}"
                style="padding: 2px 8px; font-size: var(--text-xs); font-weight: 700; height: 26px;"
              >
                ${sec}s
              </button>
            `
            ).join('')}
          </div>
        `;
      } else if (section === 'flash') {
        sectionFiltersHtml = `
          <div class="flash-records-filters" style="display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap;">
            <div style="display: inline-flex; align-items: center; gap: 4px;">
              <label for="flash-records-speed" style="font-size: var(--text-xs); color: var(--text-muted); font-weight: 600;">Speed:</label>
              <select
                id="flash-records-speed"
                class="form-select num flash-records-speed-select"
                aria-label="Filter Flash records by speed"
                style="padding: 2px 6px; font-size: var(--text-xs); font-weight: 600; height: 26px; border-radius: var(--radius-sm, 4px); border: 1px solid var(--border-hairline, #cbd5e1); background: var(--color-surface, #fff);"
              >
                ${FLASH_RECORD_SPEEDS.map((s) => `
                  <option value="${s.ms}" ${s.ms === currentSpeedMs ? 'selected' : ''}>${s.label}</option>
                `).join('')}
              </select>
            </div>
            <div class="flash-mode-pills" role="radiogroup" aria-label="Flash mode" style="display: inline-flex; background: var(--bg-surface-soft, #f1f5f9); padding: 2px; border-radius: var(--radius-sm, 6px); border: 1px solid var(--border-hairline, #e2e8f0);">
              <button
                type="button"
                class="btn-mode-pill ${currentMode === 'add' ? 'active' : ''}"
                data-mode="add"
                aria-pressed="${currentMode === 'add' ? 'true' : 'false'}"
                style="padding: 2px 8px; font-size: var(--text-xs); font-weight: 600; border-radius: 4px; border: none; cursor: pointer; background: ${currentMode === 'add' ? 'var(--color-surface, #fff)' : 'transparent'}; color: ${currentMode === 'add' ? 'var(--color-primary, #4338ca)' : 'var(--text-muted, #64748b)'}; box-shadow: ${currentMode === 'add' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none'};"
              >
                Add
              </button>
              <button
                type="button"
                class="btn-mode-pill ${currentMode === 'add_sub' ? 'active' : ''}"
                data-mode="add_sub"
                aria-pressed="${currentMode === 'add_sub' ? 'true' : 'false'}"
                style="padding: 2px 8px; font-size: var(--text-xs); font-weight: 600; border-radius: 4px; border: none; cursor: pointer; background: ${currentMode === 'add_sub' ? 'var(--color-surface, #fff)' : 'transparent'}; color: ${currentMode === 'add_sub' ? 'var(--color-primary, #4338ca)' : 'var(--text-muted, #64748b)'}; box-shadow: ${currentMode === 'add_sub' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none'};"
              >
                Add &amp; Sub
              </button>
            </div>
          </div>
        `;
      }

      const renderCards = (list) => list.map((r) => renderRecordCardHtml({ ...r, view: currentView })).join('');
      let cardsGridHtml;
      if (records.length === 0) {
        cardsGridHtml = `
          <div class="practice-records-empty">
            ${currentView === 'my_best' ? 'No personal records found.' : 'No records found for this section.'}
          </div>
        `;
      } else if (section === 'basics') {
        // Grouped like the Elements page, with a quick search.
        const groups = new Map();
        records.forEach((r) => {
          const g = basicsRecordGroupOf(r.title);
          if (!groups.has(g)) groups.set(g, []);
          groups.get(g).push(r);
        });
        const order = ['Addition & Subtraction', 'Multiplication', 'Division'];
        cardsGridHtml = order.filter((g) => groups.has(g)).map((g) => `
          <div class="practice-records-group" data-group="${escapeHtml(g)}">
            <div class="practice-records-group-h"><h4>${escapeHtml(g)}</h4><span>${groups.get(g).length} drills</span></div>
            <div class="practice-records-grid">${renderCards(groups.get(g))}</div>
          </div>
        `).join('') + '<div class="practice-records-empty practice-records-nomatch" hidden>No category matches your search.</div>';
      } else {
        cardsGridHtml = `<div class="practice-records-grid">${renderCards(records)}</div>`;
      }

      const searchHtml = section === 'basics' && records.length > 0
        ? '<input type="search" class="form-input practice-records-search" placeholder="Find a category, e.g. 2d4r" aria-label="Find a Basics category" />'
        : '';

      containerEl.innerHTML = `
        <div class="card practice-highest-records-card" style="margin-bottom: var(--space-5); padding: var(--space-4) var(--space-5);">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-3); flex-wrap: wrap; margin-bottom: var(--space-2);">
            <div>
              <div style="display: flex; align-items: center; gap: 8px;">
                <h3 style="margin: 0; font-size: var(--text-base); font-weight: 700; color: var(--color-primary); letter-spacing: 0.02em;">
                  ${escapeHtml(sectionTitle)}
                </h3>
                <span class="info-tip-wrapper">
                  <button
                    type="button"
                    class="info-tip-trigger btn-records-info-tip"
                    aria-label="About highest records and ranking rules"
                    aria-expanded="false"
                    style="border: none; background: none; cursor: pointer; padding: 2px; color: var(--text-muted);"
                  >
                    <span class="info-tip-symbol" aria-hidden="true" style="display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%; border: 1px solid var(--text-muted); font-size: 11px; font-weight: 700;">i</span>
                  </button>
                  <span class="info-tip-content records-tip-popup" role="tooltip" style="display: none; position: absolute; z-index: 100; max-width: 320px; padding: var(--space-3); background: #1e293b; color: #fff; border-radius: var(--radius-md); font-size: var(--text-xs); line-height: 1.4; box-shadow: var(--shadow-lg);">
                    ${escapeHtml(popoverContent)}
                  </span>
                </span>
              </div>
              <p style="margin: 2px 0 0 0; font-size: var(--text-xs); color: var(--text-muted);">
                ${escapeHtml(sectionSubtitle)}
              </p>
            </div>
            <div class="practice-records-toolbar" style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
              ${searchHtml}
              ${viewToggleHtml}
              ${sectionFiltersHtml}
            </div>
          </div>

          ${cardsGridHtml}
        </div>
      `;

      // Event listener for view toggle (All Students | My Best)
      containerEl.querySelectorAll('.btn-view-toggle').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const v = btn.getAttribute('data-view');
          if (v && v !== currentView) {
            currentView = v;
            await loadAndRender();
          }
        });
      });

      // Event listener for duration pills (Basics)
      containerEl.querySelectorAll('.btn-duration-pill').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const sec = Number(btn.getAttribute('data-seconds'));
          if (sec && sec !== currentDuration) {
            currentDuration = sec;
            await loadAndRender();
          }
        });
      });

      // Event listener for Flash speed select
      const speedSelect = containerEl.querySelector('.flash-records-speed-select');
      if (speedSelect) {
        speedSelect.addEventListener('change', async () => {
          const ms = Number(speedSelect.value);
          if (ms && ms !== currentSpeedMs) {
            currentSpeedMs = ms;
            await loadAndRender();
          }
        });
      }

      // Event listener for Flash mode pills
      containerEl.querySelectorAll('.btn-mode-pill').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const m = btn.getAttribute('data-mode');
          if (m && m !== currentMode) {
            currentMode = m;
            await loadAndRender();
          }
        });
      });

      // Event listener for info tip toggle
      const tipTrigger = containerEl.querySelector('.btn-records-info-tip');
      const tipPopup = containerEl.querySelector('.records-tip-popup');
      if (tipTrigger && tipPopup) {
        tipTrigger.addEventListener('click', (e) => {
          e.stopPropagation();
          const isVisible = tipPopup.style.display === 'block';
          tipPopup.style.display = isVisible ? 'none' : 'block';
          tipTrigger.setAttribute('aria-expanded', isVisible ? 'false' : 'true');
        });

        document.addEventListener('click', (e) => {
          if (!containerEl.contains(e.target)) {
            tipPopup.style.display = 'none';
            tipTrigger.setAttribute('aria-expanded', 'false');
          }
        });
      }

      // Basics: quick search across category cards
      const searchEl = containerEl.querySelector('.practice-records-search');
      if (searchEl) {
        searchEl.addEventListener('input', () => {
          const q = searchEl.value.trim().toLowerCase();
          let shown = 0;
          containerEl.querySelectorAll('.practice-records-group').forEach((grp) => {
            let inGroup = 0;
            grp.querySelectorAll('.record-card').forEach((card) => {
              const match = !q || (card.getAttribute('data-record-title') || '').includes(q);
              card.hidden = !match;
              if (match) inGroup += 1;
            });
            grp.hidden = inGroup === 0;
            shown += inGroup;
          });
          const none = containerEl.querySelector('.practice-records-nomatch');
          if (none) none.hidden = shown > 0;
        });
      }

      // Basics: "Log" fills the paper-drill form with this category
      containerEl.querySelectorAll('.btn-records-log').forEach((btn) => {
        btn.addEventListener('click', () => {
          window.dispatchEvent(new CustomEvent('practice-record-log', {
            detail: { section, categoryId: btn.getAttribute('data-cat') },
          }));
        });
      });

      // Event listener for Flash "Attempt online" buttons
      containerEl.querySelectorAll('.btn-flash-attempt-record').forEach((btn) => {
        btn.addEventListener('click', () => {
          const digits = btn.getAttribute('data-digits');
          const count = btn.getAttribute('data-count');
          const speed = btn.getAttribute('data-speed');
          const mode = btn.getAttribute('data-mode');

          if (typeof window !== 'undefined' && typeof window.applyFlashSettingsToForm === 'function') {
            window.applyFlashSettingsToForm({ digits, count, speed_ms: speed, mode });
          } else {
            // Populate form elements directly if on flash page
            const dInput = document.getElementById('flash-digits');
            const cInput = document.getElementById('flash-count');
            const sInput = document.getElementById('flash-speed-ms');
            const mInput = document.getElementById('flash-mode');

            if (dInput) dInput.value = digits;
            if (cInput) cInput.value = count;
            if (sInput) sInput.value = speed;
            if (mInput) mInput.value = mode;

            // Trigger sync
            window.dispatchEvent(new CustomEvent('flash-settings-applied', {
              detail: { digits, count, speed_ms: speed, mode }
            }));

            // Scroll to setup screen
            const setupScreen = document.getElementById('flash-setup-screen');
            if (setupScreen) {
              setupScreen.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          }
        });
      });
    } catch (err) {
      console.error('Failed to load practice records:', err);
      containerEl.innerHTML = `
        <div class="card practice-records-error" style="margin-bottom: var(--space-5); padding: var(--space-4); border: 1px solid #fecaca; background: #fef2f2; border-radius: var(--radius-md);">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-2);">
            <span style="color: #b91c1c; font-size: var(--text-xs); font-weight: 600;">
              Could not load highest records: ${escapeHtml(err.message || 'Check database connection')}
            </span>
            <button type="button" class="btn btn-sm btn-outline btn-retry-records" style="font-size: var(--text-xs); padding: 2px 10px; border-color: #b91c1c; color: #b91c1c;">
              Retry
            </button>
          </div>
        </div>
      `;
      containerEl.querySelector('.btn-retry-records')?.addEventListener('click', () => {
        loadAndRender();
      });
    }
  }

  await loadAndRender();
}
