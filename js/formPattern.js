/**
 * Trendz Tracker — Modal Form Pattern Pure Helpers (js/formPattern.js)
 *
 * Phase 14b Calmer UI:
 * - `shouldOpenMoreOptions(optionalValues, isEdit)`:
 *   Returns `true` when editing (`isEdit === true`) and at least one optional field has a non-empty / non-default value.
 * - `buildModalLiveSummary(kind, values)`:
 *   Builds a calm, single-line live summary sentence displayed directly above the modal action buttons.
 */

function trimStr(val) {
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

/**
 * Determines whether the collapsible "More options" `<details>` block should open by default.
 * Rule: Collapsed on create flows; open by default when editing AND at least one optional value is set.
 *
 * @param {Array<unknown>|Record<string, unknown>} optionalValues
 * @param {boolean} [isEdit=false]
 * @returns {boolean}
 */
export function shouldOpenMoreOptions(optionalValues, isEdit = false) {
  if (!isEdit) return false;
  if (!optionalValues) return false;

  const list = Array.isArray(optionalValues)
    ? optionalValues
    : typeof optionalValues === 'object'
      ? Object.values(optionalValues)
      : [optionalValues];

  return list.some((val) => {
    if (val === null || val === undefined || val === false) return false;
    if (typeof val === 'boolean') return val === true;
    if (typeof val === 'number') return Number.isFinite(val);
    const s = trimStr(val);
    return s.length > 0 && s.toLowerCase() !== 'any';
  });
}

/**
 * Builds the live summary sentence shown above modal footer buttons for all 8 modal forms.
 *
 * @param {'todo'|'weeklyTest'|'profile'|'studentCreate'|'target'|'resource'|'announcement'|'attendance'|'round'} kind
 * @param {Record<string, any>} [values={}]
 * @returns {string}
 */
export function buildModalLiveSummary(kind, values = {}) {
  const v = values && typeof values === 'object' ? values : {};

  switch (kind) {
    case 'todo': {
      const sectionRaw = trimStr(v.section || 'basics').toLowerCase();
      const sectionNames = {
        basics: 'Basics',
        round: 'Round',
        elements: 'Elements',
        memoriad: 'Memoriad',
        flash: 'Flash',
      };
      const typeLabel = sectionNames[sectionRaw] || 'Task';
      const countNum = Math.max(1, parseInt(v.required_count, 10) || 1);
      let unitSingular = 'round';
      let unitPlural = 'rounds';
      if (sectionRaw === 'elements') {
        unitSingular = 'set';
        unitPlural = 'sets';
      } else if (sectionRaw === 'flash') {
        unitSingular = 'try';
        unitPlural = 'tries';
      }
      const perDayText = `${countNum} ${countNum === 1 ? unitSingular : unitPlural} per day`;
      const levelText = trimStr(v.level) ? trimStr(v.level) : 'all levels';
      const targetDetail = trimStr(v.targetSummary);
      const inactiveSuffix = v.active === false ? ', inactive' : '';

      if (sectionRaw === 'flash') {
        const flashPart = targetDetail || 'Any flash anzan try';
        return `${typeLabel}: ${flashPart}, ${perDayText}, ${levelText}${inactiveSuffix}`;
      }

      const activityPart = targetDetail || `Any ${typeLabel.toLowerCase()} activity`;
      return `${typeLabel}: ${activityPart}, ${perDayText}, ${levelText}${inactiveSuffix}`;
    }

    case 'weeklyTest': {
      const isOnline = trimStr(v.test_type).toLowerCase() === 'online';
      const typeLabel = isOnline ? 'Online test' : 'Offline test';
      const titleText = trimStr(v.title) || 'Untitled test';
      const dateText = trimStr(v.test_date) || 'no date set';
      const levelText = trimStr(v.audience_level) || 'all levels';
      const secCount = Math.max(0, Number(v.sections_count) || 0);
      if (isOnline || secCount > 0) {
        const secPart = `${secCount} ${secCount === 1 ? 'section' : 'sections'}`;
        return `${typeLabel}: ${titleText} on ${dateText}, ${secPart}, ${levelText}`;
      }
      return `${typeLabel}: ${titleText} on ${dateText}, ${levelText}`;
    }

    case 'profile': {
      const nameText = trimStr(v.full_name) || 'Unnamed student';
      const codeText = trimStr(v.student_code) ? ` (${trimStr(v.student_code)})` : '';
      const levelText = trimStr(v.level) || 'no level';
      const statusText = v.active === false ? 'inactive' : 'active';
      const boardText =
        v.leaderboard_visible === false ? 'hidden from leaderboards' : 'shown on leaderboards';
      return `Profile: ${nameText}${codeText}, ${levelText}, ${statusText}, ${boardText}`;
    }

    case 'studentCreate': {
      const codeText = trimStr(v.student_code) || 'New ID';
      const nameText = trimStr(v.full_name) || 'new student';
      const levelText = trimStr(v.level) || 'no level assigned';
      return `New student: ${nameText} (${codeText}), ${levelText}`;
    }

    case 'target': {
      const catText = trimStr(v.category_name) || 'Selected category';
      const accText = trimStr(v.min_accuracy) !== '' ? `${trimStr(v.min_accuracy)}% min accuracy` : 'no accuracy set';
      const levelText = trimStr(v.level) || 'all levels';
      const extras = [];
      if (trimStr(v.min_qpm)) extras.push(`${trimStr(v.min_qpm)} q/min`);
      if (trimStr(v.max_time)) extras.push(`max ${trimStr(v.max_time)}`);
      if (v.active === false) extras.push('inactive');
      const extraSuffix = extras.length > 0 ? `, ${extras.join(', ')}` : '';
      return `Target: ${catText}, ${accText}, ${levelText}${extraSuffix}`;
    }

    case 'resource': {
      const titleText = trimStr(v.title) || 'Untitled resource';
      const topicText = trimStr(v.topic) || 'General';
      const statusText = v.active === false ? 'inactive' : 'active';
      return `Resource: ${titleText}, topic ${topicText}, ${statusText}`;
    }

    case 'announcement': {
      const titleText = trimStr(v.title) || 'Untitled announcement';
      const audienceText = trimStr(v.audience_level) ? `for ${trimStr(v.audience_level)}` : 'for all students';
      const hideText = trimStr(v.ends_at) ? `, hides after ${trimStr(v.ends_at)}` : '';
      return `Announcement: ${titleText}, ${audienceText}${hideText}`;
    }

    case 'attendance': {
      const titleText = trimStr(v.title) || 'Untitled session';
      const typeText = trimStr(v.session_type) || 'class';
      const dateText = trimStr(v.session_date) || 'today';
      return `Attendance: ${titleText} (${typeText}) on ${dateText}`;
    }

    case 'round': {
      const seriesText = trimStr(v.series_name) ? `${trimStr(v.series_name)}, ` : '';
      const roundNumText = trimStr(v.round_number) ? `Round ${trimStr(v.round_number)}` : 'Round';
      const typeText = trimStr(v.round_type) || 'Category wise';
      const dateText = trimStr(v.round_date) || 'today';
      const timeText = trimStr(v.time_taken) ? `, time ${trimStr(v.time_taken)}` : '';
      return `${seriesText}${roundNumText}: ${typeText} on ${dateText}${timeText}`;
    }

    default:
      return '';
  }
}

/**
 * Sets the open state of a `<details class="form-more-options">` element in the DOM.
 *
 * @param {HTMLDetailsElement|HTMLElement|null} detailsEl
 * @param {boolean} isOpen
 */
export function setMoreOptionsOpen(detailsEl, isOpen) {
  if (!detailsEl) return;
  if (isOpen) {
    detailsEl.setAttribute('open', '');
    detailsEl.open = true;
  } else {
    detailsEl.removeAttribute('open');
    detailsEl.open = false;
  }
}
