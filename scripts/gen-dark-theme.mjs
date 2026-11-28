#!/usr/bin/env node
/**
 * Generates css/theme-dark-auto.css: dark-mode overrides for colours that page styles
 * hard-code instead of using the tokens in css/variables.css.
 *
 *   node scripts/gen-dark-theme.mjs          (re-run after changing page CSS)
 *   node scripts/gen-dark-theme.mjs --check  (exit 1 if the file is out of date)
 *
 * For every rule in the listed CSS files that sets a literal colour:
 *   - light backgrounds (white, slate-50, pastel tints) -> a dark surface, keeping the tint's hue
 *   - dark text colours -> light text (greys -> --text-main / --text-muted; coloured -> lightened)
 *   - light borders -> --border-color (or a dark tint)
 *   - gradients made of light stops -> the same gradient with each stop darkened
 * Rules are re-emitted under html[data-theme="dark"], inside the same @media blocks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = [
  'css/style.css',
  'css/components.css',
  'css/practiceUi.css',
  'css/appRail.css',
  'css/studentPages.css',
  'css/studentHome.css',
  'css/staffPages.css',
  'css/staffHome.css',
  'css/mediaPlayer.css',
];
const OUT = 'css/theme-dark-auto.css';
const PREFIX = 'html[data-theme="dark"]';

/* ------------------------------------------------------------------ colour maths */

const NAMED = { white: '#ffffff', black: '#000000' };

function parseColor(str) {
  const s = String(str).trim().toLowerCase();
  if (NAMED[s]) return parseColor(NAMED[s]);
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    let a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  return null;
}

function lum({ r, g, b }) {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function toHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s, l };
}

function hsl(h, s, l, a = 1) {
  const hh = Math.round(h);
  const ss = Math.round(s * 100);
  const ll = Math.round(l * 100);
  return a < 1 ? `hsla(${hh}, ${ss}%, ${ll}%, ${+a.toFixed(2)})` : `hsl(${hh}, ${ss}%, ${ll}%)`;
}

/** Light background -> dark surface with the same hue. */
function darkBg(c) {
  const { h, s, l } = toHsl(c);
  if (c.a < 1 && lum(c) > 0.6) {
    // Translucent white (frosted panels, scrims): translucent dark instead.
    return s < 0.15 ? `rgba(18, 27, 45, ${+Math.max(c.a, 0.6).toFixed(2)})` : hsl(h, Math.min(0.5, s), 0.16, Math.max(c.a, 0.5));
  }
  if (s < 0.12) {
    if (l > 0.985) return 'var(--bg-surface)';
    return 'var(--bg-surface-subtle)';
  }
  // Pastel tints: keep the hue, very dark, gently saturated. Deeper pastels a touch brighter.
  const dl = l > 0.93 ? 0.14 : l > 0.85 ? 0.17 : 0.21;
  return hsl(h, Math.min(0.55, s * 0.6), dl, c.a);
}

/** Dark text -> light text. */
function lightText(c) {
  const { h, s } = toHsl(c);
  if (s < 0.18) return lum(c) < 0.03 ? 'var(--text-main)' : 'var(--text-muted)';
  return hsl(h, Math.min(0.9, s), 0.78, c.a);
}

/** Light border -> dark border. */
function darkBorder(c) {
  const { h, s } = toHsl(c);
  if (s < 0.15) return 'var(--border-color)';
  return hsl(h, Math.min(0.5, s * 0.6), 0.3, c.a);
}

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\bwhite\b/g;

function isLightBg(c) {
  return c && lum(c) > 0.72 && c.a > 0.05;
}
function isDarkText(c) {
  return c && lum(c) < 0.2 && c.a > 0.3;
}

/** Returns the dark replacement for one declaration, or null if it needs none. */
export function convertDecl(prop, value) {
  const p = prop.toLowerCase();
  const v = value.replace(/\s*!important\s*$/i, '');
  const important = /!important\s*$/i.test(value) ? ' !important' : '';
  if (/var\(/.test(v) && !COLOR_RE.test(v)) return null;
  COLOR_RE.lastIndex = 0;

  if (p === 'background' || p === 'background-color' || p === 'background-image') {
    if (/gradient\(/i.test(v)) {
      let changed = false;
      const out = v.replace(COLOR_RE, (m) => {
        const c = parseColor(m);
        if (isLightBg(c)) {
          changed = true;
          return darkBg(c).replace(/^var\(--bg-surface\)$/, '#121B2D').replace(/^var\(--bg-surface-subtle\)$/, '#18233A');
        }
        return m;
      });
      return changed ? `${p}: ${out}${important}` : null;
    }
    const cols = v.match(COLOR_RE) || [];
    if (cols.length !== 1 || /url\(/i.test(v)) return null;
    const c = parseColor(cols[0]);
    if (!isLightBg(c)) return null;
    return `${p === 'background-image' ? 'background-color' : p}: ${v.replace(cols[0], darkBg(c))}${important}`;
  }
  if (p === 'color' || p === 'fill' || p === 'stroke' || p === 'caret-color') {
    const c = parseColor(v);
    if (!isDarkText(c)) return null;
    return `${p}: ${lightText(c)}${important}`;
  }
  if (/^border(-(top|right|bottom|left))?(-color)?$/.test(p) || p === 'outline-color') {
    let changed = false;
    const out = v.replace(COLOR_RE, (m) => {
      const c = parseColor(m);
      if (c && lum(c) > 0.6) {
        changed = true;
        return darkBorder(c);
      }
      return m;
    });
    return changed ? `${p}: ${out}${important}` : null;
  }
  return null;
}

/* ------------------------------------------------------------------ tiny CSS walker */

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Yields { media: string[], selector, body } for every style rule. Skips @keyframes/@font-face. */
function* walk(css, media = []) {
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) return;
    const head = css.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') depth -= 1;
      j += 1;
    }
    const body = css.slice(open + 1, j - 1);
    if (head.startsWith('@media') || head.startsWith('@supports')) {
      yield* walk(body, [...media, head]);
    } else if (!head.startsWith('@')) {
      const selector = head.replace(/^[;}\s]+/, '');
      if (selector) yield { media, selector, body };
    }
    i = j;
  }
}

function prefixSelector(sel) {
  return sel
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (/^html\b/.test(s)) return s.replace(/^html/, PREFIX);
      if (/^:root\b/.test(s)) return s.replace(/^:root/, PREFIX);
      return `${PREFIX} ${s}`;
    })
    .join(',\n');
}

export function generate() {
  const blocks = [];
  for (const rel of SOURCES) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) continue;
    const css = stripComments(fs.readFileSync(file, 'utf8'));
    const out = [];
    for (const { media, selector, body } of walk(css)) {
      if (/theme|data-theme|@media print/.test(selector) || media.some((m) => /print|prefers-color-scheme/.test(m))) continue;
      const decls = [];
      for (const raw of body.split(';')) {
        const k = raw.indexOf(':');
        if (k < 0) continue;
        const prop = raw.slice(0, k).trim();
        const value = raw.slice(k + 1).trim();
        if (!prop || prop.startsWith('--') || !value) continue;
        const conv = convertDecl(prop, value);
        if (conv) decls.push(conv);
      }
      if (!decls.length) continue;
      let rule = `${prefixSelector(selector)} { ${decls.join('; ')}; }`;
      for (const m of [...media].reverse()) rule = `${m} { ${rule} }`;
      out.push(rule);
    }
    if (out.length) blocks.push(`/* ${rel} */\n${out.join('\n')}`);
  }
  return `/* GENERATED by scripts/gen-dark-theme.mjs - do not edit by hand; re-run the script after changing page CSS. */\n\n${blocks.join('\n\n')}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const text = generate();
  const target = path.join(ROOT, OUT);
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (cur !== text) {
      console.error(`${OUT} is out of date: run node scripts/gen-dark-theme.mjs`);
      process.exit(1);
    }
  } else {
    fs.writeFileSync(target, text);
    console.log(`wrote ${OUT} (${text.split('\n').length} lines)`);
  }
}
