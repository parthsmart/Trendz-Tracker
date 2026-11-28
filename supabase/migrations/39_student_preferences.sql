-- Phase 39: comfort settings that follow a person across devices.
--
--   * student_preferences: one row per signed-in person (students mostly, but staff
--     can keep a theme too). prefs holds only the values that differ from the
--     defaults in shared/studentPrefs.js (sound, volume, music, musicInTests,
--     vibrate, theme, largeNumbers, motion).
--   * The table is service-role only; the browser reads and writes its own row
--     through my_preferences() / save_my_preferences(jsonb), which use auth.uid().
--   * student_prefs_clean(jsonb) keeps only known keys with allowed values, so
--     nothing else can be stored here. Mirrors normalizePrefs()/diffFromDefaults().

CREATE TABLE IF NOT EXISTS public.student_preferences (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT student_preferences_prefs_object CHECK (jsonb_typeof(prefs) = 'object'),
  CONSTRAINT student_preferences_prefs_small CHECK (pg_column_size(prefs) < 2048)
);

ALTER TABLE public.student_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.student_preferences FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.student_prefs_clean(p jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path = public
AS $function$
  SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb)
  FROM jsonb_each(CASE WHEN jsonb_typeof(p) = 'object' THEN p ELSE '{}'::jsonb END) AS e(k, v)
  WHERE (k IN ('sound', 'music', 'musicInTests', 'vibrate', 'largeNumbers') AND jsonb_typeof(v) = 'boolean')
     OR (k = 'theme' AND v #>> '{}' IN ('system', 'light', 'dark'))
     OR (k = 'motion' AND v #>> '{}' IN ('auto', 'full', 'lite', 'off'))
     OR (k = 'volume' AND jsonb_typeof(v) = 'number' AND (v #>> '{}')::numeric IN (0.25, 0.5, 0.75, 1));
$function$;

CREATE OR REPLACE FUNCTION public.my_preferences()
 RETURNS TABLE (prefs jsonb, updated_at timestamptz)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = public
AS $function$
  SELECT sp.prefs, sp.updated_at
  FROM public.student_preferences sp
  WHERE sp.user_id = auth.uid();
$function$;

CREATE OR REPLACE FUNCTION public.save_my_preferences(p_prefs jsonb)
 RETURNS timestamptz
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_at timestamptz := now();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not signed in' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_uid AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'no profile' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.student_preferences (user_id, prefs, updated_at)
  VALUES (v_uid, public.student_prefs_clean(p_prefs), v_at)
  ON CONFLICT (user_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = EXCLUDED.updated_at;
  RETURN v_at;
END;
$function$;

REVOKE ALL ON FUNCTION public.student_prefs_clean(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.my_preferences() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_my_preferences(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_preferences() TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_my_preferences(jsonb) TO authenticated;
