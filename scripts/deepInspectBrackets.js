import { inspectWorkbookFile } from './inspectJmcwcWorkbooks.js';

const workbooks = {
  junior1: inspectWorkbookFile('docs/sources/JMCWC-2026-Simulator-Juniors-1.xlsx'),
  junior2: inspectWorkbookFile('docs/sources/JMCWC-2026-Simulator-Juniors-2.xlsx'),
  senior: inspectWorkbookFile('docs/sources/JMCWC-2026-Simulator-Seniors.xlsx'),
};

console.log('--- AC values across 20 slots (rows 5..43) ---');
for (const [g, wb] of Object.entries(workbooks)) {
  const sheet = wb.sheets.find(s => s.name === 'Brackets');
  const acList = [];
  for (let s = 1; s <= 20; s++) {
    const r = 3 + 2 * s;
    const ac = sheet.cells['AC' + r]?.value;
    acList.push(`Slot ${s}(R${r}): AC=${ac}`);
  }
  console.log(`\n${g} AC values:`);
  console.log(acList.join(', '));
}

// Let's inspect all formula details for row 5 in Juniors-1 across the helper columns
const sheet = workbooks.junior1.sheets.find(s => s.name === 'Brackets');
console.log('\n--- Helper cells in row 5 for all AC branches ---');

function inspectCellsInRange(startCol, endCol, r) {
  // convert col letters to index
  function colToIdx(c) {
    let n = 0;
    for (let i = 0; i < c.length; i++) n = n * 26 + (c.charCodeAt(i) - 64);
    return n;
  }
  function idxToCol(n) {
    let s = '';
    while (n > 0) {
      const rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }
  const sIdx = colToIdx(startCol);
  const eIdx = colToIdx(endCol);
  const parts = [];
  for (let i = sIdx; i <= eIdx; i++) {
    const c = idxToCol(i);
    const cell = sheet.cells[c + r];
    if (cell && (cell.value !== null && cell.value !== '')) {
      parts.push(`${c}${r}: [${cell.formula || ''}]= "${cell.value}"`);
    }
  }
  return parts.join(' | ');
}

console.log('\nAC=2 (AI..AV):');
console.log(inspectCellsInRange('AI', 'AV', 5));

console.log('\nAC=3 (BB..BO):');
console.log(inspectCellsInRange('BB', 'BO', 5));

console.log('\nAC=4 (BU..CH):');
console.log(inspectCellsInRange('BU', 'CH', 5));

console.log('\nAC=5 (CP..CZ):');
console.log('Row 5: ' + inspectCellsInRange('CP', 'CZ', 5));
console.log('Row 6: ' + inspectCellsInRange('CP', 'CZ', 6));

console.log('\nAC=6 (DQ..EG):');
console.log(inspectCellsInRange('DQ', 'EG', 5));

console.log('\nAC=7 (EQ..FL):');
console.log(inspectCellsInRange('EQ', 'FL', 5));

console.log('\nAC=8 (FV..GE):');
console.log('Row 5: ' + inspectCellsInRange('FV', 'GE', 5));
console.log('Row 6: ' + inspectCellsInRange('FV', 'GE', 6));

console.log('\nAC=9 (GY..HR):');
console.log(inspectCellsInRange('GY', 'HR', 5));

console.log('\nAC=10 (IB..IX):');
console.log(inspectCellsInRange('IB', 'IX', 5));
