import { inspectWorkbookFile } from './inspectJmcwcWorkbooks.js';

for (const group of ['Juniors-1', 'Juniors-2', 'Seniors']) {
  console.log(`\n=================== ${group} ADDITION FORMULAS ===================`);
  const data = inspectWorkbookFile(`docs/sources/JMCWC-2026-Simulator-${group}.xlsx`);
  const sheet = data.sheets.find(s => s.name === 'Int Adds');
  
  // Header / setup cells
  console.log('Setup cells in row 2/3:');
  for (const [coord, cell] of Object.entries(sheet.cells)) {
    const rm = coord.match(/^([A-Z]+)(\d+)$/);
    if (rm && (rm[2] === '2' || rm[2] === '3')) {
      if (cell.formula || ['Min', 'Max', 'Length', 'Count'].some(k => String(cell.value).includes(k))) {
        console.log(`  ${coord}: [${cell.formula}] = ${cell.value}`);
      }
    }
  }

  // Row 6 (slot 1) and Row 40 (slot 18)
  for (const r of [6, 40]) {
    console.log(`\nRow ${r}:`);
    for (const [coord, cell] of Object.entries(sheet.cells)) {
      const rm = coord.match(/^([A-Z]+)(\d+)$/);
      if (rm && Number(rm[2]) === r) {
        if (cell.formula) {
          console.log(`  ${coord}: [${cell.formula}] = ${cell.value}`);
        }
      }
    }
  }
}
