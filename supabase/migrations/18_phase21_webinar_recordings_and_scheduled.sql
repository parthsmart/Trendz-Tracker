-- =====================================================================
-- Migration 18: Phase 21 Webinar Recordings Library & Scheduled Video
-- File: supabase/migrations/18_phase21_webinar_recordings_and_scheduled.sql
--
-- Features:
-- 1. Automatic recording configuration and scheduled class type flags on live_classes:
--    - class_type: 'live' | 'prerecorded' | 'stream'
--    - recording_enabled: boolean (default true)
--    - prerecorded_asset_url: text
--    - stream_url: text
-- 2. Private Admin Recordings Library table: public.live_class_recordings
--    - Linked to live_classes(id) and webinar_id
--    - Status tracking ('processing', 'ready', 'failed', 'deleted')
--    - Server-authorized playback URL and metadata
-- 3. Recording Deletion Audit Log: public.live_class_recording_audit_log
-- 4. Strict Row Level Security: Admin only (Students and Teachers have ZERO access)
-- =====================================================================

-- 1. Extend public.live_classes with class_type and recording controls
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'live_classes' AND column_name = 'class_type'
  ) THEN
    ALTER TABLE public.live_classes
      ADD COLUMN class_type TEXT NOT NULL DEFAULT 'live'
      CHECK (class_type IN ('live', 'prerecorded', 'stream'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'live_classes' AND column_name = 'recording_enabled'
  ) THEN
    ALTER TABLE public.live_classes
      ADD COLUMN recording_enabled BOOLEAN NOT NULL DEFAULT true;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'live_classes' AND column_name = 'prerecorded_asset_url'
  ) THEN
    ALTER TABLE public.live_classes
      ADD COLUMN prerecorded_asset_url TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'live_classes' AND column_name = 'stream_url'
  ) THEN
    ALTER TABLE public.live_classes
      ADD COLUMN stream_url TEXT;
  END IF;
END $$;

-- 2. Create public.live_class_recordings
CREATE TABLE IF NOT EXISTS public.live_class_recordings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id UUID NOT NULL REFERENCES public.live_classes(id) ON DELETE CASCADE,
  webinar_id TEXT NOT NULL,
  recording_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'failed', 'deleted')),
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  playback_url TEXT,
  download_url TEXT,
  file_size_bytes BIGINT,
  recorded_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  deleted_by UUID REFERENCES public.profiles(id),
  deletion_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_live_class_recordings_class_id ON public.live_class_recordings(class_id);
CREATE INDEX IF NOT EXISTS idx_live_class_recordings_webinar_id ON public.live_class_recordings(webinar_id);
CREATE INDEX IF NOT EXISTS idx_live_class_recordings_status ON public.live_class_recordings(status);

-- 3. Create public.live_class_recording_audit_log
CREATE TABLE IF NOT EXISTS public.live_class_recording_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id UUID REFERENCES public.live_class_recordings(id) ON DELETE SET NULL,
  class_id UUID REFERENCES public.live_classes(id) ON DELETE SET NULL,
  webinar_id TEXT NOT NULL,
  action TEXT NOT NULL,
  performed_by UUID NOT NULL REFERENCES public.profiles(id),
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recording_audit_performed_by ON public.live_class_recording_audit_log(performed_by);
CREATE INDEX IF NOT EXISTS idx_recording_audit_created_at ON public.live_class_recording_audit_log(created_at);

-- 4. Enable Row Level Security (RLS)
ALTER TABLE public.live_class_recordings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_class_recording_audit_log ENABLE ROW LEVEL SECURITY;

-- 5. Policies: Strictly Admin-only (Zero Student or Teacher access)
DROP POLICY IF EXISTS "Admins have full access to live_class_recordings" ON public.live_class_recordings;
CREATE POLICY "Admins have full access to live_class_recordings"
  ON public.live_class_recordings
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admins have full access to live_class_recording_audit_log" ON public.live_class_recording_audit_log;
CREATE POLICY "Admins have full access to live_class_recording_audit_log"
  ON public.live_class_recording_audit_log
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- 6. Grant minimum privileges
REVOKE ALL ON public.live_class_recordings FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.live_class_recordings TO authenticated;

REVOKE ALL ON public.live_class_recording_audit_log FROM PUBLIC, anon;
GRANT SELECT, INSERT ON public.live_class_recording_audit_log TO authenticated;
