/* Trendz Tracker - applies the saved large-number and reduced-motion settings before the page paints.
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
  if (p.largeNumbers === true) root.setAttribute('data-large-numbers', 'on');
  if (p.motion === 'off') root.setAttribute('data-motion', 'off');
})();
