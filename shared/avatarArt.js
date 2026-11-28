/**
 * Trendz Tracker - avatar and collectible card art (shared/avatarArt.js)
 *
 * Original, hand-written layered SVG. Pure functions only (no DOM), so the browser and
 * node tests both import it. The database decides what a student owns and stores a
 * compact token:
 *   look:1|skin|hair|hair_color|outfit|outfit_color|headwear|headwear_color|acc+acc|background|frame
 * Prices and names come from the database; this file only draws.
 */

export const SKIN_TONES = ['#FBE3D1', '#F2C7A5', '#E0A97E', '#C68858', '#9A6440', '#6B4226'];

export const HAIR_COLORS = {
  black: '#1F1B1A', darkbrown: '#3B2418', brown: '#6B4423', auburn: '#8E3B1F', blonde: '#D9A752', grey: '#9AA0A6',
  blue: '#3B82F6', pink: '#EC6FA9', purple: '#8B5CF6', green: '#22A06B',
};
export const OUTFIT_COLORS = {
  blue: '#2F80ED', navy: '#1E3A8A', green: '#18A058', red: '#E2465B', orange: '#F06A3A', purple: '#8B46D9',
  pink: '#D9467A', yellow: '#F5C542', teal: '#14A3A3', gold: '#D4A017',
};
export const HEADWEAR_COLORS = {
  navy: '#1E3A8A', black: '#2A2D33', white: '#F4F4F0', red: '#E2465B', blue: '#2F80ED', teal: '#2E9C8F',
  saffron: '#F59E0B', green: '#18A058', maroon: '#7F1D3A', purple: '#8B46D9', pink: '#EC6FA9', gold: '#E0B43A',
};

/** Name colours (CSS) shown on the profile. */
export const NAME_COLORS = {
  default: 'inherit', blue: '#2563EB', green: '#15803D', pink: '#DB2777', purple: '#7C3AED', orange: '#EA580C',
  rainbow: 'linear-gradient(90deg,#EF4444,#F59E0B,#22C55E,#3B82F6,#8B5CF6)',
};

/** Profile banners (CSS backgrounds). */
export const BANNERS = {
  plain: 'linear-gradient(135deg,#E8EEF8,#F6F8FC)',
  ocean: 'linear-gradient(135deg,#0EA5E9,#1E40AF)',
  sunset: 'linear-gradient(135deg,#FB7185,#FBBF24)',
  forest: 'linear-gradient(135deg,#22C55E,#065F46)',
  abacus: 'repeating-linear-gradient(90deg,transparent 0 22px,rgba(255,255,255,.35) 22px 24px),radial-gradient(circle at 20% 50%,#F59E0B 0 8%,transparent 9%),linear-gradient(135deg,#B45309,#78350F)',
  numbers: 'radial-gradient(circle at 15% 30%,rgba(255,255,255,.25) 0 6%,transparent 7%),radial-gradient(circle at 70% 70%,rgba(255,255,255,.2) 0 9%,transparent 10%),linear-gradient(135deg,#6366F1,#0EA5E9)',
  galaxy: 'radial-gradient(circle at 80% 20%,rgba(255,255,255,.7) 0 1%,transparent 2%),radial-gradient(circle at 30% 60%,rgba(255,255,255,.6) 0 1%,transparent 2%),radial-gradient(circle at 50% 50%,#7C3AED,#1E1B4B 70%)',
};

export const DEFAULT_LOOK = Object.freeze({
  skin: 2, hair: 'short', hair_color: 'black', outfit: 'tee', outfit_color: 'blue',
  headwear: 'none', headwear_color: 'navy', accessories: [], background: 'sky', frame: 'none',
});

const shade = (hex, f) => {
  const n = parseInt(String(hex).slice(1), 16);
  const c = (s) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * f)));
  return `rgb(${c(16)},${c(8)},${c(0)})`;
};
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const BODY = 'M18 122 C20 98 38 88 60 88 C82 88 100 98 102 122Z';

const BG = {
  sky: () => `<rect width="120" height="120" fill="#BFE3FF"/><circle cx="96" cy="26" r="10" fill="#FFF3B0"/>`,
  mint: () => `<rect width="120" height="120" fill="#C9F2DE"/>`,
  peach: () => `<rect width="120" height="120" fill="#FFD9C7"/>`,
  lilac: () => `<rect width="120" height="120" fill="#E3D7FF"/>`,
  sunset: (id) => `<defs><linearGradient id="g${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FF9A8B"/><stop offset="1" stop-color="#FFE29F"/></linearGradient></defs><rect width="120" height="120" fill="url(#g${id})"/>`,
  stars: () => `<rect width="120" height="120" fill="#1D2A5C"/>` + [[18, 22], [40, 12], [92, 18], [104, 44], [14, 52], [78, 8]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.8" fill="#FFF7C2"/>`).join(''),
  beads: () => `<rect width="120" height="120" fill="#FFF1D6"/>` + [20, 44, 68, 92].map((y) => `<line x1="0" y1="${y}" x2="120" y2="${y}" stroke="#D9B98A" stroke-width="1.5"/>` + [12, 30, 92, 110].map((x) => `<ellipse cx="${x}" cy="${y}" rx="7" ry="5" fill="#E0884B"/>`).join('')).join(''),
  numbers: () => `<rect width="120" height="120" fill="#E6F0FF"/>` + [['1', 14, 24], ['2', 98, 20], ['3', 10, 70], ['+', 106, 66], ['5', 22, 104], ['9', 100, 106], ['=', 60, 14]].map(([t, x, y]) => `<text x="${x}" y="${y}" text-anchor="middle" font-family="Arial,sans-serif" font-weight="700" font-size="16" fill="#9DB8E8">${t}</text>`).join(''),
  galaxy: (id) => `<defs><radialGradient id="g${id}" cx=".5" cy=".4" r=".7"><stop offset="0" stop-color="#7C3AED"/><stop offset="1" stop-color="#13103A"/></radialGradient></defs><rect width="120" height="120" fill="url(#g${id})"/>` + [[16, 20], [36, 8], [96, 14], [108, 40], [10, 50], [84, 30], [26, 36]].map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${i % 2 ? 1.2 : 2}" fill="#fff"/>`).join('') + `<ellipse cx="96" cy="30" rx="10" ry="3" fill="none" stroke="#F0ABFC" stroke-width="1.5"/><circle cx="96" cy="30" r="5" fill="#F472B6"/>`,
};

const OUTFIT = {
  tee: (c) => `<path d="${BODY}" fill="${c}"/><path d="M50 88 Q60 97 70 88" fill="none" stroke="${shade(c, 0.75)}" stroke-width="3"/>`,
  hoodie: (c) => `<path d="${BODY}" fill="${c}"/><path d="M44 90 Q60 104 76 90" fill="${shade(c, 0.82)}"/><line x1="54" y1="98" x2="53" y2="110" stroke="#fff" stroke-width="2"/><line x1="66" y1="98" x2="67" y2="110" stroke="#fff" stroke-width="2"/>`,
  kurta: (c) => `<path d="${BODY}" fill="${c}"/><path d="M60 89 L60 112" stroke="${shade(c, 0.7)}" stroke-width="2"/><circle cx="60" cy="98" r="1.6" fill="#F3C64B"/><circle cx="60" cy="105" r="1.6" fill="#F3C64B"/><path d="M52 88 L60 94 L68 88" fill="none" stroke="#F3C64B" stroke-width="2"/>`,
  blazer: (c) => `<path d="${BODY}" fill="${c}"/><path d="M50 88 L60 112 L70 88Z" fill="#fff"/><path d="M57 92 L60 110 L63 92Z" fill="#C8102E"/><path d="M50 88 L56 106 L44 96Z M70 88 L64 106 L76 96Z" fill="${shade(c, 0.8)}"/>`,
  jersey: (c) => `<path d="${BODY}" fill="${c}"/><path d="M48 88 Q60 96 72 88" fill="none" stroke="#fff" stroke-width="3"/><text x="60" y="116" text-anchor="middle" font-family="Arial Black,Arial,sans-serif" font-weight="900" font-size="16" fill="#fff">7</text>`,
  labcoat: (c) => `<path d="${BODY}" fill="#F7F9FC" stroke="#D5DCE8" stroke-width="1"/><path d="M50 88 L60 106 L70 88Z" fill="${c}"/><path d="M50 88 L57 108 L46 98Z M70 88 L63 108 L74 98Z" fill="#E4E9F2"/><rect x="72" y="104" width="12" height="9" rx="1.5" fill="none" stroke="#C5CEDD" stroke-width="1.5"/><line x1="76" y1="100" x2="76" y2="106" stroke="#2F80ED" stroke-width="2"/>`,
  cape: (c) => `<path d="M10 122 L24 92 Q60 80 96 92 L110 122Z" fill="${shade(c, 0.65)}"/><path d="${BODY}" fill="${c}"/><circle cx="60" cy="106" r="8" fill="#FFD34D"/><path d="M60 100 l1.8 3.8 4.1.4 -3.1 2.8 .9 4.1 -3.7-2.1 -3.7 2.1 .9-4.1 -3.1-2.8 4.1-.4Z" fill="${shade(c, 0.8)}"/>`,
};

const HAIR_BACK = {
  long: (c) => `<path d="M34 54 C34 30 48 26 60 26 C72 26 86 30 86 54 L88 92 C80 96 40 96 32 92Z" fill="${c}"/>`,
  ponytail: (c) => `<ellipse cx="86" cy="60" rx="9" ry="16" fill="${c}" transform="rotate(18 86 60)"/>`,
  afro: (c) => `<circle cx="60" cy="46" r="31" fill="${c}"/>`,
  braids: (c) => [36, 84].map((x) => [58, 68, 78, 88].map((y) => `<ellipse cx="${x}" cy="${y}" rx="5" ry="6" fill="${c}" stroke="${shade(c, 0.75)}" stroke-width="1"/>`).join('') + `<circle cx="${x}" cy="96" r="2.6" fill="#E2465B"/>`).join(''),
};

const HAIR_FRONT = {
  short: (c) => `<path d="M37 54 C35 34 48 27 60 27 C73 27 85 34 83 54 C80 45 72 40 60 41 C50 41 41 45 37 54Z" fill="${c}"/>`,
  curly: (c) => `<g fill="${c}">${[[40, 46, 9], [46, 36, 9], [56, 31, 10], [67, 31, 10], [76, 37, 9], [81, 47, 8], [38, 55, 6], [83, 55, 6]].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`).join('')}</g>`,
  spiky: (c) => `<path d="M37 54 L36 36 L44 42 L46 27 L54 37 L60 24 L66 37 L74 27 L76 42 L84 36 L83 54 C78 45 70 41 60 41 C50 41 42 45 37 54Z" fill="${c}"/>`,
  fringe: (c) => `<path d="M36 56 C34 32 48 27 60 27 C72 27 86 32 84 56 C80 44 74 42 70 42 C64 46 50 46 42 44 C39 47 37 51 36 56Z" fill="${c}"/>`,
  bun: (c) => `<circle cx="60" cy="24" r="9" fill="${c}"/><path d="M37 54 C35 34 48 28 60 28 C72 28 85 34 83 54 C79 44 71 40 60 40 C49 40 41 44 37 54Z" fill="${c}"/>`,
  buzz: (c) => `<path d="M38 50 C38 34 48 30 60 30 C72 30 82 34 82 50 C76 44 68 42 60 42 C52 42 44 44 38 50Z" fill="${c}" opacity=".85"/>`,
};

/** Each hair style = a front layer plus an optional back layer. */
const HAIR = {
  short: ['short'], curly: ['curly'], fringe: ['fringe'], bun: ['bun'], buzz: ['buzz'], spiky: ['spiky'],
  ponytail: ['short', 'ponytail'], long: ['fringe', 'long'], afro: ['curly', 'afro'], braids: ['short', 'braids'],
};

const HEADWEAR = {
  none: null,
  hijab: {
    back: (c) => `<path d="M33 58 C33 32 46 24 60 24 C74 24 87 32 87 58 C87 76 82 86 76 92 L44 92 C38 86 33 76 33 58Z" fill="${c}"/><path d="M30 98 C40 90 50 92 60 92 C70 92 80 90 90 98 L96 122 L24 122Z" fill="${c}"/>`,
    front: (c) => `<path d="M38 52 C40 37 50 31 60 31 C70 31 80 37 82 52 C77 43 69 39 60 39 C51 39 43 43 38 52Z" fill="${shade(c, 0.85)}"/><path d="M38 60 C40 76 50 84 60 84 C70 84 80 76 82 60 C82 74 74 88 60 88 C46 88 38 74 38 60Z" fill="${c}"/>`,
    hidesHair: true, hidesEars: true,
  },
  turban: {
    front: (c) => `<path d="M35 50 C33 28 46 17 60 17 C74 17 87 28 85 50 C78 42 70 39 60 39 C50 39 42 42 35 50Z" fill="${c}"/><path d="M40 40 C48 30 64 24 80 30 M38 46 C48 36 64 32 82 38 M46 26 C56 28 66 34 72 44" fill="none" stroke="${shade(c, 0.78)}" stroke-width="2.2" stroke-linecap="round"/><path d="M56 39 L60 33 L64 39Z" fill="${shade(c, 0.7)}"/>`,
    hidesHair: true,
  },
  patka: {
    front: (c) => `<path d="M37 52 C35 33 47 25 60 25 C73 25 85 33 83 52 C78 44 70 40 60 40 C50 40 42 44 37 52Z" fill="${c}"/><circle cx="60" cy="22" r="8" fill="${c}"/><path d="M52 22 Q60 30 68 22" fill="none" stroke="${shade(c, 0.75)}" stroke-width="2"/><path d="M42 46 Q60 36 78 46" fill="none" stroke="${shade(c, 0.8)}" stroke-width="2"/>`,
    hidesHair: true,
  },
  cap: {
    front: (c) => `<path d="M36 46 C36 30 48 24 60 24 C72 24 84 30 84 46Z" fill="${c}"/><path d="M58 44 C70 42 88 42 96 48 C86 50 70 50 58 48Z" fill="${shade(c, 0.8)}"/><circle cx="60" cy="25" r="2.5" fill="${shade(c, 0.7)}"/>`,
  },
  wizard: {
    front: (c) => `<path d="M34 44 L70 2 L86 44Z" fill="${c}"/><ellipse cx="60" cy="44" rx="30" ry="5" fill="${shade(c, 0.75)}"/><path d="M58 24 l1.5 3 3.3.4 -2.4 2.2 .7 3.3 -3.1-1.7 -3.1 1.7 .7-3.3 -2.4-2.2 3.3-.4Z" fill="#FFD34D"/><circle cx="70" cy="34" r="1.6" fill="#FFF7C2"/><circle cx="52" cy="38" r="1.3" fill="#FFF7C2"/>`,
  },
  grad: {
    front: (c) => `<path d="M40 40 C40 32 50 30 60 30 C70 30 80 32 80 40Z" fill="${shade(c, 0.8)}"/><path d="M26 30 L60 18 L94 30 L60 42Z" fill="${c}"/><circle cx="60" cy="30" r="2" fill="#FFD34D"/><path d="M60 30 L84 34 L84 50" fill="none" stroke="#FFD34D" stroke-width="1.8"/><rect x="82" y="48" width="4" height="8" rx="1" fill="#FFD34D"/>`,
  },
  crown: {
    front: (c) => `<path d="M40 40 L40 22 L50 32 L60 16 L70 32 L80 22 L80 40Z" fill="#F2B630" stroke="#B7800F" stroke-width="1.2"/><rect x="40" y="36" width="40" height="6" rx="1.5" fill="#E0A11B"/><circle cx="60" cy="30" r="3" fill="${c}"/><circle cx="48" cy="39" r="1.8" fill="${c}"/><circle cx="72" cy="39" r="1.8" fill="${c}"/>`,
  },
};

const ACC = {
  none: () => '',
  freckles: () => [[45, 62], [48, 65], [50, 61], [70, 61], [72, 65], [75, 62]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r=".9" fill="#A0603A" opacity=".7"/>`).join(''),
  glasses: () => `<g fill="none" stroke="#2B2F3A" stroke-width="2"><circle cx="51" cy="56" r="6.5"/><circle cx="69" cy="56" r="6.5"/><path d="M57.5 56 L62.5 56"/></g>`,
  sunglasses: () => `<g fill="#1F2430" stroke="#1F2430" stroke-width="1.5"><rect x="43" y="51" width="15" height="10" rx="4"/><rect x="62" y="51" width="15" height="10" rx="4"/><path d="M58 55 L62 55" fill="none"/></g><path d="M46 54 L50 53" stroke="#fff" stroke-width="1.2" opacity=".6"/>`,
  star: () => `<path d="M78 34 l2.4 5 5.4 .6 -4 3.7 1.1 5.4 -4.9-2.7 -4.9 2.7 1.1-5.4 -4-3.7 5.4-.6Z" fill="#FFC83D" stroke="#E09A00" stroke-width="1"/>`,
  headphones: () => `<path d="M36 56 C36 30 84 30 84 56" fill="none" stroke="#33384A" stroke-width="4"/><rect x="31" y="50" width="9" height="16" rx="4" fill="#E2465B"/><rect x="80" y="50" width="9" height="16" rx="4" fill="#E2465B"/>`,
  earrings: () => `<circle cx="38.5" cy="64" r="2.2" fill="#F3C64B"/><circle cx="81.5" cy="64" r="2.2" fill="#F3C64B"/>`,
  pencil: () => `<g transform="rotate(-35 86 46)"><rect x="83" y="30" width="6" height="28" fill="#F5C542"/><rect x="83" y="30" width="6" height="4" fill="#EC6FA9"/><path d="M83 58 L86 64 L89 58Z" fill="#F4D7B0"/><path d="M85.2 62 L86 64 L86.8 62Z" fill="#333"/></g>`,
};

const FRAME = {
  none: () => '',
  silver: () => `<circle cx="60" cy="60" r="57" fill="none" stroke="#B8C2D6" stroke-width="6"/>`,
  gold: () => `<circle cx="60" cy="60" r="57" fill="none" stroke="#F2B630" stroke-width="6"/><circle cx="60" cy="60" r="53.5" fill="none" stroke="#FFE08A" stroke-width="1.5"/>`,
  rainbow: (id) => `<defs><linearGradient id="f${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FF5F6D"/><stop offset=".35" stop-color="#FFC371"/><stop offset=".65" stop-color="#47E891"/><stop offset="1" stop-color="#2F80ED"/></linearGradient></defs><circle cx="60" cy="60" r="57" fill="none" stroke="url(#f${id})" stroke-width="6"/>`,
  beads: () => `<circle cx="60" cy="60" r="56" fill="none" stroke="#8A5A2B" stroke-width="3"/>` + Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * Math.PI * 2;
    const x = (60 + 56 * Math.cos(a)).toFixed(2);
    const y = (60 + 56 * Math.sin(a)).toFixed(2);
    return `<ellipse cx="${x}" cy="${y}" rx="5" ry="3.6" fill="${i % 4 ? '#E0884B' : '#2F80ED'}" transform="rotate(${((a * 180) / Math.PI + 90).toFixed(1)} ${x} ${y})"/>`;
  }).join(''),
};

/** Every value the art can draw, per slot (tests check the database catalogue against this). */
export const ART_VALUES = {
  hair: Object.keys(HAIR),
  hair_color: Object.keys(HAIR_COLORS),
  outfit: Object.keys(OUTFIT),
  outfit_color: Object.keys(OUTFIT_COLORS),
  headwear: Object.keys(HEADWEAR),
  headwear_color: Object.keys(HEADWEAR_COLORS),
  accessory: Object.keys(ACC),
  background: Object.keys(BG),
  frame: Object.keys(FRAME),
  name_color: Object.keys(NAME_COLORS),
  banner: Object.keys(BANNERS),
};

let uid = 0;
const pick = (map, key, fallback) => (Object.prototype.hasOwnProperty.call(map, key) ? key : fallback);

/** Fills in anything missing or unknown with defaults. */
export function normalizeLook(look) {
  const o = look && typeof look === 'object' ? look : {};
  const skin = Number.isInteger(Number(o.skin)) && Number(o.skin) >= 0 && Number(o.skin) < SKIN_TONES.length ? Number(o.skin) : DEFAULT_LOOK.skin;
  const acc = [...new Set((Array.isArray(o.accessories) ? o.accessories : []).filter((a) => a !== 'none' && ACC[a]))].slice(0, 2);
  return {
    skin,
    hair: pick(HAIR, o.hair, DEFAULT_LOOK.hair),
    hair_color: pick(HAIR_COLORS, o.hair_color, DEFAULT_LOOK.hair_color),
    outfit: pick(OUTFIT, o.outfit, DEFAULT_LOOK.outfit),
    outfit_color: pick(OUTFIT_COLORS, o.outfit_color, DEFAULT_LOOK.outfit_color),
    headwear: pick(HEADWEAR, o.headwear, DEFAULT_LOOK.headwear),
    headwear_color: pick(HEADWEAR_COLORS, o.headwear_color, DEFAULT_LOOK.headwear_color),
    accessories: acc,
    background: pick(BG, o.background, DEFAULT_LOOK.background),
    frame: pick(FRAME, o.frame, DEFAULT_LOOK.frame),
  };
}

export function isLookToken(value) {
  return typeof value === 'string' && /^look:1\|[a-z0-9_|+]+$/.test(value) && value.split('|').length === 11;
}

/** 'look:1|...' -> look object (or null). Same order as avatar_look_token() in SQL. */
export function parseLookToken(token) {
  if (!isLookToken(token)) return null;
  const [, skin, hair, hairColor, outfit, outfitColor, headwear, hwColor, acc, background, frame] = token.split('|');
  return normalizeLook({
    skin: Number(skin), hair, hair_color: hairColor, outfit, outfit_color: outfitColor, headwear, headwear_color: hwColor,
    accessories: acc === 'none' ? [] : acc.split('+'), background, frame,
  });
}

export function lookToken(look) {
  const o = normalizeLook(look);
  const acc = [...o.accessories].sort().join('+') || 'none';
  return ['look:1', o.skin, o.hair, o.hair_color, o.outfit, o.outfit_color, o.headwear, o.headwear_color, acc, o.background, o.frame].join('|');
}

/** Full avatar as an SVG string. */
export function avatarSvg(look, { label = 'Avatar', extra = '' } = {}) {
  const o = normalizeLook(look);
  const id = `a${++uid}`;
  const skin = SKIN_TONES[o.skin];
  const hw = HEADWEAR[o.headwear];
  const hwColor = HEADWEAR_COLORS[o.headwear_color];
  const hair = HAIR_COLORS[o.hair_color];
  const showHair = !(hw && hw.hidesHair);
  const [front, back] = HAIR[o.hair];
  return `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(label)}">`
    + `<defs><clipPath id="c${id}"><circle cx="60" cy="60" r="60"/></clipPath></defs>`
    + `<g clip-path="url(#c${id})">`
    + BG[o.background](id)
    + (hw && hw.back ? hw.back(hwColor) : '')
    + (showHair && back ? HAIR_BACK[back](hair) : '')
    + OUTFIT[o.outfit](OUTFIT_COLORS[o.outfit_color])
    + `<rect x="52" y="72" width="16" height="18" rx="6" fill="${shade(skin, 0.9)}"/>`
    + (hw && hw.hidesEars ? '' : `<circle cx="38.5" cy="57" r="5" fill="${skin}"/><circle cx="81.5" cy="57" r="5" fill="${skin}"/>`)
    + `<ellipse cx="60" cy="55" rx="22" ry="24" fill="${skin}"/>`
    + `<circle cx="47" cy="64" r="4" fill="#FF7A8A" opacity=".28"/><circle cx="73" cy="64" r="4" fill="#FF7A8A" opacity=".28"/>`
    + `<circle cx="51" cy="56" r="2.7" fill="#1F2430"/><circle cx="69" cy="56" r="2.7" fill="#1F2430"/>`
    + `<circle cx="52" cy="55" r=".9" fill="#fff"/><circle cx="70" cy="55" r=".9" fill="#fff"/>`
    + `<path d="M46 49 Q51 46.5 55 48.5 M65 48.5 Q69 46.5 74 49" fill="none" stroke="${shade(o.hair_color === 'grey' || o.hair_color === 'blonde' ? '#6B4A30' : hair, 0.9)}" stroke-width="1.8" stroke-linecap="round"/>`
    + `<path d="M53 66 Q60 72 67 66" fill="none" stroke="#7A2E2E" stroke-width="2.2" stroke-linecap="round"/>`
    + (showHair ? HAIR_FRONT[front](hair) : '')
    + (hw ? hw.front(hwColor) : '')
    + o.accessories.map((a) => ACC[a]()).join('')
    + `</g>`
    + FRAME[o.frame](id)
    + extra
    + `</svg>`;
}

export function svgDataUri(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** 'look:' token -> data URI usable as <img src>, or null. */
export function lookTokenDataUri(token) {
  const look = parseLookToken(token);
  return look ? svgDataUri(avatarSvg(look)) : null;
}

/** Preview of one shop item on top of a base look. */
export function itemPreviewSvg(itemKey, baseLook = DEFAULT_LOOK) {
  const [slot, value] = String(itemKey).split('.');
  const look = { ...normalizeLook(baseLook) };
  if (slot === 'accessory') look.accessories = value === 'none' ? [] : [value];
  else if (slot in look) look[slot] = value;
  if (slot === 'hair' || slot === 'hair_color') look.headwear = 'none';
  if (slot === 'headwear_color' && look.headwear === 'none') look.headwear = 'turban';
  return avatarSvg(look, { label: itemKey });
}

// ---------------------------------------------------------------------------
// Collectible cards: simple original drawings, never real photos or portraits.
// ---------------------------------------------------------------------------
function abacusSvg(top, bottom, label) {
  const rods = [26, 44, 62, 80, 98];
  let s = `<svg viewBox="0 0 124 120" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(label)}"><rect x="10" y="14" width="104" height="92" rx="8" fill="#8A5A2B"/><rect x="16" y="20" width="92" height="80" rx="4" fill="#FFF1D6"/>`;
  const bar = top === 2 ? 50 : 44;
  s += `<rect x="16" y="${bar}" width="92" height="5" fill="#8A5A2B"/>`;
  rods.forEach((x, r) => {
    s += `<line x1="${x}" y1="20" x2="${x}" y2="100" stroke="#6B4423" stroke-width="2"/>`;
    for (let i = 0; i < top; i++) s += `<ellipse cx="${x}" cy="${26 + i * 9}" rx="8" ry="4.5" fill="#2F80ED"/>`;
    for (let i = 0; i < bottom; i++) s += `<ellipse cx="${x}" cy="${94 - i * 8.4}" rx="8" ry="4" fill="${r % 2 ? '#E0884B' : '#D9467A'}"/>`;
  });
  return `${s}</svg>`;
}

function schotySvg(label) {
  let s = `<svg viewBox="0 0 124 120" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(label)}"><rect x="14" y="10" width="96" height="100" rx="8" fill="#8A5A2B"/><rect x="20" y="16" width="84" height="88" rx="4" fill="#FFF1D6"/>`;
  [26, 40, 54, 68, 82, 96].forEach((y, w) => {
    s += `<line x1="20" y1="${y}" x2="104" y2="${y}" stroke="#6B4423" stroke-width="1.6"/>`;
    for (let i = 0; i < 10; i++) {
      const x = (w % 2 ? 26 : 40) + i * 6.2;
      s += `<ellipse cx="${x}" cy="${y}" rx="3" ry="5" fill="${i === 4 || i === 5 ? '#172036' : '#E0884B'}"/>`;
    }
  });
  return `${s}</svg>`;
}

function tabletSvg(label) {
  let s = `<svg viewBox="0 0 124 120" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(label)}"><rect x="8" y="22" width="108" height="76" rx="4" fill="#E9E4DA" stroke="#B9B1A1" stroke-width="2"/>`;
  [30, 42, 54, 66, 78, 90].forEach((y) => { s += `<line x1="18" y1="${y}" x2="106" y2="${y}" stroke="#A39B8B" stroke-width="1.4"/>`; });
  [[30, 30], [44, 42], [52, 42], [70, 54], [36, 66], [88, 78], [96, 78], [60, 90]].forEach(([x, y]) => { s += `<circle cx="${x}" cy="${y}" r="4" fill="#6B7280"/>`; });
  return `${s}</svg>`;
}

function rodsSvg(label) {
  let s = `<svg viewBox="0 0 124 120" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(label)}"><rect x="6" y="14" width="112" height="92" rx="8" fill="#F5E6C8"/>`;
  const rod = (x, y, rot, red) => `<rect x="${x}" y="${y}" width="4" height="26" rx="1.5" fill="${red ? '#C0392B' : '#1F2430'}" transform="rotate(${rot} ${x + 2} ${y + 13})"/>`;
  [24, 30, 36].forEach((x) => { s += rod(x, 30, 0, true); });
  [58, 66].forEach((y) => { s += rod(76, y - 22, 90, false); });
  [70, 76, 82, 88].forEach((x) => { s += rod(x, 70, 0, false); });
  [28, 34].forEach((y) => { s += rod(34, y + 44, 90, true); });
  return `${s}</svg>`;
}

function portraitSvg(look, motif, label) {
  const badge = `<g transform="translate(92 92)"><circle r="16" fill="#fff" stroke="#172036" stroke-width="2"/><text y="6.5" text-anchor="middle" font-family="Georgia,serif" font-size="18" font-weight="700" fill="#172036">${esc(motif)}</text></g>`;
  return avatarSvg(look, { label, extra: badge });
}

const P = (skin, hair, hairColor, outfit, outfitColor, background, extra = {}) => ({ skin, hair, hair_color: hairColor, outfit, outfit_color: outfitColor, background, ...extra });

/** Drawing for every card, keyed like collectible_cards.key. */
export const CARD_ART = {
  aryabhata: { portrait: P(3, 'bun', 'black', 'kurta', 'yellow', 'stars'), motif: 'π' },
  ramanujan: { portrait: P(4, 'short', 'black', 'kurta', 'navy', 'numbers'), motif: '∞' },
  brahmagupta: { portrait: P(3, 'buzz', 'black', 'kurta', 'orange', 'peach', { headwear: 'turban', headwear_color: 'white' }), motif: '0' },
  matsuzaki: { portrait: P(1, 'short', 'black', 'blazer', 'navy', 'beads'), motif: '⚡' },
  shakuntala_devi: { portrait: P(3, 'long', 'black', 'kurta', 'pink', 'numbers', { accessories: ['earrings'] }), motif: '×' },
  al_khwarizmi: { portrait: P(2, 'short', 'darkbrown', 'kurta', 'teal', 'sunset', { headwear: 'turban', headwear_color: 'white' }), motif: 'x' },
  hypatia: { portrait: P(1, 'bun', 'darkbrown', 'kurta', 'purple', 'stars'), motif: '◯' },
  katherine_johnson: { portrait: P(4, 'curly', 'darkbrown', 'blazer', 'blue', 'galaxy', { accessories: ['glasses'] }), motif: '★' },
  bhaskara: { portrait: P(3, 'buzz', 'grey', 'kurta', 'red', 'mint', { headwear: 'patka', headwear_color: 'saffron' }), motif: '?' },
  euclid: { portrait: P(1, 'curly', 'grey', 'kurta', 'blue', 'lilac'), motif: '△' },
  archimedes: { portrait: P(1, 'curly', 'brown', 'kurta', 'red', 'sky'), motif: 'π' },
  fibonacci: { portrait: P(1, 'fringe', 'brown', 'tee', 'green', 'mint'), motif: '1·1·2' },
  ada_lovelace: { portrait: P(0, 'long', 'darkbrown', 'tee', 'purple', 'peach', { accessories: ['earrings'] }), motif: '⚙' },
  gauss: { portrait: P(0, 'short', 'blonde', 'blazer', 'navy', 'sky'), motif: 'Σ' },
  mirzakhani: { portrait: P(1, 'fringe', 'brown', 'tee', 'teal', 'lilac'), motif: '∿' },
  sophie_germain: { portrait: P(0, 'ponytail', 'brown', 'blazer', 'pink', 'peach'), motif: 'p' },
  soroban: { abacus: [1, 4] },
  suanpan: { abacus: [2, 5] },
  salamis_tablet: { tablet: true },
  schoty: { schoty: true },
  counting_rods: { rods: true },
  cheng_dawei: { portrait: P(2, 'bun', 'black', 'kurta', 'blue', 'beads'), motif: '算' },
  napier: { portrait: P(0, 'long', 'grey', 'blazer', 'green', 'mint'), motif: '×' },
  pascal: { portrait: P(0, 'long', 'brown', 'blazer', 'red', 'sky'), motif: '+' },
};

export const RARITY_LABELS = { common: 'Common', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };

/** Card drawing as SVG. `name` is used for the accessible label. */
export function cardArtSvg(key, name = '') {
  const art = CARD_ART[key];
  const label = `Simple drawing for ${name || key}`;
  if (!art) return abacusSvg(1, 4, label);
  if (art.abacus) return abacusSvg(art.abacus[0], art.abacus[1], label);
  if (art.schoty) return schotySvg(label);
  if (art.tablet) return tabletSvg(label);
  if (art.rods) return rodsSvg(label);
  return portraitSvg(art.portrait, art.motif, label);
}

/** Small chest icon. kind: daily | weekly | levelup. */
export function chestSvg(kind, open = false) {
  const [lid, body, band] = {
    daily: ['#4FA3FF', '#2F6FD6', '#1D4FA3'],
    weekly: ['#B884FF', '#7A3FC4', '#55298F'],
    levelup: ['#FFC53D', '#D98E04', '#A86B00'],
  }[kind] || ['#9CA3AF', '#6B7280', '#4B5563'];
  const lidPath = open ? `<path d="M5 18 C6 6 40 2 43 12 L43 16 L5 20Z" fill="${lid}"/><path d="M10 20 L38 20 L36 14 L12 14Z" fill="#FFE58A" opacity=".9"/>` : `<path d="M5 22 C5 10 43 10 43 22Z" fill="${lid}"/>`;
  return `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="5" y="20" width="38" height="22" rx="3" fill="${body}"/>${lidPath}<rect x="5" y="20" width="38" height="4" fill="${band}"/><rect x="20" y="18" width="8" height="10" rx="2" fill="#FFD34D" stroke="#B07D00"/></svg>`;
}
