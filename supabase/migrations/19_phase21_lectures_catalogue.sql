-- =====================================================================
-- Migration 19: Phase 21 Resources Lectures Catalogue (Google Classroom)
-- File: supabase/migrations/19_phase21_lectures_catalogue.sql
--
-- Features:
-- 1. public.lecture_categories:
--    - Stores categories matching Google Classroom structure (e.g. Addition, Subtraction, Mixed)
--    - Slugs, sorting order, active flag
-- 2. public.lectures:
--    - Stores individual video lessons ordered within their category
--    - Preserves sequential structure (e.g. Jr. MCWC Addition 3 videos in order)
--    - Supports drive_embed, video_mp4, and youtube_embed media types
-- 3. Strict Row Level Security:
--    - Active categories and published lessons viewable by all authenticated students/staff
--    - Modifications, draft management, and import strictly Admin-only
-- =====================================================================

-- 1. Create public.lecture_categories
CREATE TABLE IF NOT EXISTS public.lecture_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lecture_categories_sort_order ON public.lecture_categories(sort_order);
CREATE INDEX IF NOT EXISTS idx_lecture_categories_active ON public.lecture_categories(active);

-- 2. Create public.lectures
CREATE TABLE IF NOT EXISTS public.lectures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID NOT NULL REFERENCES public.lecture_categories(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  slug TEXT,
  lesson_order INTEGER NOT NULL DEFAULT 1,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  media_type TEXT NOT NULL DEFAULT 'drive_embed' CHECK (media_type IN ('video_mp4', 'drive_embed', 'youtube_embed', 'hls')),
  media_url TEXT NOT NULL,
  thumbnail_url TEXT,
  notes TEXT,
  target_level TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'archived')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lectures_category_id ON public.lectures(category_id);
CREATE INDEX IF NOT EXISTS idx_lectures_lesson_order ON public.lectures(category_id, lesson_order);
CREATE INDEX IF NOT EXISTS idx_lectures_status ON public.lectures(status);

-- 3. Enable Row Level Security (RLS)
ALTER TABLE public.lecture_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lectures ENABLE ROW LEVEL SECURITY;

-- 4. Policies for lecture_categories
DROP POLICY IF EXISTS "Authenticated users can view active lecture categories" ON public.lecture_categories;
CREATE POLICY "Authenticated users can view active lecture categories"
  ON public.lecture_categories
  FOR SELECT
  TO authenticated
  USING (active = true OR public.is_admin());

DROP POLICY IF EXISTS "Admins have full access to lecture categories" ON public.lecture_categories;
CREATE POLICY "Admins have full access to lecture categories"
  ON public.lecture_categories
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- 5. Policies for lectures
DROP POLICY IF EXISTS "Authenticated users can view active lectures" ON public.lectures;
CREATE POLICY "Authenticated users can view active lectures"
  ON public.lectures
  FOR SELECT
  TO authenticated
  USING (status = 'active' OR public.is_admin());

DROP POLICY IF EXISTS "Admins have full access to lectures" ON public.lectures;
CREATE POLICY "Admins have full access to lectures"
  ON public.lectures
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- 6. Grant minimum privileges
REVOKE ALL ON public.lecture_categories, public.lectures FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lecture_categories, public.lectures TO authenticated;
