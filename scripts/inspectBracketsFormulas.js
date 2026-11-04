import { inspectWorkbookFile } from './inspectJmcwcWorkbooks.js';

const wb = inspectWorkbookFile('docs/sources/JMCWC-2026-Simulator-Juniors-1.xlsx');
const sheet = wb.sheets.find(s => s.name === 'Brackets');

console.log('--- Inspecting Brackets sheet in Juniors-1 ---');
console.log('Cell B5 formula:', sheet.cells['B5']?.formula);
console.log('Cell P5 formula:', sheet.cells['P5']?.formula);

// Let's inspect the branches for each AC value in row 5:
// AC can be 2, 3, 4, 5, 6, 7, 8, 9, 10
const branchCols = [
  { ac: 2, exprCol: 'AN', ansCol: 'AM' },
  { ac: 3, exprCol: 'BG', ansCol: 'BF' },
  { ac: 4, exprCol: 'BZ', ansCol: 'BY' },
  { ac: 5, exprCol: 'CZ', ansCol: 'CY' },
  { ac: 6, exprCol: 'DW', ansCol: 'DV' },
  { ac: 7, exprCol: 'FA', ansCol: 'EZ' },
  { ac: 8, exprCol: 'GE', ansCol: 'GC' },
  { ac: 9, exprCol: 'HG', ansCol: 'HF' },
  { ac: 10, exprCol: 'IK', ansCol: 'IJ' },
];

for (const b of branchCols) {
  const exprCell = sheet.cells[b.exprCol + '5'] || sheet.cells[b.exprCol + '6'];
  const ansCell = sheet.cells[b.ansCol + '5'] || sheet.cells[b.ansCol + '6'];
  console.log(`\nAC = ${b.ac}:`);
  console.log(`  Expr (${b.exprCol}5/6): [${exprCell?.formula}] = "${exprCell?.value}"`);
  console.log(`  Ans  (${b.ansCol}5/6): [${ansCell?.formula}] = "${ansCell?.value}"`);
}
