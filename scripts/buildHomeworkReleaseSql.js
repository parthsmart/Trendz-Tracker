import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const sources = [
  ['staging_homework_feature.sql', '-- 1. Table: public.homework_assignments'],
  ['staging_practice_highest_records.sql', '-- 1. Helper: format_leaderboard_name'],
];

function readFeatureBody(file, marker) {
  const sql = readFileSync(new URL(`../supabase/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const start = sql.indexOf(marker);
  const end = sql.lastIndexOf('\nCOMMIT;');
  if (start < 0 || end < start || sql.slice(end).trim() !== 'COMMIT;') {
    throw new Error(`Unexpected SQL layout in ${file}. Review the production package generator.`);
  }
  return sql.slice(start, end).trimEnd();
}

export function buildHomeworkReleaseSql() {
  return `-- Homework + Highest Records. Generated from the staging-reviewed feature SQL.
-- Confirm Supabase project kgzivhavpsvitwrscrrj before applying this package.
BEGIN;

DO $preflight$
DECLARE
  required_table text;
BEGIN
  IF current_setting('app.target_environment', true) IS DISTINCT FROM 'production_kgzivhavpsvitwrscrrj' THEN
    RAISE EXCEPTION 'Production release latch is missing or incorrect.' USING ERRCODE = '55000';
  END IF;
  FOREACH required_table IN ARRAY ARRAY[
    'profiles', 'categories', 'teacher_permissions', 'teacher_student_assignments',
    'results', 'activity_results', 'drill_sessions', 'daily_tasks', 'daily_task_recipients',
    'student_messages', 'competition_settings', 'jmcwc_attempts', 'jmcwc_payloads',
    'jmcwc_papers', 'jmcwc_targets'
  ] LOOP
    IF to_regclass(format('public.%I', required_table)) IS NULL THEN
      RAISE EXCEPTION 'Production prerequisite is missing: public.%', required_table USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF to_regprocedure('public.jmcwc_create_attempt(uuid,uuid,uuid,text,text,jsonb)') IS NULL
    OR to_regprocedure('public.jmcwc_check_student(uuid)') IS NULL
    OR to_regprocedure('public.jmcwc_validate_marks(text,jsonb,numeric)') IS NULL
    OR to_regprocedure('public.flash_start(jsonb)') IS NULL
    OR to_regprocedure('public.admin_send_student_message(uuid,text,text,boolean,text,text,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'A required production function signature is missing.' USING ERRCODE = '55000';
  END IF;
END
$preflight$;

${sources.map(([file, marker]) => readFeatureBody(file, marker)).join('\n\n')}

DO $verify$
BEGIN
  IF has_function_privilege('anon', 'public.bind_homework_session(uuid,uuid)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.bind_homework_session(uuid,uuid)', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.bind_homework_session(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Unexpected homework binding privileges.' USING ERRCODE = '55000';
  END IF;
  IF has_table_privilege('anon', 'public.homework_bound_sessions', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    OR has_table_privilege('authenticated', 'public.homework_bound_sessions', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    OR NOT has_table_privilege('service_role', 'public.homework_bound_sessions', 'SELECT') THEN
    RAISE EXCEPTION 'Unexpected homework session link table privileges.' USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname = 'jmcwc_create_attempt') <> 2
    OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname = 'jmcwc_create_attempt' AND pronargdefaults <> 0) THEN
    RAISE EXCEPTION 'Unexpected Main Round creation signatures.' USING ERRCODE = '55000';
  END IF;
END
$verify$;

COMMIT;
`;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.stdout.write(buildHomeworkReleaseSql());
}
