/**
 * Trendz Tracker - Accessible Info Tooltips and "How it works" Disclosures
 * (js/infoTooltip.js)
 *
 * Implements accessible, keyboard-friendly, touch-friendly "i" help controls:
 * - Desktop: open on hover or focus (mouseenter/focusin)
 * - Mobile: open on tap (click) - First tap opens, second tap closes
 * - Escape key closes active tooltip and remains closed until deliberate new interaction
 * - Clicking/tapping outside closes open tooltips
 * - Hover help remains readable while moving pointer onto explanation
 * - Resize/scroll and viewport edges do not leave explanation clipped
 * - Comfortably tappable info controls on mobile (min 44x44px target)
 */

export const INFO_HELP_TEXTS = {
  accuracy: 'Accuracy = (Correct ÷ Attempted) × 100%. Unattempted questions are not counted as wrong.',
  targetTime: 'Target time is a suggested goal to benchmark your speed, not a timer that stops your practice.',
  source: 'Recorded by the site: completed interactively online and timed automatically. Typed: manually entered paper practice scores. Legacy: older scores logged before source tracking.',
  lockStatus: 'Verified: reviewed and approved by your teacher. Corrected: updated by your teacher. Locked: online practice sessions or entries older than 7 days cannot be modified.',
  streakRules: 'A day counts toward your streak when all assigned tasks for that day are completed. If no tasks are assigned, any completed practice session counts.',
  flashDigits: 'Number of digits in each flashing number (1 to 5 digits).',
  flashMode: 'Addition only, or mixed Addition and Subtraction (subtracted numbers show a minus sign).',
  flashCount: 'How many numbers appear in sequence before you type your answer (2 to 1000 numbers).',
  flashSpeed: 'How long each number stays on screen before disappearing (e.g. 1.0 second = 1 number per second).',
};

/**
 * Generates semantic, keyboard-accessible "i" button and tooltip markup.
 *
 * @param {string} id - Unique ID suffix for ARIA attributes
 * @param {string} text - Explanatory text
 * @param {string} [label='More information'] - Accessible label for screen readers
 * @returns {string} HTML string
 */
export function renderInfoTip(id, text, label = 'More information') {
  const cleanId = String(id || 'tip').replace(/[^a-zA-Z0-9_-]/g, '-');
  return `
    <span class="info-tip-wrapper" data-tip-id="tip-${cleanId}">
      <button
        type="button"
        class="info-tip-trigger"
        id="btn-${cleanId}"
        aria-label="${escapeAttr(label)}"
        aria-expanded="false"
        aria-describedby="tip-${cleanId}"
      >
        <span class="info-tip-symbol" aria-hidden="true">i</span>
      </button>
      <span id="tip-${cleanId}" class="info-tip-content" role="tooltip">
        ${escapeHtml(text)}
      </span>
    </span>
  `;
}

/**
 * Generates a clean "How it works" disclosure for longer instructions.
 *
 * @param {string} title
 * @param {string} bodyHtml
 * @returns {string}
 */
export function renderHowItWorks(title, bodyHtml) {
  return `
    <details class="how-it-works-disclosure">
      <summary>
        <span class="how-it-works-icon" aria-hidden="true">💡</span>
        <span>${escapeHtml(title)}</span>
      </summary>
      <div class="how-it-works-content">
        ${bodyHtml}
      </div>
    </details>
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

function escapeAttr(str) {
  return escapeHtml(str);
}

/**
 * Positions the tooltip to guarantee it stays inside the viewport boundaries.
 */
export function positionTooltip(triggerEl, contentEl) {
  if (!triggerEl || !contentEl || typeof window === 'undefined') return;
  const pad = 12;
  const viewport = window.visualViewport;
  const width = viewport?.width || window.innerWidth;
  const height = viewport?.height || window.innerHeight;
  const offsetX = viewport?.offsetLeft || 0;
  const offsetY = viewport?.offsetTop || 0;
  const trigger = triggerEl.getBoundingClientRect();
  contentEl.style.maxWidth = `${Math.max(0, Math.min(290, width - pad * 2))}px`;
  contentEl.style.maxHeight = `${Math.max(0, height - pad * 2)}px`;
  const rect = contentEl.getBoundingClientRect();
  const left = Math.max(offsetX + pad, Math.min(trigger.left + trigger.width / 2 - rect.width / 2, offsetX + width - rect.width - pad));
  const above = trigger.top - rect.height - 8;
  const below = trigger.bottom + 8;
  const preferred = above >= offsetY + pad ? above : below;
  const top = Math.max(offsetY + pad, Math.min(preferred, offsetY + height - rect.height - pad));
  contentEl.style.left = `${left}px`;
  contentEl.style.top = `${top}px`;
}

/**
 * Open a specific info tooltip.
 *
 * @param {HTMLElement} trigger
 * @param {'tap'|'hover'|'focus'} mode
 */
export function openInfoTooltip(trigger, mode = 'tap') {
  if (!trigger) return;
  trigger.setAttribute('aria-expanded', 'true');
  trigger._openMode = mode;
  trigger._dismissed = false;

  const content = trigger.nextElementSibling;
  if (content) {
    positionTooltip(trigger, content);
  }
}

/**
 * Close a specific info tooltip.
 *
 * @param {HTMLElement} trigger
 * @param {{ dismissed?: boolean }} [options]
 */
export function closeInfoTooltip(trigger, options = {}) {
  if (!trigger) return;
  trigger.setAttribute('aria-expanded', 'false');
  trigger._openMode = null;
  if (options.dismissed) {
    trigger._dismissed = true;
  }
}

/**
 * Closes all open info tooltips across the document.
 *
 * @param {{ dismissed?: boolean }} [options]
 */
export function closeAllInfoTooltips(options = {}) {
  if (typeof document === 'undefined') return;
  document.querySelectorAll('.info-tip-trigger[aria-expanded="true"]').forEach((btn) => {
    closeInfoTooltip(btn, options);
  });
}

/**
 * Sets up global event delegation on document for all info tooltips.
 */
export function setupInfoTipDelegation(root = document) {
  if (!root || root._infoTipsDelegated) return;
  root._infoTipsDelegated = true;
  let pointerFocus = null;
  const hoverTimers = new Map();
  const triggerFor = (node) => node?.closest?.('.info-tip-wrapper')?.querySelector('.info-tip-trigger');
  const cancelClose = (trigger) => {
    clearTimeout(hoverTimers.get(trigger));
    hoverTimers.delete(trigger);
  };
  const closeOthers = (except) => root.querySelectorAll('.info-tip-trigger[aria-expanded="true"]').forEach((trigger) => {
    if (trigger !== except) { cancelClose(trigger); closeInfoTooltip(trigger); }
  });
  root.addEventListener('pointerdown', (event) => {
    pointerFocus = event.target.closest?.('.info-tip-trigger') || null;
    if (!event.target.closest?.('.info-tip-wrapper')) {
      root.querySelectorAll('.info-tip-trigger[aria-expanded="true"]').forEach((trigger) => {
        cancelClose(trigger); closeInfoTooltip(trigger, { dismissed: true });
      });
    }
  }, true);
  root.addEventListener('keydown', (event) => {
    pointerFocus = null;
    if (event.key !== 'Escape') return;
    root.querySelectorAll('.info-tip-trigger[aria-expanded="true"]').forEach((trigger) => {
      cancelClose(trigger); closeInfoTooltip(trigger, { dismissed: true });
    });
  });
  root.addEventListener('pointerover', (event) => {
    if (event.pointerType === 'touch') return;
    const trigger = triggerFor(event.target);
    if (!trigger) return;
    cancelClose(trigger);
    const wrapper = trigger.closest('.info-tip-wrapper');
    if (!wrapper.contains(event.relatedTarget)) trigger._dismissed = false;
    if (trigger._dismissed || trigger.getAttribute('aria-expanded') === 'true') return;
    closeOthers(trigger); openInfoTooltip(trigger, 'hover');
  });
  root.addEventListener('pointerout', (event) => {
    if (event.pointerType === 'touch') return;
    const trigger = triggerFor(event.target);
    if (!trigger || trigger.closest('.info-tip-wrapper').contains(event.relatedTarget)) return;
    // Bridge the small gap between the icon and its explanation.
    cancelClose(trigger);
    hoverTimers.set(trigger, setTimeout(() => {
      if (trigger._openMode === 'hover') closeInfoTooltip(trigger);
      hoverTimers.delete(trigger);
    }, 150));
  });
  root.addEventListener('focusin', (event) => {
    const trigger = event.target.closest?.('.info-tip-trigger');
    if (!trigger || pointerFocus === trigger || trigger._dismissed) return;
    closeOthers(trigger); cancelClose(trigger); openInfoTooltip(trigger, 'focus');
  });
  root.addEventListener('focusout', (event) => {
    const trigger = event.target.closest?.('.info-tip-trigger');
    if (!trigger) return;
    trigger._dismissed = false;
    if (trigger._openMode === 'focus') closeInfoTooltip(trigger);
  });
  root.addEventListener('click', (event) => {
    const trigger = event.target.closest?.('.info-tip-trigger');
    if (!trigger) {
      if (!event.target.closest?.('.info-tip-wrapper')) closeOthers(null);
      return;
    }
    event.preventDefault();
    cancelClose(trigger);
    const wasPinned = trigger.getAttribute('aria-expanded') === 'true' && trigger._openMode === 'tap';
    closeOthers(trigger);
    trigger._dismissed = false;
    if (wasPinned) closeInfoTooltip(trigger, { dismissed: true });
    else openInfoTooltip(trigger, 'tap');
    pointerFocus = null;
  });
  if (typeof window !== 'undefined') {
    const reposition = () => root.querySelectorAll('.info-tip-trigger[aria-expanded="true"]').forEach((trigger) => {
      if (trigger.isConnected === false) return;
      positionTooltip(trigger, trigger.nextElementSibling);
    });
    window.addEventListener('resize', reposition, { passive: true });
    window.addEventListener('scroll', reposition, { passive: true, capture: true });
    window.visualViewport?.addEventListener('resize', reposition, { passive: true });
    window.visualViewport?.addEventListener('scroll', reposition, { passive: true });
  }
}

/**
 * Sets up global event delegation for details expand/collapse buttons across all score histories.
 */
export function setupHistoryDetailsDelegation() {
  if (typeof document === 'undefined') return;
  if (document._historyDetailsDelegated) return;
  document._historyDetailsDelegated = true;

  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.btn-history-details');
    if (!btn) return;

    e.preventDefault();
    const targetId = btn.getAttribute('data-details-toggle') || btn.getAttribute('aria-controls');
    if (!targetId) return;

    // Prefer ID match, fall back to adjacent row in same container
    const detailsRow = document.getElementById(targetId) || btn.closest('tr')?.nextElementSibling;
    if (!detailsRow) return;

    const isHidden = detailsRow.hasAttribute('hidden');
    if (isHidden) {
      detailsRow.removeAttribute('hidden');
      btn.setAttribute('aria-expanded', 'true');
      btn.classList.add('is-open');
    } else {
      detailsRow.setAttribute('hidden', '');
      btn.setAttribute('aria-expanded', 'false');
      btn.classList.remove('is-open');
    }
  });
}

// Auto-initialize on DOM ready
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setupInfoTipDelegation();
      setupHistoryDetailsDelegation();
    });
  } else {
    setupInfoTipDelegation();
    setupHistoryDetailsDelegation();
  }
}

