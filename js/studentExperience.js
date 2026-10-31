// Organize the existing dashboard without changing its data or scoring contracts.
export const dashboardViews = ['today', 'progress', 'competitions', 'library'];
export function dashboardView(hash) {
  const value = String(hash || '').replace(/^#/, '');
  return dashboardViews.includes(value) ? value : 'today';
}

export function setupStudentExperience() {
  const root = document.querySelector('main > .container');
  if (!root || document.getElementById('student-workspace-nav')) return;
  document.body.classList.add('student-experience');
  const welcome = root.querySelector('[aria-labelledby="welcome-heading"]');
  welcome.classList.add('student-welcome');
  const intro = document.createElement('p');
  intro.className = 'workspace-intro';
  intro.textContent = 'A little practice. A stronger you.';
  welcome.prepend(intro);

  const nav = document.createElement('nav');
  nav.id = 'student-workspace-nav';
  nav.className = 'workspace-nav';
  nav.setAttribute('aria-label', 'Your workspace');
  const names = ['Today', 'Progress', 'Competitions', 'Library'];
  nav.innerHTML = dashboardViews.map((id, i) => `<a href="#${id}" data-view="${id}">${names[i]}</a>`).join('');
  welcome.after(nav);
  const panels = {};
  dashboardViews.forEach((id, i) => {
    const panel = document.createElement('section');
    panel.id = `workspace-${id}`;
    panel.setAttribute('aria-label', names[i]);
    panel.className = 'workspace-panel';
    root.append(panel);
    panels[id] = panel;
  });
  const move = (selector, view) => {
    const node = root.querySelector(selector);
    if (node) panels[view].append(node);
  };
  const hero = document.createElement('section');
  hero.id = 'next-practice';
  hero.className = 'next-practice';
  hero.setAttribute('aria-labelledby', 'next-practice-title');
  hero.innerHTML = '<div><p class="eyebrow">YOUR NEXT STEP</p><h2 id="next-practice-title">Getting your plan ready…</h2><p id="next-practice-description">Your assigned practice will appear here.</p><div id="next-practice-actions"></div></div><div class="abacus-art" aria-hidden="true"><i></i><i></i><i></i></div>';
  panels.today.append(hero);
  move('#todays-plan-card', 'today');
  move('#streak-card', 'today');
  move('#explore-practice-card', 'today');
  const progressIntro = document.createElement('div');
  progressIntro.className = 'workspace-page-title';
  progressIntro.innerHTML = '<div><h2>Your progress, in perspective.</h2><p>Practice summaries, attendance and weekly tests.</p></div><a class="btn btn-outline" href="/pages/monthly-report.html">Monthly report →</a>';
  panels.progress.append(progressIntro);
  move('#today-summary-metrics', 'progress');
  const grid = root.querySelector('.dashboard-top-grid');
  if (grid) {
    const leaderboard = grid.querySelector('[aria-labelledby="leaderboard-card-heading"]');
    const resources = grid.querySelector('[aria-labelledby="resources-heading"]');
    if (leaderboard) panels.competitions.append(leaderboard);
    if (resources) panels.library.append(resources);
    panels.progress.append(grid);
  }
  move('#charts-wrapper-container', 'progress');
  const competitionIntro = document.createElement('div');
  competitionIntro.className = 'workspace-page-title';
  competitionIntro.innerHTML = '<div><h2>Your competition record.</h2><p>Round scores and leaderboard, together.</p></div><a class="btn btn-primary" href="/pages/round-scores.html">Log round scores →</a>';
  panels.competitions.prepend(competitionIntro);
  move('[aria-labelledby="sheet-heading"]', 'competitions');
  function activate() {
    const current = dashboardView(location.hash);
    for (const id of dashboardViews) panels[id].hidden = id !== current;
    nav.querySelectorAll('a').forEach(link => {
      if (link.dataset.view === current) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }
  window.addEventListener('hashchange', activate);
  activate();
}

export function refreshNextPractice() {
  const list = document.getElementById('todo-list-container');
  const hero = document.getElementById('next-practice');
  if (!list || !hero) return;
  const rows = [...list.querySelectorAll('.todo-task-item')];
  const done = rows.filter(row => row.classList.contains('todo-task-done'));
  const next = rows.find(row => !row.classList.contains('todo-task-done') && row.querySelector('a'));
  const heading = document.getElementById('next-practice-title');
  const description = document.getElementById('next-practice-description');
  const actions = document.getElementById('next-practice-actions');
  actions.replaceChildren();
  if (next) {
    heading.textContent = next.querySelector('.todo-task-title').textContent.trim();
    description.textContent = 'Next available task in your assigned plan. Choose online practice or log a paper result when available.';
    next.querySelectorAll('a').forEach((link, index) => {
      const action = link.cloneNode(true);
      action.className = index === 0 ? 'btn next-primary' : 'btn next-secondary';
      actions.append(action);
    });
  } else {
    heading.textContent = rows.length && done.length === rows.length ? 'Today’s plan is complete.' : 'Make time for a little practice.';
    description.textContent = rows.length && done.length !== rows.length ? 'No available activity links in this plan. Ask your teacher about the remaining tasks, or choose a practice mode below.' : 'Explore the practice modes below whenever you are ready.';
  }
  if (done.length) {
    const details = document.createElement('details');
    details.className = 'completed-plan';
    const summary = document.createElement('summary');
    summary.textContent = `Completed today (${done.length})`;
    details.append(summary, ...done);
    list.append(details);
    list.querySelectorAll('.todo-section-group').forEach(group => {
      if (!group.querySelector('.todo-task-item')) group.remove();
    });
  }
}
