/**
 * Trendz Tracker - Oral Rounds page controller (js/oralRoundsPage.js)
 *
 * Reads each question aloud with the browser's speechSynthesis:
 *   intro ("2 digit times 2 digit") -> first number -> chosen delay -> second number.
 * The student types the answer and gets a verdict straight away.
 *
 * Nothing is written to the database: no activity_results, no leaderboard,
 * no streaks. The session score lives only in this page.
 */

import { requireAuth } from './guard.js';
import { isDemoMode, DemoDB } from './demoDb.js';
import { getSupabase } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { fetchStudentEffectiveAccess } from './studentAccess.js';
import {
  ORAL_DELAY_LIMITS,
  buildOralSpeech,
  checkOralAnswer,
  createOralScore,
  defaultOralSettings,
  formatOralSettingsTitle,
  generateOralQuestion,
  getOperationSymbol,
  getOralRoundOptions,
  recordOralAttempt,
  validateOralSettings,
} from './oralRounds.js';

const STORAGE_KEY = 'trendz_oral_rounds_settings_v1';
const PAUSE_AFTER_INTRO_MS = 700;

const state = {
  rule: null,
  options: null,
  settings: null,
  question: null,
  previous: null,
  phase: 'idle', // idle | speaking | answering | answered
  score: createOralScore(),
  runId: 0,
  voice: null,
};

const $ = (id) => document.getElementById(id);

function hasSpeech() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';
}

function pickVoice() {
  if (!hasSpeech()) return null;
  const voices = window.speechSynthesis.getVoices() || [];
  return (
    voices.find((v) => /^en-IN/i.test(v.lang)) ||
    voices.find((v) => /^en-GB/i.test(v.lang)) ||
    voices.find((v) => /^en/i.test(v.lang)) ||
    null
  );
}

function wait(ms, runId) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(runId === state.runId), ms);
  });
}

/**
 * Speaks text and resolves when it finishes (true) or the run was cancelled (false).
 * A timer backs up `onend`, which some browsers do not fire reliably.
 */
function speak(text, runId) {
  return new Promise((resolve) => {
    if (runId !== state.runId) return resolve(false);
    if (!hasSpeech()) return resolve(true);
    const u = new SpeechSynthesisUtterance(text);
    if (state.voice) {
      u.voice = state.voice;
      u.lang = state.voice.lang;
    } else {
      u.lang = 'en-IN';
    }
    u.rate = 0.95;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(backup);
      resolve(runId === state.runId);
    };
    const backup = setTimeout(finish, 1500 + text.length * 180);
    u.onend = finish;
    u.onerror = finish;
    window.speechSynthesis.speak(u);
  });
}

function cancelSpeech() {
  state.runId += 1;
  if (hasSpeech()) window.speechSynthesis.cancel();
}

function setStatus(text) {
  const el = $('oral-status');
  if (el) el.textContent = text;
}

function setDisplay(text) {
  const el = $('oral-display');
  if (el) el.textContent = text;
}

function setVerdict(text, kind = '') {
  const el = $('oral-verdict');
  if (!el) return;
  el.textContent = text;
  el.className = `oral-verdict${kind ? ` is-${kind}` : ''}`;
}

function renderScore() {
  const s = state.score;
  $('oral-score-correct').textContent = String(s.correct);
  $('oral-score-wrong').textContent = String(s.wrong);
  $('oral-score-asked').textContent = String(s.asked);
  $('oral-score-streak').textContent = String(s.streak);
}

function updateControls() {
  const p = state.phase;
  const inRound = p !== 'idle';
  $('oral-answer').disabled = !(p === 'speaking' || p === 'answering');
  $('btn-oral-check').disabled = !(p === 'speaking' || p === 'answering');
  $('btn-oral-repeat').disabled = !(p === 'answering' || p === 'answered');
  $('btn-oral-next').disabled = p !== 'answered';
  $('btn-oral-end').disabled = !inRound;
  $('btn-oral-start').textContent = inRound ? 'Restart with these settings' : 'Start round';
}

/* ---------------------------------------------------------------- settings */

function readFormSettings() {
  const op = document.querySelector('input[name="oral-operation"]:checked');
  return {
    operation: op ? op.value : '',
    digitsA: Number($('oral-digits-a').value),
    digitsB: Number($('oral-digits-b').value),
    delaySeconds: Number($('oral-delay').value),
  };
}

function loadSavedSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage may be unavailable (private mode); settings are optional.
  }
}

function renderSettingsForm() {
  const { operations, digits } = state.options;
  const saved = validateOralSettings(loadSavedSettings() || {}, state.rule);
  const initial = saved.ok ? saved.settings : defaultOralSettings(state.rule);

  $('oral-operation-choices').innerHTML = operations
    .map(
      (op) => `
      <label class="oral-choice">
        <input type="radio" name="oral-operation" value="${op.key}" ${op.key === initial.operation ? 'checked' : ''} />
        <span>${op.symbol} ${op.label}</span>
      </label>`
    )
    .join('');

  const optionHtml = digits.map((d) => `<option value="${d}">${d} digit${d === 1 ? '' : 's'}</option>`).join('');
  $('oral-digits-a').innerHTML = optionHtml;
  $('oral-digits-b').innerHTML = optionHtml;
  $('oral-digits-a').value = String(initial.digitsA);
  $('oral-digits-b').value = String(initial.digitsB);

  const delay = $('oral-delay');
  delay.min = String(ORAL_DELAY_LIMITS.min);
  delay.max = String(ORAL_DELAY_LIMITS.max);
  delay.step = String(ORAL_DELAY_LIMITS.step);
  delay.value = String(initial.delaySeconds);

  refreshSettingsHints();
}

function refreshSettingsHints() {
  const s = readFormSettings();
  $('oral-op-sign').textContent = getOperationSymbol(s.operation) || '+';
  const hint = $('oral-digits-hint');
  const v = validateOralSettings(s, state.rule);
  if (v.ok) {
    hint.textContent = `You will practise ${formatOralSettingsTitle(v.settings)}.`;
    hint.style.color = 'var(--text-muted)';
  } else {
    hint.textContent = v.error;
    hint.style.color = 'var(--color-danger, #b91c1c)';
  }
}

/* ---------------------------------------------------------------- round flow */

async function askQuestion() {
  cancelSpeech();
  const runId = state.runId;
  state.question = generateOralQuestion(state.settings, Math.random, state.previous);
  state.previous = { a: state.question.a, b: state.question.b };
  state.phase = 'speaking';
  $('oral-answer').value = '';
  setVerdict('');
  updateControls();
  $('oral-answer').focus();
  await playQuestion(runId);
}

async function playQuestion(runId) {
  const q = state.question;
  const speech = buildOralSpeech(q);
  const voiceless = !hasSpeech();

  setDisplay('');
  setStatus(`Listen: ${speech.intro}`);
  if (!(await speak(speech.intro, runId))) return;
  if (!(await wait(PAUSE_AFTER_INTRO_MS, runId))) return;

  setStatus('First number');
  if (voiceless) setDisplay(speech.first);
  if (!(await speak(speech.first, runId))) return;

  setStatus(`Second number in ${state.settings.delaySeconds} s…`);
  if (!(await wait(state.settings.delaySeconds * 1000, runId))) return;

  setStatus('Second number');
  if (voiceless) setDisplay(speech.second);
  if (!(await speak(speech.second, runId))) return;

  if (state.phase === 'answered') {
    setStatus('Press Enter or Next question to go on.');
    return;
  }
  state.phase = 'answering';
  setStatus('Type your answer and press Enter.');
  updateControls();
  $('oral-answer').focus();
}

function submitAnswer() {
  if (!(state.phase === 'speaking' || state.phase === 'answering')) return;
  const q = state.question;
  const result = checkOralAnswer(q, $('oral-answer').value);
  if (result.given === null) {
    setVerdict('Type a whole number.', 'wrong');
    $('oral-answer').focus();
    return;
  }
  cancelSpeech();
  state.phase = 'answered';
  state.score = recordOralAttempt(state.score, result.correct);
  const sum = `${q.a} ${getOperationSymbol(q.operation)} ${q.b} = ${q.answer}`;
  setDisplay(sum);
  if (result.correct) {
    setVerdict('Correct!', 'correct');
  } else {
    setVerdict(`Not quite. You typed ${result.given}; the answer is ${q.answer}.`, 'wrong');
  }
  setStatus('Press Enter or Next question to go on.');
  renderScore();
  updateControls();
  $('btn-oral-next').focus();
}

function startRound(event) {
  event?.preventDefault();
  const v = validateOralSettings(readFormSettings(), state.rule);
  const errEl = $('oral-settings-error');
  if (!v.ok) {
    errEl.textContent = v.error;
    errEl.style.display = 'block';
    return;
  }
  errEl.style.display = 'none';
  state.settings = v.settings;
  $('oral-delay').value = String(v.settings.delaySeconds);
  saveSettings(v.settings);
  state.score = createOralScore();
  state.previous = null;
  renderScore();
  $('oral-round-title').textContent = formatOralSettingsTitle(v.settings);
  askQuestion();
}

function endRound() {
  cancelSpeech();
  const s = state.score;
  state.phase = 'idle';
  state.question = null;
  setDisplay('');
  setVerdict('');
  $('oral-answer').value = '';
  setStatus(
    s.asked === 0
      ? 'Round ended. Choose your settings and press Start round.'
      : `Round ended: ${s.correct} of ${s.asked} correct, best streak ${s.bestStreak}.`
  );
  $('oral-round-title').textContent = 'Ready when you are';
  updateControls();
}

function wireEvents() {
  $('oral-settings-form').addEventListener('submit', startRound);
  $('oral-settings-form').addEventListener('change', refreshSettingsHints);
  $('oral-answer-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitAnswer();
  });
  $('btn-oral-next').addEventListener('click', () => askQuestion());
  $('btn-oral-repeat').addEventListener('click', () => {
    if (!state.question) return;
    cancelSpeech();
    playQuestion(state.runId);
  });
  $('btn-oral-end').addEventListener('click', endRound);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && state.phase === 'answered' && e.target?.id !== 'btn-oral-next') {
      e.preventDefault();
      askQuestion();
    }
  });
  window.addEventListener('pagehide', cancelSpeech);
  if (hasSpeech()) {
    state.voice = pickVoice();
    window.speechSynthesis.addEventListener?.('voiceschanged', () => {
      state.voice = pickVoice();
    });
  }
}

/* ---------------------------------------------------------------- init */

function renderHeaderUser(profile) {
  const container = $('user-pill-container');
  if (container) container.style.display = 'flex';
  if ($('header-user-name')) $('header-user-name').textContent = profile.full_name || 'Student';
  if ($('header-user-code')) $('header-user-code').textContent = profile.student_code || 'STU';
  $('btn-header-logout')?.addEventListener('click', async () => {
    const { logoutUser } = await import('./auth.js');
    await logoutUser();
  });
}

function showUnavailable(text) {
  $('oral-loading').style.display = 'none';
  $('oral-main').style.display = 'none';
  $('oral-unavailable').style.display = 'block';
  if (text) $('oral-unavailable-text').textContent = text;
}

async function loadRule(profile) {
  // Staff can open the page to try it with every option.
  if (profile.role !== 'student') return null;
  const supabase = !isDemoMode() && isSupabaseConfigured() ? await getSupabase() : null;
  const res = await fetchStudentEffectiveAccess(profile.id, { supabase, isDemo: isDemoMode(), DemoDB });
  if (!res?.ok) throw new Error(res?.error || 'Could not load your practice access.');
  return res.settings?.oral_rounds ?? null;
}

async function initOralRounds() {
  const profile = await requireAuth(['student', 'admin', 'teacher']);
  if (!profile) return;
  renderHeaderUser(profile);

  try {
    state.rule = await loadRule(profile);
  } catch (err) {
    showUnavailable(`${err.message} Please refresh the page.`);
    return;
  }

  state.options = getOralRoundOptions(state.rule);
  if (!state.options.allowed) {
    showUnavailable();
    return;
  }

  $('oral-loading').style.display = 'none';
  $('oral-main').style.display = '';
  if (!hasSpeech()) {
    const banner = $('config-banner-placeholder');
    banner.innerHTML =
      '<div class="banner banner-error" style="margin-bottom: var(--space-4);" role="alert">This browser cannot read aloud. The numbers will be shown on screen instead.</div>';
  }
  renderSettingsForm();
  wireEvents();
  renderScore();
  updateControls();
}

if (typeof document !== 'undefined' && document.getElementById('oral-main')) {
  initOralRounds();
}
