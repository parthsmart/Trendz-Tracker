/**
 * Trendz Tracker — JMCWC custom practice sets (api/_jmcwcCustom.js)
 *
 * Server-only helpers for revision-workbook-style practice sets. A student picks
 * how many questions of each official difficulty level (per category) appear.
 * Sets are practice only: nothing is written to the jmcwc_* tables. The private
 * questions (with answer keys) travel to the browser sealed with AES-256-GCM and
 * come back on `custom_grade`, so answer keys never reach the client in clear.
 */

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { createCryptoRng, createSeededRng, JMCWC_CATEGORY_KEYS } from './_jmcwcMath.js';
import { generateQuestionForSlot, toPublicQuestion } from './_jmcwcGenerate.js';

export const CUSTOM_MAX_PER_LEVEL = 10;
export const CUSTOM_MAX_QUESTIONS = 150;
export const CUSTOM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const TOKEN_VERSION = 1;

function slotMarkSignature(slot) {
  const p = slot?.parameters || {};
  if (p.scoring_mode === 'dynamic' && Array.isArray(p.mark_range) && p.mark_range.length === 2) {
    return { min: Number(p.mark_range[0]), max: Number(p.mark_range[1]) };
  }
  const m = Number(slot?.max_marks);
  return { min: m, max: m };
}

/**
 * Group each section's official slots into difficulty levels by their points.
 * Level 1 is the easiest (lowest points). Returns
 * [{ category_key, levels: [{ level, min_marks, max_marks, slots: [slotNumbers] }] }].
 */
export function buildCustomLevels(paperSpec) {
  const sections = Array.isArray(paperSpec?.sections) ? paperSpec.sections : [];
  return sections
    .filter((sec) => JMCWC_CATEGORY_KEYS.includes(sec.key) && Array.isArray(sec.questions))
    .map((sec) => {
      const groups = new Map();
      for (const slot of sec.questions) {
        const sig = slotMarkSignature(slot);
        if (!Number.isFinite(sig.min) || !Number.isFinite(sig.max)) continue;
        const k = `${sig.min}-${sig.max}`;
        if (!groups.has(k)) groups.set(k, { min_marks: sig.min, max_marks: sig.max, slots: [] });
        groups.get(k).slots.push(Number(slot.slot));
      }
      const levels = [...groups.values()]
        .sort((a, b) => a.min_marks - b.min_marks || a.max_marks - b.max_marks)
        .map((g, i) => ({ level: i + 1, ...g }));
      return { category_key: sec.key, levels };
    });
}

function findSlotSpec(paperSpec, categoryKey, slotNumber) {
  const sec = paperSpec.sections.find((s) => s.key === categoryKey);
  return sec?.questions?.find((q) => Number(q.slot) === Number(slotNumber)) || null;
}

/**
 * Public options for the set builder: levels with one sample prompt each.
 * `allowedCategory(key)` filters categories the student may practise.
 */
export function buildCustomOptions(paperSpec, { allowedCategory = () => true, rng = null } = {}) {
  const activeRng = rng || createCryptoRng();
  return buildCustomLevels(paperSpec)
    .filter((cat) => allowedCategory(cat.category_key))
    .map((cat) => ({
      category_key: cat.category_key,
      levels: cat.levels.map((lvl) => {
        let sample = '';
        try {
          const spec = findSlotSpec(paperSpec, cat.category_key, lvl.slots[0]);
          sample = generateQuestionForSlot(cat.category_key, spec, activeRng).prompt;
        } catch {
          sample = '';
        }
        return {
          level: lvl.level,
          min_marks: lvl.min_marks,
          max_marks: lvl.max_marks,
          official_slots: lvl.slots.length,
          sample_prompt: sample,
        };
      }),
    }));
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  err.code = 'INVALID_CUSTOM_SET';
  return err;
}

/** Validate `[{ category_key, level, count }]` against the paper's levels. */
export function normalizeCustomSelections(paperSpec, selections, { allowedCategory = () => true } = {}) {
  if (!Array.isArray(selections) || selections.length === 0) {
    throw badRequest('Choose at least one question.');
  }
  const levelsByCat = new Map(buildCustomLevels(paperSpec).map((c) => [c.category_key, c.levels]));
  const seen = new Set();
  const out = [];
  let total = 0;
  for (const sel of selections) {
    const cat = typeof sel?.category_key === 'string' ? sel.category_key : '';
    const level = Number(sel?.level);
    const count = Number(sel?.count);
    const levels = levelsByCat.get(cat);
    if (!levels) throw badRequest(`Unknown category: ${cat || '(blank)'}.`);
    if (!allowedCategory(cat)) {
      const err = new Error(`Category ${cat} is not permitted for your practice access.`);
      err.statusCode = 403;
      err.code = 'PRACTICE_ACCESS_RESTRICTED';
      throw err;
    }
    const lvl = levels.find((l) => l.level === level);
    if (!lvl) throw badRequest(`Unknown level ${sel?.level} for ${cat}.`);
    if (!Number.isInteger(count) || count < 0 || count > CUSTOM_MAX_PER_LEVEL) {
      throw badRequest(`Each level allows 0 to ${CUSTOM_MAX_PER_LEVEL} questions.`);
    }
    const key = `${cat}:${level}`;
    if (seen.has(key)) throw badRequest(`Duplicate selection for ${cat} level ${level}.`);
    seen.add(key);
    if (count === 0) continue;
    total += count;
    out.push({ category_key: cat, level, count, slots: lvl.slots });
  }
  if (total === 0) throw badRequest('Choose at least one question.');
  if (total > CUSTOM_MAX_QUESTIONS) {
    throw badRequest(`A custom set can have at most ${CUSTOM_MAX_QUESTIONS} questions.`);
  }
  return out;
}

function shuffled(rng, arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = rng.int(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Generate private questions for normalized selections, in paper category order
 * and easiest level first (like the revision workbook). Question ids are
 * `${category}_c${n}`; `slot` is the question number within its sheet.
 */
export function generateCustomSet(paperSpec, normalizedSelections, { seed = null } = {}) {
  const rng = seed !== null && seed !== undefined ? createSeededRng(seed) : createCryptoRng();
  const catOrder = paperSpec.sections.map((s) => s.key);
  const sorted = [...normalizedSelections].sort(
    (a, b) => catOrder.indexOf(a.category_key) - catOrder.indexOf(b.category_key) || a.level - b.level
  );
  const perCat = new Map();
  const privateQuestions = [];
  for (const sel of sorted) {
    let pool = [];
    for (let i = 0; i < sel.count; i += 1) {
      if (pool.length === 0) pool = shuffled(rng, sel.slots);
      const slotNumber = pool.pop();
      const spec = findSlotSpec(paperSpec, sel.category_key, slotNumber);
      const q = generateQuestionForSlot(sel.category_key, spec, rng);
      const n = (perCat.get(sel.category_key) || 0) + 1;
      perCat.set(sel.category_key, n);
      privateQuestions.push({ ...q, id: `${sel.category_key}_c${n}`, slot: n });
    }
  }
  return {
    privateQuestions,
    publicQuestions: privateQuestions.map(toPublicQuestion),
    total_max_marks: privateQuestions.reduce((s, q) => s + Number(q.max_marks), 0),
  };
}

function deriveKey(secret) {
  if (!secret || String(secret).length < 16) {
    const err = new Error('Custom practice sets are not configured on the server.');
    err.statusCode = 503;
    err.code = 'CUSTOM_SET_UNCONFIGURED';
    throw err;
  }
  return crypto.createHash('sha256').update(`trendz-jmcwc-custom-v1:${secret}`).digest();
}

export function sealCustomSet({ studentId, groupKey, paperId, privateQuestions, issuedAt }, secret) {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const plain = zlib.deflateRawSync(
    Buffer.from(
      JSON.stringify({ v: TOKEN_VERSION, sid: studentId, g: groupKey, p: paperId, iat: issuedAt, q: privateQuestions }),
      'utf8'
    )
  );
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64url');
}

export function openCustomSet(token, secret, { studentId, nowMs = Date.now() } = {}) {
  const invalid = (msg = 'This practice set is invalid or has expired. Build a new set.') => {
    const err = new Error(msg);
    err.statusCode = 400;
    err.code = 'INVALID_CUSTOM_TOKEN';
    return err;
  };
  if (typeof token !== 'string' || token.length < 40 || token.length > 200_000) throw invalid();
  const key = deriveKey(secret);
  let payload;
  try {
    const raw = Buffer.from(token, 'base64url');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
    payload = JSON.parse(zlib.inflateRawSync(plain).toString('utf8'));
  } catch {
    throw invalid();
  }
  if (payload?.v !== TOKEN_VERSION || !Array.isArray(payload.q)) throw invalid();
  if (studentId && payload.sid !== studentId) throw invalid('This practice set belongs to another account.');
  if (!Number.isFinite(payload.iat) || nowMs - payload.iat > CUSTOM_TOKEN_TTL_MS || payload.iat - nowMs > 60_000) {
    throw invalid();
  }
  return {
    studentId: payload.sid,
    groupKey: payload.g,
    paperId: payload.p,
    issuedAt: payload.iat,
    privateQuestions: payload.q,
  };
}
