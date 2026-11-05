-- ==============================================================================
-- Migration 15: Private Admin-to-Student Messages, Record Linking & Flag Alerts
-- Phase 17 — Trendz Tracker
--
-- Features:
-- 1. Table: public.student_messages
--    - Stores private notes from admins to students
--    - Optional linking to score (results), weekly test (weekly_tests), or attempt (weekly_test_attempts)
--    - Optional "Needs attention" flag and explanatory note
--    - Client nonce for idempotent retry protection
-- 2. RLS & Immutability:
--    - Admins have full access
--    - Students can SELECT only their own messages
--    - Students can UPDATE only read_at and dismissed_at (trigger prevents tampering with message content, links, sender, recipient, or client_nonce)
-- 3. Atomic RPC: public.admin_send_student_message
--    - Validates student eligibility and existence
--    - Validates linked record ownership (ensures score or attempt belongs to recipient)
--    - Validates weekly test reference and deployed audience eligibility
--    - Atomically updates results.flagged and records result_audit if "Needs attention" is flagged on a score
--    - Idempotent against client_nonce retries, safe under concurrent calls, and rejects nonce reuse with differing payloads
--    - Generates deep links opening the exact record (score, test, attempt)
-- 4. Notification Integration:
--    - Client fetches and merges student messages directly with my_notifications()
--    - RPC public.dismiss_notification(p_ref) preserves live RETURNS void signature, search_path,
--      and existing test/announcement dismissal behavior while extending it safely for msg:<uuid>
--    - RPC public.mark_student_message_read(p_msg_id) records read timestamp
-- ==============================================================================

-- 1. Table public.student_messages
CREATE TABLE IF NOT EXISTS public.student_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  title VARCHAR(120) NOT NULL,
  body TEXT NOT NULL,
  needs_attention BOOLEAN NOT NULL DEFAULT false,
  attention_reason TEXT NULL,
  linked_type VARCHAR(30) NULL CHECK (linked_type IN ('score', 'weekly_test', 'attempt')),
  linked_id UUID NULL,
  link TEXT NULL,
  client_nonce VARCHAR(64) NULL,
  read_at TIMESTAMPTZ NULL,
  dismissed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_student_message_title CHECK (char_length(trim(title)) >= 1 AND char_length(title) <= 120),
  CONSTRAINT chk_student_message_body CHECK (char_length(trim(body)) >= 1 AND char_length(body) <= 2000)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_student_messages_client_nonce
  ON public.student_messages(sender_id, client_nonce)
  WHERE client_nonce IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_student_messages_student_active
  ON public.student_messages(student_id, created_at DESC)
  WHERE dismissed_at IS NULL;

-- 2. Row Level Security & Explicit Grants
ALTER TABLE public.student_messages ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.student_messages FROM PUBLIC;
REVOKE ALL ON TABLE public.student_messages FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.student_messages TO authenticated;
GRANT ALL ON TABLE public.student_messages TO service_role;

DROP POLICY IF EXISTS "student_messages_admin_all" ON public.student_messages;
CREATE POLICY "student_messages_admin_all"
  ON public.student_messages
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin' AND active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin' AND active = true
    )
  );

DROP POLICY IF EXISTS "student_messages_student_select" ON public.student_messages;
CREATE POLICY "student_messages_student_select"
  ON public.student_messages
  FOR SELECT
  TO authenticated
  USING (
    student_id = auth.uid()
  );

DROP POLICY IF EXISTS "student_messages_student_update" ON public.student_messages;
CREATE POLICY "student_messages_student_update"
  ON public.student_messages
  FOR UPDATE
  TO authenticated
  USING (
    student_id = auth.uid()
  )
  WITH CHECK (
    student_id = auth.uid()
  );

-- 3. Student Immutability Trigger (students can only change read_at and dismissed_at)
CREATE OR REPLACE FUNCTION public.trg_student_messages_protect_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin' AND active = true
  ) THEN
    IF NEW.id <> OLD.id
       OR NEW.student_id <> OLD.student_id
       OR NEW.sender_id <> OLD.sender_id
       OR NEW.title <> OLD.title
       OR NEW.body <> OLD.body
       OR NEW.needs_attention <> OLD.needs_attention
       OR NEW.attention_reason IS DISTINCT FROM OLD.attention_reason
       OR NEW.linked_type IS DISTINCT FROM OLD.linked_type
       OR NEW.linked_id IS DISTINCT FROM OLD.linked_id
       OR NEW.link IS DISTINCT FROM OLD.link
       OR NEW.client_nonce IS DISTINCT FROM OLD.client_nonce
       OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'Unauthorized: Students cannot modify message content, links, sender, recipient, or nonce';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_student_messages_protect ON public.student_messages;
CREATE TRIGGER trg_student_messages_protect
  BEFORE UPDATE ON public.student_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_student_messages_protect_immutability();

-- 4. Atomic RPC: public.admin_send_student_message
CREATE OR REPLACE FUNCTION public.admin_send_student_message(
  p_student_id UUID,
  p_title TEXT,
  p_body TEXT,
  p_needs_attention BOOLEAN DEFAULT false,
  p_attention_reason TEXT DEFAULT NULL,
  p_linked_type TEXT DEFAULT NULL,
  p_linked_id UUID DEFAULT NULL,
  p_client_nonce TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller_id UUID;
  v_student_level TEXT;
  v_clean_title TEXT;
  v_clean_body TEXT;
  v_clean_reason TEXT;
  v_clean_link TEXT;
  v_clean_linked_type TEXT;
  v_existing_msg RECORD;
  v_new_msg RECORD;
  v_result_row RECORD;
  v_cat_section TEXT;
  v_student_round_id UUID;
  v_test_row RECORD;
  v_attempt_row RECORD;
BEGIN
  v_caller_id := auth.uid();

  -- Verify caller is active admin (or service role)
  IF auth.role() <> 'service_role' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = v_caller_id AND role = 'admin' AND active = true
    ) THEN
      RAISE EXCEPTION 'Unauthorized: only active administrators can send student messages';
    END IF;
  END IF;

  -- Validate recipient student
  SELECT level INTO v_student_level
  FROM public.profiles
  WHERE id = p_student_id AND role = 'student' AND active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Recipient student not found or deactivated';
  END IF;

  -- Validate title & body
  v_clean_title := TRIM(COALESCE(p_title, ''));
  v_clean_body := TRIM(COALESCE(p_body, ''));
  v_clean_reason := NULLIF(TRIM(COALESCE(p_attention_reason, '')), '');
  v_clean_linked_type := NULLIF(TRIM(COALESCE(p_linked_type, '')), '');

  IF char_length(v_clean_title) < 1 OR char_length(v_clean_title) > 120 THEN
    RAISE EXCEPTION 'Title must be between 1 and 120 characters';
  END IF;

  IF char_length(v_clean_body) < 1 OR char_length(v_clean_body) > 2000 THEN
    RAISE EXCEPTION 'Body must be between 1 and 2000 characters';
  END IF;

  -- Idempotent check on client_nonce with transaction serialization
  IF p_client_nonce IS NOT NULL AND btrim(p_client_nonce) <> '' THEN
    -- Serialize concurrent requests for this sender + client_nonce
    PERFORM pg_advisory_xact_lock(hashtext(v_caller_id::text), hashtext(btrim(p_client_nonce)));

    SELECT * INTO v_existing_msg
    FROM public.student_messages
    WHERE sender_id = v_caller_id AND client_nonce = btrim(p_client_nonce);

    IF FOUND THEN
      -- Reject reuse with different recipient or payload
      IF v_existing_msg.student_id <> p_student_id
         OR v_existing_msg.title <> v_clean_title
         OR v_existing_msg.body <> v_clean_body
         OR v_existing_msg.needs_attention <> COALESCE(p_needs_attention, false)
         OR v_existing_msg.attention_reason IS DISTINCT FROM v_clean_reason
         OR v_existing_msg.linked_type IS DISTINCT FROM v_clean_linked_type
         OR v_existing_msg.linked_id IS DISTINCT FROM p_linked_id THEN
        RAISE EXCEPTION 'Nonce reuse detected: client_nonce has already been used with different parameters'
          USING ERRCODE = '23505';
      END IF;

      RETURN to_jsonb(v_existing_msg);
    END IF;
  END IF;

  -- Validate linked record & ownership
  IF v_clean_linked_type = 'score' THEN
    IF p_linked_id IS NULL THEN
      RAISE EXCEPTION 'Missing linked score ID';
    END IF;

    -- Lock the score row before capturing its previous flag state
    SELECT id, student_id, category_id, student_round_id, flagged, flag_note INTO v_result_row
    FROM public.results
    WHERE id = p_linked_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Linked score not found';
    END IF;

    IF v_result_row.student_id <> p_student_id THEN
      RAISE EXCEPTION 'Linked score does not belong to the recipient student';
    END IF;

    -- Resolve category section for specific deep link
    SELECT section INTO v_cat_section
    FROM public.categories
    WHERE id = v_result_row.category_id;

    IF v_cat_section = 'round' THEN
      IF v_result_row.student_round_id IS NOT NULL THEN
        v_clean_link := '/pages/round-scores.html?roundId=' || v_result_row.student_round_id || '&resultId=' || p_linked_id;
      ELSE
        v_clean_link := '/pages/round-scores.html?resultId=' || p_linked_id;
      END IF;
    ELSE
      v_clean_link := '/pages/basics.html?resultId=' || p_linked_id;
    END IF;

  ELSIF v_clean_linked_type = 'attempt' THEN
    IF p_linked_id IS NULL THEN
      RAISE EXCEPTION 'Missing linked attempt ID';
    END IF;

    SELECT id, test_id, student_id INTO v_attempt_row
    FROM public.weekly_test_attempts
    WHERE id = p_linked_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Linked weekly test attempt not found';
    END IF;

    IF v_attempt_row.student_id <> p_student_id THEN
      RAISE EXCEPTION 'Linked attempt does not belong to the recipient student';
    END IF;

    v_clean_link := '/pages/weekly-test.html?testId=' || v_attempt_row.test_id || '&attemptId=' || p_linked_id;

  ELSIF v_clean_linked_type = 'weekly_test' THEN
    IF p_linked_id IS NULL THEN
      RAISE EXCEPTION 'Missing linked weekly test ID';
    END IF;

    SELECT id, audience_level INTO v_test_row
    FROM public.weekly_tests
    WHERE id = p_linked_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Linked weekly test not found';
    END IF;

    -- Validate audience level eligibility using deployed live semantics (NULL means all students)
    IF v_test_row.audience_level IS NOT NULL
       AND (v_student_level IS NULL OR v_test_row.audience_level <> v_student_level) THEN
      RAISE EXCEPTION 'Weekly test is not assigned to recipient student level';
    END IF;

    v_clean_link := '/pages/weekly-test.html?testId=' || p_linked_id;

  ELSIF v_clean_linked_type IS NULL THEN
    v_clean_link := '/pages/student.html';
  ELSE
    RAISE EXCEPTION 'Invalid linked_type: %, must be score, weekly_test, or attempt', p_linked_type;
  END IF;

  -- Insert private message record FIRST with concurrency-safe nonce retry handling
  BEGIN
    INSERT INTO public.student_messages (
      student_id,
      sender_id,
      title,
      body,
      needs_attention,
      attention_reason,
      linked_type,
      linked_id,
      link,
      client_nonce
    ) VALUES (
      p_student_id,
      v_caller_id,
      v_clean_title,
      v_clean_body,
      COALESCE(p_needs_attention, false),
      v_clean_reason,
      v_clean_linked_type,
      p_linked_id,
      v_clean_link,
      NULLIF(btrim(p_client_nonce), '')
    )
    RETURNING * INTO v_new_msg;
  EXCEPTION WHEN unique_violation THEN
    IF p_client_nonce IS NOT NULL AND btrim(p_client_nonce) <> '' THEN
      SELECT * INTO v_existing_msg
      FROM public.student_messages
      WHERE sender_id = v_caller_id AND client_nonce = btrim(p_client_nonce);

      IF FOUND THEN
        IF v_existing_msg.student_id <> p_student_id
           OR v_existing_msg.title <> v_clean_title
           OR v_existing_msg.body <> v_clean_body
           OR v_existing_msg.needs_attention <> COALESCE(p_needs_attention, false)
           OR v_existing_msg.attention_reason IS DISTINCT FROM v_clean_reason
           OR v_existing_msg.linked_type IS DISTINCT FROM v_clean_linked_type
           OR v_existing_msg.linked_id IS DISTINCT FROM p_linked_id THEN
          RAISE EXCEPTION 'Nonce reuse detected: client_nonce has already been used with different parameters'
            USING ERRCODE = '23505';
        END IF;

        RETURN to_jsonb(v_existing_msg);
      END IF;
    END IF;
    RAISE;
  END;

  -- If needs attention is requested on a score, atomically flag and write audit entry in the same transaction
  IF v_clean_linked_type = 'score' AND p_needs_attention = true THEN
    UPDATE public.results
    SET flagged = true,
        flag_note = COALESCE(v_clean_reason, v_clean_title)
    WHERE id = p_linked_id;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'result_audit') THEN
      INSERT INTO public.result_audit (result_id, student_id, changed_by, action, old_values, new_values, reason)
      VALUES (
        p_linked_id,
        p_student_id,
        v_caller_id,
        'flag',
        jsonb_build_object('flagged', v_result_row.flagged, 'flag_note', v_result_row.flag_note),
        jsonb_build_object('flagged', true, 'flag_note', COALESCE(v_clean_reason, v_clean_title)),
        COALESCE(v_clean_reason, 'Teacher flagged via private message')
      );
    END IF;
  END IF;

  RETURN to_jsonb(v_new_msg);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_send_student_message(UUID, TEXT, TEXT, BOOLEAN, TEXT, TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_send_student_message(UUID, TEXT, TEXT, BOOLEAN, TEXT, TEXT, UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_send_student_message(UUID, TEXT, TEXT, BOOLEAN, TEXT, TEXT, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_send_student_message(UUID, TEXT, TEXT, BOOLEAN, TEXT, TEXT, UUID, TEXT) TO service_role;

-- 5. RPC public.mark_student_message_read
CREATE OR REPLACE FUNCTION public.mark_student_message_read(p_msg_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  UPDATE public.student_messages
  SET read_at = COALESCE(read_at, now())
  WHERE id = p_msg_id AND student_id = auth.uid();

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_student_message_read(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_student_message_read(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.mark_student_message_read(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_student_message_read(UUID) TO service_role;

-- 6. Updated RPC public.dismiss_notification
-- Preserves live deployed signature (RETURNS void), SET search_path TO 'public',
-- and all existing dismissals for test/announcement while safely extending for msg:<uuid>
CREATE OR REPLACE FUNCTION public.dismiss_notification(p_ref TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_msg_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  IF p_ref IS NULL OR length(p_ref) > 80 THEN
    RAISE EXCEPTION 'Invalid notification.';
  END IF;

  -- 1. Private student message dismissal
  IF p_ref ~ '^msg:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_msg_id := (SUBSTRING(p_ref FROM 5))::UUID;

    UPDATE public.student_messages
    SET dismissed_at = now()
    WHERE id = v_msg_id AND student_id = auth.uid();

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Message not found or unauthorized';
    END IF;

    INSERT INTO public.notification_dismissals (student_id, ref)
    VALUES (auth.uid(), p_ref)
    ON CONFLICT DO NOTHING;

  -- 2. Weekly test reminders and announcements (live behavior preserved exactly)
  ELSIF p_ref ~ '^(test|ann):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:(upcoming|tomorrow|today))?$' THEN
    INSERT INTO public.notification_dismissals (student_id, ref)
    VALUES (auth.uid(), p_ref)
    ON CONFLICT DO NOTHING;

  ELSE
    RAISE EXCEPTION 'Invalid notification.';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.dismiss_notification(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dismiss_notification(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.dismiss_notification(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dismiss_notification(TEXT) TO service_role;
