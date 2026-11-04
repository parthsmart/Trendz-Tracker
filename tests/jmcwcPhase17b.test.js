/**
 * Trendz Tracker — Phase 17b Automated Test Suite (tests/jmcwcPhase17b.test.js)
 *
 * Verifies the Phase 17b authenticated JMCWC server APIs, session lifecycle,
 * save-queue coordinator, response whitelisting, and admin operations against
 * the authoritative deployed database contract in `docs/JMCWC_DATABASE_CONTRACT.json`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  JMCWC_CATEGORY_REGISTRY,
  JMCWC_PAPERS,
} from '../api/_jmcwcBlueprints.js';
import { createJmcwcSaveQueue } from '../api/_jmcwcSaveQueue.js';
import { createJmcwcServer, createJmcwcRateLimiter } from '../api/_jmcwcServer.js';

const JUNIOR1_BLUEPRINT_2026_1 = JMCWC_PAPERS.junior1.spec;
const JUNIOR2_BLUEPRINT_2026_1 = JMCWC_PAPERS.junior2.spec;
const SENIOR_BLUEPRINT_2026_1 = JMCWC_PAPERS.senior.spec;

// ============================================================================
// High-Fidelity Contract Harness (Mirrors docs/JMCWC_DATABASE_CONTRACT.json)
// ============================================================================

function createContractDatabaseHarness({ initialClockMs = 1_762_000_000_000 } = {}) {
  let clockMs = initialClockMs;

  const nowIso = () => new Date(clockMs).toISOString();
  const advanceClockMs = (deltaMs) => {
    clockMs += Number(deltaMs);
    return clockMs;
  };

  // Tables
  const tokens = new Map(); // token -> user_id
  const profiles = new Map(); // id -> { id, student_code, full_name, role, level, active }
  const categories = new Map(); // id -> { id, name, section }
  const jmcwc_categories = new Map(); // key -> { key, label, workbook_sheet, position, legacy_category_id }
  const jmcwc_assignments = new Map(); // student_id -> { student_id, group_key, updated_at }
  const jmcwc_papers = new Map(); // id -> { id, group_key, version, spec, published, created_at }
  const jmcwc_targets = new Map(); // `${group_key}:${category_key}` -> { group_key, category_key, target_seconds, updated_at }
  const jmcwc_attempts = new Map(); // id -> attempt row
  const jmcwc_payloads = new Map(); // attempt_id -> { attempt_id, questions }
  const jmcwc_scores = new Map(); // attempt_id -> score row

  let failNextFinalizeCount = 0;

  // Seed default 23 JMCWC categories
  for (const cat of JMCWC_CATEGORY_REGISTRY) {
    jmcwc_categories.set(cat.key, {
      key: cat.key,
      label: cat.title,
      workbook_sheet: cat.workbook_sheet,
      position: cat.sort_order,
      legacy_category_id: null,
    });
  }

  // Exact implementation of public.jmcwc_validate_marks(p_category, p_slot, p_question_marks)
  function jmcwc_validate_marks(p_category, p_slot, p_question_marks = null) {
    if (!p_slot || typeof p_slot !== 'object' || Array.isArray(p_slot)) {
      throw new Error('Invalid scoring slot.');
    }
    const params = p_slot.parameters;
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw new Error('Slot parameters must be an object.');
    }
    if (
      Object.prototype.hasOwnProperty.call(p_slot, 'scoring_mode') ||
      Object.prototype.hasOwnProperty.call(p_slot, 'mark_rule') ||
      Object.prototype.hasOwnProperty.call(p_slot, 'mark_range')
    ) {
      throw new Error('Scoring metadata must be inside slot.parameters.');
    }
    if (typeof p_slot.max_marks !== 'number') {
      throw new Error('Blueprint max_marks must be numeric.');
    }
    const baseline = Number(p_slot.max_marks);
    if (baseline <= 0 || baseline !== Math.trunc(baseline)) {
      throw new Error('Blueprint max_marks must be a positive integer.');
    }

    let scoring_mode = 'fixed';
    if (Object.prototype.hasOwnProperty.call(params, 'scoring_mode')) {
      if (typeof params.scoring_mode !== 'string') {
        throw new Error('Invalid scoring_mode.');
      }
      scoring_mode = params.scoring_mode;
    }
    if (scoring_mode !== 'fixed' && scoring_mode !== 'dynamic') {
      throw new Error('Unknown scoring_mode.');
    }

    if (scoring_mode === 'fixed') {
      if (
        Object.prototype.hasOwnProperty.call(params, 'mark_rule') ||
        Object.prototype.hasOwnProperty.call(params, 'mark_range')
      ) {
        throw new Error('Fixed slots must not declare dynamic scoring metadata.');
      }
      if (p_question_marks !== null && p_question_marks !== undefined) {
        const qm = Number(p_question_marks);
        if (!Number.isFinite(qm) || qm <= 0 || qm !== Math.trunc(qm) || qm !== baseline) {
          throw new Error('Fixed question marks must equal blueprint max_marks.');
        }
      }
      return;
    }

    if (typeof params.mark_rule !== 'string') {
      throw new Error('Dynamic slot needs a mark_rule.');
    }
    const rule_name = params.mark_rule;
    const validCombo =
      Boolean(p_category) &&
      ((p_category === 'multiplication' && rule_name === 'multiplication_digits_product') ||
        (p_category === 'prime_factors' && rule_name === 'prime_factors_target_scale') ||
        (p_category === 'approximation' && rule_name === 'approximation_product_digits') ||
        (p_category === 'sum_squares' &&
          ['sum_squares_j1_decomposition', 'sum_squares_j2_target', 'sum_squares_sr_target'].includes(
            rule_name
          )));
    if (!validCombo) {
      throw new Error(`Unrecognized scoring rule ${rule_name} for category ${p_category}.`);
    }

    const bounds = params.mark_range;
    if (!Array.isArray(bounds)) {
      throw new Error('mark_range must be an array.');
    }
    if (bounds.length !== 2) {
      throw new Error('mark_range must contain exactly two bounds.');
    }
    if (typeof bounds[0] !== 'number' || typeof bounds[1] !== 'number') {
      throw new Error('mark_range bounds must be numeric.');
    }
    const lower_mark = Number(bounds[0]);
    const upper_mark = Number(bounds[1]);
    if (
      lower_mark <= 0 ||
      upper_mark <= 0 ||
      lower_mark !== Math.trunc(lower_mark) ||
      upper_mark !== Math.trunc(upper_mark) ||
      lower_mark > upper_mark
    ) {
      throw new Error('mark_range needs ordered positive integer bounds.');
    }
    if (baseline < lower_mark || baseline > upper_mark) {
      throw new Error('Blueprint baseline marks must fall inside mark_range.');
    }
    if (p_question_marks !== null && p_question_marks !== undefined) {
      const qm = Number(p_question_marks);
      if (
        !Number.isFinite(qm) ||
        qm <= 0 ||
        qm !== Math.trunc(qm) ||
        qm < lower_mark ||
        qm > upper_mark
      ) {
        throw new Error('Dynamic question marks must be an integer within mark_range.');
      }
    }
  }

  // Exact implementation of public.jmcwc_paper_guard() trigger
  function jmcwc_paper_guard(oldRow, newRow) {
    if (oldRow && oldRow.published) {
      throw new Error('Published papers are immutable; create a new version.');
    }
    if (newRow.published) {
      const sections = newRow.spec?.sections;
      if (!Array.isArray(sections)) {
        throw new Error('Paper sections must be an array.');
      }
      if (sections.length !== 23) {
        throw new Error('A complete paper needs the 23 visible workbook sections.');
      }
      const uniqueKeys = new Set(sections.map((s) => String(s?.key || '')));
      if (uniqueKeys.size !== 23) {
        throw new Error('Duplicate or missing sections.');
      }
      let n = 0;
      for (const s of sections) {
        if (!jmcwc_categories.has(String(s?.key || ''))) {
          throw new Error('Invalid section.');
        }
        if (!Array.isArray(s.questions)) {
          throw new Error('Section questions must be an array.');
        }
        if (s.questions.length < 1 || s.questions.length > 250) {
          throw new Error('Invalid question count.');
        }
        const slots = new Set(s.questions.map((q) => String(q?.slot ?? '')));
        if (slots.size !== s.questions.length) {
          throw new Error('Duplicate or missing slots.');
        }
        for (const q of s.questions) {
          if (!String(q?.slot ?? '') || !String(q?.generator ?? '')) {
            throw new Error('Invalid question specification.');
          }
          jmcwc_validate_marks(String(s.key), q, null);
          n += 1;
        }
      }
      if (n > 2000) {
        throw new Error('Paper is too large.');
      }
    }
    return newRow;
  }

  // Exact implementation of public.jmcwc_assignment_guard() trigger
  function jmcwc_assignment_guard(oldRow, newRow) {
    if (oldRow && newRow.group_key !== oldRow.group_key) {
      for (const att of jmcwc_attempts.values()) {
        if (att.student_id === oldRow.student_id && att.status !== 'submitted') {
          throw new Error(
            "Complete this student's unfinished simulator attempts before changing group."
          );
        }
      }
    }
    const p = profiles.get(newRow.student_id);
    if (!p || p.role !== 'student') {
      throw new Error('Assign a student account only.');
    }
    newRow.updated_at = nowIso();
    return newRow;
  }

  // Exact implementation of public.jmcwc_check_student(p_student)
  function jmcwc_check_student(p_student) {
    const p = profiles.get(p_student);
    if (!p || p.role !== 'student' || !p.active) {
      throw new Error('An active student account is required.');
    }
    const assign = jmcwc_assignments.get(p_student);
    if (!assign || !assign.group_key) {
      throw new Error('Ask your teacher to assign your JMCWC group.');
    }
    return assign.group_key;
  }

  // Exact implementation of public.jmcwc_tick(p_attempt)
  function jmcwc_tick(p_attempt) {
    const a = jmcwc_attempts.get(p_attempt);
    if (!a || a.status !== 'running') {
      return;
    }
    const lastSeenMs = a.last_seen_at ? new Date(a.last_seen_at).getTime() : clockMs;
    const gap = Math.max(0, Math.floor(clockMs - lastSeenMs));

    if (gap > 25000) {
      a.status = 'paused';
      a.lease_id = null;
      a.last_seen_at = null;
      a.revision = Number(a.revision) + 1;
    } else {
      a.active_ms = Number(a.active_ms) + gap;
      if (a.mode === 'flat' && a.active_ms >= 7200000) {
        a.active_ms = 7200000;
        a.status = 'grading';
        a.lease_id = null;
        a.last_seen_at = null;
        a.finished_at = nowIso();
        a.submitted_reason = 'time_limit';
        a.revision = Number(a.revision) + 1;
      } else {
        a.last_seen_at = nowIso();
      }
    }
  }

  // Exact implementation of public.jmcwc_create_attempt(...)
  function jmcwc_create_attempt({
    p_student,
    p_request,
    p_paper,
    p_mode,
    p_category,
    p_questions,
  }) {
    const g = jmcwc_check_student(p_student);

    for (const existing of jmcwc_attempts.values()) {
      if (existing.student_id === p_student && existing.request_id === p_request) {
        return existing.id;
      }
    }

    if (!p_request || !p_mode || (p_mode !== 'flat' && p_mode !== 'category')) {
      throw new Error('Invalid request.');
    }

    const p = jmcwc_papers.get(p_paper);
    if (!p || p.group_key !== g || !p.published) {
      throw new Error('No published paper for your assigned group.');
    }

    if ((p_mode === 'flat' && p_category !== null) || (p_mode === 'category' && p_category === null)) {
      throw new Error('Invalid category.');
    }

    if (p_mode === 'flat') {
      let unfinishedFlat = 0;
      for (const att of jmcwc_attempts.values()) {
        if (att.student_id === p_student && att.mode === 'flat' && att.status !== 'submitted') {
          unfinishedFlat += 1;
        }
      }
      if (unfinishedFlat >= 3) {
        throw new Error('You have three unfinished flat rounds. Complete one before starting another.');
      }
    }

    let expected = 0;
    const slotLookup = new Map();
    for (const s of p.spec.sections || []) {
      if (p_mode === 'flat' || s.key === p_category) {
        for (const item of s.questions || []) {
          expected += 1;
          slotLookup.set(`${s.key}:${String(item.slot)}`, item);
        }
      }
    }

    if (expected === 0 || !Array.isArray(p_questions)) {
      throw new Error('Invalid generated paper.');
    }
    if (
      p_questions.length !== expected ||
      Buffer.byteLength(JSON.stringify(p_questions), 'utf8') > 5000000
    ) {
      throw new Error('Paper size mismatch.');
    }

    const distinctIds = new Set(p_questions.map((x) => String(x?.id ?? '')));
    const distinctCatSlots = new Set(
      p_questions.map((x) => `${String(x?.category_key ?? '')}:${String(x?.slot ?? '')}`)
    );
    if (distinctIds.size !== expected || distinctCatSlots.size !== expected) {
      throw new Error('Duplicate question IDs or slots.');
    }

    for (const q of p_questions) {
      if (
        !q ||
        typeof q !== 'object' ||
        Array.isArray(q) ||
        !String(q.id ?? '') ||
        String(q.id).length > 100 ||
        !Object.prototype.hasOwnProperty.call(q, 'answer_key') ||
        !Object.prototype.hasOwnProperty.call(q, 'prompt') ||
        !Object.prototype.hasOwnProperty.call(q, 'input') ||
        typeof q.max_marks !== 'number'
      ) {
        throw new Error('Invalid generated question.');
      }
      const blueprint_slot = slotLookup.get(`${String(q.category_key)}:${String(q.slot)}`);
      if (!blueprint_slot) {
        throw new Error('Question does not match the published blueprint.');
      }
      jmcwc_validate_marks(String(q.category_key), blueprint_slot, Number(q.max_marks));
    }

    const targetRow =
      p_mode === 'category' ? jmcwc_targets.get(`${g}:${p_category}`) : null;
    const target = targetRow?.target_seconds ?? null;

    const attemptId = crypto.randomUUID();
    const attemptRow = {
      id: attemptId,
      student_id: p_student,
      request_id: p_request,
      paper_id: p_paper,
      group_key: g,
      mode: p_mode,
      category_key: p_category ?? null,
      status: 'paused',
      active_ms: 0,
      target_seconds: p_mode === 'category' ? target : null,
      last_seen_at: null,
      lease_id: null,
      save_seq: -1,
      revision: 0,
      answers: {},
      created_at: nowIso(),
      finished_at: null,
      submitted_reason: null,
    };
    jmcwc_attempts.set(attemptId, attemptRow);
    jmcwc_payloads.set(attemptId, {
      attempt_id: attemptId,
      questions: structuredClone(p_questions),
    });

    return attemptId;
  }

  // Exact implementation of public.jmcwc_act(...)
  function jmcwc_act({
    p_student,
    p_attempt,
    p_action,
    p_lease = null,
    p_seq = null,
    p_answers = null,
  }) {
    const g = jmcwc_check_student(p_student);
    const a = jmcwc_attempts.get(p_attempt);
    if (!a || a.student_id !== p_student) {
      throw new Error('Round not found.');
    }
    if (a.group_key !== g && a.status !== 'submitted') {
      throw new Error('This round belongs to a different assigned group.');
    }
    if (
      !p_action ||
      !['read', 'resume', 'save', 'heartbeat', 'pause', 'submit'].includes(p_action)
    ) {
      throw new Error('Unknown action.');
    }

    if (
      ['save', 'heartbeat', 'pause', 'submit'].includes(p_action) &&
      a.status === 'running' &&
      (!p_lease || p_lease !== a.lease_id)
    ) {
      throw new Error('Session changed. Reload this round.');
    }

    jmcwc_tick(a.id);

    if (a.status === 'grading' || a.status === 'submitted') {
      return structuredClone(a);
    }

    if (p_action === 'resume') {
      for (const other of jmcwc_attempts.values()) {
        if (other.student_id === p_student && other.status === 'running') {
          jmcwc_tick(other.id);
          if (other.status === 'running') {
            other.status = 'paused';
            other.lease_id = null;
            other.last_seen_at = null;
            other.revision = Number(other.revision) + 1;
          }
        }
      }
      if (a.status === 'grading') {
        return structuredClone(a);
      }
      const token = crypto.randomUUID();
      a.status = 'running';
      a.lease_id = token;
      a.save_seq = -1;
      a.last_seen_at = nowIso();
      a.revision = Number(a.revision) + 1;
    } else if (['save', 'heartbeat', 'pause', 'submit'].includes(p_action)) {
      if (a.status !== 'running') {
        return structuredClone(a);
      }
      if (p_answers !== null && p_answers !== undefined) {
        if (
          typeof p_answers !== 'object' ||
          Array.isArray(p_answers) ||
          Buffer.byteLength(JSON.stringify(p_answers), 'utf8') > 250000 ||
          p_seq === null ||
          p_seq === undefined ||
          Number(p_seq) < 0
        ) {
          throw new Error('Invalid answer patch.');
        }

        const seqNum = Number(p_seq);
        if (seqNum > Number(a.save_seq)) {
          const payload = jmcwc_payloads.get(a.id);
          const validQuestionIds = new Set(
            (payload?.questions || []).map((q) => String(q.id))
          );

          for (const [k, v] of Object.entries(p_answers)) {
            const valType = v === null ? 'null' : typeof v;
            if (
              (valType !== 'string' && valType !== 'null') ||
              Buffer.byteLength(JSON.stringify(v), 'utf8') > 4000 ||
              !validQuestionIds.has(k)
            ) {
              throw new Error('Invalid question or answer.');
            }
          }

          a.answers = { ...a.answers, ...p_answers };
          a.save_seq = seqNum;
          a.revision = Number(a.revision) + 1;
        }
      }

      if (p_action === 'pause') {
        a.status = 'paused';
        a.lease_id = null;
        a.last_seen_at = null;
        a.revision = Number(a.revision) + 1;
      } else if (p_action === 'submit') {
        a.status = 'grading';
        a.lease_id = null;
        a.last_seen_at = null;
        a.finished_at = nowIso();
        a.submitted_reason = 'early';
        a.revision = Number(a.revision) + 1;
      }
    }

    return structuredClone(a);
  }

  // Exact implementation of public.jmcwc_list(p_student, p_offset)
  function jmcwc_list({ p_student, p_offset = 0 }) {
    jmcwc_check_student(p_student);
    for (const att of jmcwc_attempts.values()) {
      if (att.student_id === p_student && att.status === 'running') {
        jmcwc_tick(att.id);
      }
    }
    const matching = [...jmcwc_attempts.values()]
      .filter((att) => att.student_id === p_student)
      .sort((x, y) => {
        if (y.created_at !== x.created_at) return y.created_at.localeCompare(x.created_at);
        return x.id.localeCompare(y.id);
      });
    const off = Math.max(0, Math.min(Number(p_offset) || 0, 100000));
    return matching.slice(off, off + 50).map((r) => structuredClone(r));
  }

  // Exact implementation of public.jmcwc_finalize(p_student, p_attempt, p_revision, p_items)
  function jmcwc_finalize({ p_student, p_attempt, p_revision, p_items }) {
    if (failNextFinalizeCount > 0) {
      failNextFinalizeCount -= 1;
      throw new Error('Simulated transient finalize failure.');
    }

    const a = jmcwc_attempts.get(p_attempt);
    if (!a || a.student_id !== p_student) {
      throw new Error('Round not found.');
    }
    if (a.status === 'submitted') {
      return;
    }
    if (a.status !== 'grading' || Number(a.revision) !== Number(p_revision)) {
      throw new Error('Grading snapshot changed.');
    }

    const payload = jmcwc_payloads.get(a.id);
    const qs = payload?.questions || [];
    if (!Array.isArray(p_items)) {
      throw new Error('Invalid grading output.');
    }
    const distinctQIds = new Set(p_items.map((x) => String(x?.question_id ?? '')));
    if (p_items.length !== qs.length || distinctQIds.size !== qs.length) {
      throw new Error('Grade every question exactly once.');
    }

    const qById = new Map(qs.map((q) => [String(q.id), q]));
    let maximum = 0;
    let earned = 0;
    let c = 0;
    let h = 0;
    let w = 0;
    let sk = 0;

    for (const item of p_items) {
      const q = qById.get(String(item?.question_id ?? ''));
      if (
        !q ||
        typeof item.award !== 'number' ||
        !['correct', 'partial', 'wrong', 'skipped'].includes(String(item.verdict ?? ''))
      ) {
        throw new Error('Invalid mark.');
      }

      const m = Number(q.max_marks);
      const rawAns = a.answers?.[q.id];
      const btrimmed =
        rawAns === null || rawAns === undefined ? '' : String(rawAns).replace(/^ +| +$/g, '');
      const blank = btrimmed === '';

      const expectedAward =
        item.verdict === 'correct' ? m : item.verdict === 'partial' ? m / 2 : 0;

      if (
        Number(item.award) !== expectedAward ||
        (blank && item.verdict !== 'skipped') ||
        (!blank && item.verdict === 'skipped')
      ) {
        throw new Error('Inconsistent mark or blank-answer classification.');
      }

      maximum += m;
      earned += Number(item.award);
      if (item.verdict === 'correct') c += 1;
      else if (item.verdict === 'partial') h += 1;
      else if (item.verdict === 'wrong') w += 1;
      else sk += 1;
    }

    jmcwc_scores.set(a.id, {
      attempt_id: a.id,
      marks: earned,
      max_marks: maximum,
      correct: c,
      partial: h,
      wrong: w,
      skipped: sk,
      items: structuredClone(p_items),
      created_at: nowIso(),
    });

    a.status = 'submitted';
    a.revision = Number(a.revision) + 1;
  }

  // Query builder emulation for Supabase PostgREST calls used by api/_jmcwcServer.js
  function createTableQueryBuilder(tableName) {
    let op = 'select';
    let payloadData = null;
    const eqFilters = [];
    const inFilters = [];
    const orders = [];
    let rangeBounds = null;
    let limitCount = null;

    const getTableRows = () => {
      switch (tableName) {
        case 'profiles':
          return [...profiles.values()];
        case 'categories':
          return [...categories.values()];
        case 'jmcwc_categories':
          return [...jmcwc_categories.values()];
        case 'jmcwc_assignments':
          return [...jmcwc_assignments.values()];
        case 'jmcwc_papers':
          return [...jmcwc_papers.values()];
        case 'jmcwc_targets':
          return [...jmcwc_targets.values()];
        case 'jmcwc_attempts':
          return [...jmcwc_attempts.values()];
        case 'jmcwc_payloads':
          return [...jmcwc_payloads.values()];
        case 'jmcwc_scores':
          return [...jmcwc_scores.values()];
        default:
          throw new Error(`Unknown table: ${tableName}`);
      }
    };

    const matchesFilters = (row) => {
      for (const [col, val] of eqFilters) {
        if (row[col] !== val) return false;
      }
      for (const [col, vals] of inFilters) {
        if (!vals.includes(row[col])) return false;
      }
      return true;
    };

    const execute = async (mode = 'many') => {
      try {
        if (op === 'upsert') {
          if (tableName === 'jmcwc_assignments') {
            const oldRow = jmcwc_assignments.get(payloadData.student_id) || null;
            const newRow = jmcwc_assignment_guard(oldRow, {
              student_id: payloadData.student_id,
              group_key: payloadData.group_key,
              updated_at: nowIso(),
            });
            jmcwc_assignments.set(newRow.student_id, newRow);
            return { data: structuredClone(newRow), error: null };
          }
          if (tableName === 'jmcwc_targets') {
            const key = `${payloadData.group_key}:${payloadData.category_key}`;
            const newRow = {
              group_key: payloadData.group_key,
              category_key: payloadData.category_key,
              target_seconds: payloadData.target_seconds ?? null,
              updated_at: nowIso(),
            };
            jmcwc_targets.set(key, newRow);
            return { data: structuredClone(newRow), error: null };
          }
        }

        if (op === 'update') {
          if (tableName === 'jmcwc_categories') {
            const matched = getTableRows().filter(matchesFilters);
            if (matched.length === 0) {
              return { data: null, error: { message: 'Not found' } };
            }
            const updated = { ...matched[0], ...payloadData };
            jmcwc_categories.set(updated.key, updated);
            return { data: structuredClone(updated), error: null };
          }
          if (tableName === 'jmcwc_papers') {
            const matched = getTableRows().filter(matchesFilters);
            if (matched.length === 0) {
              return { data: null, error: { message: 'Not found' } };
            }
            const oldRow = matched[0];
            const nextRow = jmcwc_paper_guard(oldRow, { ...oldRow, ...payloadData });
            jmcwc_papers.set(nextRow.id, nextRow);
            return { data: structuredClone(nextRow), error: null };
          }
        }

        let rows = getTableRows().filter(matchesFilters).map((r) => structuredClone(r));

        for (let i = orders.length - 1; i >= 0; i--) {
          const { col, ascending } = orders[i];
          rows.sort((a, b) => {
            if (a[col] === b[col]) return 0;
            const cmp = a[col] < b[col] ? -1 : 1;
            return ascending ? cmp : -cmp;
          });
        }

        if (rangeBounds) {
          rows = rows.slice(rangeBounds[0], rangeBounds[1] + 1);
        }
        if (limitCount !== null) {
          rows = rows.slice(0, limitCount);
        }

        if (mode === 'single') {
          if (rows.length === 0) {
            return { data: null, error: { message: 'Row not found' } };
          }
          return { data: rows[0], error: null };
        }
        if (mode === 'maybeSingle') {
          return { data: rows[0] || null, error: null };
        }
        return { data: rows, error: null };
      } catch (err) {
        return { data: null, error: { message: err.message } };
      }
    };

    const builder = {
      select() {
        return builder;
      },
      upsert(data) {
        op = 'upsert';
        payloadData = data;
        return builder;
      },
      update(data) {
        op = 'update';
        payloadData = data;
        return builder;
      },
      eq(col, val) {
        eqFilters.push([col, val]);
        return builder;
      },
      in(col, vals) {
        inFilters.push([col, Array.isArray(vals) ? vals : []]);
        return builder;
      },
      order(col, { ascending = true } = {}) {
        orders.push({ col, ascending });
        return builder;
      },
      range(from, to) {
        rangeBounds = [from, to];
        return builder;
      },
      limit(n) {
        limitCount = n;
        return builder;
      },
      single() {
        return execute('single');
      },
      maybeSingle() {
        return execute('maybeSingle');
      },
      then(onFulfilled, onRejected) {
        return execute('many').then(onFulfilled, onRejected);
      },
    };

    return builder;
  }

  const supabaseClient = {
    auth: {
      async getUser(token) {
        const userId = tokens.get(token);
        if (!userId) {
          return { data: { user: null }, error: { message: 'Invalid token' } };
        }
        return { data: { user: { id: userId } }, error: null };
      },
    },
    from(tableName) {
      return createTableQueryBuilder(tableName);
    },
    async rpc(fnName, args = {}) {
      try {
        switch (fnName) {
          case 'jmcwc_check_student':
            return { data: jmcwc_check_student(args.p_student), error: null };
          case 'jmcwc_create_attempt':
            return { data: jmcwc_create_attempt(args), error: null };
          case 'jmcwc_act':
            return { data: jmcwc_act(args), error: null };
          case 'jmcwc_list':
            return { data: jmcwc_list(args), error: null };
          case 'jmcwc_finalize':
            jmcwc_finalize(args);
            return { data: null, error: null };
          case 'jmcwc_validate_marks':
            jmcwc_validate_marks(args.p_category, args.p_slot, args.p_question_marks);
            return { data: null, error: null };
          default:
            return { data: null, error: { message: `Unknown RPC: ${fnName}` } };
        }
      } catch (err) {
        return { data: null, error: { message: err.message } };
      }
    },
  };

  // Helper methods for test setup
  function seedUser({
    id = crypto.randomUUID(),
    token = `tok_${id}`,
    student_code = 'STU001',
    full_name = 'Test Student',
    role = 'student',
    level = 'Level 1',
    active = true,
    group_key = null,
  } = {}) {
    profiles.set(id, { id, student_code, full_name, role, level, active });
    tokens.set(token, id);
    if (group_key) {
      const row = jmcwc_assignment_guard(null, {
        student_id: id,
        group_key,
        updated_at: nowIso(),
      });
      jmcwc_assignments.set(id, row);
    }
    return { id, token };
  }

  function insertPaper({
    id = crypto.randomUUID(),
    group_key = 'junior1',
    version = '2026.1',
    spec = JUNIOR1_BLUEPRINT_2026_1,
    published = false,
  } = {}) {
    const row = jmcwc_paper_guard(null, {
      id,
      group_key,
      version,
      spec: structuredClone(spec),
      published: Boolean(published),
      created_at: nowIso(),
    });
    jmcwc_papers.set(id, row);
    return row;
  }

  function setPaperPublished(paperId, published) {
    const existing = jmcwc_papers.get(paperId);
    const updated = jmcwc_paper_guard(existing, {
      ...existing,
      published: Boolean(published),
    });
    jmcwc_papers.set(paperId, updated);
    return updated;
  }

  return {
    supabaseClient,
    advanceClockMs,
    seedUser,
    insertPaper,
    setPaperPublished,
    setFailNextFinalize(count = 1) {
      failNextFinalizeCount = count;
    },
    tables: {
      profiles,
      categories,
      jmcwc_categories,
      jmcwc_assignments,
      jmcwc_papers,
      jmcwc_targets,
      jmcwc_attempts,
      jmcwc_payloads,
      jmcwc_scores,
    },
  };
}

/**
 * Helper to invoke the Express-compatible handler and return `{ status, headers, body }`.
 */
async function callApi(handler, { method = 'POST', url = '/api/jmcwc', token = null, body = {} } = {}) {
  const headers = {};
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const resHeaders = {};
  let statusCode = 200;
  let jsonPayload = null;

  const req = {
    method,
    url,
    headers,
    body,
  };
  const res = {
    setHeader(k, v) {
      resHeaders[k.toLowerCase()] = v;
    },
    status(code) {
      statusCode = code;
      return res;
    },
    json(payload) {
      jsonPayload = payload;
      return res;
    },
  };

  await handler(req, res);
  return {
    status: statusCode,
    headers: resHeaders,
    body: jsonPayload,
  };
}

// ============================================================================
// Tests
// ============================================================================

test('Phase 17b — Authoritative Database Contract Snapshot (docs/JMCWC_DATABASE_CONTRACT.json)', () => {
  const contractPath = path.resolve(process.cwd(), 'docs/JMCWC_DATABASE_CONTRACT.json');
  assert.equal(fs.existsSync(contractPath), true, 'docs/JMCWC_DATABASE_CONTRACT.json must exist');

  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const tableNames = contract.tables.map((t) => t.name).sort();
  assert.deepEqual(tableNames, [
    'jmcwc_assignments',
    'jmcwc_attempts',
    'jmcwc_categories',
    'jmcwc_papers',
    'jmcwc_payloads',
    'jmcwc_scores',
    'jmcwc_targets',
  ]);

  const functionNames = contract.functions.map((f) => f.name).sort();
  assert.deepEqual(functionNames, [
    'jmcwc_act',
    'jmcwc_assignment_guard',
    'jmcwc_check_student',
    'jmcwc_create_attempt',
    'jmcwc_finalize',
    'jmcwc_list',
    'jmcwc_paper_guard',
    'jmcwc_tick',
    'jmcwc_validate_marks',
  ]);
});

test('Phase 17b — Staging Bootstrap Verbatim Parity with Contract Snapshot (supabase/tests/jmcwc_staging_bootstrap.sql)', () => {
  const bootstrapPath = path.resolve(process.cwd(), 'supabase/tests/jmcwc_staging_bootstrap.sql');
  assert.equal(fs.existsSync(bootstrapPath), true, 'supabase/tests/jmcwc_staging_bootstrap.sql must exist');

  const contractPath = path.resolve(process.cwd(), 'docs/JMCWC_DATABASE_CONTRACT.json');
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const bootstrapSql = fs.readFileSync(bootstrapPath, 'utf8');

  // 1. Every single function definition must occur verbatim
  for (const fn of contract.functions) {
    const verbatim = fn.definition.trim();
    assert.equal(
      bootstrapSql.includes(verbatim),
      true,
      `Bootstrap SQL is missing verbatim function definition for: ${fn.name}`
    );
  }

  // 2. Every constraint definition must occur verbatim
  for (const table of contract.tables) {
    for (const con of table.constraints) {
      assert.equal(
        bootstrapSql.includes(con.definition),
        true,
        `Bootstrap SQL is missing constraint ${con.name} (${con.definition}) for table ${table.name}`
      );
    }
  }

  // 3. Both triggers must occur verbatim
  assert.equal(
    bootstrapSql.includes('CREATE TRIGGER jmcwc_assignment_check BEFORE INSERT OR UPDATE ON public.jmcwc_assignments FOR EACH ROW EXECUTE FUNCTION public.jmcwc_assignment_guard()'),
    true,
    'jmcwc_assignment_check trigger missing'
  );
  assert.equal(
    bootstrapSql.includes('CREATE TRIGGER jmcwc_paper_check BEFORE INSERT OR UPDATE ON public.jmcwc_papers FOR EACH ROW EXECUTE FUNCTION public.jmcwc_paper_guard()'),
    true,
    'jmcwc_paper_check trigger missing'
  );

  // 4. Exactly 69 target rows seeded with NULL
  const nullTargets = (bootstrapSql.match(/, NULL\)/g) || []).length;
  assert.equal(nullTargets, 69, `Expected exactly 69 NULL target seeds, got ${nullTargets}`);

  // 5. Must NOT create a substitute auth schema or auth.users table (managed by Supabase)
  assert.equal(bootstrapSql.includes('CREATE SCHEMA IF NOT EXISTS auth;'), false);
  assert.equal(bootstrapSql.includes('CREATE TABLE IF NOT EXISTS auth.users'), false);
});

test('Phase 17b — 1. Authorization: unauthenticated, inactive, unassigned, cross-student, non-admin, and URL-token requests fail', async () => {
  const harness = createContractDatabaseHarness();
  const handler = createJmcwcServer({
    getSupabaseAdmin: () => harness.supabaseClient,
    seedGenerator: () => 202601,
  });

  const inactiveStudent = harness.seedUser({ active: false, group_key: 'junior1' });
  const unassignedStudent = harness.seedUser({ active: true, level: 'Senior', group_key: null });
  const studentA = harness.seedUser({ active: true, group_key: 'junior1' });
  const studentB = harness.seedUser({ active: true, group_key: 'junior1' });
  const adminUser = harness.seedUser({ role: 'admin', active: true });

  harness.insertPaper({ group_key: 'junior1', version: '2026.1', spec: JUNIOR1_BLUEPRINT_2026_1, published: true });

  // 1a. Missing token -> 401 + Cache-Control: no-store
  const unauthRes = await callApi(handler, { body: { action: 'status' } });
  assert.equal(unauthRes.status, 401);
  assert.equal(unauthRes.headers['cache-control'], 'no-store');

  // 1b. Token in URL query -> 400 (never allow tokens in URLs)
  const urlTokRes = await callApi(handler, {
    url: `/api/jmcwc?access_token=${studentA.token}`,
    token: studentA.token,
    body: { action: 'status' },
  });
  assert.equal(urlTokRes.status, 400);
  assert.equal(urlTokRes.body.code, 'TOKEN_IN_URL_FORBIDDEN');

  // 1c. Inactive student -> 403
  const inactiveRes = await callApi(handler, {
    token: inactiveStudent.token,
    body: { action: 'status' },
  });
  assert.equal(inactiveRes.status, 403);

  // 1d. Unassigned student: status returns blocked=true, group_key=null (never inferred from profiles.level!)
  const unassignedStatus = await callApi(handler, {
    token: unassignedStudent.token,
    body: { action: 'status' },
  });
  assert.equal(unassignedStatus.status, 200);
  assert.equal(unassignedStatus.body.assigned, false);
  assert.equal(unassignedStatus.body.group_key, null);
  assert.equal(unassignedStatus.body.blocked, true);

  // Unassigned student attempting create -> 403 GROUP_UNASSIGNED
  const unassignedCreate = await callApi(handler, {
    token: unassignedStudent.token,
    body: { action: 'create', request_id: crypto.randomUUID(), mode: 'flat' },
  });
  assert.equal(unassignedCreate.status, 403);
  assert.equal(unassignedCreate.body.code, 'GROUP_UNASSIGNED');

  // 1e. Student attempting admin action -> 403 ADMIN_REQUIRED
  const nonAdminRes = await callApi(handler, {
    token: studentA.token,
    body: { action: 'admin_get_overview' },
  });
  assert.equal(nonAdminRes.status, 403);
  assert.equal(nonAdminRes.body.code, 'ADMIN_REQUIRED');

  // 1f. Admin attempting student lifecycle action -> 403 INACTIVE_OR_NON_STUDENT
  const adminAsStudentRes = await callApi(handler, {
    token: adminUser.token,
    body: { action: 'create', request_id: crypto.randomUUID(), mode: 'flat' },
  });
  assert.equal(adminAsStudentRes.status, 403);
  assert.equal(adminAsStudentRes.body.code, 'INACTIVE_OR_NON_STUDENT');

  // 1g. Cross-student attempt access fails with 404 (even if client supplies student_id of studentA!)
  const createdA = await callApi(handler, {
    token: studentA.token,
    body: {
      action: 'create',
      request_id: crypto.randomUUID(),
      mode: 'category',
      category_key: 'addition',
    },
  });
  assert.equal(createdA.status, 200);
  const attemptIdA = createdA.body.attempt.id;

  const crossRead = await callApi(handler, {
    token: studentB.token,
    body: {
      action: 'read',
      student_id: studentA.id, // Spoofed student_id must be ignored
      attempt_id: attemptIdA,
    },
  });
  assert.equal(crossRead.status, 404);
  assert.equal(crossRead.body.code, 'ROUND_NOT_FOUND');
});

test('Phase 17b — 2, 3 & 4. Unpublished paper rejection, idempotent creation, and all 3 group blueprints validate marks', async () => {
  const harness = createContractDatabaseHarness();
  const handler = createJmcwcServer({
    getSupabaseAdmin: () => harness.supabaseClient,
    seedGenerator: () => 202602,
  });

  const sJ1 = harness.seedUser({ group_key: 'junior1' });
  const sJ2 = harness.seedUser({ group_key: 'junior2' });
  const sSr = harness.seedUser({ group_key: 'senior' });

  // Insert all 3 papers with published = false (matching owner's current production DB state)
  const pJ1 = harness.insertPaper({
    group_key: 'junior1',
    version: '2026.1',
    spec: JUNIOR1_BLUEPRINT_2026_1,
    published: false,
  });
  const pJ2 = harness.insertPaper({
    group_key: 'junior2',
    version: '2026.1',
    spec: JUNIOR2_BLUEPRINT_2026_1,
    published: false,
  });
  const pSr = harness.insertPaper({
    group_key: 'senior',
    version: '2026.1',
    spec: SENIOR_BLUEPRINT_2026_1,
    published: false,
  });

  // 2. Unpublished papers are rejected when creating student attempts
  for (const stu of [sJ1, sJ2, sSr]) {
    const res = await callApi(handler, {
      token: stu.token,
      body: { action: 'create', request_id: crypto.randomUUID(), mode: 'flat' },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'NO_PUBLISHED_PAPER');
  }

  // Publish all 3 papers in isolated staging harness (validates jmcwc_paper_guard + jmcwc_validate_marks on all 1,331 slots)
  harness.setPaperPublished(pJ1.id, true);
  harness.setPaperPublished(pJ2.id, true);
  harness.setPaperPublished(pSr.id, true);

  // 3. Idempotent creation returns the exact same attempt on retry with the same request_id
  const reqId = crypto.randomUUID();
  const create1 = await callApi(handler, {
    token: sJ1.token,
    body: { action: 'create', request_id: reqId, mode: 'flat' },
  });
  assert.equal(create1.status, 200);
  assert.equal(create1.body.idempotent_replay, false);
  assert.equal(create1.body.attempt.status, 'paused');

  const create2 = await callApi(handler, {
    token: sJ1.token,
    body: { action: 'create', request_id: reqId, mode: 'flat' },
  });
  assert.equal(create2.status, 200);
  assert.equal(create2.body.idempotent_replay, true);
  assert.equal(create2.body.attempt.id, create1.body.attempt.id);

  // 4. All 3 groups (junior1, junior2, senior) pass jmcwc_validate_marks & jmcwc_create_attempt for full flat papers
  const createJ2 = await callApi(handler, {
    token: sJ2.token,
    body: { action: 'create', request_id: crypto.randomUUID(), mode: 'flat' },
  });
  assert.equal(createJ2.status, 200);
  assert.ok(createJ2.body.attempt.max_marks > 0);

  const createSr = await callApi(handler, {
    token: sSr.token,
    body: { action: 'create', request_id: crypto.randomUUID(), mode: 'flat' },
  });
  assert.equal(createSr.status, 200);
  assert.ok(createSr.body.attempt.max_marks > 0);
});

test('Phase 17b — 5. Response whitelisting: never leak answer_key; list and paused responses never include questions, answers, or lease_id', async () => {
  const harness = createContractDatabaseHarness();
  const handler = createJmcwcServer({
    getSupabaseAdmin: () => harness.supabaseClient,
    seedGenerator: () => 202605,
  });

  const student = harness.seedUser({ group_key: 'junior1' });
  const paper = harness.insertPaper({
    group_key: 'junior1',
    version: '2026.1',
    spec: JUNIOR1_BLUEPRINT_2026_1,
    published: true,
  });
  assert.ok(paper.id);

  // Create attempt (starts in 'paused')
  const created = await callApi(handler, {
    token: student.token,
    body: {
      action: 'create',
      request_id: crypto.randomUUID(),
      mode: 'category',
      category_key: 'multiplication',
    },
  });
  assert.equal(created.status, 200);
  const attemptId = created.body.attempt.id;

  // Paused create response must omit questions, answers, and lease_id
  assert.equal('questions' in created.body.attempt, false);
  assert.equal('answers' in created.body.attempt, false);
  assert.equal('lease_id' in created.body.attempt, false);

  // Read while paused must omit questions, answers, and lease_id
  const readPaused = await callApi(handler, {
    token: student.token,
    body: { action: 'read', attempt_id: attemptId },
  });
  assert.equal(readPaused.status, 200);
  assert.equal(readPaused.body.attempt.status, 'paused');
  assert.equal('questions' in readPaused.body.attempt, false);
  assert.equal('answers' in readPaused.body.attempt, false);
  assert.equal('lease_id' in readPaused.body.attempt, false);

  // Resume explicitly -> returns lease_id, public questions (NO answer_key), and answers
  const resumed = await callApi(handler, {
    token: student.token,
    body: { action: 'resume', attempt_id: attemptId },
  });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.attempt.status, 'running');
  assert.ok(resumed.body.attempt.lease_id);
  assert.ok(Array.isArray(resumed.body.attempt.questions));
  assert.equal(resumed.body.attempt.questions.length, 20);
  for (const q of resumed.body.attempt.questions) {
    assert.equal('answer_key' in q, false, 'Public question must never expose answer_key');
    assert.equal('scoring_data' in q, false, 'Public question must never expose scoring_data');
  }

  // Read while running WITHOUT presenting matching lease_id must NOT leak lease_id, questions, or answers
  const readWithoutLease = await callApi(handler, {
    token: student.token,
    body: { action: 'read', attempt_id: attemptId },
  });
  assert.equal(readWithoutLease.status, 200);
  assert.equal(readWithoutLease.body.attempt.status, 'running');
  assert.equal(readWithoutLease.body.attempt.has_active_lease, true);
  assert.equal('lease_id' in readWithoutLease.body.attempt, false);
  assert.equal('questions' in readWithoutLease.body.attempt, false);
  assert.equal('answers' in readWithoutLease.body.attempt, false);

  // List response while running must omit questions, answers, and lease_id
  const listed = await callApi(handler, {
    token: student.token,
    body: { action: 'list' },
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.attempts.length, 1);
  assert.equal('questions' in listed.body.attempts[0], false);
  assert.equal('answers' in listed.body.attempts[0], false);
  assert.equal('lease_id' in listed.body.attempts[0], false);
});

test('Phase 17b — 6. Unfinished flat round cap (max 3), category rounds remain allowed, submitting frees slot', async () => {
  const harness = createContractDatabaseHarness();
  const handler = createJmcwcServer({
    getSupabaseAdmin: () => harness.supabaseClient,
    seedGenerator: () => 202606,
  });

  const student = harness.seedUser({ group_key: 'junior1' });
  harness.insertPaper({
    group_key: 'junior1',
    version: '2026.1',
    spec: JUNIOR1_BLUEPRINT_2026_1,
    published: true,
  });

  const flatIds = [];
  for (let i = 0; i < 3; i++) {
    const res = await callApi(handler, {
      token: student.token,
      body: { action: 'create', request_id: crypto.randomUUID(), mode: 'flat' },
    });
    assert.equal(res.status, 200);
    flatIds.push(res.body.attempt.id);
  }

  // 4th unfinished flat round is rejected with 409 FLAT_CAP_REACHED
  const fourthFlat = await callApi(handler, {
    token: student.token,
    body: { action: 'create', request_id: crypto.randomUUID(), mode: 'flat' },
  });
  assert.equal(fourthFlat.status, 409);
  assert.equal(fourthFlat.body.code, 'FLAT_CAP_REACHED');

  // Category round creation remains allowed even while 3 flat rounds are unfinished
  const catRes = await callApi(handler, {
    token: student.token,
    body: {
      action: 'create',
      request_id: crypto.randomUUID(),
      mode: 'category',
      category_key: 'addition',
    },
  });
  assert.equal(catRes.status, 200);

  // Resume and submit the 1st flat round -> frees a slot so a new flat round can be created
  const resResume = await callApi(handler, {
    token: student.token,
    body: { action: 'resume', attempt_id: flatIds[0] },
  });
  assert.equal(resResume.status, 200);

  const resSubmit = await callApi(handler, {
    token: student.token,
    body: {
      action: 'submit',
      attempt_id: flatIds[0],
      lease_id: resResume.body.attempt.lease_id,
    },
  });
  assert.equal(resSubmit.status, 200);
  assert.equal(resSubmit.body.attempt.status, 'submitted');

  const newFlatAfterSubmit = await callApi(handler, {
    token: student.token,
    body: { action: 'create', request_id: crypto.randomUUID(), mode: 'flat' },
  });
  assert.equal(newFlatAfterSubmit.status, 200);
});

test('Phase 17b — 7 & 8. Explicit takeover confirmation, lease rotation, stale lease rejection, save_seq ordering, and save-queue coordinator', async () => {
  const harness = createContractDatabaseHarness();
  const handler = createJmcwcServer({
    getSupabaseAdmin: () => harness.supabaseClient,
    seedGenerator: () => 202607,
  });

  const student = harness.seedUser({ group_key: 'junior1' });
  harness.insertPaper({
    group_key: 'junior1',
    version: '2026.1',
    spec: JUNIOR1_BLUEPRINT_2026_1,
    published: true,
  });

  const c1 = await callApi(handler, {
    token: student.token,
    body: {
      action: 'create',
      request_id: crypto.randomUUID(),
      mode: 'category',
      category_key: 'addition',
    },
  });
  const c2 = await callApi(handler, {
    token: student.token,
    body: {
      action: 'create',
      request_id: crypto.randomUUID(),
      mode: 'category',
      category_key: 'subtraction',
    },
  });
  const a1 = c1.body.attempt.id;
  const a2 = c2.body.attempt.id;

  // Resume round 1
  const r1 = await callApi(handler, {
    token: student.token,
    body: { action: 'resume', attempt_id: a1 },
  });
  assert.equal(r1.status, 200);
  const lease1 = r1.body.attempt.lease_id;
  const q1Id = r1.body.attempt.questions[0].id;
  const q2Id = r1.body.attempt.questions[1].id;

  // Attempting to resume round 2 without confirm_takeover -> 409 TAKEOVER_CONFIRMATION_REQUIRED
  const r2WithoutConfirm = await callApi(handler, {
    token: student.token,
    body: { action: 'resume', attempt_id: a2 },
  });
  assert.equal(r2WithoutConfirm.status, 409);
  assert.equal(r2WithoutConfirm.body.code, 'TAKEOVER_CONFIRMATION_REQUIRED');
  assert.equal(r2WithoutConfirm.body.running_attempt_id, a1);

  // Round 1 is still running and accepts saves with lease1
  const saveSeq1 = await callApi(handler, {
    token: student.token,
    body: {
      action: 'save',
      attempt_id: a1,
      lease_id: lease1,
      save_seq: 1,
      answers: { [q1Id]: '100' },
    },
  });
  assert.equal(saveSeq1.status, 200);
  assert.equal(saveSeq1.body.attempt.answers[q1Id], '100');
  assert.equal(saveSeq1.body.attempt.save_seq, 1);

  // Out-of-order/duplicate save_seq (save_seq = 0 or 1) is safely ignored without overwriting '100'
  const staleSeqSave = await callApi(handler, {
    token: student.token,
    body: {
      action: 'save',
      attempt_id: a1,
      lease_id: lease1,
      save_seq: 0,
      answers: { [q1Id]: '999' },
    },
  });
  assert.equal(staleSeqSave.status, 200);
  assert.equal(staleSeqSave.body.attempt.answers[q1Id], '100');
  assert.equal(staleSeqSave.body.attempt.save_seq, 1);

  // Invalid question ID in save patch is rejected with 400
  const badQuestionSave = await callApi(handler, {
    token: student.token,
    body: {
      action: 'save',
      attempt_id: a1,
      lease_id: lease1,
      save_seq: 2,
      answers: { nonexistent_question_id: '42' },
    },
  });
  assert.equal(badQuestionSave.status, 400);

  // Resume round 2 WITH confirm_takeover: true -> pauses round 1 and issues a lease for round 2
  harness.advanceClockMs(5000);
  const r2Confirmed = await callApi(handler, {
    token: student.token,
    body: { action: 'resume', attempt_id: a2, confirm_takeover: true },
  });
  assert.equal(r2Confirmed.status, 200);
  assert.equal(r2Confirmed.body.attempt.status, 'running');

  // Round 1 is now paused; old lease1 is invalid
  const read1AfterTakeover = await callApi(handler, {
    token: student.token,
    body: { action: 'read', attempt_id: a1 },
  });
  assert.equal(read1AfterTakeover.body.attempt.status, 'paused');

  // If round 1 is resumed again (with confirm_takeover: true), it gets a brand-new lease2 != lease1
  const r1Again = await callApi(handler, {
    token: student.token,
    body: { action: 'resume', attempt_id: a1, confirm_takeover: true },
  });
  assert.equal(r1Again.status, 200);
  const lease2 = r1Again.body.attempt.lease_id;
  assert.notEqual(lease2, lease1);
  assert.equal(r1Again.body.attempt.save_seq, -1);

  // Stale save from old tab with lease1 is rejected with 409 LEASE_MISMATCH
  const staleTabSave = await callApi(handler, {
    token: student.token,
    body: {
      action: 'save',
      attempt_id: a1,
      lease_id: lease1,
      save_seq: 2,
      answers: { [q1Id]: 'spoof' },
    },
  });
  assert.equal(staleTabSave.status, 409);
  assert.equal(staleTabSave.body.code, 'LEASE_MISMATCH');

  // Test Save Queue Coordinator: single request in flight, coalescing, same-seq retry on transient failure
  const sentCalls = [];
  let failFirstAttempt = true;
  const queue = createJmcwcSaveQueue({
    async sendSave(payload) {
      sentCalls.push(structuredClone(payload));
      if (failFirstAttempt) {
        failFirstAttempt = false;
        const err = new Error('Network glitch');
        err.statusCode = 503;
        throw err;
      }
      const res = await callApi(handler, {
        token: student.token,
        body: {
          action: 'save',
          ...payload,
        },
      });
      return res.body;
    },
  });

  queue.startSession({ attempt_id: a1, lease_id: lease2 });
  queue.queueAnswer(q1Id, '111');
  queue.queueAnswer(q2Id, '222');

  // First flush fails transiently at seq=0
  await assert.rejects(() => queue.flush(), /Network glitch/);
  assert.equal(sentCalls.length, 1);
  assert.equal(sentCalls[0].save_seq, 0);
  assert.deepEqual(sentCalls[0].answers, { [q1Id]: '111', [q2Id]: '222' });

  // Queue another edit while retry is pending; next flush must retry seq=0 FIRST, then send seq=1!
  queue.queueAnswer(q1Id, '333');
  await queue.flush();

  assert.equal(sentCalls.length, 3);
  assert.equal(sentCalls[1].save_seq, 0);
  assert.deepEqual(sentCalls[1].answers, { [q1Id]: '111', [q2Id]: '222' });
  assert.equal(sentCalls[2].save_seq, 1);
  assert.deepEqual(sentCalls[2].answers, { [q1Id]: '333' });
});

test('Phase 17b — 9 & 10. Heartbeat >25s gap auto-pauses at last confirmed heartbeat; 2-hour flat timer expires to grading, rejects post-expiry edits, and finalizes', async () => {
  const harness = createContractDatabaseHarness();
  const handler = createJmcwcServer({
    getSupabaseAdmin: () => harness.supabaseClient,
    seedGenerator: () => 202609,
  });

  const student = harness.seedUser({ group_key: 'junior1' });
  harness.insertPaper({
    group_key: 'junior1',
    version: '2026.1',
    spec: JUNIOR1_BLUEPRINT_2026_1,
    published: true,
  });

  const created = await callApi(handler, {
    token: student.token,
    body: { action: 'create', request_id: crypto.randomUUID(), mode: 'flat' },
  });
  const attemptId = created.body.attempt.id;

  const resumed = await callApi(handler, {
    token: student.token,
    body: { action: 'resume', attempt_id: attemptId },
  });
  const lease1 = resumed.body.attempt.lease_id;
  const firstQuestionId = resumed.body.attempt.questions[0].id;

  // Two 10-second heartbeats advance active_ms to 20,000 ms
  harness.advanceClockMs(10_000);
  const hb1 = await callApi(handler, {
    token: student.token,
    body: { action: 'heartbeat', attempt_id: attemptId, lease_id: lease1 },
  });
  assert.equal(hb1.status, 200);
  assert.equal(hb1.body.attempt.active_ms, 10_000);

  harness.advanceClockMs(10_000);
  const hb2 = await callApi(handler, {
    token: student.token,
    body: {
      action: 'save',
      attempt_id: attemptId,
      lease_id: lease1,
      save_seq: 0,
      answers: { [firstQuestionId]: '123' },
    },
  });
  assert.equal(hb2.status, 200);
  assert.equal(hb2.body.attempt.active_ms, 20_000);

  // 9. Advance clock by 30,000 ms (> 25,000 ms threshold) -> next heartbeat/read pauses at 20,000 ms!
  harness.advanceClockMs(30_000);
  const lateHb = await callApi(handler, {
    token: student.token,
    body: { action: 'heartbeat', attempt_id: attemptId, lease_id: lease1 },
  });
  assert.equal(lateHb.status, 409);
  assert.equal(lateHb.body.code, 'SESSION_PAUSED');
  assert.equal(lateHb.body.attempt.status, 'paused');
  assert.equal(lateHb.body.attempt.active_ms, 20_000);

  // 10. Resume and advance active_ms to 7,195,000 ms, then tick 10,000 ms past the 7,200,000 ms (2-hour) cap
  const resumedAgain = await callApi(handler, {
    token: student.token,
    body: { action: 'resume', attempt_id: attemptId },
  });
  const lease2 = resumedAgain.body.attempt.lease_id;

  // Directly set active_ms to 7,195,000 ms (5 seconds before 2-hour cap) to test boundary transition
  harness.tables.jmcwc_attempts.get(attemptId).active_ms = 7_195_000;
  harness.advanceClockMs(10_000);

  // Send a post-expiry save attempt: jmcwc_tick transitions to 'grading' at 7,200,000 ms BEFORE save applies,
  // rejects the late answer edit ('999999'), and finalizes with the frozen pre-expiry answer ('123')!
  const postExpirySave = await callApi(handler, {
    token: student.token,
    body: {
      action: 'save',
      attempt_id: attemptId,
      lease_id: lease2,
      save_seq: 0,
      answers: { [firstQuestionId]: '999999' },
    },
  });
  assert.equal(postExpirySave.status, 200);
  assert.equal(postExpirySave.body.expired, true);
  assert.equal(postExpirySave.body.attempt.status, 'submitted');
  assert.equal(postExpirySave.body.attempt.submitted_reason, 'time_limit');
  assert.equal(postExpirySave.body.attempt.active_ms, 7_200_000);
  // Post-expiry answer '999999' was rejected; pre-expiry answer '123' was preserved!
  assert.equal(postExpirySave.body.attempt.answers[firstQuestionId], '123');
  assert.ok(postExpirySave.body.attempt.score);
});

test('Phase 17b — 11 & 12. Early submission, server-side grading from private payload, and idempotent finalize retry after failure', async () => {
  const harness = createContractDatabaseHarness();
  const handler = createJmcwcServer({
    getSupabaseAdmin: () => harness.supabaseClient,
    seedGenerator: () => 202611,
  });

  const student = harness.seedUser({ group_key: 'junior1' });
  harness.insertPaper({
    group_key: 'junior1',
    version: '2026.1',
    spec: JUNIOR1_BLUEPRINT_2026_1,
    published: true,
  });

  const created = await callApi(handler, {
    token: student.token,
    body: {
      action: 'create',
      request_id: crypto.randomUUID(),
      mode: 'category',
      category_key: 'inexact_square_root',
    },
  });
  const attemptId = created.body.attempt.id;

  const resumed = await callApi(handler, {
    token: student.token,
    body: { action: 'resume', attempt_id: attemptId },
  });
  const leaseId = resumed.body.attempt.lease_id;

  // Inspect private payload in DB to construct 1 exact answer, 1 excess-precision partial answer, 1 wrong answer
  const privateQs = harness.tables.jmcwc_payloads.get(attemptId).questions;
  const q0 = privateQs[0];
  const q1 = privateQs[1];
  const q2 = privateQs[2];

  const correctAns0 = q0.answer_key.expected_display;
  // Excess precision for q1: compute 1 extra decimal place from scaled_floor
  const dropExtra = Number(q1.answer_key.scale) - (Number(q1.answer_key.target_decimals) + 1);
  const divExtra = 10n ** BigInt(dropExtra);
  const sf1 = BigInt(q1.answer_key.scaled_floor);
  const unitsExtra = (sf1 + divExtra / 2n) / divExtra;
  const decimalsExtra = Number(q1.answer_key.target_decimals) + 1;
  const sExtra = unitsExtra.toString().padStart(decimalsExtra + 1, '0');
  const partialAns1 = `${sExtra.slice(0, sExtra.length - decimalsExtra)}.${sExtra.slice(sExtra.length - decimalsExtra)}`;

  // 12. Simulate transient failure in jmcwc_finalize on first submit attempt
  harness.setFailNextFinalize(1);
  harness.advanceClockMs(4000);

  const failedSubmit = await callApi(handler, {
    token: student.token,
    body: {
      action: 'submit',
      attempt_id: attemptId,
      lease_id: leaseId,
      save_seq: 0,
      answers: {
        [q0.id]: correctAns0,
        [q1.id]: partialAns1,
        [q2.id]: '999999.9',
      },
    },
  });
  assert.equal(failedSubmit.status, 500);

  // Verify the attempt is safely frozen in 'grading' state with the flushed answers
  const dbAttemptWhileGrading = harness.tables.jmcwc_attempts.get(attemptId);
  assert.equal(dbAttemptWhileGrading.status, 'grading');
  assert.equal(dbAttemptWhileGrading.submitted_reason, 'early');
  assert.equal(dbAttemptWhileGrading.answers[q0.id], correctAns0);

  // Retrying submit (or read) settles the 'grading' attempt idempotently via jmcwc_finalize
  const retrySubmit = await callApi(handler, {
    token: student.token,
    body: {
      action: 'submit',
      attempt_id: attemptId,
    },
  });
  assert.equal(retrySubmit.status, 200);
  assert.equal(retrySubmit.body.attempt.status, 'submitted');
  assert.equal(retrySubmit.body.attempt.score.correct, 1);
  assert.equal(retrySubmit.body.attempt.score.partial, 1);
  assert.equal(retrySubmit.body.attempt.score.wrong, 1);
  assert.equal(retrySubmit.body.attempt.score.skipped, privateQs.length - 3);
  assert.equal(
    retrySubmit.body.attempt.score.marks,
    Number(q0.max_marks) + Number(q1.max_marks) / 2
  );
  assert.equal(retrySubmit.body.attempt.review.length, privateQs.length);
});

test('Phase 17b — 13. Admin operations: group assignment guard with unfinished attempts, targets, round-category mapping, papers, and history', async () => {
  const harness = createContractDatabaseHarness();
  const handler = createJmcwcServer({
    getSupabaseAdmin: () => harness.supabaseClient,
    seedGenerator: () => 202613,
  });

  const admin = harness.seedUser({ role: 'admin', active: true });
  const student = harness.seedUser({
    student_code: 'STU099',
    full_name: 'Alice MentalMath',
    role: 'student',
    level: 'Senior',
    group_key: null,
  });

  harness.insertPaper({
    group_key: 'junior1',
    version: '2026.1',
    spec: JUNIOR1_BLUEPRINT_2026_1,
    published: true,
  });
  harness.insertPaper({
    group_key: 'junior2',
    version: '2026.1',
    spec: JUNIOR2_BLUEPRINT_2026_1,
    published: false,
  });

  // Seed legacy categories (1 round, 1 non-round)
  const roundCatId = crypto.randomUUID();
  const testCatId = crypto.randomUUID();
  harness.tables.categories.set(roundCatId, {
    id: roundCatId,
    name: 'Legacy Addition Round',
    section: 'round',
  });
  harness.tables.categories.set(testCatId, {
    id: testCatId,
    name: 'Legacy Weekly Test',
    section: 'complete_test',
  });

  // 13a. Admin overview does not infer group_key from profiles.level
  const overview1 = await callApi(handler, {
    token: admin.token,
    body: { action: 'admin_get_overview' },
  });
  assert.equal(overview1.status, 200);
  const stuSummary1 = overview1.body.students.find((s) => s.id === student.id);
  assert.equal(stuSummary1.group_key, null);

  // 13b. Admin assigns student to junior1
  const setAssign1 = await callApi(handler, {
    token: admin.token,
    body: {
      action: 'admin_set_assignment',
      student_id: student.id,
      group_key: 'junior1',
    },
  });
  assert.equal(setAssign1.status, 200);
  assert.equal(setAssign1.body.assignment.group_key, 'junior1');

  // 13c. Admin sets optional target_seconds = 180 for (junior1, addition)
  const setTarget = await callApi(handler, {
    token: admin.token,
    body: {
      action: 'admin_set_target',
      group_key: 'junior1',
      category_key: 'addition',
      target_seconds: 180,
    },
  });
  assert.equal(setTarget.status, 200);
  assert.equal(setTarget.body.target.target_seconds, 180);

  // Student creates an addition category attempt -> snapshots target_seconds = 180
  const stuCreate = await callApi(handler, {
    token: student.token,
    body: {
      action: 'create',
      request_id: crypto.randomUUID(),
      mode: 'category',
      category_key: 'addition',
    },
  });
  assert.equal(stuCreate.status, 200);
  assert.equal(stuCreate.body.attempt.target_seconds, 180);
  const attemptId = stuCreate.body.attempt.id;

  // 13d. Admin tries to change student's group to junior2 while unfinished attempt exists -> blocked with 409!
  const blockedGroupChange = await callApi(handler, {
    token: admin.token,
    body: {
      action: 'admin_set_assignment',
      student_id: student.id,
      group_key: 'junior2',
    },
  });
  assert.equal(blockedGroupChange.status, 409);
  assert.equal(blockedGroupChange.body.code, 'UNFINISHED_ATTEMPTS_EXIST');

  // Student resumes and submits the unfinished attempt
  const stuResume = await callApi(handler, {
    token: student.token,
    body: { action: 'resume', attempt_id: attemptId },
  });
  await callApi(handler, {
    token: student.token,
    body: {
      action: 'submit',
      attempt_id: attemptId,
      lease_id: stuResume.body.attempt.lease_id,
    },
  });

  // Now admin can change student's group to junior2
  const allowedGroupChange = await callApi(handler, {
    token: admin.token,
    body: {
      action: 'admin_set_assignment',
      student_id: student.id,
      group_key: 'junior2',
    },
  });
  assert.equal(allowedGroupChange.status, 200);
  assert.equal(allowedGroupChange.body.assignment.group_key, 'junior2');

  // 13e. Legacy category mapping rejects non-round category and accepts section='round' category
  const badMapping = await callApi(handler, {
    token: admin.token,
    body: {
      action: 'admin_set_category_mapping',
      category_key: 'addition',
      legacy_category_id: testCatId,
    },
  });
  assert.equal(badMapping.status, 400);
  assert.equal(badMapping.body.code, 'INVALID_LEGACY_CATEGORY_SECTION');

  const goodMapping = await callApi(handler, {
    token: admin.token,
    body: {
      action: 'admin_set_category_mapping',
      category_key: 'addition',
      legacy_category_id: roundCatId,
    },
  });
  assert.equal(goodMapping.status, 200);
  assert.equal(goodMapping.body.category.legacy_category_id, roundCatId);

  // 13f. Admin attempt history and completed attempt review
  const adminHistory = await callApi(handler, {
    token: admin.token,
    body: { action: 'admin_list_attempts', student_id: student.id },
  });
  assert.equal(adminHistory.status, 200);
  assert.equal(adminHistory.body.attempts.length, 1);
  assert.equal(adminHistory.body.attempts[0].id, attemptId);

  const adminReview = await callApi(handler, {
    token: admin.token,
    body: { action: 'admin_get_attempt_review', attempt_id: attemptId },
  });
  assert.equal(adminReview.status, 200);
  assert.equal(adminReview.body.attempt.status, 'submitted');
  assert.ok(Array.isArray(adminReview.body.attempt.review));
});

test('Phase 17b — Rate limiter allows 10-second heartbeats while capping abusive bursts', () => {
  let now = 1_000_000;
  const limiter = createJmcwcRateLimiter({
    windowMs: 60_000,
    maxHighFreq: 120,
    maxStandard: 5,
    nowFn: () => now,
  });

  // 6 heartbeats per minute (every 10s) plus saves easily pass within the 120/min high-frequency bucket
  for (let i = 0; i < 60; i++) {
    limiter.checkLimit('stu-1', 'heartbeat');
    limiter.checkLimit('stu-1', 'save');
  }

  // Standard bucket caps at maxStandard (5)
  for (let i = 0; i < 5; i++) {
    limiter.checkLimit('stu-1', 'create');
  }
  assert.throws(() => limiter.checkLimit('stu-1', 'create'), /Too many JMCWC requests/);

  // Advancing past the 60s window resets the bucket
  now += 61_000;
  assert.doesNotThrow(() => limiter.checkLimit('stu-1', 'create'));
});
