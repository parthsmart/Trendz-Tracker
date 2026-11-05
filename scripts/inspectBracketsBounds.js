import { inspectWorkbookFile } from './inspectJmcwcWorkbooks.js';

const sheet = inspectWorkbookFile('docs/sources/JMCWC-2026-Simulator-Juniors-1.xlsx').sheets.find(s => s.name === 'Brackets');

console.log('--- Bounds for AC branches in Juniors 1 ---');
for (const r of [5, 11, 21, 29, 39]) {
  console.log(`\nRow ${r}:`);
  console.log(`  AC=2 bounds (AG, AH): [${sheet.cells['AG' + r]?.value}, ${sheet.cells['AH' + r]?.value}]`);
  console.log(`  AC=3 bounds (AZ, BA): [${sheet.cells['AZ' + r]?.value}, ${sheet.cells['BA' + r]?.value}]`);
  console.log(`  AC=4 bounds (BS, BT): [${sheet.cells['BS' + r]?.value}, ${sheet.cells['BT' + r]?.value}]`);
  console.log(`  AC=5 bounds (CL, CM) and (CN, CO): [${sheet.cells['CL' + r]?.value}, ${sheet.cells['CM' + r]?.value}], [${sheet.cells['CN' + r]?.value}, ${sheet.cells['CO' + r]?.value}]`);
  console.log(`  AC=6 bounds (DK..DP): DK-DL=[${sheet.cells['DK' + r]?.value}, ${sheet.cells['DL' + r]?.value}], DM-DN=[${sheet.cells['DM' + r]?.value}, ${sheet.cells['DN' + r]?.value}], DO-DP=[${sheet.cells['DO' + r]?.value}, ${sheet.cells['DP' + r]?.value}]`);
}
