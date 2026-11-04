import { inspectWorkbookFile } from './inspectJmcwcWorkbooks.js';

for (const group of ['Juniors-1', 'Juniors-2', 'Seniors']) {
  console.log(`\n=================== ${group} ===================`);
  const data = inspectWorkbookFile(`docs/sources/JMCWC-2026-Simulator-${group}.xlsx`);
  const addSheet = data.sheets.find(s => s.name === 'Int Adds');
  if (!addSheet) {
    console.log('No Int Adds sheet found');
    continue;
  }
  for (let r = 6; r <= 42; r += 2) {
    const s = addSheet.cells['AS' + r]?.value;
    const at = addSheet.cells['AT' + r]?.value;
    const atFormula = addSheet.cells['AT' + r]?.formula;
    const bz = addSheet.cells['BZ' + r]?.value;
    const bzFormula = addSheet.cells['BZ' + r]?.formula;
    const ca = addSheet.cells['CA' + r]?.value;
    const caFormula = addSheet.cells['CA' + r]?.formula;
    const bk = addSheet.cells['BK' + r]?.value;
    const af = addSheet.cells['AF' + r]?.value ?? addSheet.cells['AK' + r]?.value;
    console.log(`Slot ${s} (Row ${r}): level(AT)=${at} [${atFormula}], digits/length(BZ)=${bz} [${bzFormula}], terms/count(CA)=${ca} [${caFormula}], mark(BK)=${bk}, adj=${af}`);
  }
}
