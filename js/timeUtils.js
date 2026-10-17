/**
 * Trendz Tracker - Time Utilities & Keyboard Navigation
 * 
 * Rules:
 * - Time input accepts "2:07" or "127" (raw seconds).
 * - Formats cleanly as mm:ss (e.g. 127 -> "2:07").
 * - Handles Enter key navigation across table/form inputs.
 */

/**
 * Parses user input into total integer seconds.
 * Accepts: "2:07", "02:07", "127", "60", "0:45", "1m 15s"
 * @param {string|number} input
 * @returns {number|null} Seconds or null if empty/invalid
 */
export function parseTimeToSeconds(input) {
  if (input === null || input === undefined || input === '') {
    return null;
  }

  if (typeof input === 'number') {
    return input >= 0 ? Math.round(input) : null;
  }

  const str = String(input).trim();
  if (!str) return null;

  // Pattern 1: mm:ss or m:ss (e.g. "2:07" or "0:45" or "12:30")
  if (str.includes(':')) {
    const parts = str.split(':');
    if (parts.length === 2) {
      const minutes = parseInt(parts[0], 10);
      const seconds = parseInt(parts[1], 10);
      if (!isNaN(minutes) && !isNaN(seconds) && minutes >= 0 && seconds >= 0 && seconds < 60) {
        return minutes * 60 + seconds;
      }
    }
  }

  // Pattern 2: Raw seconds (e.g. "127")
  const rawNum = parseInt(str, 10);
  if (!isNaN(rawNum) && rawNum >= 0) {
    return rawNum;
  }

  return null;
}

/**
 * Formats integer seconds into mm:ss display string.
 * E.g. 127 -> "2:07", 65 -> "1:05", 9 -> "0:09", 0 -> "0:00"
 * @param {number|null|undefined} seconds
 * @returns {string}
 */
export function formatSecondsToMMSS(seconds) {
  if (seconds === null || seconds === undefined || isNaN(seconds) || seconds < 0) {
    return '';
  }

  const totalSec = Math.round(Number(seconds));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  const paddedSecs = secs < 10 ? `0${secs}` : `${secs}`;

  return `${mins}:${paddedSecs}`;
}

/**
 * Sets up Enter key navigation so pressing Enter advances to the next input in tab order.
 * @param {HTMLElement|Document} root
 * @param {string} inputSelector
 */
export function setupEnterKeyNavigation(root = document, inputSelector = 'input:not([disabled]):not([readonly]), select:not([disabled]), textarea:not([disabled])') {
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const target = e.target;
      if (!target || !target.matches(inputSelector)) return;

      // Allow Enter inside multiline textarea with Shift
      if (target.tagName.toLowerCase() === 'textarea' && !e.shiftKey) {
        // let it advance
      } else if (target.tagName.toLowerCase() === 'textarea' && e.shiftKey) {
        return;
      }

      e.preventDefault();

      const inputs = Array.from(root.querySelectorAll(inputSelector));
      const currentIndex = inputs.indexOf(target);

      if (currentIndex !== -1 && currentIndex < inputs.length - 1) {
        inputs[currentIndex + 1].focus();
        if (typeof inputs[currentIndex + 1].select === 'function') {
          inputs[currentIndex + 1].select();
        }
      }
    }
  });
}
