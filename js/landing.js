// Trendz Abacus public homepage (preview). No portal imports: this page must work signed out.

const root = document.documentElement;
root.classList.add('js');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');

/* ---------- Header: scrolled state + mobile menu ---------- */
const header = document.querySelector('[data-header]');
const onScroll = () => header?.classList.toggle('is-scrolled', window.scrollY > 8);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

const menuBtn = document.querySelector('[data-menu-toggle]');
const mobileNav = document.querySelector('[data-mobile-nav]');
function setMenu(open) {
  if (!menuBtn || !mobileNav) return;
  menuBtn.setAttribute('aria-expanded', String(open));
  menuBtn.querySelector('.sr-only').textContent = open ? 'Close menu' : 'Open menu';
  mobileNav.hidden = !open;
}
menuBtn?.addEventListener('click', () => setMenu(menuBtn.getAttribute('aria-expanded') !== 'true'));
mobileNav?.addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && menuBtn?.getAttribute('aria-expanded') === 'true') { setMenu(false); menuBtn.focus(); }
});
window.matchMedia('(min-width: 1021px)').addEventListener('change', (e) => { if (e.matches) setMenu(false); });

/* ---------- Click-to-load YouTube players ---------- */
document.querySelectorAll('[data-video]').forEach((frame) => {
  const btn = frame.querySelector('.video-play');
  btn?.addEventListener('click', () => {
    const id = frame.dataset.video;
    const iframe = document.createElement('iframe');
    iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0&modestbranding=1`;
    iframe.title = frame.dataset.title || 'YouTube video';
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.replaceChildren(iframe);
    iframe.focus();
  });
});

/* ---------- Gallery: show more + lightbox ---------- */
const moreToggle = document.querySelector('[data-gallery-toggle]');
const morePanel = document.querySelector('[data-gallery-more]');
moreToggle?.addEventListener('click', () => {
  const open = morePanel.hidden;
  morePanel.hidden = !open;
  moreToggle.setAttribute('aria-expanded', String(open));
  moreToggle.textContent = open ? 'Show fewer photos' : 'View all 19 photos';
  if (open) morePanel.querySelector('.g-open')?.focus({ preventScroll: true });
});

const lightbox = document.querySelector('[data-lightbox]');
const lbImg = lightbox?.querySelector('[data-lb-img]');
const lbCap = lightbox?.querySelector('[data-lb-cap]');
const photoButtons = [...document.querySelectorAll('.g-open')];
let lbIndex = 0;
let lbReturnFocus = null;

function showPhoto(i) {
  lbIndex = (i + photoButtons.length) % photoButtons.length;
  const btn = photoButtons[lbIndex];
  const thumb = btn.querySelector('img');
  lbImg.src = btn.dataset.full || thumb.currentSrc || thumb.src;
  lbImg.alt = thumb.alt;
  lbCap.innerHTML = btn.closest('figure').querySelector('figcaption')?.innerHTML || '';
}
photoButtons.forEach((btn, i) => btn.addEventListener('click', () => {
  if (!lightbox?.showModal) return;
  lbReturnFocus = btn;
  showPhoto(i);
  lightbox.showModal();
}));
lightbox?.querySelector('[data-lb-prev]')?.addEventListener('click', () => showPhoto(lbIndex - 1));
lightbox?.querySelector('[data-lb-next]')?.addEventListener('click', () => showPhoto(lbIndex + 1));
lightbox?.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') showPhoto(lbIndex - 1);
  if (e.key === 'ArrowRight') showPhoto(lbIndex + 1);
});
lightbox?.addEventListener('click', (e) => { if (e.target === lightbox) lightbox.close(); });
lightbox?.addEventListener('close', () => lbReturnFocus?.focus({ preventScroll: true }));
// Swipe on touch screens
let touchX = null;
lightbox?.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
lightbox?.addEventListener('touchend', (e) => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  if (Math.abs(dx) > 50) showPhoto(lbIndex + (dx < 0 ? 1 : -1));
  touchX = null;
});

/* ---------- 3D abacus (modelled on the real Trendz abacus) ---------- */
const abacus = document.querySelector('[data-abacus]');
const rodsEl = abacus?.querySelector('[data-rods]');
const valueEl = document.querySelector('[data-abacus-value]');
const COLORS = [
  ['#f47fb4', '#c24c84'], // pink
  ['#e63b2e', '#a51f17'], // red
  ['#2eaa52', '#197033'], // green
  ['#ffd426', '#d6a400'], // yellow
  ['#ff8a1f', '#cf610a'], // orange
  ['#2363d8', '#133f93'], // blue
  ['#f5f5f5', '#b9b9b9'], // white
];
const PLACE = ['Millions', 'Hundred thousands', 'Ten thousands', 'Thousands', 'Hundreds', 'Tens', 'Ones'];
// Start by showing a friendly number: 2026
const state = COLORS.map(() => ({ heaven: false, earth: 0 }));
const START = 2026;

function renderRod(r) {
  const rod = rodsEl.querySelectorAll('.ab-rod')[r];
  const s = state[r];
  const hb = rod.querySelector('.ab-heaven .bead');
  hb.classList.toggle('is-set', s.heaven);
  hb.setAttribute('aria-pressed', String(s.heaven));
  rod.querySelectorAll('.ab-earth .bead').forEach((b, k) => {
    const set = k < s.earth;
    b.classList.toggle('is-set', set);
    b.setAttribute('aria-pressed', String(set));
  });
}
function renderValue() {
  const v = state.reduce((acc, s) => acc * 10 + (s.heaven ? 5 : 0) + s.earth, 0);
  if (valueEl) valueEl.textContent = v.toLocaleString('en-IN');
}
function setNumber(n) {
  const digits = String(n).padStart(state.length, '0').slice(-state.length);
  [...digits].forEach((d, r) => { const x = Number(d); state[r] = { heaven: x >= 5, earth: x % 5 }; });
  state.forEach((_, r) => renderRod(r));
  renderValue();
}

if (abacus && rodsEl) {
  COLORS.forEach(([c, d], r) => {
    const rod = document.createElement('div');
    rod.className = 'ab-rod';
    rod.style.setProperty('--c', c);
    rod.style.setProperty('--c-d', d);
    rod.setAttribute('role', 'group');
    rod.setAttribute('aria-label', `${PLACE[r]} rod`);

    const heaven = document.createElement('div');
    heaven.className = 'ab-heaven';
    const hb = document.createElement('button');
    hb.type = 'button';
    hb.className = 'bead';
    hb.setAttribute('aria-label', `${PLACE[r]}: five bead`);
    hb.addEventListener('click', () => { state[r].heaven = !state[r].heaven; renderRod(r); renderValue(); });
    heaven.append(hb);

    const earth = document.createElement('div');
    earth.className = 'ab-earth';
    for (let k = 0; k < 4; k++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'bead';
      b.setAttribute('aria-label', `${PLACE[r]}: one bead ${k + 1}`);
      b.addEventListener('click', () => {
        state[r].earth = k < state[r].earth ? k : k + 1;
        renderRod(r); renderValue();
      });
      earth.append(b);
    }
    rod.append(heaven, earth);
    rodsEl.append(rod);
  });
  setNumber(START);
  document.querySelector('[data-abacus-reset]')?.addEventListener('click', () => setNumber(0));

  // Optional gentle tilt toward the pointer: mouse/trackpad only, never with reduced motion.
  const stage = document.querySelector('[data-abacus-stage]');
  stage?.addEventListener('pointermove', (e) => {
    if (reduceMotion.matches || !finePointer.matches || e.pointerType !== 'mouse') return;
    const rect = stage.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width - 0.5;
    const py = (e.clientY - rect.top) / rect.height - 0.5;
    abacus.style.setProperty('--ty', `${(-16 + px * 14).toFixed(2)}deg`);
    abacus.style.setProperty('--tx', `${(10 - py * 8).toFixed(2)}deg`);
  });
  stage?.addEventListener('pointerleave', () => {
    abacus.style.removeProperty('--ty');
    abacus.style.removeProperty('--tx');
  });
}

/* ---------- Gentle reveal on scroll ---------- */
const reveals = document.querySelectorAll('.reveal');
if (!reduceMotion.matches && 'IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); } });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  reveals.forEach((el) => io.observe(el));
} else {
  reveals.forEach((el) => el.classList.add('is-in'));
}
