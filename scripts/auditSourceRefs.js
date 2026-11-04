import { inspectWorkbookFile } from './inspectJmcwcWorkbooks.js';
import { JMCWC_PAPERS } from '../api/_jmcwcBlueprints.js';

const workbooks = {
  junior1: inspectWorkbookFile('docs/sources/JMCWC-2026-Simulator-Juniors-1.xlsx'),
  junior2: inspectWorkbookFile('docs/sources/JMCWC-2026-Simulator-Juniors-2.xlsx'),
  senior: inspectWorkbookFile('docs/sources/JMCWC-2026-Simulator-Seniors.xlsx'),
};

console.log('Auditing source_ref cells across all 23 categories in current blueprints...\n');

for (const group of ['junior1', 'junior2', 'senior']) {
  const wb = workbooks[group];
  const paper = JMCWC_PAPERS[group];
  console.log(`\n============================ ${group} ============================`);

  for (const section of paper.spec.sections) {
    const sheet = wb.sheets.find(s => s.name === section.workbook_sheet);
    if (!sheet) {
      console.log(`[${section.key}] Sheet not found: ${section.workbook_sheet}`);
      continue;
    }

    const firstQ = section.questions[0];
    const sref = firstQ.source_ref;
    if (!sref) {
      console.log(`[${section.key}] No source_ref on Q1`);
      continue;
    }

    // Check answer_cell and mark_cell
    const ansCell = sref.answer_cell ? sheet.cells[sref.answer_cell] : null;
    const markCell = sref.mark_cell ? sheet.cells[sref.mark_cell] : null;

    const ansVal = ansCell ? ansCell.value : '(missing)';
    const markVal = markCell ? markCell.value : '(missing)';

    // Check if markVal matches firstQ.max_marks
    const markMatches = Number(markVal) === Number(firstQ.max_marks);
    
    console.log(
      `[${section.key}] Q1: max_marks=${firstQ.max_marks} | mark_cell ${sref.mark_cell}=${markVal} (${markMatches ? 'OK' : 'MISMATCH!'}) | ans_cell ${sref.answer_cell}=${ansVal} | printed: ${sref.printed_cells}`
    );
  }
}
