/**
 * Production Build Stub for js/demoDb.js
 *
 * During `vite build` (production bundle), Vite resolves imports of `demoDb.js`
 * to this lightweight stub so that zero bytes of mock accounts, seed scores,
 * or local demo database logic ship in the production JavaScript bundle.
 */

export const DEFAULT_ROUND_CATEGORIES = [
  'ADD', 'SUB', 'MIX', 'MULT', 'DIV', 'BRAC',
  'PRIME FACTORS', 'HCF and LCM', 'FRAC +', 'FRAC -', 'FRAC *', 'FRAC ÷',
  'Approximation', 'Remainder', 'Ratio', 'Square Root', 'D.P', 'Next Square',
  'Cube root', 'Next cube', 'Calendar', 'Time Elapsed', 'Sum of Squares', 'Surprise Task'
];

export const OLD_SIMULATOR_CATEGORIES = [
  'ADD', 'SUB', 'MIX', 'MULT', 'DIV', 'BRAC',
  'PRIME FACTORS', 'Currency', 'FRAC +', 'FRAC -', 'FRAC *', 'FRAC ÷',
  'Missing Figures', 'Remainder', 'Ratio', 'Square Root', 'D.P', 'Next Square',
  'Cube root', 'Next cube', 'Calendar', 'Time Elapsed', 'Sum of Squares', 'Surprise Task'
];

export const DEFAULT_BASICS_CATEGORIES = [
  '1d4r',
  '2d2r',
  '2d4r',
  '1dx1d',
  '2dx1d',
  '2dby1d',
  '3d/1d',
];

export function isDemoMode() {
  return false;
}

export const DemoDB = new Proxy(
  {
    getDemoAuth: () => null,
    setDemoAuth: () => {},
    getBackupStatus: () => null,
  },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      return () => [];
    },
  }
);


