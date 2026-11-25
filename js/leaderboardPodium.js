/**
 * Trendz Tracker - Leaderboard top-five graph (js/leaderboardPodium.js)
 *
 * Student layout only: a bar graph of the top five on the current board, with everyone
 * else listed underneath. It reads the rows js/leaderboard.js already rendered (no extra
 * data calls), so every board, period, scope and privacy rule stays exactly as before.
 * Hidden by CSS unless body.has-student-rail (teacher/admin views are unchanged).
 */

const TOP_N = 5;
const MEDALS = ['🥇', '🥈', '🥉'];

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
  const nameEl = cells[1].querySelector('a, span:not(.lb-av):not(.badge)');
  const name = (nameEl?.textContent || cells[1].textContent || '').replace(/\s+/g, ' ').trim();
  // The main score is always the third column (Points / Best / Days / Tasks ...).
  const value = (cells[2].textContent || '').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  return { rank: Number(rank.replace(/^#/, '')), name, value, me: tr.getAttribute('data-is-me') === 'true' };
}

/** Leading number of a score, or null for times (m:ss) and anything non-numeric. */
function toNumber(value) {
  if (/\d:\d/.test(value)) return null;
  const m = String(value).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function metricLabel() {
  const th = document.querySelectorAll('#leaderboard-table-head th')[2];
  return (th?.textContent || 'Score').trim();
}

function renderGraph(graph, rows, metric) {
  const nums = rows.map((r) => toNumber(r.value));
  // Lower-is-better boards (fastest time) and text values get evenly stepped bars by rank.
  const lowerIsBetter = /^best$/i.test(metric) || nums.some((n) => n === null);
  const max = Math.max(0, ...nums.filter((n) => n !== null));
  const heightFor = (r, i) => {
    if (lowerIsBetter || max <= 0) return 100 - i * 14;
    return Math.max(6, Math.round((nums[i] / max) * 100));
  };

  graph.innerHTML = `
    <div class="lb-graph-head">
      <h3 class="lb-graph-title">Top ${rows.length}</h3>
      <span class="lb-graph-metric">${esc(metric)}${lowerIsBetter && /^best$/i.test(metric) ? ' · lower is better' : ''}</span>
    </div>
    <ol class="lb-bars" style="--cols:${rows.length}">
      ${rows
        .map((r, i) => {
          const tip = `#${r.rank} ${r.name}${r.me ? ' (you)' : ''}: ${r.value} ${metric}`;
          const medal = MEDALS[r.rank - 1] ? `<span class="lb-medal" aria-hidden="true">${MEDALS[r.rank - 1]}</span>` : '';
          return `<li class="lb-col${r.me ? ' is-me' : ''}" title="${esc(tip)}" aria-label="${esc(tip)}">
            <div class="lb-plot" aria-hidden="true">
              <span class="lb-val num">${esc(r.value)}</span>
              <span class="lb-bar" style="height:${heightFor(r, i)}%"></span>
            </div>
            <div class="lb-who" aria-hidden="true">
              <span class="lb-rank num">${medal}#${esc(r.rank)}</span>
              <span class="lb-av">${esc(r.name.charAt(0).toUpperCase())}</span>
              <b class="lb-name">${esc(r.name)}</b>
              ${r.me ? '<span class="lb-you">You</span>' : ''}
            </div>
          </li>`;
        })
        .join('')}
    </ol>`;
  return { lowerIsBetter, max, nums };
}

/** Adds an initial avatar and a thin score meter to a row below the graph (idempotent). */
function decorateRestRow(tr, row, scale) {
  const cells = tr.querySelectorAll('td');
  const who = cells[1];
  if (!who.querySelector('.lb-av')) {
    who.insertAdjacentHTML('afterbegin', `<span class="lb-av" aria-hidden="true">${esc(row.name.charAt(0).toUpperCase())}</span>`);
  }
  who.classList.add('lb-who-cell');
  who.querySelector('.lb-meter')?.remove();
  const n = toNumber(row.value);
  if (!scale.lowerIsBetter && scale.max > 0 && n !== null) {
    const pct = Math.max(2, Math.round((n / scale.max) * 100));
    who.insertAdjacentHTML('beforeend', `<span class="lb-meter" aria-hidden="true"><i style="width:${pct}%"></i></span>`);
  }
}

function render(graph, restTitle, tbody) {
  const trs = Array.from(tbody.querySelectorAll('tr'));
  const ranked = trs.map((tr) => ({ tr, row: readRow(tr) })).filter((x) => x.row);
  const top = ranked.slice(0, TOP_N);
  const rest = ranked.slice(TOP_N);

  trs.forEach((tr) => tr.classList.remove('lb-on-podium'));
  top.forEach((x) => x.tr.classList.add('lb-on-podium'));
  tbody.querySelector('.lb-rest-note')?.remove();

  if (top.length === 0) {
    graph.hidden = true;
    graph.innerHTML = '';
    restTitle.hidden = true;
    graph.parentElement?.classList.remove('lb-no-rest');
    return;
  }

  graph.hidden = false;
  const scale = renderGraph(graph, top.map((x) => x.row), metricLabel());
  rest.forEach((x) => decorateRestRow(x.tr, x.row, scale));

  const othersVisible = trs.some((tr) => !tr.classList.contains('lb-on-podium'));
  restTitle.hidden = !othersVisible;
  restTitle.textContent = 'Everyone else';
  graph.parentElement?.classList.toggle('lb-no-rest', !othersVisible);
  if (!othersVisible) {
    const cols = trs[0]?.children.length || 3;
    tbody.insertAdjacentHTML(
      'beforeend',
      `<tr class="lb-rest-note"><td colspan="${cols}">Everyone on this board is in the top ${top.length} above.</td></tr>`
    );
  }
}

function init() {
  const tbody = document.getElementById('leaderboard-table-body');
  const wrapper = tbody?.closest('.table-wrapper');
  if (!tbody || !wrapper || document.getElementById('leaderboard-podium')) return;

  const board = document.createElement('div');
  board.className = 'lb-board';
  wrapper.parentNode.insertBefore(board, wrapper);
  const graph = document.createElement('section');
  graph.id = 'leaderboard-podium';
  graph.className = 'lb-podium lb-graph';
  graph.setAttribute('aria-label', 'Top students graph');
  graph.hidden = true;
  const restTitle = document.createElement('h3');
  restTitle.className = 'lb-rest-title';
  restTitle.hidden = true;
  board.appendChild(graph);
  board.appendChild(restTitle);
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
      render(graph, restTitle, tbody);
      observer?.observe(tbody, opts);
    });
  };
  observer = new MutationObserver(update);
  observer.observe(tbody, opts);
  // The header (metric name) can change without the rows changing.
  const thead = document.getElementById('leaderboard-table-head');
  if (thead) new MutationObserver(update).observe(thead, { childList: true, subtree: true });
  update();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
