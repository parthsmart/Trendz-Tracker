import fs from 'node:fs';

// Check which categories have mark cells whose upstream chain contains RAND()
function checkSheetDynamic(sheetFile, markCellCoord) {
  const txt = fs.readFileSync('/tmp/jmcwc_dump/j1_' + sheetFile + '.txt', 'utf8');
  const cells = {};
  for (const line of txt.split('\n')) {
    const m = line.match(/^R(\d+):\s*(.*)$/);
    if (!m) continue;
    const r = m[1];
    for (const part of m[2].split(' | ')) {
      const cm = part.match(/^([A-Z]+)\d+:(.*)$/);
      if (cm) {
        const coord = cm[1] + r;
        const val = cm[2];
        const fm = val.match(/^\[(.*)\]=(.*)$/);
        cells[coord] = {
          formula: fm ? fm[1] : null,
          val: fm ? fm[2].replace(/^"|"$/g, '') : val.replace(/^"|"$/g, ''),
        };
      }
    }
  }

  // Traverse upstream dependency graph from markCellCoord
  const visited = new Set();
  const queue = [markCellCoord];
  let isDynamic = false;
  const randSources = [];

  while (queue.length > 0) {
    const curr = queue.shift();
    if (visited.has(curr)) continue;
    visited.add(curr);

    const c = cells[curr];
    if (!c || !c.formula) continue;

    if (c.formula.includes('RAND(')) {
      isDynamic = true;
      randSources.push(`${curr}: [${c.formula}]`);
    }

    // Extract cell tokens e.g. A1, $B$2, AB12
    const refs = c.formula.match(/\$?[A-Z]+\$?\d+/g) || [];
    for (const rawRef of refs) {
      const cleanRef = rawRef.replace(/\$/g, '');
      if (!visited.has(cleanRef)) {
        queue.push(cleanRef);
      }
    }
  }

  return { isDynamic, randSources, formula: cells[markCellCoord]?.formula, val: cells[markCellCoord]?.val };
}

const tests = [
  { key: 'addition', file: '01_Int_Adds', coord: 'E12' },
  { key: 'subtraction', file: '02_Int_Subs', coord: 'K5' },
  { key: 'mixed', file: '03_Mixed_adds+subs', coord: 'E13' },
  { key: 'multiplication', file: '04_Int_Mults', coord: 'D7' },
  { key: 'division', file: '05_Int_Divs', coord: 'K4' },
  { key: 'brackets', file: '06_Brackets', coord: 'R5' },
  { key: 'prime_factors', file: '07_Primes', coord: 'G9' },
  { key: 'hcf_lcm', file: '08_HCF_LCM', coord: 'H11' },
  { key: 'fraction_add', file: '09_Fraction_Additions', coord: 'J13' },
  { key: 'fraction_sub', file: '10_Fraction_Subtractions', coord: 'I9' },
  { key: 'fraction_mul', file: '11_Fraction_Multiplications', coord: 'Z9' },
  { key: 'fraction_div', file: '12_Fraction_Divisions', coord: 'Z10' },
  { key: 'approximation', file: '15_Approximations', coord: 'M8' },
  { key: 'remainder', file: '16_Remainders', coord: 'K6' },
  { key: 'ratio', file: '17_Ratios', coord: 'P7' },
  { key: 'square_root', file: '18_Perfect_Square_Roots', coord: 'I6' },
  { key: 'inexact_square_root', file: '19_Irrational_Square_Roots', coord: 'L6' },
  { key: 'next_square', file: '20_Next_Squares', coord: 'K8' },
  { key: 'cube_root', file: '21_Cube_Roots_-_Exact', coord: 'I7' },
  { key: 'next_cube', file: '22_Next_Cubes', coord: 'K7' },
  { key: 'calendar', file: '23_Calendars', coord: 'K9' },
  { key: 'elapsed_time', file: '24_Times_Elapsed', coord: 'N7' },
  { key: 'sum_squares', file: '25_Sums_of_Squares', coord: 'G16' },
];

for (const t of tests) {
  const res = checkSheetDynamic(t.file, t.coord);
  console.log(`${t.key.padEnd(22)} | ${res.isDynamic ? 'DYNAMIC (B)' : 'FIXED (A)  '} | cell ${t.coord}: [${res.formula || 'literal'}] = ${res.val}`);
  if (res.isDynamic) {
    console.log(`   -> RAND upstream: ${res.randSources.slice(0, 2).join('; ')}`);
  }
}
