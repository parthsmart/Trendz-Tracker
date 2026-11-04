import fs from 'node:fs';

const deps = [
  { key: 'addition', file: '01_Int_Adds', row: 6, cell: 'BK6', adj: 'AF6' },
  { key: 'subtraction', file: '02_Int_Subs', row: 5, cell: 'AH5', adj: 'M5' },
  { key: 'mixed', file: '03_Mixed_adds+subs', row: 8, cell: 'AN8', adj: 'AE8' },
  { key: 'multiplication', file: '04_Int_Mults', row: 8, cell: 'BD8', adj: null },
  { key: 'division', file: '05_Int_Divs', row: 4, cell: 'V4', adj: 'M4' },
  { key: 'brackets', file: '06_Brackets', row: 5, cell: 'JE5', adj: 'T5' },
  { key: 'prime_factors', file: '07_Primes', row: 6, cell: 'CA6', adj: null },
  { key: 'hcf_lcm', file: '08_HCF_LCM', row: 11, cell: 'R11', adj: null },
  { key: 'fraction_add', file: '09_Fraction_Additions', row: 13, cell: 'AK13', adj: 'L13' },
  { key: 'fraction_sub', file: '10_Fraction_Subtractions', row: 9, cell: 'R9', adj: 'K9' },
  { key: 'fraction_mul', file: '11_Fraction_Multiplications', row: 9, cell: 'AJ9', adj: 'AB9' },
  { key: 'fraction_div', file: '12_Fraction_Divisions', row: 10, cell: 'AI10', adj: 'AB10' },
  { key: 'approximation', file: '15_Approximations', row: 8, cell: 'BV8', adj: null },
  { key: 'remainder', file: '16_Remainders', row: 6, cell: 'AK6', adj: 'M6' },
  { key: 'ratio', file: '17_Ratios', row: 7, cell: 'AA7', adj: 'R7' },
  { key: 'square_root', file: '18_Perfect_Square_Roots', row: 6, cell: 'T6', adj: 'K6' },
  { key: 'inexact_square_root', file: '19_Irrational_Square_Roots', row: 6, cell: 'W6', adj: 'N6' },
  { key: 'next_square', file: '20_Next_Squares', row: 8, cell: 'AI8', adj: 'M8' },
  { key: 'cube_root', file: '21_Cube_Roots_-_Exact', row: 7, cell: 'T7', adj: null },
  { key: 'next_cube', file: '22_Next_Cubes', row: 7, cell: 'AJ7', adj: 'M7' },
  { key: 'calendar', file: '23_Calendars', row: 9, cell: 'K9', adj: null },
  { key: 'elapsed_time', file: '24_Times_Elapsed', row: 7, cell: 'AA7', adj: 'P7' },
  { key: 'sum_squares', file: '25_Sums_of_Squares', row: 16, cell: 'L16', adj: 'M16' },
];

for (const d of deps) {
  const txt = fs.readFileSync('/tmp/jmcwc_dump/j1_' + d.file + '.txt', 'utf8');
  const rows = {};
  for (const line of txt.split('\n')) {
    const m = line.match(/^R(\d+):\s*(.*)$/);
    if (!m) continue;
    rows[Number(m[1])] = m[2];
  }
  const rLine = rows[d.row] || '';
  const parts = rLine.split(' | ');
  const foundCell = parts.find((p) => p.startsWith(d.cell + ':') || p.startsWith(d.cell.replace(/\d+$/, '') + d.row + ':'));
  const foundAdj = d.adj ? parts.find((p) => p.startsWith(d.adj + ':') || p.startsWith(d.adj.replace(/\d+$/, '') + d.row + ':')) : null;

  console.log(`[${d.key}] in row ${d.row}:`);
  console.log(`   ${d.cell}: ${foundCell || 'not found'}`);
  if (d.adj) console.log(`   adj ${d.adj}: ${foundAdj || 'not found'}`);
}
