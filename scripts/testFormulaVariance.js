import fs from 'node:fs';

// Check if cell value ever varies across 10,000 random evaluations or if it is purely a function of fixed slot parameters
function testFormulaVariance(sheetFile, markRow, markCol) {
  // Let's inspect all rows of the sheet
  const txt = fs.readFileSync('/tmp/jmcwc_dump/j1_' + sheetFile + '.txt', 'utf8');
  const rows = {};
  for (const line of txt.split('\n')) {
    const m = line.match(/^R(\d+):\s*(.*)$/);
    if (!m) continue;
    rows[Number(m[1])] = m[2];
  }
  return rows[markRow];
}

console.log('Subtraction row 5:', testFormulaVariance('02_Int_Subs', 5));
console.log('Remainder row 6:', testFormulaVariance('16_Remainders', 6));
console.log('Next Square row 8:', testFormulaVariance('20_Next_Squares', 8));
console.log('Next Cube row 7:', testFormulaVariance('22_Next_Cubes', 7));
