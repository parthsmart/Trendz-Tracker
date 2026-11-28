-- Fair-play guardrails: configurable impossible-time thresholds, a teacher review queue,
-- voiding with an audit log, and rate limits on result submissions and reward claims.
--
-- Learning first: nothing here drops an honest result. Server-graded practice that looks
-- unusually fast is saved and FLAGGED ('review'); a teacher, centre head or admin approves or
-- voids it. A voided result keeps its row (fair_play_status = 'voided') but leaves XP, coins,
-- the record boards and the "most improved" board. Every decision is audited, and a void can
-- be reversed (its XP rows are restored from the audit snapshot).
--
-- Students see "Under review" / "Not counted" only, never the reasons.
-- Thresholds: fair_play_thresholds, per kind (basics, element, memoriad, typed_round, ...),
-- key (drill / module / category) and level (digits), '*' = any. Defaults match
-- shared/fairPlay.js DEFAULT_FAIR_PLAY_THRESHOLDS.
--
-- Centre scoping: a reviewer sees a student only if they are an admin / network admin, can
-- manage the student (can_manage_profile: centre heads for their own centre), or are a teacher
-- assigned to the student.
--
-- No data is deleted except student_xp_events rows of a voided result, which are copied into
-- fair_play_audit.snapshot first. Rollback: supabase/rollbacks/42_fair_play_guardrails_rollback.sql

-- ---------------------------------------------------------------------------
-- 1. Status columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.results ADD COLUMN IF NOT EXISTS fair_play_status text;
ALTER TABLE public.activity_results ADD COLUMN IF NOT EXISTS fair_play_status text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'results_fair_play_status_check') THEN
    ALTER TABLE public.results ADD CONSTRAINT results_fair_play_status_check
      CHECK (fair_play_status IS NULL OR fair_play_status IN ('review', 'approved', 'voided'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activity_results_fair_play_status_check') THEN
    ALTER TABLE public.activity_results ADD CONSTRAINT activity_results_fair_play_status_check
      CHECK (fair_play_status IS NULL OR fair_play_status IN ('review', 'approved', 'voided'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS results_fair_play_status_idx
  ON public.results (fair_play_status) WHERE fair_play_status IS NOT NULL;
CREATE INDEX IF NOT EXISTS activity_results_fair_play_status_idx
  ON public.activity_results (fair_play_status) WHERE fair_play_status IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Thresholds (configurable per round type and level)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fair_play_thresholds (
  kind text NOT NULL,
  key text NOT NULL DEFAULT '*',
  level text NOT NULL DEFAULT '*',
  reject_spq numeric,          -- seconds a question below which a result is impossible (rejected)
  flag_spq numeric,            -- seconds a correct answer below which a result is flagged
  max_correct integer,         -- more correct than this is flagged
  enabled boolean NOT NULL DEFAULT true,
  note text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  PRIMARY KEY (kind, key, level),
  CONSTRAINT fair_play_thresholds_kind_check
    CHECK (kind IN ('basics', 'element', 'memoriad', 'flash', 'typed_round', 'typed_basics', 'duel')),
  CONSTRAINT fair_play_thresholds_values_check
    CHECK ((reject_spq IS NULL OR reject_spq >= 0) AND (flag_spq IS NULL OR flag_spq >= 0)
           AND (max_correct IS NULL OR max_correct > 0))
);

INSERT INTO public.fair_play_thresholds (kind, key, level, reject_spq, flag_spq, max_correct, note) VALUES
  ('basics', '*', '*', 0.25, 0.5, NULL, 'Fastest real 60 s run: 0.60 s a question'),
  ('element', '*', '*', 0.25, 0.6, NULL, 'Fastest real run: 0.96 s a question'),
  ('duel', '*', '*', 0.25, 0.5, NULL, NULL),
  ('flash', '*', '*', NULL, NULL, NULL, 'Server enforces the presentation time'),
  ('typed_round', '*', '*', NULL, 0.3, 200, 'Typed paper rounds: 4 of 7744 past rows under 0.3 s'),
  ('typed_basics', '*', '*', NULL, 0.4, 150, NULL),
  ('memoriad', 'calendar', '*', 0.25, 0.75, NULL, NULL),
  ('memoriad', 'additions', '*', 3, 10, NULL, 'Official: 10 x 10-digit in 10 min'),
  ('memoriad', 'multiplications', '*', 5, 10, NULL, 'Official: 5d x 5d, 10 tasks in 5 min'),
  ('memoriad', 'multiplications', '3', 2, 4, NULL, NULL),
  ('memoriad', 'multiplications', '4', 3, 6, NULL, NULL),
  ('memoriad', 'multiplications', '6', 5, 14, NULL, NULL),
  ('memoriad', 'multiplications', '7', 5, 20, NULL, NULL),
  ('memoriad', 'multiplications', '8', 5, 25, NULL, 'Official: 8d x 8d, 10 tasks in 12 min'),
  ('memoriad', 'multiplications', '9', 5, 32, NULL, NULL),
  ('memoriad', 'multiplications', '10', 5, 40, NULL, NULL),
  ('memoriad', 'square_roots', '*', 5, 15, NULL, 'Official: 6 digits, 10 tasks in 15 min'),
  ('memoriad', 'square_roots', '8', 5, 20, NULL, NULL),
  ('memoriad', 'square_roots', '10', 5, 25, NULL, NULL),
  ('memoriad', 'division', '*', 3, 8, NULL, NULL),
  ('memoriad', 'division', '10', 3, 15, NULL, 'Official: 10d / 5d, 10 tasks in 6 min')
ON CONFLICT (kind, key, level) DO NOTHING;

ALTER TABLE public.fair_play_thresholds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fair_play_thresholds_select ON public.fair_play_thresholds;
CREATE POLICY fair_play_thresholds_select ON public.fair_play_thresholds
  FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.fair_play_thresholds TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fair_play_thresholds TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Review queue and audit log (RPC / service role only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fair_play_reviews (
  id bigserial PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  source_table text NOT NULL CHECK (source_table IN ('results', 'activity_results')),
  source_id uuid NOT NULL,
  kind text NOT NULL,
  activity_key text,
  label text,
  reasons text[] NOT NULL DEFAULT '{}',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,     -- counts and timings only
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'voided')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid,
  decision_note text,
  UNIQUE (source_table, source_id)
);
CREATE INDEX IF NOT EXISTS fair_play_reviews_status_idx ON public.fair_play_reviews (status, created_at DESC);
CREATE INDEX IF NOT EXISTS fair_play_reviews_student_idx ON public.fair_play_reviews (student_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.fair_play_audit (
  id bigserial PRIMARY KEY,
  review_id bigint REFERENCES public.fair_play_reviews(id) ON DELETE SET NULL,
  action text NOT NULL,                 -- opened / approved / voided / restored / threshold_saved
  actor_id uuid,
  note text,
  snapshot jsonb,                       -- XP rows removed by a void, threshold before / after
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fair_play_audit_review_idx ON public.fair_play_audit (review_id, at);

ALTER TABLE public.fair_play_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fair_play_audit ENABLE ROW LEVEL SECURITY;
-- No policies: read and written through the SECURITY DEFINER functions below.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fair_play_reviews, public.fair_play_audit TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.fair_play_reviews_id_seq, public.fair_play_audit_id_seq TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Rate-limit ledger (for the API helper; triggers below count their own tables)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fair_play_rate_hits (
  id bigserial PRIMARY KEY,
  student_id uuid NOT NULL,
  bucket text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fair_play_rate_hits_idx ON public.fair_play_rate_hits (student_id, bucket, at DESC);
ALTER TABLE public.fair_play_rate_hits ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON public.fair_play_rate_hits TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.fair_play_rate_hits_id_seq TO service_role;

-- Records a hit when under the limit. Returns true when allowed.
CREATE OR REPLACE FUNCTION public.fair_play_rate_hit(p_student uuid, p_bucket text, p_limit integer,
                                                     p_window_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_hits integer;
BEGIN
  IF p_student IS NULL OR p_bucket IS NULL OR COALESCE(p_limit, 0) <= 0 THEN
    RETURN true;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('fair_play:' || p_student::text || ':' || p_bucket));
  SELECT count(*) INTO v_hits FROM public.fair_play_rate_hits
   WHERE student_id = p_student AND bucket = p_bucket
     AND at > now() - make_interval(secs => GREATEST(1, p_window_seconds));
  IF v_hits >= p_limit THEN
    RETURN false;
  END IF;
  INSERT INTO public.fair_play_rate_hits (student_id, bucket) VALUES (p_student, p_bucket);
  -- Keep the ledger small.
  DELETE FROM public.fair_play_rate_hits
   WHERE student_id = p_student AND bucket = p_bucket AND at < now() - interval '2 days';
  RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Who may review a student
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fair_play_can_review(p_student uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := auth.uid();
BEGIN
  IF v_me IS NULL OR p_student IS NULL OR v_me = p_student THEN
    RETURN false;
  END IF;
  IF public.is_admin() THEN
    RETURN true;
  END IF;
  IF to_regprocedure('public.can_manage_profile(uuid)') IS NOT NULL THEN
    IF public.can_manage_profile(p_student) THEN
      RETURN true;
    END IF;
  END IF;
  RETURN public.is_teacher(v_me) AND public.is_teacher_assigned_to_student(v_me, p_student);
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Assessment for typed scores (results written by the student from the browser)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fair_play_threshold(p_kind text, p_key text, p_level text)
RETURNS public.fair_play_thresholds LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.* FROM public.fair_play_thresholds t
   WHERE t.kind = p_kind AND t.enabled
     AND t.key IN (COALESCE(p_key, '*'), '*') AND t.level IN (COALESCE(p_level, '*'), '*')
   ORDER BY (t.key <> '*') DESC, (t.level <> '*') DESC
   LIMIT 1
$$;

-- Returns the reasons a typed score looks implausible (empty = fine).
CREATE OR REPLACE FUNCTION public.fair_play_typed_reasons(p_kind text, p_correct integer, p_total integer,
                                                          p_seconds numeric)
RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t public.fair_play_thresholds;
  v_reasons text[] := '{}';
BEGIN
  IF COALESCE(p_total, 0) <= 0 OR COALESCE(p_correct, 0) <= 0 THEN
    RETURN v_reasons;
  END IF;
  t := public.fair_play_threshold(p_kind, '*', '*');
  IF t.kind IS NULL THEN
    RETURN v_reasons;
  END IF;
  IF t.flag_spq IS NOT NULL AND p_seconds IS NOT NULL AND p_seconds > 0
     AND p_seconds / p_correct < t.flag_spq THEN
    v_reasons := array_append(v_reasons, 'too_fast');
  END IF;
  IF t.max_correct IS NOT NULL AND p_correct > t.max_correct THEN
    v_reasons := array_append(v_reasons, 'over_max');
  END IF;
  RETURN v_reasons;
END;
$$;

-- Opens (or keeps) a review and marks the source row. Service role and internal use.
CREATE OR REPLACE FUNCTION public.fair_play_open_review(
  p_student uuid, p_source_table text, p_source_id uuid, p_kind text, p_key text, p_label text,
  p_reasons text[], p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id bigint;
BEGIN
  IF p_source_table NOT IN ('results', 'activity_results') OR p_source_id IS NULL THEN
    RAISE EXCEPTION 'Unknown result source.';
  END IF;
  INSERT INTO public.fair_play_reviews (student_id, source_table, source_id, kind, activity_key, label, reasons, detail)
  VALUES (p_student, p_source_table, p_source_id, p_kind, p_key, p_label,
          COALESCE(p_reasons, '{}'), COALESCE(p_detail, '{}'::jsonb))
  ON CONFLICT (source_table, source_id) DO UPDATE
     SET reasons = EXCLUDED.reasons, detail = EXCLUDED.detail,
         status = 'open', decided_at = NULL, decided_by = NULL, decision_note = NULL,
         created_at = CASE WHEN public.fair_play_reviews.status = 'open'
                           THEN public.fair_play_reviews.created_at ELSE now() END
   WHERE public.fair_play_reviews.status <> 'voided'
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    -- Already voided: leave it voided.
    SELECT id INTO v_id FROM public.fair_play_reviews WHERE source_table = p_source_table AND source_id = p_source_id;
    RETURN v_id;
  END IF;

  IF p_source_table = 'results' THEN
    UPDATE public.results SET fair_play_status = 'review'
     WHERE id = p_source_id AND fair_play_status IS DISTINCT FROM 'voided';
  ELSE
    UPDATE public.activity_results SET fair_play_status = 'review'
     WHERE id = p_source_id AND fair_play_status IS DISTINCT FROM 'voided';
  END IF;

  INSERT INTO public.fair_play_audit (review_id, action, snapshot)
  VALUES (v_id, 'opened', jsonb_build_object('reasons', to_jsonb(COALESCE(p_reasons, '{}')), 'detail', p_detail));
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Triggers on results: guard the status column, flag implausible typed scores,
--    rate-limit typed entries.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fair_play_results_before()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_browser boolean := current_user IN ('authenticated', 'anon');
  v_self boolean := v_browser AND auth.uid() IS NOT NULL AND auth.uid() = NEW.student_id;
  v_kind text;
  v_section text;
  v_recent integer;
BEGIN
  IF v_browser THEN
    -- The status column is never set from the site.
    IF TG_OP = 'INSERT' THEN
      NEW.fair_play_status := NULL;
    ELSE
      NEW.fair_play_status := OLD.fair_play_status;
    END IF;
  END IF;

  IF NOT v_self OR COALESCE(NEW.source, '') = 'site' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT count(*) INTO v_recent FROM public.results
     WHERE student_id = NEW.student_id AND created_at > now() - interval '1 hour';
    IF v_recent >= 300 THEN
      RAISE EXCEPTION 'You have saved a lot of scores in the last hour. Please wait a little and try again.'
        USING ERRCODE = 'P0001', HINT = 'rate_limited';
    END IF;
  ELSIF NEW.correct IS NOT DISTINCT FROM OLD.correct AND NEW.total IS NOT DISTINCT FROM OLD.total
        AND NEW.time_seconds IS NOT DISTINCT FROM OLD.time_seconds THEN
    RETURN NEW;
  END IF;

  IF NEW.fair_play_status = 'voided' THEN
    RETURN NEW;
  END IF;

  SELECT c.section INTO v_section FROM public.categories c WHERE c.id = NEW.category_id;
  v_kind := CASE WHEN v_section = 'basics' THEN 'typed_basics' ELSE 'typed_round' END;
  IF array_length(public.fair_play_typed_reasons(v_kind, NEW.correct, NEW.total, NEW.time_seconds), 1) > 0 THEN
    NEW.fair_play_status := 'review';
  ELSIF TG_OP = 'UPDATE' AND OLD.fair_play_status = 'review' THEN
    -- Corrected numbers now look fine: the open review stays for the teacher, status stays.
    NEW.fair_play_status := 'review';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fair_play_results_after()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_section text;
  v_name text;
  v_kind text;
BEGIN
  IF NEW.fair_play_status IS DISTINCT FROM 'review' OR COALESCE(NEW.source, '') = 'site' THEN
    RETURN NEW;
  END IF;
  -- Status-only updates come from the review functions themselves.
  IF TG_OP = 'UPDATE'
     AND NEW.correct IS NOT DISTINCT FROM OLD.correct AND NEW.total IS NOT DISTINCT FROM OLD.total
     AND NEW.time_seconds IS NOT DISTINCT FROM OLD.time_seconds THEN
    RETURN NEW;
  END IF;
  SELECT c.section, c.name INTO v_section, v_name FROM public.categories c WHERE c.id = NEW.category_id;
  v_kind := CASE WHEN v_section = 'basics' THEN 'typed_basics' ELSE 'typed_round' END;
  PERFORM public.fair_play_open_review(
    NEW.student_id, 'results', NEW.id, v_kind, 'cat:' || NEW.category_id, COALESCE(v_name, 'Typed score'),
    public.fair_play_typed_reasons(v_kind, NEW.correct, NEW.total, NEW.time_seconds),
    jsonb_build_object('correct', NEW.correct, 'total', NEW.total, 'seconds', NEW.time_seconds,
                       'entry_date', NEW.entry_date));
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A review must never block saving a score.
  RAISE WARNING 'fair play review skipped for result %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fair_play_results_before ON public.results;
CREATE TRIGGER trg_fair_play_results_before
  BEFORE INSERT OR UPDATE ON public.results
  FOR EACH ROW EXECUTE FUNCTION public.fair_play_results_before();

DROP TRIGGER IF EXISTS trg_fair_play_results_after ON public.results;
CREATE TRIGGER trg_fair_play_results_after
  AFTER INSERT OR UPDATE OF correct, total, time_seconds ON public.results
  FOR EACH ROW EXECUTE FUNCTION public.fair_play_results_after();

-- ---------------------------------------------------------------------------
-- 8. XP never comes back for a voided result
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fair_play_xp_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    IF NEW.source = 'result' AND EXISTS (
         SELECT 1 FROM public.results r WHERE r.id = NEW.source_id::uuid AND r.fair_play_status = 'voided') THEN
      RETURN NULL;
    END IF;
    IF NEW.source = 'activity' AND EXISTS (
         SELECT 1 FROM public.activity_results a WHERE a.id = NEW.source_id::uuid AND a.fair_play_status = 'voided') THEN
      RETURN NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fair_play_xp_guard ON public.student_xp_events;
CREATE TRIGGER trg_fair_play_xp_guard
  BEFORE INSERT ON public.student_xp_events
  FOR EACH ROW EXECUTE FUNCTION public.fair_play_xp_guard();

-- ---------------------------------------------------------------------------
-- 9. Rate limits on practice starts and reward claims
-- ---------------------------------------------------------------------------
-- Real peak: 29 starts in 10 minutes (Flash Anzan), so 60 never touches honest practice.
CREATE OR REPLACE FUNCTION public.fair_play_session_rate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_recent integer;
BEGIN
  SELECT count(*) INTO v_recent FROM public.drill_sessions
   WHERE student_id = NEW.student_id AND started_at > now() - interval '10 minutes';
  IF v_recent >= 60 THEN
    RAISE EXCEPTION 'You have started a lot of rounds in the last few minutes. Take a short break and try again.'
      USING ERRCODE = 'P0001', HINT = 'rate_limited';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fair_play_session_rate ON public.drill_sessions;
CREATE TRIGGER trg_fair_play_session_rate
  BEFORE INSERT ON public.drill_sessions
  FOR EACH ROW EXECUTE FUNCTION public.fair_play_session_rate();

CREATE OR REPLACE FUNCTION public.fair_play_reward_rate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_recent integer;
BEGIN
  SELECT count(*) INTO v_recent FROM public.reward_redemptions
   WHERE student_id = NEW.student_id AND requested_at > now() - interval '1 day';
  IF v_recent >= 10 THEN
    RAISE EXCEPTION 'You can ask for up to 10 rewards a day. Try again tomorrow!'
      USING ERRCODE = 'P0001', HINT = 'rate_limited';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF to_regclass('public.reward_redemptions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_fair_play_reward_rate ON public.reward_redemptions;
    CREATE TRIGGER trg_fair_play_reward_rate
      BEFORE INSERT ON public.reward_redemptions
      FOR EACH ROW EXECUTE FUNCTION public.fair_play_reward_rate();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 10. Review queue, decisions, student view, thresholds editor
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fair_play_queue(p_status text DEFAULT 'open', p_limit integer DEFAULT 100)
RETURNS TABLE(id bigint, student_id uuid, student_name text, student_code text, level text,
              kind text, label text, reasons text[], detail jsonb, status text, created_at timestamptz,
              decided_at timestamptz, decision_note text, xp integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(p_status, 'open') NOT IN ('open', 'approved', 'voided', 'all') THEN
    RAISE EXCEPTION 'Unknown status';
  END IF;
  RETURN QUERY
  SELECT r.id, r.student_id, p.full_name, p.student_code, p.level, r.kind, r.label, r.reasons, r.detail,
         r.status, r.created_at, r.decided_at, r.decision_note,
         (SELECT COALESCE(sum(x.xp), 0)::integer FROM public.student_xp_events x
           WHERE x.source = CASE r.source_table WHEN 'results' THEN 'result' ELSE 'activity' END
             AND x.source_id = r.source_id::text)
    FROM public.fair_play_reviews r
    JOIN public.profiles p ON p.id = r.student_id
   WHERE (COALESCE(p_status, 'open') = 'all' OR r.status = COALESCE(p_status, 'open'))
     AND public.fair_play_can_review(r.student_id)
   ORDER BY r.created_at DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
END;
$$;

CREATE OR REPLACE FUNCTION public.fair_play_decide(p_review bigint, p_decision text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  rv public.fair_play_reviews;
  v_me uuid := auth.uid();
  v_xp_source text;
  v_snapshot jsonb;
  v_removed integer := 0;
  v_restored integer := 0;
  v_last_void jsonb;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_decision NOT IN ('approve', 'void') THEN
    RAISE EXCEPTION 'Decision must be approve or void.';
  END IF;
  SELECT * INTO rv FROM public.fair_play_reviews WHERE id = p_review FOR UPDATE;
  IF NOT FOUND OR NOT public.fair_play_can_review(rv.student_id) THEN
    RAISE EXCEPTION 'Review not found.' USING ERRCODE = 'P0002';
  END IF;
  IF (p_decision = 'approve' AND rv.status = 'approved') OR (p_decision = 'void' AND rv.status = 'voided') THEN
    RETURN jsonb_build_object('id', rv.id, 'status', rv.status, 'changed', false);
  END IF;
  v_xp_source := CASE rv.source_table WHEN 'results' THEN 'result' ELSE 'activity' END;

  IF p_decision = 'void' THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb) INTO v_snapshot
      FROM public.student_xp_events x WHERE x.source = v_xp_source AND x.source_id = rv.source_id::text;
    -- Mark first, so the XP guard blocks any re-award while we remove the rows.
    IF rv.source_table = 'results' THEN
      UPDATE public.results SET fair_play_status = 'voided' WHERE id = rv.source_id;
    ELSE
      UPDATE public.activity_results SET fair_play_status = 'voided' WHERE id = rv.source_id;
    END IF;
    DELETE FROM public.student_xp_events WHERE source = v_xp_source AND source_id = rv.source_id::text;
    GET DIAGNOSTICS v_removed = ROW_COUNT;
    UPDATE public.fair_play_reviews
       SET status = 'voided', decided_at = now(), decided_by = v_me, decision_note = p_note
     WHERE id = rv.id;
    INSERT INTO public.fair_play_audit (review_id, action, actor_id, note, snapshot)
    VALUES (rv.id, 'voided', v_me, p_note, jsonb_build_object('xp_events', v_snapshot));
  ELSE
    IF rv.source_table = 'results' THEN
      UPDATE public.results SET fair_play_status = 'approved' WHERE id = rv.source_id;
    ELSE
      UPDATE public.activity_results SET fair_play_status = 'approved' WHERE id = rv.source_id;
    END IF;
    IF rv.status = 'voided' THEN
      -- Reversing a void: put back the XP rows saved when it was voided.
      SELECT a.snapshot INTO v_last_void FROM public.fair_play_audit a
       WHERE a.review_id = rv.id AND a.action = 'voided' ORDER BY a.at DESC, a.id DESC LIMIT 1;
      INSERT INTO public.student_xp_events
      SELECT (jsonb_populate_record(NULL::public.student_xp_events, e)).*
        FROM jsonb_array_elements(COALESCE(v_last_void->'xp_events', '[]'::jsonb)) e
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS v_restored = ROW_COUNT;
    END IF;
    UPDATE public.fair_play_reviews
       SET status = 'approved', decided_at = now(), decided_by = v_me, decision_note = p_note
     WHERE id = rv.id;
    INSERT INTO public.fair_play_audit (review_id, action, actor_id, note, snapshot)
    VALUES (rv.id, CASE WHEN rv.status = 'voided' THEN 'restored' ELSE 'approved' END, v_me, p_note,
            CASE WHEN v_restored > 0 THEN jsonb_build_object('xp_rows_restored', v_restored) END);
  END IF;

  RETURN jsonb_build_object('id', rv.id, 'status', CASE p_decision WHEN 'void' THEN 'voided' ELSE 'approved' END,
                            'changed', true, 'xp_rows_removed', v_removed, 'xp_rows_restored', v_restored);
END;
$$;

-- The audit trail of one review, for reviewers.
CREATE OR REPLACE FUNCTION public.fair_play_history(p_review bigint)
RETURNS TABLE(action text, actor_name text, note text, at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_student uuid;
BEGIN
  SELECT r.student_id INTO v_student FROM public.fair_play_reviews r WHERE r.id = p_review;
  IF v_student IS NULL OR NOT public.fair_play_can_review(v_student) THEN
    RAISE EXCEPTION 'Review not found.' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY
  SELECT a.action, p.full_name, a.note, a.at
    FROM public.fair_play_audit a LEFT JOIN public.profiles p ON p.id = a.actor_id
   WHERE a.review_id = p_review ORDER BY a.at, a.id;
END;
$$;

-- The signed-in student's own results under review or not counted. No reasons, no names.
CREATE OR REPLACE FUNCTION public.my_fair_play_reviews()
RETURNS TABLE(source_id uuid, label text, status text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.source_id, r.label,
         CASE r.status WHEN 'open' THEN 'review' WHEN 'voided' THEN 'voided' ELSE 'approved' END,
         r.created_at
    FROM public.fair_play_reviews r
   WHERE r.student_id = auth.uid() AND r.status IN ('open', 'voided')
   ORDER BY r.created_at DESC
   LIMIT 50
$$;

CREATE OR REPLACE FUNCTION public.fair_play_threshold_save(
  p_kind text, p_key text, p_level text, p_reject_spq numeric, p_flag_spq numeric,
  p_max_correct integer, p_enabled boolean DEFAULT true, p_note text DEFAULT NULL)
RETURNS public.fair_play_thresholds LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_before public.fair_play_thresholds;
  v_after public.fair_play_thresholds;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only an admin can change fair-play thresholds.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_before FROM public.fair_play_thresholds
   WHERE kind = p_kind AND key = COALESCE(NULLIF(p_key, ''), '*') AND level = COALESCE(NULLIF(p_level, ''), '*');
  INSERT INTO public.fair_play_thresholds (kind, key, level, reject_spq, flag_spq, max_correct, enabled, note,
                                           updated_at, updated_by)
  VALUES (p_kind, COALESCE(NULLIF(p_key, ''), '*'), COALESCE(NULLIF(p_level, ''), '*'), p_reject_spq, p_flag_spq,
          p_max_correct, COALESCE(p_enabled, true), p_note, now(), auth.uid())
  ON CONFLICT (kind, key, level) DO UPDATE
     SET reject_spq = EXCLUDED.reject_spq, flag_spq = EXCLUDED.flag_spq, max_correct = EXCLUDED.max_correct,
         enabled = EXCLUDED.enabled, note = EXCLUDED.note, updated_at = now(), updated_by = auth.uid()
  RETURNING * INTO v_after;
  INSERT INTO public.fair_play_audit (action, actor_id, snapshot)
  VALUES ('threshold_saved', auth.uid(), jsonb_build_object('before', to_jsonb(v_before), 'after', to_jsonb(v_after)));
  RETURN v_after;
END;
$$;

-- ---------------------------------------------------------------------------
-- 11. Boards skip voided results; record boards hold results under review
--     (the student still sees their own). Patches the live definitions in place,
--     so it composes with whichever version of these functions is deployed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fair_play_patch_function(p_signature text)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_oid regprocedure := to_regprocedure(p_signature);
  v_def text;
  v_new text;
  v_hits integer := 0;
BEGIN
  IF v_oid IS NULL THEN
    RETURN 0;
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF position('fair_play_status' IN v_def) > 0 THEN
    RETURN -1;   -- already patched
  END IF;
  v_new := regexp_replace(v_def, 'FROM public\.results (r|res)\M',
    'FROM (SELECT * FROM public.results WHERE fair_play_status IS DISTINCT FROM ''voided'' AND (fair_play_status IS DISTINCT FROM ''review'' OR student_id = auth.uid())) \1', 'g');
  v_new := regexp_replace(v_new, 'FROM public\.activity_results (ar|a)\M',
    'FROM (SELECT * FROM public.activity_results WHERE fair_play_status IS DISTINCT FROM ''voided'' AND (fair_play_status IS DISTINCT FROM ''review'' OR student_id = auth.uid())) \1', 'g');
  IF v_new = v_def THEN
    RAISE EXCEPTION 'fair play: no results read found in %', p_signature;
  END IF;
  v_hits := (length(v_new) - length(replace(v_new, 'fair_play_status IS DISTINCT FROM ''voided''', ''))) / length('fair_play_status IS DISTINCT FROM ''voided''');
  EXECUTE v_new;
  RETURN v_hits;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.fair_play_patch_function(text) FROM PUBLIC;

SELECT public.fair_play_patch_function('public.practice_highest_records(text,jsonb)');
SELECT public.fair_play_patch_function('public.leaderboard(text,text,text,integer,text)');

-- ---------------------------------------------------------------------------
-- 12. Grants
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.fair_play_rate_hit(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fair_play_open_review(uuid, text, uuid, text, text, text, text[], jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fair_play_typed_reasons(text, integer, integer, numeric) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fair_play_threshold(text, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fair_play_can_review(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fair_play_queue(text, integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fair_play_decide(bigint, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fair_play_history(bigint) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.my_fair_play_reviews() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fair_play_threshold_save(text, text, text, numeric, numeric, integer, boolean, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fair_play_rate_hit(uuid, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fair_play_open_review(uuid, text, uuid, text, text, text, text[], jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.fair_play_typed_reasons(text, integer, integer, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fair_play_threshold(text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fair_play_can_review(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fair_play_queue(text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fair_play_decide(bigint, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fair_play_history(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_fair_play_reviews() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fair_play_threshold_save(text, text, text, numeric, numeric, integer, boolean, text) TO authenticated;
