import { inspectWorkbookFile } from './inspectJmcwcWorkbooks.js';

const workbooks = {
  junior1: inspectWorkbookFile('docs/sources/JMCWC-2026-Simulator-Juniors-1.xlsx'),
  junior2: inspectWorkbookFile('docs/sources/JMCWC-2026-Simulator-Juniors-2.xlsx'),
  senior: inspectWorkbookFile('docs/sources/JMCWC-2026-Simulator-Seniors.xlsx'),
};

console.log('Workbooks loaded successfully.');

// Check sheet mapping across the 3 workbooks
for (const [group, wb] of Object.entries(workbooks)) {
  console.log(`\n--- ${group} sheets ---`);
  for (const s of wb.sheets) {
    console.log(`  ${s.name} (${Object.keys(s.cells).length} cells)`);
  }
}
