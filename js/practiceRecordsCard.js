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
    'Only completed online drills or teacher-verified paper drills are eligible. Students with private or inactive accounts are excluded. Display names follow student privacy settings.';

  switch (section) {
    case 'basics':
      return `Basics rankings compare drills within the exact same category and fixed duration (30s, 60s, 120s, or 300s). Sorted by most correct answers, with fewest errors as tie-breaker. Genuine ties share the record. ${commonRules}`;
    case 'flash':
      return `Flash Anzan rankings evaluate standard competition benchmark presets with identical digits, numbers count, speed per number, and addition/subtraction mode. Shows total verified completions and accuracy. Genuine ties share the record. ${commonRules}`;
    case 'element':
      return `Elements rankings compare attempts on the exact same worksheet drill configuration. Sorted by highest score, with fastest completion time as tie-breaker. Genuine ties share the record. ${commonRules}`;
    case 'memoriad':
      return `Memoriad rankings compare attempts within each standard competition module (Calendar, Additions, Multiplications, Square Roots). Sorted by highest official score and elapsed time. Genuine ties share the record. ${commonRules}`;
    default:
      return commonRules;
  }
}

/**
 * Renders the HTML markup for a single record card.
 */
export function renderRecordCardHtml(record) {
  const isHeldByMe = Boolean(record.isHeldByMe);
  const hasRecord = Boolean(record.hasRecord);

  let holdersHtml = '';
  if (hasRecord && Array.isArray(record.holders) && record.holders.length > 0) {
    const names = record.holders.map((h) => escapeHtml(h.display_name)).join(', ');
    const label = record.holders.length > 1 ? 'Record holders (Tied)' : 'Record holder';
    holdersHtml = `
      <div class="record-card-holder-row" style="font-size: var(--text-xs); color: var(--text-muted); margin-top: 4px;">
        <span style="font-weight: 600;">${label}:</span>
        <span class="record-holder-name" style="font-weight: 700; color: var(--text-main);">${names}</span>
      </div>
    `;
  } else if (!hasRecord) {
    holdersHtml = `
      <div class="record-card-holder-row" style="font-size: var(--text-xs); color: var(--text-muted); margin-top: 4px;">
        <span>No holder yet &mdash; be the first!</span>
      </div>
    `;
  }

  const youHoldItBadge = isHeldByMe
    ? `
      <div class="record-you-hold-badge" style="display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: var(--radius-full, 9999px); background: #fef3c7; color: #92400e; font-size: 11px; font-weight: 700; margin-bottom: 6px; border: 1px solid #fde68a;">
        <span aria-hidden="true">⭐</span>
        <span>${record.holders.length > 1 ? 'You share this record!' : 'You hold this record!'}</span>
      </div>
    `
    : '';

  const scoreClass = hasRecord ? 'record-score-active' : 'record-score-empty';
  const scoreStyle = hasRecord
    ? 'font-size: var(--text-lg); font-weight: 700; color: var(--color-primary); line-height: 1.2;'
    : 'font-size: var(--text-sm); font-weight: 600; color: var(--text-muted); font-style: italic;';

  const actionButton = record.section === 'flash'
    ? `
      <button
        type="button"
        class="btn btn-primary btn-sm btn-flash-attempt-record"
        data-digits="${record.rawSettings?.digits || 1}"
        data-count="${record.rawSettings?.count || 10}"
        data-speed="${record.rawSettings?.speed_ms || 1000}"
        data-mode="${record.rawSettings?.mode || 'add'}"
        style="width: 100%; justify-content: center;"
      >
        ${escapeHtml(record.attemptLabel || 'Attempt online')} &rarr;
      </button>
    `
    : `
      <a
        href="${escapeHtml(record.attemptUrl || '#')}"
        class="btn ${isHeldByMe ? 'btn-outline' : 'btn-primary'} btn-sm"
        style="width: 100%; justify-content: center; text-decoration: none;"
      >
        ${escapeHtml(record.attemptLabel || 'Attempt online')} &rarr;
      </a>
    `;

  return `
    <div
      class="card record-card ${isHeldByMe ? 'record-card-mine' : ''}"
      data-record-id="${escapeHtml(record.id)}"
      style="display: flex; flex-direction: column; justify-content: space-between; padding: var(--space-4); border: 1px solid ${isHeldByMe ? 'var(--color-primary)' : 'var(--border-hairline)'}; border-radius: var(--radius-md); background: ${isHeldByMe ? 'var(--color-primary-soft, #f0fdf4)' : 'var(--color-surface, #fff)'}; position: relative;"
    >
      <div>
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-2); margin-bottom: 4px;">
          <h4 style="margin: 0; font-size: var(--text-sm); font-weight: 700; color: var(--text-main);">
            ${escapeHtml(record.title)}
          </h4>
          <span class="badge" style="font-size: 10px; font-weight: 600; text-transform: uppercase;">
            ${escapeHtml(record.settingsSummary || '')}
          </span>
        </div>

        ${youHoldItBadge}

        <div style="margin: var(--space-2) 0;">
          <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); font-weight: 600;">
            ${hasRecord ? 'Highest Record' : 'Status'}
          </div>
          <div class="${scoreClass} num" style="${scoreStyle}">
            ${hasRecord ? escapeHtml(record.scoreDisplay) : 'No record yet'}
          </div>
        </div>

        ${holdersHtml}
      </div>

      <div style="margin-top: var(--space-3); padding-top: var(--space-2); border-top: 1px solid var(--border-hairline);">
        ${actionButton}
      </div>
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

  let currentDuration = options.defaultDuration || DEFAULT_BASICS_RECORD_DURATION;

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
      const records = await loadPracticeHighestRecords(
        section,
        { durationSeconds: currentDuration },
        callerProfile
      );

      const sectionTitle =
        section === 'basics'
          ? 'Highest Records Ever'
          : section === 'flash'
            ? 'Highest Records Ever — Benchmarks'
            : section === 'element'
              ? 'Highest Records Ever — Elements'
              : 'Highest Records Ever — Memoriad';

      const sectionSubtitle =
        section === 'basics'
          ? 'All-time best scores across standard timed online & verified drills.'
          : section === 'flash'
            ? 'Benchmark visualization records with identical digits, count, and speed.'
            : section === 'element'
              ? 'All-time best scores across standard Elements worksheet drills.'
              : 'All-time best scores across Memoriad competition modules.';

      const popoverContent = getRecordsRulesExplanation(section);

      // Duration selector pills for basics
      let durationSelectorHtml = '';
      if (section === 'basics') {
        durationSelectorHtml = `
          <div class="basics-duration-pills" role="radiogroup" aria-label="Select record duration" style="display: flex; gap: var(--space-1); flex-wrap: wrap;">
            ${BASICS_RECORD_DURATIONS.map(
              (sec) => `
              <button
                type="button"
                class="btn btn-sm ${sec === currentDuration ? 'btn-primary' : 'btn-outline'} btn-duration-pill"
                data-seconds="${sec}"
                aria-pressed="${sec === currentDuration ? 'true' : 'false'}"
                style="padding: 2px 10px; font-size: var(--text-xs); font-weight: 700;"
              >
                ${sec}s
              </button>
            `
            ).join('')}
          </div>
        `;
      }

      const cardsGridHtml = records.length > 0
        ? `
          <div class="practice-records-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: var(--space-3); margin-top: var(--space-3);">
            ${records.map((r) => renderRecordCardHtml(r)).join('')}
          </div>
        `
        : `
          <div style="text-align: center; padding: var(--space-5); color: var(--text-muted); font-size: var(--text-sm);">
            No records found for this section.
          </div>
        `;

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
            ${durationSelectorHtml}
          </div>

          ${cardsGridHtml}
        </div>
      `;

      // Event listener for duration pills
      containerEl.querySelectorAll('.btn-duration-pill').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const sec = Number(btn.getAttribute('data-seconds'));
          if (sec && sec !== currentDuration) {
            currentDuration = sec;
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
