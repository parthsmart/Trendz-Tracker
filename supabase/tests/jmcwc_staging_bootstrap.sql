-- =============================================================================
-- Trendz Tracker — JMCWC Simulator Staging Database Bootstrap SQL
-- File: supabase/tests/jmcwc_staging_bootstrap.sql
-- Source: Authoritative Deployed Database Contract (docs/JMCWC_DATABASE_CONTRACT.json)
-- VERIFICATION: Automated generation guarantees 100% verbatim parity with the
--               authoritative deployed contract snapshot.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- PART 1: MINIMAL DEPENDENCIES (FOR SQL REGRESSION TESTING ONLY)
-- WARNING: These minimal stubs satisfy the foreign key and column invariants
-- needed by JMCWC tables and the SQL regression test suite.
-- They DO NOT represent the full application schema (avatars, levels,
-- attendance, audit logs, legacy drill categories, etc.) and are UNSUITABLE
-- for full application or browser-based staging testing.
-- In a fresh Supabase project, auth.users is already managed by Supabase Auth.
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  student_code text UNIQUE,
  full_name text,
  role text NOT NULL DEFAULT 'student',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE
);

-- -----------------------------------------------------------------------------
-- PART 2: THE SEVEN JMCWC SIMULATOR TABLES (FROM CONTRACT SNAPSHOT)
-- -----------------------------------------------------------------------------

-- Table: public.jmcwc_categories
CREATE TABLE IF NOT EXISTS public.jmcwc_categories (
  key text NOT NULL,
  label text NOT NULL,
  workbook_sheet text NOT NULL,
  "position" integer NOT NULL,
  legacy_category_id uuid,
  CONSTRAINT jmcwc_categories_legacy_category_id_fkey FOREIGN KEY (legacy_category_id) REFERENCES categories(id) ON DELETE SET NULL,
  CONSTRAINT jmcwc_categories_pkey PRIMARY KEY (key),
  CONSTRAINT jmcwc_categories_position_key UNIQUE ("position")
);

-- Table: public.jmcwc_papers
CREATE TABLE IF NOT EXISTS public.jmcwc_papers (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  group_key text NOT NULL,
  version text NOT NULL,
  spec jsonb NOT NULL,
  published boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT jmcwc_papers_group_key_check CHECK (group_key = ANY (ARRAY['junior1'::text, 'junior2'::text, 'senior'::text])),
  CONSTRAINT jmcwc_papers_group_key_version_key UNIQUE (group_key, version),
  CONSTRAINT jmcwc_papers_pkey PRIMARY KEY (id),
  CONSTRAINT jmcwc_papers_spec_check CHECK (jsonb_typeof(spec) = 'object'::text)
);

-- Table: public.jmcwc_assignments
CREATE TABLE IF NOT EXISTS public.jmcwc_assignments (
  student_id uuid NOT NULL,
  group_key text NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT jmcwc_assignments_group_key_check CHECK (group_key = ANY (ARRAY['junior1'::text, 'junior2'::text, 'senior'::text])),
  CONSTRAINT jmcwc_assignments_pkey PRIMARY KEY (student_id),
  CONSTRAINT jmcwc_assignments_student_id_fkey FOREIGN KEY (student_id) REFERENCES profiles(id) ON DELETE CASCADE
);

-- Table: public.jmcwc_targets
CREATE TABLE IF NOT EXISTS public.jmcwc_targets (
  group_key text NOT NULL,
  category_key text NOT NULL,
  target_seconds integer,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT jmcwc_targets_category_key_fkey FOREIGN KEY (category_key) REFERENCES jmcwc_categories(key),
  CONSTRAINT jmcwc_targets_group_key_check CHECK (group_key = ANY (ARRAY['junior1'::text, 'junior2'::text, 'senior'::text])),
  CONSTRAINT jmcwc_targets_pkey PRIMARY KEY (group_key, category_key),
  CONSTRAINT jmcwc_targets_target_seconds_check CHECK (target_seconds > 0 AND target_seconds <= 86400)
);

-- Table: public.jmcwc_attempts
CREATE TABLE IF NOT EXISTS public.jmcwc_attempts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL,
  request_id uuid NOT NULL,
  paper_id uuid NOT NULL,
  group_key text NOT NULL,
  mode text NOT NULL,
  category_key text,
  status text NOT NULL DEFAULT 'paused'::text,
  active_ms bigint NOT NULL DEFAULT 0,
  target_seconds integer,
  last_seen_at timestamp with time zone,
  lease_id uuid,
  save_seq bigint NOT NULL DEFAULT '-1'::integer,
  revision bigint NOT NULL DEFAULT 0,
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  finished_at timestamp with time zone,
  submitted_reason text,
  CONSTRAINT jmcwc_attempts_active_ms_check CHECK (active_ms >= 0),
  CONSTRAINT jmcwc_attempts_answers_check CHECK (jsonb_typeof(answers) = 'object'::text),
  CONSTRAINT jmcwc_attempts_category_key_fkey FOREIGN KEY (category_key) REFERENCES jmcwc_categories(key),
  CONSTRAINT jmcwc_attempts_check CHECK (mode = 'flat'::text AND category_key IS NULL AND target_seconds IS NULL AND active_ms <= 7200000 OR mode = 'category'::text AND category_key IS NOT NULL),
  CONSTRAINT jmcwc_attempts_group_key_check CHECK (group_key = ANY (ARRAY['junior1'::text, 'junior2'::text, 'senior'::text])),
  CONSTRAINT jmcwc_attempts_mode_check CHECK (mode = ANY (ARRAY['flat'::text, 'category'::text])),
  CONSTRAINT jmcwc_attempts_paper_id_fkey FOREIGN KEY (paper_id) REFERENCES jmcwc_papers(id),
  CONSTRAINT jmcwc_attempts_pkey PRIMARY KEY (id),
  CONSTRAINT jmcwc_attempts_status_check CHECK (status = ANY (ARRAY['paused'::text, 'running'::text, 'grading'::text, 'submitted'::text])),
  CONSTRAINT jmcwc_attempts_student_id_fkey FOREIGN KEY (student_id) REFERENCES profiles(id) ON DELETE CASCADE,
  CONSTRAINT jmcwc_attempts_student_id_request_id_key UNIQUE (student_id, request_id),
  CONSTRAINT jmcwc_attempts_submitted_reason_check CHECK (submitted_reason = ANY (ARRAY['early'::text, 'time_limit'::text])),
  CONSTRAINT jmcwc_attempts_target_seconds_check CHECK (target_seconds > 0)
);

-- Table: public.jmcwc_payloads
CREATE TABLE IF NOT EXISTS public.jmcwc_payloads (
  attempt_id uuid NOT NULL,
  questions jsonb NOT NULL,
  CONSTRAINT jmcwc_payloads_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES jmcwc_attempts(id) ON DELETE CASCADE,
  CONSTRAINT jmcwc_payloads_pkey PRIMARY KEY (attempt_id),
  CONSTRAINT jmcwc_payloads_questions_check CHECK (jsonb_typeof(questions) = 'array'::text)
);

-- Table: public.jmcwc_scores
CREATE TABLE IF NOT EXISTS public.jmcwc_scores (
  attempt_id uuid NOT NULL,
  marks numeric NOT NULL,
  max_marks numeric NOT NULL,
  correct integer NOT NULL,
  partial integer NOT NULL,
  wrong integer NOT NULL,
  skipped integer NOT NULL,
  items jsonb NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT jmcwc_scores_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES jmcwc_attempts(id) ON DELETE CASCADE,
  CONSTRAINT jmcwc_scores_check CHECK (max_marks > 0::numeric AND marks <= max_marks),
  CONSTRAINT jmcwc_scores_correct_check CHECK (correct >= 0),
  CONSTRAINT jmcwc_scores_items_check CHECK (jsonb_typeof(items) = 'array'::text),
  CONSTRAINT jmcwc_scores_marks_check CHECK (marks >= 0::numeric),
  CONSTRAINT jmcwc_scores_partial_check CHECK (partial >= 0),
  CONSTRAINT jmcwc_scores_pkey PRIMARY KEY (attempt_id),
  CONSTRAINT jmcwc_scores_skipped_check CHECK (skipped >= 0),
  CONSTRAINT jmcwc_scores_wrong_check CHECK (wrong >= 0)
);

-- -----------------------------------------------------------------------------
-- PART 3: INDEXES (VERBATIM FROM CONTRACT SNAPSHOT)
-- -----------------------------------------------------------------------------
CREATE INDEX jmcwc_attempts_student_history ON public.jmcwc_attempts USING btree (student_id, created_at DESC);
CREATE UNIQUE INDEX jmcwc_one_running ON public.jmcwc_attempts USING btree (student_id) WHERE (status = 'running'::text);

-- -----------------------------------------------------------------------------
-- PART 4: ROW LEVEL SECURITY & PERMISSIONS (SERVER-ONLY ACCESS)
-- -----------------------------------------------------------------------------
ALTER TABLE public.jmcwc_categories ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.jmcwc_categories FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.jmcwc_categories TO postgres, service_role;
ALTER TABLE public.jmcwc_papers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.jmcwc_papers FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.jmcwc_papers TO postgres, service_role;
ALTER TABLE public.jmcwc_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.jmcwc_assignments FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.jmcwc_assignments TO postgres, service_role;
ALTER TABLE public.jmcwc_targets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.jmcwc_targets FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.jmcwc_targets TO postgres, service_role;
ALTER TABLE public.jmcwc_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.jmcwc_attempts FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.jmcwc_attempts TO postgres, service_role;
ALTER TABLE public.jmcwc_payloads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.jmcwc_payloads FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.jmcwc_payloads TO postgres, service_role;
ALTER TABLE public.jmcwc_scores ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.jmcwc_scores FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.jmcwc_scores TO postgres, service_role;

-- -----------------------------------------------------------------------------
-- PART 5: ALL NINE FUNCTIONS (VERBATIM FROM CONTRACT SNAPSHOT)
-- -----------------------------------------------------------------------------

-- Function: public.jmcwc_act
CREATE OR REPLACE FUNCTION public.jmcwc_act(p_student uuid, p_attempt uuid, p_action text, p_lease uuid DEFAULT NULL::uuid, p_seq bigint DEFAULT NULL::bigint, p_answers jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  a public.jmcwc_attempts;
  other uuid;
  g text;
  entry record;
  token uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_student::text,172026)
  );

  g:=public.jmcwc_check_student(p_student);

  SELECT * INTO a
  FROM public.jmcwc_attempts
  WHERE id=p_attempt AND student_id=p_student
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Round not found.';
  END IF;

  IF a.group_key<>g AND a.status<>'submitted' THEN
    RAISE EXCEPTION
      'This round belongs to a different assigned group.';
  END IF;

  IF p_action NOT IN (
    'read','resume','save','heartbeat','pause','submit'
  ) OR p_action IS NULL
  THEN
    RAISE EXCEPTION 'Unknown action.';
  END IF;

  IF p_action IN ('save','heartbeat','pause','submit')
     AND a.status='running'
     AND (p_lease IS NULL OR p_lease IS DISTINCT FROM a.lease_id)
  THEN
    RAISE EXCEPTION 'Session changed. Reload this round.';
  END IF;

  PERFORM public.jmcwc_tick(a.id);

  SELECT * INTO a
  FROM public.jmcwc_attempts
  WHERE id=a.id;

  IF a.status IN ('grading','submitted') THEN
    RETURN to_jsonb(a);
  END IF;

  IF p_action='resume' THEN
    FOR other IN
      SELECT id
      FROM public.jmcwc_attempts
      WHERE student_id=p_student AND status='running'
    LOOP
      PERFORM public.jmcwc_tick(other);

      UPDATE public.jmcwc_attempts
      SET status='paused',
          lease_id=NULL,
          last_seen_at=NULL,
          revision=revision+1
      WHERE id=other AND status='running';
    END LOOP;

    SELECT status INTO a.status
    FROM public.jmcwc_attempts
    WHERE id=a.id;

    IF a.status='grading' THEN
      SELECT * INTO a
      FROM public.jmcwc_attempts
      WHERE id=a.id;

      RETURN to_jsonb(a);
    END IF;

    token:=gen_random_uuid();

    UPDATE public.jmcwc_attempts
    SET status='running',
        lease_id=token,
        save_seq=-1,
        last_seen_at=clock_timestamp(),
        revision=revision+1
    WHERE id=a.id;

  ELSIF p_action IN ('save','heartbeat','pause','submit') THEN
    IF a.status<>'running' THEN
      RETURN to_jsonb(a);
    END IF;

    IF p_answers IS NOT NULL THEN
      IF jsonb_typeof(p_answers)<>'object'
         OR octet_length(p_answers::text)>250000
         OR p_seq IS NULL
         OR p_seq<0
      THEN
        RAISE EXCEPTION 'Invalid answer patch.';
      END IF;

      IF p_seq>a.save_seq THEN
        FOR entry IN
          SELECT * FROM jsonb_each(p_answers)
        LOOP
          IF jsonb_typeof(entry.value) NOT IN ('string','null')
             OR octet_length(entry.value::text)>4000
             OR NOT EXISTS (
               SELECT 1
               FROM public.jmcwc_payloads pp
               CROSS JOIN LATERAL
                 jsonb_array_elements(pp.questions) q
               WHERE pp.attempt_id=a.id
                 AND q->>'id'=entry.key
             )
          THEN
            RAISE EXCEPTION 'Invalid question or answer.';
          END IF;
        END LOOP;

        UPDATE public.jmcwc_attempts
        SET answers=answers||p_answers,
            save_seq=p_seq,
            revision=revision+1
        WHERE id=a.id;
      END IF;
    END IF;

    IF p_action='pause' THEN
      UPDATE public.jmcwc_attempts
      SET status='paused',
          lease_id=NULL,
          last_seen_at=NULL,
          revision=revision+1
      WHERE id=a.id;

    ELSIF p_action='submit' THEN
      UPDATE public.jmcwc_attempts
      SET status='grading',
          lease_id=NULL,
          last_seen_at=NULL,
          finished_at=clock_timestamp(),
          submitted_reason='early',
          revision=revision+1
      WHERE id=a.id;
    END IF;
  END IF;

  SELECT * INTO a
  FROM public.jmcwc_attempts
  WHERE id=a.id;

  RETURN to_jsonb(a);
END $function$;

-- Function: public.jmcwc_assignment_guard
CREATE OR REPLACE FUNCTION public.jmcwc_assignment_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.student_id::text,172026)
  );

  IF TG_OP='UPDATE'
     AND NEW.group_key IS DISTINCT FROM OLD.group_key
     AND EXISTS (
       SELECT 1
       FROM public.jmcwc_attempts
       WHERE student_id=OLD.student_id
         AND status<>'submitted'
     )
  THEN
    RAISE EXCEPTION
      'Complete this student''s unfinished simulator attempts before changing group.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id=NEW.student_id AND role='student'
  )
  THEN
    RAISE EXCEPTION 'Assign a student account only.';
  END IF;

  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END $function$;

-- Function: public.jmcwc_check_student
CREATE OR REPLACE FUNCTION public.jmcwc_check_student(p_student uuid)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  g text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id=p_student AND role='student' AND active
  )
  THEN
    RAISE EXCEPTION 'An active student account is required.';
  END IF;

  SELECT group_key INTO g
  FROM public.jmcwc_assignments
  WHERE student_id=p_student;

  IF g IS NULL THEN
    RAISE EXCEPTION
      'Ask your teacher to assign your JMCWC group.';
  END IF;

  RETURN g;
END $function$;

-- Function: public.jmcwc_create_attempt
CREATE OR REPLACE FUNCTION public.jmcwc_create_attempt(p_student uuid, p_request uuid, p_paper uuid, p_mode text, p_category text, p_questions jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  g text;
  p public.jmcwc_papers;
  a uuid;
  expected integer;
  q jsonb;
  blueprint_slot jsonb;
  question_marks numeric;
  target integer;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_student::text,172026)
  );

  g := public.jmcwc_check_student(p_student);

  SELECT id INTO a
  FROM public.jmcwc_attempts
  WHERE student_id = p_student
    AND request_id = p_request;

  IF FOUND THEN
    RETURN a;
  END IF;

  IF p_request IS NULL
     OR p_mode IS NULL
     OR p_mode NOT IN ('flat','category')
  THEN
    RAISE EXCEPTION 'Invalid request.';
  END IF;

  SELECT * INTO p
  FROM public.jmcwc_papers
  WHERE id = p_paper
    AND group_key = g
    AND published;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'No published paper for your assigned group.';
  END IF;

  IF (p_mode = 'flat' AND p_category IS NOT NULL)
     OR (p_mode = 'category' AND p_category IS NULL)
  THEN
    RAISE EXCEPTION 'Invalid category.';
  END IF;

  IF p_mode = 'flat'
     AND (
       SELECT count(*)
       FROM public.jmcwc_attempts
       WHERE student_id = p_student
         AND mode = 'flat'
         AND status <> 'submitted'
     ) >= 3
  THEN
    RAISE EXCEPTION
      'You have three unfinished flat rounds. Complete one before starting another.';
  END IF;

  SELECT count(*) INTO expected
  FROM jsonb_array_elements(p.spec->'sections') s
  CROSS JOIN LATERAL
    jsonb_array_elements(s->'questions') item
  WHERE p_mode = 'flat'
     OR s->>'key' = p_category;

  IF expected = 0
     OR jsonb_typeof(p_questions)
          IS DISTINCT FROM 'array'
  THEN
    RAISE EXCEPTION 'Invalid generated paper.';
  END IF;

  IF jsonb_array_length(p_questions) <> expected
     OR octet_length(p_questions::text) > 5000000
  THEN
    RAISE EXCEPTION 'Paper size mismatch.';
  END IF;

  IF (
    SELECT count(DISTINCT x->>'id')
    FROM jsonb_array_elements(p_questions) x
  ) <> expected
  OR (
    SELECT count(DISTINCT (x->>'category_key',x->>'slot'))
    FROM jsonb_array_elements(p_questions) x
  ) <> expected
  THEN
    RAISE EXCEPTION 'Duplicate question IDs or slots.';
  END IF;

  FOR q IN
    SELECT * FROM jsonb_array_elements(p_questions)
  LOOP
    IF jsonb_typeof(q) IS DISTINCT FROM 'object'
       OR coalesce(q->>'id','') = ''
       OR length(q->>'id') > 100
       OR NOT(q ? 'answer_key')
       OR NOT(q ? 'prompt')
       OR NOT(q ? 'input')
       OR jsonb_typeof(q->'max_marks')
            IS DISTINCT FROM 'number'
    THEN
      RAISE EXCEPTION 'Invalid generated question.';
    END IF;

    SELECT item INTO blueprint_slot
    FROM jsonb_array_elements(p.spec->'sections') s
    CROSS JOIN LATERAL
      jsonb_array_elements(s->'questions') item
    WHERE s->>'key' = q->>'category_key'
      AND item->>'slot' = q->>'slot'
      AND (
        p_mode = 'flat'
        OR s->>'key' = p_category
      );

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Question does not match the published blueprint.';
    END IF;

    question_marks := (q->>'max_marks')::numeric;

    PERFORM public.jmcwc_validate_marks(
      q->>'category_key',
      blueprint_slot,
      question_marks
    );
  END LOOP;

  SELECT target_seconds INTO target
  FROM public.jmcwc_targets
  WHERE group_key = g
    AND category_key = p_category;

  INSERT INTO public.jmcwc_attempts(
    student_id,
    request_id,
    paper_id,
    group_key,
    mode,
    category_key,
    target_seconds
  )
  VALUES(
    p_student,
    p_request,
    p_paper,
    g,
    p_mode,
    p_category,
    CASE WHEN p_mode = 'category' THEN target END
  )
  RETURNING id INTO a;

  INSERT INTO public.jmcwc_payloads(
    attempt_id, questions
  )
  VALUES(a,p_questions);

  RETURN a;
END;
$function$;

-- Function: public.jmcwc_finalize
CREATE OR REPLACE FUNCTION public.jmcwc_finalize(p_student uuid, p_attempt uuid, p_revision bigint, p_items jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  a public.jmcwc_attempts;
  qs jsonb;
  item jsonb;
  q jsonb;
  m numeric;
  maximum numeric:=0;
  earned numeric:=0;
  c integer:=0;
  h integer:=0;
  w integer:=0;
  sk integer:=0;
  blank boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_student::text,172026)
  );

  SELECT * INTO a
  FROM public.jmcwc_attempts
  WHERE id=p_attempt AND student_id=p_student
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Round not found.';
  END IF;

  IF a.status='submitted' THEN
    RETURN;
  END IF;

  IF a.status<>'grading'
     OR a.revision IS DISTINCT FROM p_revision
  THEN
    RAISE EXCEPTION 'Grading snapshot changed.';
  END IF;

  SELECT questions INTO qs
  FROM public.jmcwc_payloads
  WHERE attempt_id=a.id;

  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid grading output.';
  END IF;

  IF jsonb_array_length(p_items)<>jsonb_array_length(qs)
     OR (
       SELECT count(DISTINCT x->>'question_id')
       FROM jsonb_array_elements(p_items) x
     )<>jsonb_array_length(qs)
  THEN
    RAISE EXCEPTION 'Grade every question exactly once.';
  END IF;

  FOR item IN
    SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT value INTO q
    FROM jsonb_array_elements(qs)
    WHERE value->>'id'=item->>'question_id';

    IF NOT FOUND
       OR jsonb_typeof(item->'award') IS DISTINCT FROM 'number'
       OR coalesce(item->>'verdict','')
            NOT IN ('correct','partial','wrong','skipped')
    THEN
      RAISE EXCEPTION 'Invalid mark.';
    END IF;

    m:=(q->>'max_marks')::numeric;
    blank:=coalesce(btrim(a.answers->>(q->>'id')),'')='';

    IF (item->>'award')::numeric<>(
      CASE item->>'verdict'
        WHEN 'correct' THEN m
        WHEN 'partial' THEN m/2
        ELSE 0
      END
    )
    OR (blank AND item->>'verdict'<>'skipped')
    OR (NOT blank AND item->>'verdict'='skipped')
    THEN
      RAISE EXCEPTION
        'Inconsistent mark or blank-answer classification.';
    END IF;

    maximum:=maximum+m;
    earned:=earned+(item->>'award')::numeric;

    CASE item->>'verdict'
      WHEN 'correct' THEN c:=c+1;
      WHEN 'partial' THEN h:=h+1;
      WHEN 'wrong' THEN w:=w+1;
      ELSE sk:=sk+1;
    END CASE;
  END LOOP;

  INSERT INTO public.jmcwc_scores(
    attempt_id,marks,max_marks,correct,partial,wrong,skipped,items
  )
  VALUES(a.id,earned,maximum,c,h,w,sk,p_items);

  UPDATE public.jmcwc_attempts
  SET status='submitted',revision=revision+1
  WHERE id=a.id;
END $function$;

-- Function: public.jmcwc_list
CREATE OR REPLACE FUNCTION public.jmcwc_list(p_student uuid, p_offset integer DEFAULT 0)
 RETURNS SETOF jmcwc_attempts
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  a uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_student::text,172026)
  );

  PERFORM public.jmcwc_check_student(p_student);

  FOR a IN
    SELECT id
    FROM public.jmcwc_attempts
    WHERE student_id=p_student AND status='running'
  LOOP
    PERFORM public.jmcwc_tick(a);
  END LOOP;

  RETURN QUERY
  SELECT *
  FROM public.jmcwc_attempts
  WHERE student_id=p_student
  ORDER BY created_at DESC,id
  LIMIT 50
  OFFSET greatest(0,least(coalesce(p_offset,0),100000));
END $function$;

-- Function: public.jmcwc_paper_guard
CREATE OR REPLACE FUNCTION public.jmcwc_paper_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  s jsonb;
  q jsonb;
  n integer := 0;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.published THEN
    RAISE EXCEPTION
      'Published papers are immutable; create a new version.';
  END IF;

  IF NEW.published THEN
    IF jsonb_typeof(NEW.spec->'sections')
         IS DISTINCT FROM 'array'
    THEN
      RAISE EXCEPTION 'Paper sections must be an array.';
    END IF;

    IF jsonb_array_length(NEW.spec->'sections') <> 23 THEN
      RAISE EXCEPTION
        'A complete paper needs the 23 visible workbook sections.';
    END IF;

    IF (
      SELECT count(DISTINCT x->>'key')
      FROM jsonb_array_elements(NEW.spec->'sections') x
    ) <> 23
    THEN
      RAISE EXCEPTION 'Duplicate or missing sections.';
    END IF;

    FOR s IN
      SELECT *
      FROM jsonb_array_elements(NEW.spec->'sections')
    LOOP
      IF NOT EXISTS (
        SELECT 1
        FROM public.jmcwc_categories
        WHERE key = s->>'key'
      )
      THEN
        RAISE EXCEPTION 'Invalid section.';
      END IF;

      IF jsonb_typeof(s->'questions')
           IS DISTINCT FROM 'array'
      THEN
        RAISE EXCEPTION 'Section questions must be an array.';
      END IF;

      IF jsonb_array_length(s->'questions')
           NOT BETWEEN 1 AND 250
      THEN
        RAISE EXCEPTION 'Invalid question count.';
      END IF;

      IF (
        SELECT count(DISTINCT x->>'slot')
        FROM jsonb_array_elements(s->'questions') x
      ) <> jsonb_array_length(s->'questions')
      THEN
        RAISE EXCEPTION 'Duplicate or missing slots.';
      END IF;

      FOR q IN
        SELECT *
        FROM jsonb_array_elements(s->'questions')
      LOOP
        IF coalesce(q->>'slot','') = ''
           OR coalesce(q->>'generator','') = ''
        THEN
          RAISE EXCEPTION 'Invalid question specification.';
        END IF;

        PERFORM public.jmcwc_validate_marks(
          s->>'key', q
        );

        n := n + 1;
      END LOOP;
    END LOOP;

    IF n > 2000 THEN
      RAISE EXCEPTION 'Paper is too large.';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- Function: public.jmcwc_tick
CREATE OR REPLACE FUNCTION public.jmcwc_tick(p_attempt uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  a public.jmcwc_attempts;
  t timestamptz:=clock_timestamp();
  gap bigint;
BEGIN
  SELECT * INTO a
  FROM public.jmcwc_attempts
  WHERE id=p_attempt
  FOR UPDATE;

  IF NOT FOUND OR a.status<>'running' THEN
    RETURN;
  END IF;

  gap:=greatest(
    0,
    floor(extract(epoch FROM t-a.last_seen_at)*1000)::bigint
  );

  IF gap>25000 THEN
    UPDATE public.jmcwc_attempts
    SET status='paused',
        lease_id=NULL,
        last_seen_at=NULL,
        revision=revision+1
    WHERE id=a.id;
  ELSE
    a.active_ms:=a.active_ms+gap;

    IF a.mode='flat' AND a.active_ms>=7200000 THEN
      UPDATE public.jmcwc_attempts
      SET active_ms=7200000,
          status='grading',
          lease_id=NULL,
          last_seen_at=NULL,
          finished_at=t,
          submitted_reason='time_limit',
          revision=revision+1
      WHERE id=a.id;
    ELSE
      UPDATE public.jmcwc_attempts
      SET active_ms=a.active_ms,
          last_seen_at=t
      WHERE id=a.id;
    END IF;
  END IF;
END $function$;

-- Function: public.jmcwc_validate_marks
CREATE OR REPLACE FUNCTION public.jmcwc_validate_marks(p_category text, p_slot jsonb, p_question_marks numeric DEFAULT NULL::numeric)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  params jsonb;
  scoring_mode text;
  rule_name text;
  bounds jsonb;
  baseline numeric;
  lower_mark numeric;
  upper_mark numeric;
BEGIN
  IF jsonb_typeof(p_slot) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid scoring slot.';
  END IF;

  params := p_slot->'parameters';

  IF jsonb_typeof(params) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Slot parameters must be an object.';
  END IF;

  -- Avoid two competing metadata locations.
  IF p_slot ? 'scoring_mode'
     OR p_slot ? 'mark_rule'
     OR p_slot ? 'mark_range'
  THEN
    RAISE EXCEPTION
      'Scoring metadata must be inside slot.parameters.';
  END IF;

  IF jsonb_typeof(p_slot->'max_marks')
       IS DISTINCT FROM 'number'
  THEN
    RAISE EXCEPTION 'Blueprint max_marks must be numeric.';
  END IF;

  baseline := (p_slot->>'max_marks')::numeric;

  IF baseline <= 0 OR baseline <> trunc(baseline) THEN
    RAISE EXCEPTION
      'Blueprint max_marks must be a positive integer.';
  END IF;

  IF params ? 'scoring_mode' THEN
    IF jsonb_typeof(params->'scoring_mode')
         IS DISTINCT FROM 'string'
    THEN
      RAISE EXCEPTION 'Invalid scoring_mode.';
    END IF;

    scoring_mode := params->>'scoring_mode';
  ELSE
    scoring_mode := 'fixed';
  END IF;

  IF scoring_mode NOT IN ('fixed','dynamic') THEN
    RAISE EXCEPTION 'Unknown scoring_mode.';
  END IF;

  IF scoring_mode = 'fixed' THEN
    IF params ? 'mark_rule' OR params ? 'mark_range' THEN
      RAISE EXCEPTION
        'Fixed slots must not declare dynamic scoring metadata.';
    END IF;

    IF p_question_marks IS NOT NULL THEN
      IF p_question_marks::text IN ('NaN','Infinity','-Infinity')
         OR p_question_marks <= 0
         OR p_question_marks <> trunc(p_question_marks)
         OR p_question_marks <> baseline
      THEN
        RAISE EXCEPTION
          'Fixed question marks must equal blueprint max_marks.';
      END IF;
    END IF;

    RETURN;
  END IF;

  IF jsonb_typeof(params->'mark_rule')
       IS DISTINCT FROM 'string'
  THEN
    RAISE EXCEPTION 'Dynamic slot needs a mark_rule.';
  END IF;

  rule_name := params->>'mark_rule';

  IF NOT (
    (
      p_category = 'multiplication'
      AND rule_name = 'multiplication_digits_product'
    )
    OR (
      p_category = 'prime_factors'
      AND rule_name = 'prime_factors_target_scale'
    )
    OR (
      p_category = 'approximation'
      AND rule_name = 'approximation_product_digits'
    )
    OR (
      p_category = 'sum_squares'
      AND rule_name IN (
        'sum_squares_j1_decomposition',
        'sum_squares_j2_target',
        'sum_squares_sr_target'
      )
    )
  ) OR p_category IS NULL
  THEN
    RAISE EXCEPTION
      'Unrecognized scoring rule % for category %.',
      rule_name, p_category;
  END IF;

  bounds := params->'mark_range';

  IF jsonb_typeof(bounds) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'mark_range must be an array.';
  END IF;

  IF jsonb_array_length(bounds) <> 2 THEN
    RAISE EXCEPTION 'mark_range must contain exactly two bounds.';
  END IF;

  IF jsonb_typeof(bounds->0) IS DISTINCT FROM 'number'
     OR jsonb_typeof(bounds->1) IS DISTINCT FROM 'number'
  THEN
    RAISE EXCEPTION 'mark_range bounds must be numeric.';
  END IF;

  lower_mark := (bounds->>0)::numeric;
  upper_mark := (bounds->>1)::numeric;

  IF lower_mark <= 0
     OR upper_mark <= 0
     OR lower_mark <> trunc(lower_mark)
     OR upper_mark <> trunc(upper_mark)
     OR lower_mark > upper_mark
  THEN
    RAISE EXCEPTION
      'mark_range needs ordered positive integer bounds.';
  END IF;

  IF baseline < lower_mark OR baseline > upper_mark THEN
    RAISE EXCEPTION
      'Blueprint baseline marks must fall inside mark_range.';
  END IF;

  IF p_question_marks IS NOT NULL THEN
    IF p_question_marks::text IN ('NaN','Infinity','-Infinity')
       OR p_question_marks <= 0
       OR p_question_marks <> trunc(p_question_marks)
       OR p_question_marks < lower_mark
       OR p_question_marks > upper_mark
    THEN
      RAISE EXCEPTION
        'Dynamic question marks must be an integer within mark_range.';
    END IF;
  END IF;
END;
$function$;

-- -----------------------------------------------------------------------------
-- PART 6: FUNCTION PERMISSIONS (RESTRICTED TO POSTGRES & SERVICE_ROLE)
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.jmcwc_act(uuid, uuid, text, uuid, bigint, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.jmcwc_act(uuid, uuid, text, uuid, bigint, jsonb) TO postgres, service_role;
REVOKE ALL ON FUNCTION public.jmcwc_assignment_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.jmcwc_assignment_guard() TO postgres, service_role;
REVOKE ALL ON FUNCTION public.jmcwc_check_student(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.jmcwc_check_student(uuid) TO postgres, service_role;
REVOKE ALL ON FUNCTION public.jmcwc_create_attempt(uuid, uuid, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.jmcwc_create_attempt(uuid, uuid, uuid, text, text, jsonb) TO postgres, service_role;
REVOKE ALL ON FUNCTION public.jmcwc_finalize(uuid, uuid, bigint, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.jmcwc_finalize(uuid, uuid, bigint, jsonb) TO postgres, service_role;
REVOKE ALL ON FUNCTION public.jmcwc_list(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.jmcwc_list(uuid, integer) TO postgres, service_role;
REVOKE ALL ON FUNCTION public.jmcwc_paper_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.jmcwc_paper_guard() TO postgres, service_role;
REVOKE ALL ON FUNCTION public.jmcwc_tick(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.jmcwc_tick(uuid) TO postgres, service_role;
REVOKE ALL ON FUNCTION public.jmcwc_validate_marks(text, jsonb, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.jmcwc_validate_marks(text, jsonb, numeric) TO postgres, service_role;

-- -----------------------------------------------------------------------------
-- PART 7: TABLE TRIGGERS (VERBATIM FROM CONTRACT SNAPSHOT)
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS jmcwc_assignment_check ON public.jmcwc_assignments;
CREATE TRIGGER jmcwc_assignment_check BEFORE INSERT OR UPDATE ON public.jmcwc_assignments FOR EACH ROW EXECUTE FUNCTION public.jmcwc_assignment_guard();

DROP TRIGGER IF EXISTS jmcwc_paper_check ON public.jmcwc_papers;
CREATE TRIGGER jmcwc_paper_check BEFORE INSERT OR UPDATE ON public.jmcwc_papers FOR EACH ROW EXECUTE FUNCTION public.jmcwc_paper_guard();

-- -----------------------------------------------------------------------------
-- PART 8: CANONICAL CATEGORY REGISTRY SEED (23 WORKBOOK CATEGORIES)
-- -----------------------------------------------------------------------------
INSERT INTO public.jmcwc_categories (key, label, workbook_sheet, position)
VALUES
  ('addition', 'Integer addition', 'Int Adds', 1),
  ('subtraction', 'Integer subtraction', 'Int Subs', 2),
  ('mixed', 'Mixed addition and subtraction', 'Mixed adds+subs', 3),
  ('multiplication', 'Integer multiplication', 'Int Mults', 4),
  ('division', 'Integer division', 'Int Divs', 5),
  ('brackets', 'Brackets', 'Brackets', 6),
  ('prime_factors', 'Prime factorisation', 'Primes', 7),
  ('hcf_lcm', 'HCF and LCM', 'HCF LCM', 8),
  ('fraction_add', 'Fraction addition', 'Fraction Additions', 9),
  ('fraction_sub', 'Fraction subtraction', 'Fraction Subtractions', 10),
  ('fraction_mul', 'Fraction multiplication', 'Fraction Multiplications', 11),
  ('fraction_div', 'Fraction division', 'Fraction Divisions', 12),
  ('approximation', 'Approximations', 'Approximations', 13),
  ('remainder', 'Remainders', 'Remainders', 14),
  ('ratio', 'Ratios', 'Ratios', 15),
  ('square_root', 'Perfect square roots', 'Perfect Square Roots', 16),
  ('inexact_square_root', 'Inexact square roots', 'Irrational Square Roots', 17),
  ('next_square', 'Next squares', 'Next Squares', 18),
  ('cube_root', 'Exact cube roots', 'Cube Roots - Exact', 19),
  ('next_cube', 'Next cubes', 'Next Cubes', 20),
  ('calendar', 'Calendars', 'Calendars', 21),
  ('elapsed_time', 'Elapsed time', 'Times Elapsed', 22),
  ('sum_squares', 'Sums of squares', 'Sums of Squares', 23)
ON CONFLICT (key) DO UPDATE SET
  label = EXCLUDED.label,
  workbook_sheet = EXCLUDED.workbook_sheet,
  position = EXCLUDED.position;

-- -----------------------------------------------------------------------------
-- PART 9: SEED ALL 69 GROUP/CATEGORY TARGET ROWS WITH NULL TARGETS
-- All 69 combinations (3 groups x 23 categories) initialized to NULL.
-- Test-specific targets belong inside test fixtures, not bootstrap defaults.
-- -----------------------------------------------------------------------------
INSERT INTO public.jmcwc_targets (group_key, category_key, target_seconds)
VALUES
  ('junior1', 'addition', NULL),
  ('junior1', 'subtraction', NULL),
  ('junior1', 'mixed', NULL),
  ('junior1', 'multiplication', NULL),
  ('junior1', 'division', NULL),
  ('junior1', 'brackets', NULL),
  ('junior1', 'prime_factors', NULL),
  ('junior1', 'hcf_lcm', NULL),
  ('junior1', 'fraction_add', NULL),
  ('junior1', 'fraction_sub', NULL),
  ('junior1', 'fraction_mul', NULL),
  ('junior1', 'fraction_div', NULL),
  ('junior1', 'approximation', NULL),
  ('junior1', 'remainder', NULL),
  ('junior1', 'ratio', NULL),
  ('junior1', 'square_root', NULL),
  ('junior1', 'inexact_square_root', NULL),
  ('junior1', 'next_square', NULL),
  ('junior1', 'cube_root', NULL),
  ('junior1', 'next_cube', NULL),
  ('junior1', 'calendar', NULL),
  ('junior1', 'elapsed_time', NULL),
  ('junior1', 'sum_squares', NULL),
  ('junior2', 'addition', NULL),
  ('junior2', 'subtraction', NULL),
  ('junior2', 'mixed', NULL),
  ('junior2', 'multiplication', NULL),
  ('junior2', 'division', NULL),
  ('junior2', 'brackets', NULL),
  ('junior2', 'prime_factors', NULL),
  ('junior2', 'hcf_lcm', NULL),
  ('junior2', 'fraction_add', NULL),
  ('junior2', 'fraction_sub', NULL),
  ('junior2', 'fraction_mul', NULL),
  ('junior2', 'fraction_div', NULL),
  ('junior2', 'approximation', NULL),
  ('junior2', 'remainder', NULL),
  ('junior2', 'ratio', NULL),
  ('junior2', 'square_root', NULL),
  ('junior2', 'inexact_square_root', NULL),
  ('junior2', 'next_square', NULL),
  ('junior2', 'cube_root', NULL),
  ('junior2', 'next_cube', NULL),
  ('junior2', 'calendar', NULL),
  ('junior2', 'elapsed_time', NULL),
  ('junior2', 'sum_squares', NULL),
  ('senior', 'addition', NULL),
  ('senior', 'subtraction', NULL),
  ('senior', 'mixed', NULL),
  ('senior', 'multiplication', NULL),
  ('senior', 'division', NULL),
  ('senior', 'brackets', NULL),
  ('senior', 'prime_factors', NULL),
  ('senior', 'hcf_lcm', NULL),
  ('senior', 'fraction_add', NULL),
  ('senior', 'fraction_sub', NULL),
  ('senior', 'fraction_mul', NULL),
  ('senior', 'fraction_div', NULL),
  ('senior', 'approximation', NULL),
  ('senior', 'remainder', NULL),
  ('senior', 'ratio', NULL),
  ('senior', 'square_root', NULL),
  ('senior', 'inexact_square_root', NULL),
  ('senior', 'next_square', NULL),
  ('senior', 'cube_root', NULL),
  ('senior', 'next_cube', NULL),
  ('senior', 'calendar', NULL),
  ('senior', 'elapsed_time', NULL),
  ('senior', 'sum_squares', NULL)
ON CONFLICT (group_key, category_key) DO UPDATE SET
  target_seconds = EXCLUDED.target_seconds;

COMMIT;
