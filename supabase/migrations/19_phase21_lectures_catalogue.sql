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
--    - Active lessons are available to staff and eligible students
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
  USING (
    public.is_admin()
    OR (
      status = 'active'
      AND EXISTS (
        SELECT 1 FROM public.lecture_categories AS category
        WHERE category.id = lectures.category_id AND category.active
      )
      AND EXISTS (
        SELECT 1 FROM public.profiles AS profile
        WHERE profile.id = (SELECT auth.uid())
          AND profile.active
          AND (
            profile.role = 'teacher'
            OR (profile.role = 'student' AND (lectures.target_level IS NULL OR lectures.target_level = profile.level))
          )
      )
    )
  );

DROP POLICY IF EXISTS "Admins have full access to lectures" ON public.lectures;
CREATE POLICY "Admins have full access to lectures"
  ON public.lectures
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- 6. Ensure unique constraint for atomic upsert
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_lectures_category_lesson_order'
  ) THEN
    ALTER TABLE public.lectures ADD CONSTRAINT uq_lectures_category_lesson_order UNIQUE (category_id, lesson_order);
  END IF;
END $$;

-- 7. Grant minimum privileges
REVOKE ALL ON public.lecture_categories, public.lectures FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lecture_categories, public.lectures TO authenticated;

-- 8. Transactional atomic catalogue publication routine
CREATE OR REPLACE FUNCTION public.publish_classroom_catalogue(p_manifest JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_category JSONB;
  v_lesson JSONB;
  v_cat_id UUID;
  v_cat_title TEXT;
  v_cat_slug TEXT;
  v_cat_desc TEXT;
  v_cat_order INT;
  v_lec_title TEXT;
  v_lec_slug TEXT;
  v_lec_order INT;
  v_lec_duration INT;
  v_lec_media_type TEXT;
  v_lec_media_url TEXT;
  v_lec_thumb_url TEXT;
  v_lec_notes TEXT;
  v_lec_level TEXT;
  v_imported_cats INT := 0;
  v_imported_lecs INT := 0;
  v_idx INT := 0;
  v_lidx INT := 0;
BEGIN
  -- Strict Admin check at database boundary (trusted service_role or authenticated admin)
  IF NOT (
    COALESCE(
      NULLIF(current_setting('request.jwt.claim.role', true), ''),
      NULLIF(auth.role(), ''),
      NULLIF(current_setting('role', true), ''),
      ''
    ) = 'service_role'
    OR public.is_admin()
  ) THEN
    RAISE EXCEPTION 'Forbidden: Only administrators can publish lecture catalogues.'
      USING ERRCODE = '42501';
  END IF;

  IF p_manifest IS NULL OR NOT (p_manifest ? 'categories') OR jsonb_array_length(p_manifest->'categories') = 0 THEN
    RAISE EXCEPTION 'Invalid manifest: categories array is required.'
      USING ERRCODE = '22023';
  END IF;

  FOR v_category IN SELECT * FROM jsonb_array_elements(p_manifest->'categories')
  LOOP
    v_idx := v_idx + 1;
    v_cat_title := trim(v_category->>'title');
    v_cat_slug := COALESCE(NULLIF(trim(v_category->>'slug'), ''), lower(regexp_replace(v_cat_title, '[^a-zA-Z0-9]+', '-', 'g')));
    v_cat_desc := v_category->>'description';
    v_cat_order := COALESCE((v_category->>'sortOrder')::INT, v_idx);

    IF v_cat_title IS NULL OR v_cat_title = '' THEN
      RAISE EXCEPTION 'Category #% missing title.', v_idx USING ERRCODE = '22023';
    END IF;

    -- Upsert category
    INSERT INTO public.lecture_categories (title, slug, description, sort_order, active, updated_at)
    VALUES (v_cat_title, v_cat_slug, v_cat_desc, v_cat_order, true, now())
    ON CONFLICT (slug) DO UPDATE SET
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order,
      active = true,
      updated_at = now()
    RETURNING id INTO v_cat_id;

    v_imported_cats := v_imported_cats + 1;

    -- Upsert lessons
    IF v_category ? 'lessons' AND jsonb_typeof(v_category->'lessons') = 'array' THEN
      v_lidx := 0;
      FOR v_lesson IN SELECT * FROM jsonb_array_elements(v_category->'lessons')
      LOOP
        v_lidx := v_lidx + 1;
        v_lec_title := trim(v_lesson->>'title');
        v_lec_order := COALESCE((v_lesson->>'lessonOrder')::INT, v_lidx);
        v_lec_slug := COALESCE(NULLIF(trim(v_lesson->>'slug'), ''), v_cat_slug || '-part-' || v_lec_order);
        v_lec_duration := COALESCE((v_lesson->>'durationSeconds')::INT, 0);
        v_lec_media_type := COALESCE(NULLIF(trim(v_lesson->>'mediaType'), ''), 'video_mp4');
        v_lec_media_url := trim(v_lesson->>'mediaUrl');
        v_lec_thumb_url := v_lesson->>'thumbnailUrl';
        v_lec_notes := v_lesson->>'notes';
        v_lec_level := v_lesson->>'targetLevel';

        IF v_lec_title IS NULL OR v_lec_title = '' THEN
          RAISE EXCEPTION 'Lesson #% in category % missing title.', v_lidx, v_cat_title USING ERRCODE = '22023';
        END IF;

        -- Validate media URL: http://, https://, or storage:// / private:// references
        IF v_lec_media_url IS NULL OR (
          v_lec_media_url NOT LIKE 'http://%' AND
          v_lec_media_url NOT LIKE 'https://%' AND
          v_lec_media_url NOT LIKE 'storage://%' AND
          v_lec_media_url NOT LIKE 'private://%'
        ) THEN
          RAISE EXCEPTION 'Lesson "%" in category % has invalid media URL.', v_lec_title, v_cat_title USING ERRCODE = '22023';
        END IF;

        IF v_lec_media_url ~ '/file/d/1[A-Z0-9]+(_[A-Z0-9]+)+/(preview|view)([?#]|$)' THEN
          RAISE EXCEPTION 'Lesson "%" needs a verified video reference.', v_lec_title USING ERRCODE = '22023';
        END IF;

        -- Enforce configured private lectures bucket for storage references
        IF v_lec_media_url LIKE 'storage://%' OR v_lec_media_url LIKE 'private://%' THEN
          IF v_lec_media_url NOT LIKE 'storage://lectures/%' AND v_lec_media_url NOT LIKE 'private://lectures/%' THEN
            RAISE EXCEPTION 'Lesson "%" in category % references unauthorized storage bucket. Storage references must point to the configured "lectures" bucket.', v_lec_title, v_cat_title USING ERRCODE = '22023';
          END IF;
        END IF;

        INSERT INTO public.lectures (
          category_id,
          title,
          slug,
          lesson_order,
          duration_seconds,
          media_type,
          media_url,
          thumbnail_url,
          notes,
          target_level,
          status,
          updated_at
        )
        VALUES (
          v_cat_id,
          v_lec_title,
          v_lec_slug,
          v_lec_order,
          v_lec_duration,
          v_lec_media_type,
          v_lec_media_url,
          v_lec_thumb_url,
          v_lec_notes,
          v_lec_level,
          'active',
          now()
        )
        ON CONFLICT (category_id, lesson_order) DO UPDATE SET
          title = EXCLUDED.title,
          slug = EXCLUDED.slug,
          duration_seconds = EXCLUDED.duration_seconds,
          media_type = EXCLUDED.media_type,
          media_url = EXCLUDED.media_url,
          thumbnail_url = EXCLUDED.thumbnail_url,
          notes = EXCLUDED.notes,
          target_level = EXCLUDED.target_level,
          status = 'active',
          updated_at = now();

        v_imported_lecs := v_imported_lecs + 1;
      END LOOP;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'importedCategories', v_imported_cats,
    'importedLectures', v_imported_lecs
  );
END;
$$;

REVOKE ALL ON FUNCTION public.publish_classroom_catalogue(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.publish_classroom_catalogue(JSONB) TO authenticated, service_role;
