import fs from 'node:fs';

const sheets = [
  { key: 'addition', file: '01_Int_Adds', markCols: ['E', 'J', 'O'], markRows: [12, 21, 30] },
  { key: 'subtraction', file: '02_Int_Subs', markCol: 'K', markRows: [5, 7, 9] },
  { key: 'mixed', file: '03_Mixed_adds+subs', markCols: ['E', 'J', 'O'], markRows: [13, 22, 31] },
  { key: 'multiplication', file: '04_Int_Mults', markCols: ['D', 'L'], markRows: [7, 12, 17] },
  { key: 'division', file: '05_Int_Divs', markCol: 'K', markRows: [4, 6, 8] },
  { key: 'brackets', file: '06_Brackets', markCol: 'R', markRows: [5, 7, 9] },
  { key: 'prime_factors', file: '07_Primes', markCol: 'G', markRows: [9, 11, 13] },
  { key: 'hcf_lcm', file: '08_HCF_LCM', markCol: 'H', markRows: [11, 13, 15] },
  { key: 'fraction_add', file: '09_Fraction_Additions', markCol: 'J', markRows: [13, 30, 47] },
  { key: 'fraction_sub', file: '10_Fraction_Subtractions', markCol: 'I', markRows: [9, 22, 35] },
  { key: 'fraction_mul', file: '11_Fraction_Multiplications', markCol: 'Z', markRows: [9, 22, 35] },
  { key: 'fraction_div', file: '12_Fraction_Divisions', markCol: 'Z', markRows: [10, 23, 36] },
  { key: 'approximation', file: '15_Approximations', markCol: 'M', markRows: [8, 10, 25, 38, 53] },
  { key: 'remainder', file: '16_Remainders', markCol: 'K', markRows: [6, 8, 10] },
  { key: 'ratio', file: '17_Ratios', markCol: 'P', markRows: [7, 9, 11] },
  { key: 'square_root', file: '18_Perfect_Square_Roots', markCol: 'I', markRows: [6, 8, 10] },
  { key: 'inexact_square_root', file: '19_Irrational_Square_Roots', markCol: 'L', markRows: [6, 8, 10] },
  { key: 'next_square', file: '20_Next_Squares', markCol: 'K', markRows: [8, 10, 12] },
  { key: 'cube_root', file: '21_Cube_Roots_-_Exact', markCol: 'I', markRows: [7, 9, 11] },
  { key: 'next_cube', file: '22_Next_Cubes', markCol: 'K', markRows: [7, 9, 11] },
  { key: 'calendar', file: '23_Calendars', markCol: 'K', markRows: [9, 11, 13] },
  { key: 'elapsed_time', file: '24_Times_Elapsed', markCol: 'N', markRows: [7, 9, 11] },
  { key: 'sum_squares', file: '25_Sums_of_Squares', markCol: 'G', markRows: [16, 18, 20] },
];

for (const s of sheets) {
  const txt = fs.readFileSync('/tmp/jmcwc_dump/j1_' + s.file + '.txt', 'utf8');
  const rows = {};
  for (const line of txt.split('\n')) {
    const m = line.match(/^R(\d+):\s*(.*)$/);
    if (!m) continue;
    rows[Number(m[1])] = m[2];
  }

  console.log(`=== ${s.key.toUpperCase()} (${s.file}) ===`);
  const col = s.markCol || s.markCols[0];
  for (const r of s.markRows) {
    const rLine = rows[r] || '';
    const parts = rLine.split(' | ');
    const found = parts.find((p) => p.startsWith(col + r + ':'));
    if (found) {
      console.log(`  Row ${r} ${found}`);
    } else {
      console.log(`  Row ${r} ${col}${r}: NOT FOUND in line: ${rLine.slice(0, 80)}`);
    }
  }
}
