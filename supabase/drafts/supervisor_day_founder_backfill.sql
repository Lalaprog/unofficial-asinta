-- Coordinated Supervisor daily-attendance cutover component. Not installed.
-- A Founder may record a historical daily assertion for a current Supervisor;
-- it starts pending and must be reviewed separately. No payroll is changed.
-- Existing site attendance, paid periods and external evidence need review.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF to_regclass('public.supervisor_daily_attendance') IS NULL OR to_regclass('public.users') IS NULL
 OR to_regprocedure('public.submit_supervisor_day(uuid,date,text)') IS NULL
 OR to_regprocedure('public.review_supervisor_day(uuid,text)') IS NULL
 OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL THEN
  RAISE EXCEPTION 'Supervisor backfill prerequisites missing'; END IF;
 IF to_regclass('public.supervisor_day_founder_backfills') IS NOT NULL OR to_regprocedure('public.record_supervisor_day_backfill(uuid,uuid,date,text,text)') IS NOT NULL OR to_regprocedure('public.supervisor_day_backfill_lookup(uuid)') IS NOT NULL OR to_regprocedure('public.supervisor_day_backfill_catalog()') IS NOT NULL THEN RAISE EXCEPTION 'Supervisor backfill already exists'; END IF;
END;
$preflight$;
CREATE TABLE public.supervisor_day_founder_backfills(
 day_id uuid PRIMARY KEY REFERENCES public.supervisor_daily_attendance(id) ON DELETE RESTRICT,
 founder_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 300 AND reason=btrim(reason)),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.supervisor_day_founder_backfills ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supervisor_day_founder_backfills FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.guard_supervisor_day_backfill_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Supervisor backfill evidence is immutable' USING ERRCODE='22023'; END;
$$;
REVOKE ALL ON FUNCTION public.guard_supervisor_day_backfill_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_supervisor_day_backfill_immutable BEFORE UPDATE OR DELETE ON public.supervisor_day_founder_backfills FOR EACH ROW EXECUTE FUNCTION public.guard_supervisor_day_backfill_immutable();
CREATE FUNCTION public.supervisor_day_backfill_catalog() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_items jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF (SELECT count(*) FROM public.users WHERE role='supervisor')>2000 THEN RAISE EXCEPTION 'Supervisor catalog too large' USING ERRCODE='54000'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY name,id),'[]'::jsonb) INTO v_items FROM public.users WHERE role='supervisor';
 RETURN jsonb_build_object('supervisors',v_items);
END;
$$;
CREATE FUNCTION public.record_supervisor_day_backfill(p_id uuid,p_supervisor uuid,p_date date,p_work_status text,p_reason text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=auth.uid();v_prev public.supervisor_daily_attendance%ROWTYPE;v_evidence public.supervisor_day_founder_backfills%ROWTYPE;v_now timestamptz;
BEGIN
 IF v_actor IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Daily attendance requires read committed' USING ERRCODE='P1002'; END IF;
 IF p_id IS NULL OR p_supervisor IS NULL OR p_date IS NULL OR NOT isfinite(p_date) OR p_date<DATE '1900-01-01' OR p_date>DATE '9998-12-31' OR p_work_status IS NULL OR p_work_status NOT IN ('present','half_day','absent') OR p_reason IS NULL OR p_reason<>btrim(p_reason) OR length(p_reason) NOT BETWEEN 1 AND 300 OR p_reason ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'Invalid backfill' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM public.users WHERE id=v_actor AND role='founder' FOR SHARE;
 IF NOT FOUND OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.users WHERE id=p_supervisor AND role='supervisor' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Supervisor unavailable' USING ERRCODE='22023'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('supervisor-day:'||p_id::text,0));
 SELECT * INTO v_prev FROM public.supervisor_daily_attendance WHERE id=p_id;
 IF FOUND THEN
  SELECT * INTO v_evidence FROM public.supervisor_day_founder_backfills WHERE day_id=p_id;
  IF NOT FOUND OR (v_prev.supervisor_id,v_prev.work_date,v_prev.work_status,v_evidence.founder_id,v_evidence.reason) IS DISTINCT FROM (p_supervisor,p_date,p_work_status,v_actor,p_reason) THEN RAISE EXCEPTION 'Request ID used for different attendance' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('id',p_id,'status',v_prev.status,'replayed',true);
 END IF;
 v_now:=clock_timestamp();
 IF p_date>(v_now AT TIME ZONE 'Asia/Manila')::date THEN RAISE EXCEPTION 'Cannot backfill a future Manila date' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.supervisor_daily_attendance WHERE supervisor_id=p_supervisor AND work_date=p_date AND status IN ('pending','approved')) THEN RAISE EXCEPTION 'A pending or approved daily record already exists' USING ERRCODE='22023'; END IF;
 INSERT INTO public.supervisor_daily_attendance(id,supervisor_id,work_date,work_status,submitted_at) VALUES(p_id,p_supervisor,p_date,p_work_status,v_now);
 INSERT INTO public.supervisor_day_founder_backfills(day_id,founder_id,reason) VALUES(p_id,v_actor,p_reason);
 RETURN jsonb_build_object('id',p_id,'status','pending','replayed',false);
END;
$$;
-- Lookup is available to any Founder for audit/reconciliation, never to other roles.
CREATE FUNCTION public.supervisor_day_backfill_lookup(p_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF p_id IS NULL THEN RAISE EXCEPTION 'Invalid backfill ID' USING ERRCODE='22023'; END IF;
 SELECT jsonb_build_object('id',d.id,'supervisor_id',d.supervisor_id,'date',d.work_date,'work_status',d.work_status,'status',d.status,'founder_id',b.founder_id,'reason',b.reason,'recorded_at',b.recorded_at) INTO v_result FROM public.supervisor_day_founder_backfills b JOIN public.supervisor_daily_attendance d ON d.id=b.day_id WHERE b.day_id=p_id;
 RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.supervisor_day_backfill_catalog(),public.record_supervisor_day_backfill(uuid,uuid,date,text,text),public.supervisor_day_backfill_lookup(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.supervisor_day_backfill_catalog(),public.record_supervisor_day_backfill(uuid,uuid,date,text,text),public.supervisor_day_backfill_lookup(uuid) TO authenticated;
DO $postflight$
DECLARE v text;
BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name) WHERE has_table_privilege(r.role_name,'public.supervisor_day_founder_backfills','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.supervisor_day_founder_backfills'::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r.role_name,a.attrelid,a.attname,'SELECT,INSERT,UPDATE'))) THEN RAISE EXCEPTION 'Unexpected Supervisor backfill table privilege'; END IF;
 FOREACH v IN ARRAY ARRAY['public.supervisor_day_backfill_catalog()','public.record_supervisor_day_backfill(uuid,uuid,date,text,text)','public.supervisor_day_backfill_lookup(uuid)'] LOOP
  IF has_function_privilege('anon',v,'EXECUTE') OR has_function_privilege('service_role',v,'EXECUTE') OR NOT has_function_privilege('authenticated',v,'EXECUTE') THEN RAISE EXCEPTION 'Unexpected Supervisor backfill function privilege: %',v; END IF;
 END LOOP;
END;
$postflight$;
