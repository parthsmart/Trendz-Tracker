/**
 * Trendz Tracker - profile style, chests, weekly quests and the card collection
 * (js/profileExtras.js). Mounted by js/profile.js into #pf-extras.
 *
 * Coins come only from practice: 1 coin per 10 XP, plus chests that open after real
 * practice. Every chest is rolled and saved by the database; opening it again shows the
 * same contents. No real money anywhere.
 */

import { showToast } from './toast.js';
import { claimChest, loadAvatarState, saveAvatarLook, saveProfileStyle } from './avatarStore.js';
import { BANNERS, NAME_COLORS, RARITY_LABELS, avatarSvg, cardArtSvg, chestSvg } from '../shared/avatarArt.js';

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const fmt = (n) => Number(n || 0).toLocaleString('en-IN');

const CHESTS = [
  { kind: 'daily', title: 'Daily chest', when: 'Opens after your first practice round each day (India time).', locked: 'Finish a practice round today to open it.' },
  { kind: 'weekly', title: 'Weekly quest chest', when: 'Opens when all 3 weekly quests are done (Monday to Sunday).', locked: 'Finish all 3 quests to open it.' },
  { kind: 'levelup', title: 'Level-up chest', when: 'Opens each time you reach a new tier this season.', locked: 'Reach the next tier to open another one.' },
];

let ctx = { studentId: null, own: false, onAvatarChange: null, data: null, busy: false };

export async function mountProfileExtras({ studentId = null, own = false, onAvatarChange = null } = {}) {
  const host = $('pf-extras');
  if (!host) return;
  ensureExtrasStyles();
  ctx = { ...ctx, studentId, own, onAvatarChange };
  try {
    ctx.data = await loadAvatarState(studentId);
  } catch (err) {
    console.warn('Avatar and chests could not load:', err);
    host.innerHTML = '';
    return;
  }
  render();
}

function render() {
  const host = $('pf-extras');
  const d = ctx.data;
  if (!host || !d) return;
  applyHeroStyle(d);
  host.innerHTML = (ctx.own ? styleSectionHtml(d) + chestSectionHtml(d) : '') + collectionHtml(d);
  bind();
}

// ---------------------------------------------------------------------------
// Hero: banner, name colour, title, showcase
// ---------------------------------------------------------------------------
function applyHeroStyle(d) {
  const hero = document.querySelector('.pf-hero');
  const name = $('pf-name');
  const st = d.style || {};
  if (hero) {
    hero.classList.toggle('px-has-banner', st.banner && st.banner !== 'plain');
    hero.style.background = st.banner && st.banner !== 'plain' ? BANNERS[st.banner] || '' : '';
  }
  if (name) {
    const c = NAME_COLORS[st.name_color] || 'inherit';
    name.classList.toggle('px-rainbow', st.name_color === 'rainbow');
    name.style.color = st.name_color === 'rainbow' || c === 'inherit' ? '' : c;
    name.style.backgroundImage = st.name_color === 'rainbow' ? c : '';
  }
  let tag = $('px-hero-extra');
  if (!tag && name) {
    tag = document.createElement('div');
    tag.id = 'px-hero-extra';
    tag.className = 'px-hero-extra';
    name.insertAdjacentElement('afterend', tag);
  }
  if (tag) {
    const title = (d.titles || []).find((t) => t.key === st.title && t.earned);
    const badges = (st.showcase || []).map((k) => (d.badges || []).find((b) => b.key === k)).filter(Boolean);
    tag.innerHTML = (title ? `<span class="px-title-chip">🏅 ${esc(title.name)}</span>` : '')
      + badges.map((b) => `<span class="px-show-badge" title="${esc(b.name)}"><span aria-hidden="true">${esc(b.icon)}</span><span class="sr-only">${esc(b.name)}</span></span>`).join('');
    tag.hidden = !tag.innerHTML;
  }
}

// ---------------------------------------------------------------------------
// Style controls (own profile only)
// ---------------------------------------------------------------------------
function styleSectionHtml(d) {
  const st = d.style || {};
  const owned = (slot) => (d.items || []).filter((i) => i.slot === slot && i.owned);
  const opt = (items, cur) => items.map((i) => `<option value="${esc(i.key.split('.')[1])}" ${i.key.split('.')[1] === cur ? 'selected' : ''}>${esc(i.name)}</option>`).join('');
  const earnedTitles = (d.titles || []).filter((t) => t.earned);
  const lockedTitles = (d.titles || []).filter((t) => !t.earned);
  const hasAvatar = Boolean(st.token);
  const preview = hasAvatar ? avatarSvg(st.look, { label: 'Your avatar' }) : '<span class="px-empty-av" aria-hidden="true">?</span>';
  return `
  <section class="card pf-card px-card" aria-labelledby="px-style-h">
    <div class="ac-card-h"><h2 id="px-style-h">🎨 My look</h2><span class="ac-sub">Coins: <b class="num">${fmt(d.coins?.balance)}</b></span></div>
    <div class="px-style-grid">
      <div class="px-pic">
        <div class="px-pic-av">${preview}</div>
        <div class="px-seg" role="radiogroup" aria-label="Picture to show">
          <button type="button" role="radio" aria-checked="${st.mode !== 'avatar'}" data-px-mode="photo" class="${st.mode !== 'avatar' ? 'on' : ''}">📷 Photo</button>
          <button type="button" role="radio" aria-checked="${st.mode === 'avatar'}" data-px-mode="avatar" class="${st.mode === 'avatar' ? 'on' : ''}" ${hasAvatar ? '' : 'disabled title="Build your avatar in the Store first"'}>🙂 Avatar</button>
        </div>
        <a class="btn btn-outline btn-sm" href="/pages/store.html#avatar">${hasAvatar ? 'Change avatar' : 'Build my avatar'}</a>
        <p class="pf-dim px-note">Your avatar shows on leaderboards and duels when you pick it.</p>
      </div>
      <form class="pf-form px-form" id="px-style-form">
        <label><span>Name colour</span><select id="px-name-color">${opt(owned('name_color'), st.name_color || 'default')}</select></label>
        <label><span>Banner</span><select id="px-banner">${opt(owned('banner'), st.banner || 'plain')}</select></label>
        <label><span>Title <small class="pf-dim">earned from achievements</small></span>
          <select id="px-title"><option value="">No title</option>${earnedTitles.map((t) => `<option value="${esc(t.key)}" ${t.key === st.title ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
        ${lockedTitles.length ? `<details class="px-locked"><summary>How to earn more titles (${lockedTitles.length})</summary><ul>${lockedTitles.map((t) => `<li><b>${esc(t.name)}</b>: ${esc(t.how)}</li>`).join('')}</ul></details>` : ''}
        <fieldset class="px-showcase"><legend>Show off up to 3 badges</legend>
          ${(d.badges || []).length ? (d.badges || []).map((b) => `<label class="px-chk"><input type="checkbox" value="${esc(b.key)}" ${(st.showcase || []).includes(b.key) ? 'checked' : ''}/> <span aria-hidden="true">${esc(b.icon)}</span> ${esc(b.name)}</label>`).join('') : '<p class="pf-dim">Earn badges by practising, then pick them here.</p>'}
        </fieldset>
        <p class="pf-dim px-note">More name colours and banners are in the Store.</p>
        <button type="submit" class="btn btn-primary btn-sm">Save style</button>
      </form>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Chests and weekly quests (own profile only)
// ---------------------------------------------------------------------------
function oddsTable(kind, odds) {
  const o = odds?.[kind];
  if (!o) return '';
  const coins = kind === 'levelup' ? `${o.coins_per_tier} coins × tier number` : `${o.coins_min}–${o.coins_max} coins`;
  const cardLine = o.card_chance >= 100 ? '1 card, every time' : `${o.card_chance}% chance of a card`;
  const rows = ['common', 'rare', 'epic', 'legendary'].map((r) => `<tr><td><span class="px-dot r-${r}"></span>${RARITY_LABELS[r]}</td><td class="num">${o.rarity[r]}%</td></tr>`).join('');
  return `<details class="px-odds"><summary>What's inside and the odds</summary>
    <p><b>${esc(coins)}</b> · ${esc(cardLine)}</p>
    <table><thead><tr><th>If you get a card</th><th>Chance</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="pf-dim">A card you already have turns into coins: ${['common', 'rare', 'epic', 'legendary'].map((r) => `${RARITY_LABELS[r]} ${odds.duplicate_coins?.[r]}`).join(', ')}.</p>
  </details>`;
}

function questsHtml(quests) {
  return `<ul class="px-quests">${(quests || []).map((q) => {
    const pct = Math.min(100, Math.round((q.done / Math.max(1, q.goal)) * 100));
    const done = q.done >= q.goal;
    return `<li class="${done ? 'done' : ''}"><div class="px-q-top"><span>${done ? '✅' : '⬜'} ${esc(q.label)}</span><b class="num">${q.done}/${q.goal}</b></div><div class="xp-bar"><span style="width:${pct}%"></span></div></li>`;
  }).join('')}</ul>`;
}

function chestSectionHtml(d) {
  const ch = d.chests || {};
  const cards = CHESTS.map((c) => {
    const s = ch[c.kind] || {};
    const ready = s.ready && !s.claimed;
    let status;
    if (s.claimed) status = c.kind === 'daily' ? 'Opened today. Come back tomorrow.' : c.kind === 'weekly' ? 'Opened this week. New quests on Monday.' : '';
    else if (ready) status = c.kind === 'levelup' && s.tier ? `You reached tier ${s.next_tier_rank}. Open your reward!` : 'Ready to open!';
    else status = c.locked;
    return `<div class="px-chest ${ready ? 'is-ready' : ''}" data-kind="${c.kind}">
      <div class="px-chest-h"><span class="px-chest-ic">${chestSvg(c.kind, s.claimed)}</span><div><h3>${c.title}</h3><p class="pf-dim">${c.when}</p></div></div>
      ${c.kind === 'weekly' ? questsHtml(s.quests) : ''}
      <p class="px-chest-status">${esc(status)}</p>
      <button type="button" class="btn ${ready ? 'btn-primary' : 'btn-outline'} btn-sm" data-px-open="${c.kind}" data-period="${esc(s.period || '')}" ${ready ? '' : 'disabled'}>${ready ? 'Open chest' : s.claimed ? 'Opened' : 'Locked'}</button>
      ${oddsTable(c.kind, d.odds)}
    </div>`;
  }).join('');
  return `
  <section class="card pf-card px-card" aria-labelledby="px-chests-h">
    <div class="ac-card-h"><h2 id="px-chests-h">🎁 Chests</h2><span class="ac-sub">🪙 <b class="num" id="px-coins">${fmt(d.coins?.balance)}</b> coins</span></div>
    <p class="pf-dim px-note">You earn 1 coin for every 10 XP from practice, and chests open after real practice. Coins are only for avatar items. They can never be bought.</p>
    <div class="px-reveal" id="px-reveal" hidden aria-live="polite"></div>
    <div class="px-chests">${cards}</div>
  </section>`;
}

function revealHtml(r) {
  const coins = (r.coins || 0) + (r.duplicate_coins || 0);
  const card = r.card ? `<div class="px-reveal-card">${cardHtml({ ...r.card, copies: 1 }, true)}<p>${r.duplicate ? `You already had this card, so it became <b>${r.duplicate_coins}</b> bonus coins.` : 'New card for your collection!'}</p></div>` : '';
  return `<div class="px-reveal-in"><h3>${r.already ? 'You already opened this chest' : 'Chest opened!'}</h3>
    <p class="px-reveal-coins">🪙 +${fmt(coins)} coins</p>${card}
    <button type="button" class="btn btn-outline btn-sm" data-px-close>Done</button></div>`;
}

// ---------------------------------------------------------------------------
// Collection book
// ---------------------------------------------------------------------------
function cardHtml(c, big = false) {
  const have = c.copies > 0;
  return `<article class="px-mcard r-${esc(c.rarity)} ${have ? '' : 'is-missing'} ${big ? 'is-big' : ''}">
    <div class="px-art"><span class="px-rar">${RARITY_LABELS[c.rarity] || ''}</span><span class="px-num">#${String(c.number).padStart(2, '0')}</span>${have ? cardArtSvg(c.key, c.name) : '<span class="px-q" aria-hidden="true">?</span>'}${c.copies > 1 ? `<span class="px-copies">×${c.copies}</span>` : ''}</div>
    <h3>${esc(c.name)}</h3><div class="px-yrs">${esc(c.subtitle)}</div>
    ${have && c.fact ? `<p>${esc(c.fact)}</p>` : '<p class="pf-dim">Find this card in a chest.</p>'}
  </article>`;
}

function collectionHtml(d) {
  const cards = d.cards || [];
  const have = cards.filter((c) => c.copies > 0).length;
  return `
  <section class="card pf-card px-card" aria-labelledby="px-book-h">
    <div class="ac-card-h"><h2 id="px-book-h">📚 Collection book</h2><span class="ac-sub"><b class="num">${have}</b> of ${cards.length} cards</span></div>
    <p class="pf-dim px-note">Famous mathematicians and abacus heroes. Each card has a true fact to learn.</p>
    <div class="px-book">${cards.map((c) => cardHtml(c)).join('')}</div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function refresh() {
  ctx.data = await loadAvatarState(ctx.studentId);
  render();
}

function bind() {
  document.querySelectorAll('[data-px-mode]').forEach((btn) => btn.addEventListener('click', async () => {
    if (ctx.busy || btn.classList.contains('on')) return;
    ctx.busy = true;
    try {
      await saveAvatarLook(null, btn.dataset.pxMode);
      showToast('success', btn.dataset.pxMode === 'avatar' ? 'Now showing your avatar' : 'Now showing your photo');
      await refresh();
      ctx.onAvatarChange?.();
    } catch (err) {
      showToast('error', err?.message || 'Could not change your picture.');
    } finally {
      ctx.busy = false;
    }
  }));

  $('px-style-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const show = [...document.querySelectorAll('.px-showcase input:checked')].map((i) => i.value);
    if (show.length > 3) { showToast('error', 'Pick up to 3 badges.'); return; }
    try {
      await saveProfileStyle({ nameColor: $('px-name-color').value, banner: $('px-banner').value, title: $('px-title').value || null, showcase: show });
      showToast('success', 'Style saved');
      await refresh();
    } catch (err) {
      showToast('error', err?.message || 'Could not save your style.');
    }
  });

  document.querySelectorAll('.px-showcase input').forEach((box) => box.addEventListener('change', () => {
    const checked = document.querySelectorAll('.px-showcase input:checked');
    if (checked.length > 3) { box.checked = false; showToast('info', 'You can show up to 3 badges.'); }
  }));

  document.querySelectorAll('[data-px-open]').forEach((btn) => btn.addEventListener('click', async () => {
    if (ctx.busy) return;
    ctx.busy = true;
    btn.disabled = true;
    try {
      const r = await claimChest(btn.dataset.pxOpen, btn.dataset.period || null);
      if (!r?.already) document.dispatchEvent(new CustomEvent('tt:cue', { detail: 'chest' }));
      await refresh();
      const box = $('px-reveal');
      if (box) {
        box.innerHTML = revealHtml(r);
        box.hidden = false;
        box.querySelector('[data-px-close]')?.addEventListener('click', () => { box.hidden = true; });
        box.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } catch (err) {
      showToast('error', err?.message || 'Could not open the chest.');
      btn.disabled = false;
    } finally {
      ctx.busy = false;
    }
  }));
}

// ---------------------------------------------------------------------------
// Styles (scoped with px-)
// ---------------------------------------------------------------------------
function ensureExtrasStyles() {
  if (document.getElementById('px-style')) return;
  const style = document.createElement('style');
  style.id = 'px-style';
  style.textContent = `
  .px-card { margin-top: 0; }
  .px-note { font-size: 13px; margin: 4px 0 12px; }
  .px-hero-extra { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 4px 0 6px; }
  .px-title-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border-radius: 999px; background: #FEF3C7; color: #92400E; font-weight: 700; font-size: 13px; border: 1px solid #FCD34D; }
  .px-show-badge { display: inline-grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: #fff; border: 1px solid #E5E7EB; font-size: 16px; }
  .pf-hero.px-has-banner { color: #fff; border-color: transparent; }
  .pf-hero.px-has-banner .pf-eyebrow, .pf-hero.px-has-banner .pf-motto { color: rgba(255,255,255,.92); }
  .pf-hero.px-has-banner .ac-fact { background: rgba(255,255,255,.88); color: #172036; }
  .pf-hero.px-has-banner #pf-name:not(.px-rainbow) { text-shadow: 0 1px 2px rgba(0,0,0,.25); }
  .px-rainbow { background-clip: text; -webkit-background-clip: text; color: transparent !important; }
  .px-style-grid { display: grid; grid-template-columns: 200px 1fr; gap: 20px; align-items: start; }
  .px-pic { display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; }
  .px-pic-av { width: 120px; height: 120px; }
  .px-pic-av svg { width: 100%; height: 100%; display: block; }
  .px-empty-av { width: 120px; height: 120px; border-radius: 50%; display: grid; place-items: center; background: #EEF2FF; color: #6366F1; font-size: 44px; font-weight: 800; border: 2px dashed #C7D2FE; }
  .px-seg { display: inline-flex; border: 1px solid #D1D5DB; border-radius: 999px; overflow: hidden; }
  .px-seg button { border: 0; background: #fff; padding: 6px 12px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; min-height: 36px; }
  .px-seg button.on { background: #2563EB; color: #fff; }
  .px-seg button:disabled { opacity: .5; cursor: not-allowed; }
  .px-form { display: grid; gap: 10px; }
  .px-form label { display: grid; gap: 4px; font-weight: 600; font-size: 14px; }
  .px-form select { min-height: 40px; }
  .px-locked { font-size: 13px; }
  .px-locked ul { margin: 6px 0 0; padding-left: 18px; display: grid; gap: 4px; }
  .px-showcase { border: 1px solid #E5E7EB; border-radius: 10px; padding: 8px 12px 10px; display: flex; flex-wrap: wrap; gap: 6px 14px; }
  .px-showcase legend { font-weight: 600; font-size: 14px; padding: 0 4px; }
  .px-chk { display: inline-flex !important; grid: none; align-items: center; gap: 6px; font-weight: 500 !important; }
  .px-chests { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .px-chest { border: 1px solid #E5E7EB; border-radius: 14px; padding: 12px; display: flex; flex-direction: column; gap: 8px; background: #FAFBFF; }
  .px-chest.is-ready { border-color: #93C5FD; box-shadow: 0 0 0 3px #DBEAFE; background: #fff; }
  .px-chest-h { display: flex; gap: 10px; align-items: flex-start; }
  .px-chest-h h3 { margin: 0; font-size: 16px; }
  .px-chest-h p { margin: 2px 0 0; font-size: 12.5px; }
  .px-chest-ic { width: 44px; height: 44px; flex: none; }
  .px-chest-ic svg { width: 100%; height: 100%; }
  .px-chest-status { margin: 0; font-weight: 600; font-size: 13.5px; }
  .px-chest .btn { align-self: flex-start; }
  .px-quests { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; font-size: 13px; }
  .px-q-top { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 3px; }
  .px-quests .xp-bar { height: 6px; }
  .px-odds { font-size: 13px; }
  .px-odds summary { cursor: pointer; color: #2563EB; font-weight: 600; }
  .px-odds table { width: 100%; border-collapse: collapse; margin: 6px 0; }
  .px-odds th, .px-odds td { text-align: left; padding: 3px 4px; border-bottom: 1px solid #EEF0F4; }
  .px-odds td.num { text-align: right; }
  .px-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .px-dot.r-common, .px-mcard.r-common .px-rar { background: #94A3B8; }
  .px-dot.r-rare, .px-mcard.r-rare .px-rar { background: #2563EB; }
  .px-dot.r-epic, .px-mcard.r-epic .px-rar { background: #9333EA; }
  .px-dot.r-legendary, .px-mcard.r-legendary .px-rar { background: #D97706; }
  .px-reveal { margin-bottom: 12px; }
  .px-reveal-in { border: 2px solid #FCD34D; background: #FFFBEB; border-radius: 14px; padding: 14px; text-align: center; display: grid; gap: 8px; justify-items: center; }
  .px-reveal-in h3 { margin: 0; }
  .px-reveal-coins { font-size: 22px; font-weight: 800; margin: 0; }
  .px-reveal-card { display: grid; gap: 6px; justify-items: center; max-width: 280px; }
  .px-book { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; }
  .px-mcard { border-radius: 14px; border: 2px solid #CBD5E1; background: #fff; padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 2px; }
  .px-mcard.r-rare { border-color: #93C5FD; }
  .px-mcard.r-epic { border-color: #D8B4FE; }
  .px-mcard.r-legendary { border-color: #FCD34D; background: linear-gradient(180deg, #FFFBEB, #fff 40%); }
  .px-mcard.is-missing { opacity: .7; border-style: dashed; }
  .px-art { position: relative; aspect-ratio: 1 / 1; border-radius: 10px; background: #F1F5F9; display: grid; place-items: center; overflow: hidden; margin-bottom: 6px; }
  .px-art svg { width: 86%; height: 86%; }
  .px-q { font-size: 44px; font-weight: 800; color: #CBD5E1; }
  .px-rar { position: absolute; top: 6px; left: 6px; color: #fff; font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 999px; }
  .px-num { position: absolute; top: 6px; right: 8px; font-size: 11px; font-weight: 700; color: #64748B; }
  .px-copies { position: absolute; bottom: 6px; right: 8px; font-size: 12px; font-weight: 800; background: #172036; color: #fff; padding: 1px 7px; border-radius: 999px; }
  .px-mcard h3 { margin: 0; font-size: 15px; }
  .px-yrs { font-size: 12px; color: #64748B; }
  .px-mcard p { margin: 4px 0 0; font-size: 12.5px; line-height: 1.4; }
  @media (max-width: 760px) {
    .px-style-grid { grid-template-columns: 1fr; }
    .px-chests { grid-template-columns: 1fr; }
    .px-book { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .px-mcard p { font-size: 12px; }
  }
  `;
  document.head.appendChild(style);
}
