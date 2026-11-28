/* Trendz Tracker - applies the saved theme and large-number setting before the page paints.
   Plain script (not a module) loaded in <head>. Mirrors js/prefs.js applyPrefs(); keep in step. */
(function () {
  var root = document.documentElement;
  var p = {};
  try {
    var raw = JSON.parse(localStorage.getItem('tt_prefs') || 'null');
    p = (raw && (raw.p || raw.prefs)) || {};
  } catch (e) {
    p = {};
  }
  var dark = false;
  try {
    dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch (e) {
    dark = false;
  }
  var theme = p.theme === 'dark' ? 'dark' : p.theme === 'light' ? 'light' : dark ? 'dark' : 'light';
  root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;
  if (p.largeNumbers === true) root.setAttribute('data-large-numbers', 'on');
  if (p.motion === 'off') root.setAttribute('data-motion', 'off');
})();
