/** Presentation-only modes. No drill, grading, or storage behavior lives here. */
export const BASICS_MODES = ['online', 'paper', 'history'];

export function initialBasicsMode(search = '') {
  const params = new URLSearchParams(search);
  // Existing Today links use these parameters specifically to log a paper result.
  if (params.get('cat') || params.get('category_id')) return 'paper';
  const view = params.get('view');
  return BASICS_MODES.includes(view) ? view : 'online';
}

export function initializeBasicsExperience(root, search = '') {
  const tabs = BASICS_MODES.map(mode => root.getElementById(`basics-tab-${mode}`));
  const panels = BASICS_MODES.map(mode => root.getElementById(`basics-panel-${mode}`));

  function show(mode, { focus = false } = {}) {
    const selected = BASICS_MODES.indexOf(mode);
    if (selected < 0) return;
    tabs.forEach((tab, index) => {
      if (!tab) return;
      tab.setAttribute('aria-selected', String(index === selected));
      tab.tabIndex = index === selected ? 0 : -1;
    });
    panels.forEach((panel, index) => {
      if (panel) panel.hidden = index !== selected;
    });
    if (focus) tabs[selected]?.focus();
  }

  tabs.forEach((tab, index) => {
    if (!tab) return;
    tab.addEventListener('click', () => show(BASICS_MODES[index]));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      show(BASICS_MODES[next], { focus: true });
    });
  });
  show(initialBasicsMode(search));
  return { show };
}
