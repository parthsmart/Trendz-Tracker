/**
 * Trendz Tracker — Pure Weekly Test Runner Helpers (js/weeklyTestRunner.js)
 *
 * Pure ES module (no DOM, no network) for:
 * - `runnerLink(section, testId)`: builds the test-mode URL (`?test=<id>&section=<id>`) for each section kind
 * - `flashProgressText(triesStarted, questionCount)`: formats `"Try <n> of <m>"`
 * - `parseTestRunnerQuery(search)`: parses `?test=<id>&section=<id>` from URL search string
 */

export const START_SECTION_CONFIRM_TEXT =
  'You can take this section only once. If you leave the page, the section ends.';

export const RUNNER_EXIT_CONFIRM_TEXT =
  'This section can be taken only once. Leaving now ends it.';

const RUNNER_PATHS_BY_KIND = {
  basics: '/pages/basics-practice.html',
  elements: '/pages/element-drill.html',
  flash: '/pages/flash.html',
  memoriad: '/pages/memoriad-play.html',
};

/**
 * Builds the URL for starting or continuing an online weekly test section in test mode.
 *
 * @param {{ section_id?: string, id?: string, kind?: string }} section
 * @param {string} testId
 * @returns {string|null}
 */
export function runnerLink(sectionOrTestId, testIdOrSection) {
  let section = sectionOrTestId;
  let testId = testIdOrSection;
  if (typeof sectionOrTestId === 'string' && testIdOrSection && typeof testIdOrSection === 'object') {
    testId = sectionOrTestId;
    section = testIdOrSection;
  }
  if (!section || typeof section !== 'object') return null;
  const cleanTestId = typeof testId === 'string' ? testId.trim() : '';
  const cleanSectionId = String(section.section_id || section.id || '').trim();
  if (!cleanTestId || !cleanSectionId) return null;

  const kind = String(section.kind || 'basics').trim().toLowerCase();
  const basePath = RUNNER_PATHS_BY_KIND[kind];
  if (!basePath) return null;

  const params = new URLSearchParams();
  params.set('test', cleanTestId);
  params.set('section', cleanSectionId);
  return `${basePath}?${params.toString()}`;
}

/**
 * Formats the Flash Anzan try progress label: `"Try <n> of <m>"`.
 *
 * @param {number|string|null|undefined} triesStarted
 * @param {number|string|null|undefined} questionCount
 * @returns {string}
 */
export function flashProgressText(triesStarted, questionCount) {
  const rawTotal = Number(questionCount);
  const total = Math.max(
    1,
    Number.isFinite(rawTotal) && rawTotal > 0 ? Math.round(rawTotal) : 1
  );

  const rawTry = Number(triesStarted);
  const tryNo = Math.min(
    total,
    Math.max(1, Number.isFinite(rawTry) && rawTry > 0 ? Math.round(rawTry) : 1)
  );

  return `Try ${tryNo} of ${total}`;
}

/**
 * Parses a URL query string (`?test=<id>&section=<id>`) to detect Weekly Test runner mode.
 *
 * @param {string} [search='']
 * @returns {{ isTestMode: boolean, testId: string | null, sectionId: string | null }}
 */
export function parseTestRunnerQuery(search = '') {
  const params = new URLSearchParams(typeof search === 'string' ? search : '');
  const testId = (params.get('test') || params.get('test_id') || '').trim() || null;
  const sectionId = (params.get('section') || params.get('section_id') || '').trim() || null;

  return {
    isTestMode: Boolean(testId && sectionId),
    testId: testId && sectionId ? testId : null,
    sectionId: testId && sectionId ? sectionId : null,
  };
}
