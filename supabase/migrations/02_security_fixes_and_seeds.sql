-- ==============================================================================
-- 02_security_fixes_and_seeds.sql
-- Security Fixes: Safe Sign-Up Trigger (never trust user_metadata role),
-- Categories Uniqueness Fix, and Full Basics Seeds
-- Run Order: 2 of 12
-- ==============================================================================

-- 1. Safe sign-up trigger: NEVER allow raw_user_meta_data to self-promote to 'admin'.
-- Every newly created auth user starts strictly as 'student'; admins are promoted only
-- via SQL or service_role.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, student_code, full_name, role, level, active)
  VALUES (
    NEW.id,
    COALESCE(NULLIF(TRIM(NEW.raw_user_meta_data->>'student_code'), ''), UPPER(split_part(NEW.email, '@', 1))),
    COALESCE(NULLIF(TRIM(NEW.raw_user_meta_data->>'full_name'), ''), 'Student User'),
    'student',
    NULLIF(TRIM(NEW.raw_user_meta_data->>'level'), ''),
    true
  )
  ON CONFLICT (id) DO UPDATE SET
    student_code = EXCLUDED.student_code,
    full_name = EXCLUDED.full_name,
    level = EXCLUDED.level;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- 2. Categories uniqueness fix (case-insensitive per section)
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_unique_section_name
ON public.categories (section, LOWER(TRIM(name)));

-- 3. Additional Basics speed drill category seeds
INSERT INTO public.categories (name, section, sort_order, active)
VALUES
  ('1d4r', 'basics', 1, true),
  ('1d5r', 'basics', 2, true),
  ('1d10r', 'basics', 3, true),
  ('2d2r', 'basics', 4, true),
  ('2d3r', 'basics', 5, true),
  ('2d4r', 'basics', 6, true),
  ('2d5r', 'basics', 7, true),
  ('3d2r', 'basics', 8, true),
  ('3d3r', 'basics', 9, true)
ON CONFLICT DO NOTHING;
