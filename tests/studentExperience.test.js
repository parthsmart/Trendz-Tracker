import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardView } from '../js/studentExperience.js';
test('workspace deep links preserve all destinations and default safely', () => {
  for (const view of ['today', 'progress', 'competitions', 'library']) assert.equal(dashboardView(`#${view}`), view);
  for (const hash of ['', '#unknown', '#student=other', null]) assert.equal(dashboardView(hash), 'today');
});
