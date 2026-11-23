-- =====================================================================
-- Rollback 18: Phase 21 Webinar Recordings Library & Scheduled Video
-- File: supabase/rollbacks/18_phase21_webinar_recordings_and_scheduled_rollback.sql
-- =====================================================================

DROP TABLE IF EXISTS public.live_class_recording_audit_log CASCADE;
DROP TABLE IF EXISTS public.live_class_recordings CASCADE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'live_classes' AND column_name = 'class_type'
  ) THEN
    ALTER TABLE public.live_classes DROP COLUMN class_type;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'live_classes' AND column_name = 'recording_enabled'
  ) THEN
    ALTER TABLE public.live_classes DROP COLUMN recording_enabled;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'live_classes' AND column_name = 'prerecorded_asset_url'
  ) THEN
    ALTER TABLE public.live_classes DROP COLUMN prerecorded_asset_url;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'live_classes' AND column_name = 'stream_url'
  ) THEN
    ALTER TABLE public.live_classes DROP COLUMN stream_url;
  END IF;
END $$;
