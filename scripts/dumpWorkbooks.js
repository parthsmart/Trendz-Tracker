import fs from 'node:fs';
import path from 'node:path';
import { inspectWorkbookFile } from './inspectJmcwcWorkbooks.js';

const workbooks = [
  { group: 'j1', file: 'docs/sources/JMCWC-2026-Simulator-Juniors-1.xlsx' },
  { group: 'j2', file: 'docs/sources/JMCWC-2026-Simulator-Juniors-2.xlsx' },
  { group: 'sr', file: 'docs/sources/JMCWC-2026-Simulator-Seniors.xlsx' },
];

if (!fs.existsSync('/tmp/jmcwc_dump')) {
  fs.mkdirSync('/tmp/jmcwc_dump', { recursive: true });
}

for (const wb of workbooks) {
  console.log(`Dumping ${wb.group} from ${wb.file}...`);
  const data = inspectWorkbookFile(wb.file);
  let sheetIdx = 0;
  for (const sheet of data.sheets) {
    sheetIdx++;
    const prefix = String(sheetIdx).padStart(2, '0');
    const safeName = sheet.name.replace(/[^a-zA-Z0-9_\-+]/g, '_');
    const fname = `${wb.group}_${prefix}_${safeName}.txt`;
    
    // Group cells by row
    const rows = {};
    for (const [coord, cell] of Object.entries(sheet.cells)) {
      const rm = coord.match(/^([A-Z]+)(\d+)$/);
      if (!rm) continue;
      const col = rm[1];
      const r = Number(rm[2]);
      if (!rows[r]) rows[r] = {};
      const valStr = cell.value !== null ? String(cell.value) : '';
      const fStr = cell.formula ? `[${cell.formula}]=` : '';
      rows[r][coord] = `${fStr}"${valStr}"`;
    }

    const lines = [];
    const sortedRowNums = Object.keys(rows).map(Number).sort((a, b) => a - b);
    for (const r of sortedRowNums) {
      const cellParts = Object.entries(rows[r]).map(([c, text]) => `${c}:${text}`);
      lines.push(`R${r}: ${cellParts.join(' | ')}`);
    }

    fs.writeFileSync(path.join('/tmp/jmcwc_dump', fname), lines.join('\n'));
  }
}
console.log('Successfully dumped all sheets to /tmp/jmcwc_dump');
