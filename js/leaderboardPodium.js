/**
 * Trendz Tracker - Leaderboard podium (js/leaderboardPodium.js)
 *
 * Student layout only: shows the top three of the current board beside the table.
 * It reads the rows js/leaderboard.js already rendered (no extra data calls), so every
 * board, period, scope and privacy rule stays exactly as before. Hidden by CSS unless
 * body.has-student-rail (teacher/admin views are unchanged).
 */

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function readRow(tr) {
  const cells = tr.querySelectorAll('td');
  if (cells.length < 3) return null;
  const rank = (cells[0].textContent || '').trim();
  if (!/^#?\d+/.test(rank)) return null;
  const name = (cells[1].querySelector('span')?.textContent || cells[1].textContent || '').trim();
  const value = (cells[cells.length - 1].textContent || '').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  return { rank: rank.replace(/^#/, ''), name, value, me: tr.getAttribute('data-is-me') === 'true' };
}

function renderPodium(podium, tbody) {
  const trs = Array.from(tbody.querySelectorAll('tr'));
  const ranked = trs.map((tr) => ({ tr, row: readRow(tr) })).filter((x) => x.row);
  const rows = ranked.slice(0, 3).map((x) => x.row);
  // Ranks 1-3 are on the podium, so the table (student layout) continues from rank 4.
  trs.forEach((tr) => tr.classList.remove('lb-on-podium'));
  ranked.slice(0, 3).forEach((x) => x.tr.classList.add('lb-on-podium'));
  const restNote = tbody.querySelector('.lb-rest-note');
  if (restNote) restNote.remove();
  if (rows.length > 0 && ranked.length <= 3) {
    const cols = trs[0]?.children.length || 3;
    tbody.insertAdjacentHTML('beforeend', `<tr class="lb-rest-note"><td colspan="${cols}">Everyone on this board is on the podium.</td></tr>`);
  }
  if (rows.length === 0) {
    podium.hidden = true;
    podium.innerHTML = '';
    return;
  }
  podium.hidden = false;
  // Display order: 2nd, 1st, 3rd
  const order = [rows[1], rows[0], rows[2]];
  const cls = ['p2', 'p1', 'p3'];
  podium.innerHTML = order
    .map((r, i) => {
      if (!r) return '<div class="lb-pd lb-empty" aria-hidden="true"></div>';
      return `<div class="lb-pd ${cls[i]}${r.me ? ' is-me' : ''}">
        ${cls[i] === 'p1' ? '<span class="crown" aria-hidden="true">👑</span>' : ''}
        <span class="av" aria-hidden="true">${esc(r.name.charAt(0).toUpperCase())}</span>
        <b>${esc(r.name)}${r.me ? ' (you)' : ''}</b>
        <span class="pts num">${esc(r.value)}</span>
        <span class="blk num">${esc(r.rank)}</span>
      </div>`;
    })
    .join('');
}

function init() {
  const tbody = document.getElementById('leaderboard-table-body');
  const wrapper = tbody?.closest('.table-wrapper');
  if (!tbody || !wrapper || document.getElementById('leaderboard-podium')) return;

  const board = document.createElement('div');
  board.className = 'lb-board';
  wrapper.parentNode.insertBefore(board, wrapper);
  const podium = document.createElement('div');
  podium.id = 'leaderboard-podium';
  podium.className = 'lb-podium';
  podium.setAttribute('aria-label', 'Top three');
  podium.hidden = true;
  board.appendChild(podium);
  board.appendChild(wrapper);

  let queued = false;
  const opts = { childList: true, subtree: true, characterData: true };
  let observer = null;
  const update = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      // Pause while we tag rows / add the note so our own changes don't re-trigger us.
      observer?.disconnect();
      renderPodium(podium, tbody);
      observer?.observe(tbody, opts);
    });
  };
  observer = new MutationObserver(update);
  observer.observe(tbody, opts);
  update();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
