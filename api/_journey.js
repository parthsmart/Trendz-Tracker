/**
 * Journey boss rounds and checked oral sets (delegated from api/drill.js, so the
 * project stays within the Vercel Hobby limit of 12 functions).
 *
 * - { action: 'journey_start', kind: 'boss' | 'oral' }
 *     Boss: the database decides if the boss round is open (5 of 6 stages cleared,
 *     at most 3 tries a day). The paper is generated here from the level's real
 *     question types; answers stay in journey_sessions and never reach the browser.
 * - { action: 'journey_submit', session_id, answers }
 *     Marks the paper here, saves it exactly once (journey_finish_session), and
 *     only then shows the right answers. A passed boss round flags the student
 *     "ready for level-up" for a teacher; it never changes the official level.
 */

import { randomInt } from 'node:crypto';
import {
  BOSS_PASS_PERCENT,
  ORAL_PASS_PERCENT,
  ORAL_SET_SIZE,
  generateBossPaper,
  generateOralSet,
  gradePaper,
  levelIndex,
  publicQuestions,
} from '../shared/world.js';

export const ORAL_SETS_PER_HOUR = 20;
export const MIN_SECONDS_PER_QUESTION = 1;
export const MAX_ANSWER_LENGTH = 20;
const GRACE_MS = 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleJourneyStart({ body, student, adminSupabase, res, now = Date.now(), seed }) {
  const kind = String(body?.kind || '').trim();
  if (kind !== 'boss' && kind !== 'oral') {
    return res.status(400).json({ error: 'Choose a boss round or an oral set.' });
  }

  let level = student?.level || null;
  if (kind === 'boss') {
    const { data: check, error } = await adminSupabase.rpc('journey_boss_check', { p_student: student.id });
    if (error) return res.status(500).json({ error: 'Could not check your journey. Please try again.' });
    if (!check?.ok) return res.status(409).json({ error: check?.reason || 'The boss round is not open yet.' });
    level = check.level;
  } else {
    if (levelIndex(level) < 0) {
      return res.status(409).json({ error: 'Your teacher needs to set your level first.' });
    }
    const since = new Date(now - 60 * 60 * 1000).toISOString();
    const { count, error } = await adminSupabase
      .from('journey_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('student_id', student.id)
      .eq('kind', 'oral')
      .gte('started_at', since);
    if (error) return res.status(500).json({ error: 'Could not start the oral set. Please try again.' });
    if ((count || 0) >= ORAL_SETS_PER_HOUR) {
      return res.status(429).json({ error: 'That is a lot of oral sets this hour. Take a short break.' });
    }
  }

  const s = seed ?? randomInt(1, 2 ** 31 - 1);
  const paper = kind === 'boss' ? generateBossPaper(level, s) : generateOralSet(level, s, ORAL_SET_SIZE);
  const expiresAt = new Date(now + paper.minutes * 60 * 1000 + GRACE_MS).toISOString();

  const { data: row, error: insErr } = await adminSupabase
    .from('journey_sessions')
    .insert({
      student_id: student.id,
      kind,
      level,
      questions: paper.questions,
      started_at: new Date(now).toISOString(),
      expires_at: expiresAt,
    })
    .select('id')
    .single();
  if (insErr || !row?.id) return res.status(500).json({ error: 'Could not start. Please try again.' });

  return res.status(200).json({
    session_id: row.id,
    kind,
    level,
    minutes: paper.minutes,
    expires_at: expiresAt,
    pass_percent: kind === 'boss' ? BOSS_PASS_PERCENT : ORAL_PASS_PERCENT,
    questions: publicQuestions(paper.questions),
  });
}

/** Checks the shape of the answers before anything is loaded. */
export function validateJourneyAnswers(answers) {
  if (!Array.isArray(answers) || answers.length > 200) return false;
  return answers.every(
    (a) => a === null || a === undefined || ((typeof a === 'string' || typeof a === 'number') && String(a).length <= MAX_ANSWER_LENGTH),
  );
}

export async function handleJourneySubmit({ body, student, adminSupabase, res, now = Date.now() }) {
  const sessionId = String(body?.session_id || '').trim();
  if (!UUID_RE.test(sessionId)) return res.status(400).json({ error: 'Unknown round.' });
  if (!validateJourneyAnswers(body?.answers)) return res.status(400).json({ error: 'Those answers could not be read.' });

  const { data: session, error } = await adminSupabase
    .from('journey_sessions')
    .select('id, student_id, kind, level, questions, started_at, expires_at, status')
    .eq('id', sessionId)
    .eq('student_id', student.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'Could not load the round. Please try again.' });
  if (!session) return res.status(404).json({ error: 'Unknown round.' });
  if (session.status !== 'open') return res.status(409).json({ error: 'This round was already handed in.' });
  if (now > Date.parse(session.expires_at) + GRACE_MS) {
    return res.status(409).json({ error: 'Time ran out for this round. Start a new one.' });
  }

  const questions = Array.isArray(session.questions) ? session.questions : [];
  const usedSeconds = (now - Date.parse(session.started_at)) / 1000;
  if (usedSeconds < questions.length * MIN_SECONDS_PER_QUESTION) {
    return res.status(400).json({ error: 'That was too fast to be real. Take your time and try again.' });
  }

  const answers = questions.map((_, i) => (body.answers[i] === undefined ? null : body.answers[i]));
  const pass = session.kind === 'boss' ? BOSS_PASS_PERCENT : ORAL_PASS_PERCENT;
  const g = gradePaper(questions, answers, pass);

  const { data: saved, error: finErr } = await adminSupabase.rpc('journey_finish_session', {
    p_session: session.id,
    p_student: student.id,
    p_answers: answers.map((a) => (a === null ? null : String(a))),
    p_correct: g.correct,
    p_total: g.total,
    p_percent: g.percent,
    p_passed: g.passed,
    p_by_type: g.by_type,
  });
  if (finErr) return res.status(500).json({ error: 'Could not save the round. Please try again.' });
  if (!saved?.ok) return res.status(409).json({ error: saved?.reason || 'This round was already handed in.' });

  return res.status(200).json({
    kind: session.kind,
    level: session.level,
    correct: g.correct,
    total: g.total,
    percent: g.percent,
    passed: g.passed,
    pass_percent: pass,
    by_type: g.by_type,
    review: questions.map((q, i) => ({
      n: i + 1,
      type: q.type,
      prompt: q.prompt,
      answer: q.answer,
      given: answers[i] === null ? '' : String(answers[i]),
      correct: g.marks[i],
    })),
  });
}
