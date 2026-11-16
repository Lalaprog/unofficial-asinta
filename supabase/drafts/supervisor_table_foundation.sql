-- Guarded additive foundation only; NOT a complete feature or general install.
-- This adds empty tables only. It does not create the Supervisor RPCs or grant
-- application roles access. Review the target and the exact SQL before use.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
DO $preflight$
BEGIN
 IF pg_catalog.to_regclass('public.users') IS NULL THEN RAISE EXCEPTION 'Application users table is missing'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['public.supervisor_leave_requests','public.supervisor_leave_owner_dates_idx','public.supervisor_leave_queue_idx','public.supervisor_daily_attendance','public.supervisor_daily_attendance_open_day','public.supervisor_daily_attendance_queue']) n WHERE pg_catalog.to_regclass(n) IS NOT NULL) THEN
  RAISE EXCEPTION 'Supervisor foundation name collision'; END IF;
 IF pg_catalog.to_regprocedure('app_private.normal_leave_notice_allowed(date,timestamptz)') IS NOT NULL OR pg_catalog.to_regprocedure('public.submit_supervisor_leave(uuid,date,date,text,text)') IS NOT NULL OR pg_catalog.to_regprocedure('public.submit_supervisor_day(uuid,date,text)') IS NOT NULL THEN
  RAISE EXCEPTION 'Supervisor foundation function collision'; END IF;
END;
$preflight$;

-- Exact table/index/RLS portions from the two PR #103 migrations.
CREATE TABLE public.supervisor_leave_requests (
  id uuid PRIMARY KEY,
  supervisor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  start_date date NOT NULL,
  end_date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('normal','emergency')),
  reason text NOT NULL CHECK (length(reason)<=500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  submitted_at timestamptz NOT NULL,
  reviewed_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  CHECK (end_date>=start_date AND end_date-start_date<=366),
  CHECK ((status='pending' AND reviewed_by IS NULL AND reviewed_at IS NULL) OR
         (status IN ('approved','rejected') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE INDEX supervisor_leave_owner_dates_idx ON public.supervisor_leave_requests(supervisor_id,start_date,end_date);
CREATE INDEX supervisor_leave_queue_idx ON public.supervisor_leave_requests(status,submitted_at DESC,id);
ALTER TABLE public.supervisor_leave_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supervisor_leave_requests FROM PUBLIC,anon,authenticated;

CREATE TABLE public.supervisor_daily_attendance (
  id uuid PRIMARY KEY,
  supervisor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  work_date date NOT NULL,
  work_status text NOT NULL CHECK (work_status IN ('present','half_day','absent')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  submitted_at timestamptz NOT NULL,
  reviewed_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  CHECK ((status='pending' AND reviewed_by IS NULL AND reviewed_at IS NULL) OR
         (status IN ('approved','rejected') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE UNIQUE INDEX supervisor_daily_attendance_open_day ON public.supervisor_daily_attendance(supervisor_id,work_date) WHERE status IN ('pending','approved');
CREATE INDEX supervisor_daily_attendance_queue ON public.supervisor_daily_attendance(status,submitted_at DESC,id);
ALTER TABLE public.supervisor_daily_attendance ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supervisor_daily_attendance FROM PUBLIC,anon,authenticated;

DO $postflight$
DECLARE v_table text;
BEGIN
 FOREACH v_table IN ARRAY ARRAY['public.supervisor_leave_requests','public.supervisor_daily_attendance'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass(v_table) AND relrowsecurity AND relkind='r') THEN
   RAISE EXCEPTION 'Missing RLS or table on %',v_table; END IF;
  IF pg_catalog.has_table_privilege('anon',v_table,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR pg_catalog.has_table_privilege('authenticated',v_table,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
   RAISE EXCEPTION 'Unexpected inherited client table privileges on %',v_table; END IF;
 END LOOP;
END;
$postflight$;
