-- ==============================================================================
-- 03_phase2_today_ist_and_validate_result.sql
-- Phase 2: Authoritative Indian Standard Time (today_ist) and Result Validation Trigger
-- Run Order: 3 of 12
-- ==============================================================================

-- 1. Authoritative Indian Standard Time date function
CREATE OR REPLACE FUNCTION public.today_ist()
RETURNS DATE
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT (timezone('Asia/Kolkata', now()))::date;
$$;

-- Set default entry_date and round_date to today_ist()
ALTER TABLE public.results ALTER COLUMN entry_date SET DEFAULT public.today_ist();
ALTER TABLE public.rounds ALTER COLUMN round_date SET DEFAULT public.today_ist();

-- 2. Trigger function: validate_result()
-- Enforces:
-- - correct <= total
-- - entry_date cannot be in the future (relative to today_ist())
-- - For non-admins, entry_date cannot be backdated more than 7 days
-- - On UPDATE by a student, entry_date cannot be changed
CREATE OR REPLACE FUNCTION public.validate_result()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today DATE := public.today_ist();
  v_is_admin BOOLEAN := public.is_admin();
BEGIN
  IF NEW.entry_date IS NULL THEN
    NEW.entry_date := v_today;
  END IF;

  IF NEW.correct IS NOT NULL AND NEW.total IS NOT NULL AND NEW.correct > NEW.total THEN
    RAISE EXCEPTION 'Correct answers (%) cannot exceed total questions (%).', NEW.correct, NEW.total;
  END IF;

  IF NEW.entry_date > v_today THEN
    RAISE EXCEPTION 'Entry date (%) cannot be in the future (today in IST is %).', NEW.entry_date, v_today;
  END IF;

  IF NOT v_is_admin THEN
    IF TG_OP = 'INSERT' AND NEW.entry_date < (v_today - INTERVAL '7 days')::date THEN
      RAISE EXCEPTION 'Entries can only be logged for the past 7 days.';
    END IF;

    IF TG_OP = 'UPDATE' AND NEW.entry_date IS DISTINCT FROM OLD.entry_date THEN
      NEW.entry_date := OLD.entry_date;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_result ON public.results;
CREATE TRIGGER trg_validate_result
  BEFORE INSERT OR UPDATE ON public.results
  FOR EACH ROW EXECUTE FUNCTION public.validate_result();
