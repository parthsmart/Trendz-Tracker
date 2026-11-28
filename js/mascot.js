/**
 * Trendz Tracker - the student's mascot (js/mascot.js)
 *
 * Original, hand-built SVG: Beadle the owl, Bead-bot and Ember the dragon. The look
 * comes from shared/world.js mascotForm(kind, level): it grows a little at every level,
 * gains abacus rods, wings, a graduate cap, a cape and finally a crown. Moods (idle,
 * happy, cheer, encourage) change the eyes, mouth and a small extra.
 *
 * Movement is CSS only and runs only when html[data-motion] is "full" or "lite"
 * (js/motion.js sets it, and sets "off" for reduced motion); the
 * prefers-reduced-motion media query also stops it.
 */

import {
  MASCOTS,
  isMascotKind,
  mascotForm,
  mascotLine,
  pickMascotMood,
} from '../shared/world.js';

const STYLE_ID = 'mascot-style';
export const MASCOT_CACHE_KEY = 'tt_mascot';

const INK = '#2b2233';
const BEADS = ['#e2574c', '#3b82f6', '#f2b134', '#22a06b', '#a855f7', '#ec4899'];

/** Where things sit on each body (viewBox 0 0 120 120, feet at y 108). */
const ANCHORS = Object.freeze({
  owl: { eyes: [[50, 63], [70, 63]], head: [60, 62, 23], top: 46, neck: 82, mouth: [60, 77], abacus: [47, 84, 26, 16] },
  bot: { eyes: [[53, 53], [67, 53]], head: [60, 53, 21], top: 38, neck: 70, mouth: [60, 60], abacus: [46, 78, 28, 18] },
  dragon: { eyes: [[52, 54], [68, 54]], head: [60, 56, 20], top: 40, neck: 71, mouth: [60, 63], abacus: [49, 82, 22, 15] },
});

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function eyes(kind, mood) {
  const bot = kind === 'bot';
  const ink = bot ? '#7ff0ff' : INK;
  return ANCHORS[kind].eyes.map(([x, y], i) => {
    if (mood === 'happy') {
      return `<path d="M${x - 4.5} ${y + 1.5} Q${x} ${y - 4.5} ${x + 4.5} ${y + 1.5}" stroke="${ink}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
    }
    if (mood === 'cheer') {
      return `<circle cx="${x}" cy="${y}" r="5.4" fill="${ink}"/><circle cx="${x + 1.8}" cy="${y - 2}" r="1.9" fill="#fff"/><circle cx="${x - 1.8}" cy="${y + 1.6}" r="1" fill="#fff"/>`;
    }
    const brow = mood === 'encourage'
      ? (i === 0
        ? `<path d="M${x - 5} ${y - 6.5} L${x + 4} ${y - 9}" stroke="${ink}" stroke-width="1.8" stroke-linecap="round"/>`
        : `<path d="M${x - 4} ${y - 9} L${x + 5} ${y - 6.5}" stroke="${ink}" stroke-width="1.8" stroke-linecap="round"/>`)
      : '';
    return `<g class="m-eye">${brow}<circle cx="${x}" cy="${y}" r="${mood === 'encourage' ? 3.8 : 4.3}" fill="${ink}"/><circle cx="${x + 1.4}" cy="${y - 1.5}" r="1.4" fill="#fff"/></g>`;
  }).join('');
}

function mouth(kind, mood) {
  const [x, y] = ANCHORS[kind].mouth;
  if (kind === 'owl') {
    // The beak is the mouth: open when cheering.
    return mood === 'cheer'
      ? `<path d="M55 72 L65 72 L60 77Z" fill="#f0a830"/><path d="M56.5 77.5 L63.5 77.5 L60 82Z" fill="#d98a1f"/>`
      : `<path d="M55.5 72 L64.5 72 L60 79.5Z" fill="#f0a830"/>`;
  }
  const ink = kind === 'bot' ? '#7ff0ff' : INK;
  if (mood === 'cheer') return `<ellipse cx="${x}" cy="${y + 1}" rx="5" ry="4" fill="${kind === 'bot' ? '#7ff0ff' : '#7a2e3a'}"/>`;
  const w = mood === 'happy' ? 6 : mood === 'encourage' ? 3.5 : 4.5;
  const d = mood === 'happy' ? 4 : 2.5;
  return `<path d="M${x - w} ${y} Q${x} ${y + d} ${x + w} ${y}" stroke="${ink}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
}

function abacus(kind, rods) {
  const [x, y, w, h] = ANCHORS[kind].abacus;
  const frame = kind === 'bot' ? '#30606c' : '#6b4423';
  let out = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2.5" fill="rgba(255,255,255,.55)" stroke="${frame}" stroke-width="1.6"/>`;
  out += `<line x1="${x}" y1="${y + h * 0.38}" x2="${x + w}" y2="${y + h * 0.38}" stroke="${frame}" stroke-width="1.2"/>`;
  for (let i = 0; i < rods; i += 1) {
    const rx = x + ((i + 1) * w) / (rods + 1);
    out += `<line x1="${rx}" y1="${y + 1.5}" x2="${rx}" y2="${y + h - 1.5}" stroke="${frame}" stroke-width="1"/>`;
    out += `<circle class="m-bead" cx="${rx}" cy="${y + h * 0.2}" r="1.9" fill="${BEADS[i % BEADS.length]}"/>`;
    out += `<circle class="m-bead" cx="${rx}" cy="${y + h * (0.6 + (i % 2) * 0.18)}" r="1.9" fill="${BEADS[(i + 2) % BEADS.length]}"/>`;
  }
  return out;
}

function owlBody(f) {
  const wings = f.wings
    ? '<path class="m-wing" d="M37 62 Q14 74 24 100 Q34 96 40 84Z" fill="#7d5428"/><path class="m-wing m-wing-r" d="M83 62 Q106 74 96 100 Q86 96 80 84Z" fill="#7d5428"/>'
    : '<ellipse cx="36" cy="82" rx="6" ry="13" fill="#7d5428"/><ellipse cx="84" cy="82" rx="6" ry="13" fill="#7d5428"/>';
  return `${wings}
    <path d="M41 52 L37 34 L52 47Z" fill="#8a5e2f"/><path d="M79 52 L83 34 L68 47Z" fill="#8a5e2f"/>
    <ellipse cx="60" cy="76" rx="27" ry="31" fill="#a0703c"/>
    <ellipse cx="60" cy="90" rx="18" ry="16" fill="#f3dcb2"/>
    <circle cx="50" cy="63" r="10.5" fill="#f8ecd4"/><circle cx="70" cy="63" r="10.5" fill="#f8ecd4"/>
    <ellipse cx="51" cy="107" rx="6" ry="3" fill="#f0a830"/><ellipse cx="69" cy="107" rx="6" ry="3" fill="#f0a830"/>`;
}

function botBody(f) {
  const fins = f.wings
    ? '<path class="m-wing" d="M39 76 L22 96 L39 96Z" fill="#f2b134"/><path class="m-wing m-wing-r" d="M81 76 L98 96 L81 96Z" fill="#f2b134"/>'
    : '';
  return `${fins}
    <line x1="60" y1="38" x2="60" y2="29" stroke="#30606c" stroke-width="2.5"/>
    <circle class="m-glow" cx="60" cy="27" r="4" fill="#f2b134"/>
    <rect x="30" y="76" width="9" height="20" rx="4.5" fill="#4b8fa0"/><rect x="81" y="76" width="9" height="20" rx="4.5" fill="#4b8fa0"/>
    <rect x="38" y="70" width="44" height="34" rx="9" fill="#4b8fa0"/>
    <rect x="44" y="75" width="32" height="24" rx="4" fill="#dbe9ee"/>
    <rect x="39" y="37" width="42" height="32" rx="9" fill="#5aa7b8"/>
    <rect x="44" y="42" width="32" height="22" rx="6" fill="#16323a"/>
    <rect x="44" y="103" width="12" height="5" rx="2.5" fill="#30606c"/><rect x="64" y="103" width="12" height="5" rx="2.5" fill="#30606c"/>`;
}

function dragonBody(f) {
  const wings = f.wings
    ? '<path class="m-wing" d="M42 70 Q20 48 12 72 Q22 70 24 82 Q32 74 40 84Z" fill="#2f8a52"/><path class="m-wing m-wing-r" d="M78 70 Q100 48 108 72 Q98 70 96 82 Q88 74 80 84Z" fill="#2f8a52"/>'
    : '';
  const horns = f.stage >= 2
    ? '<path d="M47 43 L43 31 L54 40Z" fill="#f6e7a1"/><path d="M73 43 L77 31 L66 40Z" fill="#f6e7a1"/>'
    : '';
  return `${wings}
    <path d="M78 96 Q100 102 100 86 Q99 80 106 76" stroke="#3f9a5e" stroke-width="6" fill="none" stroke-linecap="round"/>
    <path d="M103 70 L112 74 L104 81Z" fill="#3f9a5e"/>
    <ellipse cx="60" cy="84" rx="24" ry="23" fill="#4caf6d"/>
    <ellipse cx="60" cy="90" rx="14" ry="15" fill="#f6e7a1"/>
    ${horns}
    <ellipse cx="60" cy="56" rx="21" ry="18" fill="#4caf6d"/>
    <circle cx="56" cy="62" r="1" fill="${INK}"/><circle cx="64" cy="62" r="1" fill="${INK}"/>
    <ellipse cx="50" cy="106" rx="7" ry="3.2" fill="#3f9a5e"/><ellipse cx="70" cy="106" rx="7" ry="3.2" fill="#3f9a5e"/>`;
}

const BODIES = { owl: owlBody, bot: botBody, dragon: dragonBody };

function cape() {
  return '<path d="M36 58 Q60 48 84 58 L94 106 Q60 114 26 106Z" fill="#6b4bb8"/><path d="M36 58 Q60 52 84 58 L82 64 Q60 58 38 64Z" fill="#8f6fe0"/>';
}

function cap(top) {
  return `<g><rect x="50" y="${top - 2}" width="20" height="6" rx="1.5" fill="#222"/><polygon points="38,${top - 2} 60,${top - 10} 82,${top - 2} 60,${top + 5}" fill="#2b2b2b"/><line x1="78" y1="${top - 2}" x2="80" y2="${top + 10}" stroke="#f2c230" stroke-width="1.6"/><circle cx="80" cy="${top + 11}" r="2" fill="#f2c230"/></g>`;
}

function crown(top) {
  return `<polygon points="46,${top + 2} 46,${top - 9} 53,${top - 3} 60,${top - 12} 67,${top - 3} 74,${top - 9} 74,${top + 2}" fill="#f2c230" stroke="#c99a12" stroke-width="1"/><circle cx="60" cy="${top - 2}" r="2" fill="#e2574c"/>`;
}

function eggShell() {
  return '<path d="M30 88 L38 81 L46 89 L54 81 L62 89 L70 81 L78 89 L86 81 L90 88 Q92 113 60 113 Q28 113 30 88Z" fill="#fff6e3" stroke="#e6d3a8" stroke-width="1.5"/>';
}

/** Season outfits, earned at the end of a themed season (theme key = item key). */
function itemBack(item) {
  if (item === 'volcano') {
    return '<path class="m-flame" d="M30 104 Q20 70 38 58 Q36 74 46 66 Q48 46 60 36 Q72 46 74 66 Q84 74 82 58 Q100 70 90 104Z" fill="#ff8a3d" opacity=".45"/>';
  }
  return '';
}

function itemFront(item, kind) {
  const a = ANCHORS[kind];
  const [hx, hy, hr] = a.head;
  const [[lx, ly], [rx2]] = a.eyes;
  switch (item) {
    case 'space':
      return `<circle cx="${hx}" cy="${hy}" r="${hr + 9}" fill="rgba(170,215,255,.22)" stroke="#cfe6ff" stroke-width="2.5"/><path d="M${hx - hr} ${hy - 8} Q${hx - hr + 4} ${hy - hr} ${hx - 6} ${hy - hr - 4}" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round" opacity=".8"/>`;
    case 'ocean':
      return `<rect x="${lx - 9}" y="${ly - 8}" width="${rx2 - lx + 18}" height="15" rx="7" fill="rgba(120,200,255,.35)" stroke="#1f6fb2" stroke-width="2"/><path d="M${rx2 + 9} ${ly} Q${rx2 + 16} ${ly} ${rx2 + 16} ${ly - 18}" stroke="#f2b134" stroke-width="3" fill="none" stroke-linecap="round"/>`;
    case 'jungle':
      return `<ellipse cx="60" cy="${a.top + 2}" rx="26" ry="5" fill="#b08a4f"/><path d="M44 ${a.top + 2} Q46 ${a.top - 14} 60 ${a.top - 15} Q74 ${a.top - 14} 76 ${a.top + 2}Z" fill="#c9a66b"/><rect x="45" y="${a.top - 3}" width="30" height="3.5" fill="#7d5428"/>`;
    case 'arctic':
      return `<path d="M38 ${a.neck - 3} Q60 ${a.neck + 7} 82 ${a.neck - 3} L82 ${a.neck + 3} Q60 ${a.neck + 13} 38 ${a.neck + 3}Z" fill="#e2574c"/><path d="M70 ${a.neck + 6} L76 ${a.neck + 24} L68 ${a.neck + 24} L64 ${a.neck + 8}Z" fill="#c43d33"/>`;
    case 'desert':
      return `<rect x="${lx - 7}" y="${ly - 5}" width="14" height="9" rx="3.5" fill="#1d1d24"/><rect x="${rx2 - 7}" y="${ly - 5}" width="14" height="9" rx="3.5" fill="#1d1d24"/><line x1="${lx + 7}" y1="${ly - 1}" x2="${rx2 - 7}" y2="${ly - 1}" stroke="#1d1d24" stroke-width="2"/>`;
    default:
      return '';
  }
}

function extras(mood) {
  if (mood === 'cheer') {
    return '<g class="m-spark"><path d="M18 30 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3z" fill="#f2c230"/><path d="M98 22 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2z" fill="#f2c230"/><path d="M104 54 l1.5 3.5 3.5 1.5 -3.5 1.5 -1.5 3.5 -1.5 -3.5 -3.5 -1.5 3.5 -1.5z" fill="#ec4899"/></g>';
  }
  if (mood === 'encourage') {
    return '<path class="m-heart" d="M100 34 q-4 -6 -8 -1 q-3 4 8 11 q11 -7 8 -11 q-4 -5 -8 1z" fill="#ec4899"/>';
  }
  return '';
}

function blush(kind, mood) {
  if (mood !== 'happy' && mood !== 'cheer') return '';
  const [[lx, ly], [rx, ry]] = ANCHORS[kind].eyes;
  const c = kind === 'bot' ? 'rgba(127,240,255,.35)' : 'rgba(236,72,153,.35)';
  return `<ellipse cx="${lx - 5}" cy="${ly + 8}" rx="4" ry="2.4" fill="${c}"/><ellipse cx="${rx + 5}" cy="${ry + 8}" rx="4" ry="2.4" fill="${c}"/>`;
}

/**
 * The mascot as an SVG string.
 * @param {{kind?:string, level?:string, mood?:string, equipped?:string|null, size?:number, label?:string}} opts
 */
export function mascotSvg({ kind = 'owl', level = null, mood = 'idle', equipped = null, size = 120, label = '' } = {}) {
  const f = mascotForm(kind, level);
  const k = f.kind;
  const m = ['idle', 'happy', 'cheer', 'encourage'].includes(mood) ? mood : 'idle';
  const a = ANCHORS[k];
  const name = label || `${MASCOTS[k].title}, ${f.name} form`;
  const s = f.scale.toFixed(3);
  const hat = equipped === 'jungle' || equipped === 'space';
  return `<svg class="mascot-svg mascot-${k} mood-${m}" viewBox="0 0 120 120" width="${size}" height="${size}" role="img" aria-label="${esc(name)}" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="60" cy="110" rx="${(24 * f.scale + 4).toFixed(1)}" ry="3.5" fill="rgba(0,0,0,.12)"/>
  <g class="m-extra">${extras(m)}</g>
  <g transform="translate(60 108) scale(${s}) translate(-60 -108)">
    <g class="m-body">
      ${itemBack(equipped)}
      ${f.cape ? cape() : ''}
      ${BODIES[k](f)}
      ${abacus(k, f.rods)}
      ${eyes(k, m)}
      ${blush(k, m)}
      ${mouth(k, m)}
      ${f.hatching ? eggShell() : ''}
      ${itemFront(equipped, k)}
      ${f.crown && !hat ? crown(a.top) : ''}
      ${f.cap && !hat ? cap(a.top) : ''}
    </g>
  </g>
</svg>`;
}

/** Movement for the mascot (injected once). */
export function ensureMascotStyles(doc = globalThis.document) {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.mascot-svg { display:block; overflow:visible; }
.mascot-svg .m-body, .mascot-svg .m-spark, .mascot-svg .m-heart, .mascot-svg .m-eye, .mascot-svg .m-wing, .mascot-svg .m-glow, .mascot-svg .m-flame { transform-box: fill-box; transform-origin: 50% 100%; }
.mascot-svg .m-eye { transform-origin: 50% 50%; }
.mascot-svg .m-wing { transform-origin: 100% 30%; }
.mascot-svg .m-wing-r { transform-origin: 0% 30%; }
html[data-motion="full"] .mascot-svg.mood-idle .m-body { animation: m-bob 3.2s ease-in-out infinite; }
html[data-motion="full"] .mascot-svg.mood-idle .m-eye { animation: m-blink 5s infinite; }
html[data-motion="full"] .mascot-svg.mood-happy .m-body { animation: m-bounce 1.1s ease-in-out infinite; }
html[data-motion="full"] .mascot-svg.mood-happy .m-wing { animation: m-flap .55s ease-in-out infinite alternate; }
html[data-motion="full"] .mascot-svg.mood-cheer .m-body { animation: m-jump .9s cubic-bezier(.2,1.4,.4,1) infinite; }
html[data-motion="full"] .mascot-svg.mood-cheer .m-spark { animation: m-twinkle 1.2s ease-in-out infinite; transform-origin: 50% 50%; }
html[data-motion="full"] .mascot-svg.mood-encourage .m-body { animation: m-nod 2.4s ease-in-out infinite; }
html[data-motion="full"] .mascot-svg.mood-encourage .m-heart { animation: m-float 2.4s ease-in-out infinite; }
html[data-motion="full"] .mascot-svg .m-glow, html[data-motion="full"] .mascot-svg .m-flame { animation: m-glow 1.6s ease-in-out infinite alternate; }
html[data-motion="lite"] .mascot-svg .m-body { animation: m-bounce 1.1s ease-in-out 1; }
@keyframes m-bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-2px); } }
@keyframes m-blink { 0%,94%,100% { transform: scaleY(1); } 97% { transform: scaleY(.1); } }
@keyframes m-bounce { 0%,100% { transform: translateY(0) scale(1,1); } 40% { transform: translateY(-5px) scale(.98,1.03); } 70% { transform: translateY(0) scale(1.03,.97); } }
@keyframes m-jump { 0%,100% { transform: translateY(0); } 45% { transform: translateY(-11px) rotate(-3deg); } }
@keyframes m-flap { from { transform: rotate(0); } to { transform: rotate(-12deg); } }
@keyframes m-twinkle { 0%,100% { opacity:.3; transform: scale(.8); } 50% { opacity:1; transform: scale(1.1); } }
@keyframes m-nod { 0%,100% { transform: rotate(0); } 30% { transform: rotate(-4deg); } 60% { transform: rotate(3deg); } }
@keyframes m-float { 0% { opacity:0; transform: translateY(6px); } 40% { opacity:1; } 100% { opacity:0; transform: translateY(-10px); } }
@keyframes m-glow { from { opacity:.55; } to { opacity:1; } }
@media (prefers-reduced-motion: reduce) { .mascot-svg * { animation: none !important; } }
.mascot-react { display:flex; align-items:center; gap:10px; margin-top:10px; }
.mascot-react .mascot-bubble { position:relative; background:var(--surface-2, #f4f1fb); color:inherit; border-radius:14px; padding:8px 12px; font-size:14px; line-height:1.35; }
.mascot-react .mascot-bubble::before { content:''; position:absolute; left:-6px; top:50%; margin-top:-6px; border:6px solid transparent; border-left:0; border-right-color:var(--surface-2, #f4f1fb); }
`;
  doc.head.appendChild(style);
}

/** The chosen mascot kept in this browser, so round cards need no extra request. */
export function readMascotCache(storage = globalThis.localStorage) {
  try {
    const v = JSON.parse(storage?.getItem(MASCOT_CACHE_KEY) || 'null');
    return v && isMascotKind(v.kind) ? { kind: v.kind, level: v.level || null, equipped: v.equipped || null } : null;
  } catch {
    return null;
  }
}

export function writeMascotCache(value, storage = globalThis.localStorage) {
  try {
    if (!value || !isMascotKind(value.kind)) storage?.removeItem(MASCOT_CACHE_KEY);
    else storage?.setItem(MASCOT_CACHE_KEY, JSON.stringify({ kind: value.kind, level: value.level || null, equipped: value.equipped || null }));
  } catch {
    /* storage may be blocked */
  }
}

/** The mascot reaction row for a round card (null when the student has not picked one). */
export function roundReactionHtml(summary, mascot) {
  if (!mascot || !summary?.round) return '';
  const r = summary.round;
  const mood = pickMascotMood({
    correct: Number(r.correct) || 0,
    total: Number(r.total) || 0,
    personalBest: Boolean(r.personal_best),
    streak: Number(summary.streak?.current) || 0,
  });
  const line = mascotLine(mood, (Number(r.correct) || 0) + (Number(r.total) || 0));
  return `<div class="mascot-react" data-mood="${mood}">${mascotSvg({ ...mascot, mood, size: 64 })}<div class="mascot-bubble">${esc(line)}</div></div>`;
}

/** Adds the mascot's reaction to a round card that js/xpRewards.js has just shown. */
export function attachRoundMascot(card, summary) {
  const mascot = readMascotCache();
  const html = roundReactionHtml(summary, mascot);
  if (!card || !html) return null;
  ensureMascotStyles(card.ownerDocument);
  const row = card.ownerDocument.createElement('div');
  row.innerHTML = html;
  const el = row.firstElementChild;
  card.appendChild(el);
  return el;
}
