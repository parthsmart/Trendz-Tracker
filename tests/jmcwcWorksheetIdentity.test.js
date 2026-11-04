import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
const root = process.env.JMCWC_TEST_ROOT || new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const { describeQuestionInputSpec, JMCWC_CATEGORY_TITLES, createJmcwcRunnerController, formatJmcwcQuestionPrompt, buildSubmittedReviewViewModel } = await import(pathToFileURL(root + '/js/jmcwcClient.js'));
const source = fs.readFileSync(root + '/js/roundScores.js', 'utf8');

function renderer() {
  let html = '', writes = 0;
  const grid = {
    get innerHTML() { return html; },
    set innerHTML(value) { html = value; writes++; },
    get children() { return html ? [{}] : []; },
    querySelectorAll() { return []; },
  };
  const title = {};
  const context = vm.createContext({
    jmcwcCurrentSectionOrder: 1, jmcwcRenderedSectionOrder: null, jmcwcRenderedWorksheetKey: null,
    document: { getElementById(id) { return id === 'jmcwc-worksheet-grid' ? grid : id === 'jmcwc-sheet-section-title' ? title : null; } },
    escapeHtml: s => String(s ?? ''), formatWorksheetMathPromptHtml: s => s, describeQuestionInputSpec,
  });
  vm.runInContext(source.slice(source.indexOf('function renderWorksheetGridView('), source.indexOf('\nfunction updateCellAnsweredState(')), context);
  function render(id, category, prompt, answer = '') {
    const q = { question_key: category + '_s1', question_index: 1, category_slug: category, prompt, input: {type:'integer'}, marks: 3 };
    const state = { attempt:{id}, answers:{[q.question_key]:answer}, questions:[{section_order:1,category_slug:category,display_name:JMCWC_CATEGORY_TITLES[category],questions:[q]}] };
    context.renderWorksheetGridView(state, [q], q);
  }
  return { render, grid, title, writes: () => writes };
}

it('replaces Elapsed Time questions when switching to every other category at section 1', () => {
  for (const category of Object.keys(JMCWC_CATEGORY_TITLES)) {
    const r = renderer();
    r.render('elapsed-attempt', 'elapsed_time', 'From 08:00 to 10:00');
    r.render('next-attempt', category, 'NEW QUESTION ' + category);
    assert.ok(r.grid.innerHTML.includes('NEW QUESTION ' + category), category);
    assert.ok(!r.grid.innerHTML.includes('From 08:00'), category);
    assert.ok(r.title.textContent.includes(JMCWC_CATEGORY_TITLES[category]));
  }
});

it('rebuilds for a new attempt in the same category but preserves inputs during answer/heartbeat updates', () => {
  const r = renderer();
  r.render('first', 'addition', '10 + 20 =');
  r.render('second', 'addition', '40 + 50 =');
  assert.ok(r.grid.innerHTML.includes('40 + 50 ='));
  assert.ok(!r.grid.innerHTML.includes('10 + 20 ='));
  const writes = r.writes();
  r.render('second', 'addition', '40 + 50 =', '90');
  assert.equal(r.writes(), writes, 'answer updates must not replace focused inputs');
});

it('never borrows a previous attempt question payload when a different attempt omits questions', async () => {
  let response = {id:'old',mode:'category',status:'running',lease_id:'old-lease',questions:[{id:'elapsed_s1',category_key:'elapsed_time',prompt:'From 08:00 to 10:00',max_marks:1,input:{type:'integer'}}],answers:{elapsed_s1:'120'}};
  const controller = createJmcwcRunnerController({userId:'test',getAccessToken:async()=> 'fake',fetchImpl:async()=>({ok:true,status:200,json:async()=>({ok:true,attempt:response})})});
  await controller.resumeAttempt('old');
  assert.equal(controller.getState().questions.length, 1);
  response = {id:'new',mode:'category',status:'running',lease_id:'new-lease',category_key:'addition'};
  await controller.resumeAttempt('new');
  assert.equal(controller.getState().questions.length, 0);
  assert.deepEqual(controller.getState().answers, {});
});

it('Next Cubes asks for cubes in newly generated questions and older saved question displays', async () => {
  const { generateQuestionForSlot } = await import(pathToFileURL(root + '/api/_jmcwcGenerate.js'));
  const q = generateQuestionForSlot('next_cube', {slot:1,max_marks:3,parameters:{subtype:'next_cube_value',v_power:3}}, {bigInt:()=>6598n});
  assert.equal(q.prompt, 'Next perfect cube strictly greater than 6598:');
  assert.equal(q.answer_key.value, '6859');
  const old = {category_key:'next_cube',prompt:'Next perfect square strictly greater than 6598:'};
  assert.equal(formatJmcwcQuestionPrompt(old), q.prompt);
  assert.equal(formatJmcwcQuestionPrompt({...old,category_key:'next_square'}), old.prompt);
});
