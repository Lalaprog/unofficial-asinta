-- UNINSTALLED DRAFT: Founder-only, read-only planning inputs. Not a payroll
-- generator, ledger, rate history, payment, or legacy-to-new cutover. Run only
-- after reviewing dependencies and inside a single transaction.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preflight$
DECLARE v_missing text;
BEGIN
 IF to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL
   OR to_regprocedure('public.supervisor_day_list(integer)') IS NULL OR to_regprocedure('public.supervisor_leave_list(integer)') IS NULL
   OR to_regclass('public.users') IS NULL OR to_regclass('public.workers') IS NULL OR to_regclass('public.attendance') IS NULL OR to_regclass('public.payroll') IS NULL
   OR to_regclass('public.supervisor_daily_attendance') IS NULL OR to_regclass('public.supervisor_leave_requests') IS NULL THEN
  RAISE EXCEPTION 'Supervisor payroll preview prerequisites missing'; END IF;
 IF to_regprocedure('public.supervisor_payroll_preview_catalog()') IS NOT NULL OR to_regprocedure('public.supervisor_payroll_preview_inputs(uuid,date)') IS NOT NULL THEN
  RAISE EXCEPTION 'Supervisor payroll preview functions already exist'; END IF;
 LOCK TABLE public.supervisor_daily_attendance,public.supervisor_leave_requests IN SHARE MODE;
 SELECT string_agg(required.rel||'.'||required.col,', ' ORDER BY required.rel,required.col) INTO v_missing
 FROM (VALUES ('users','id','uuid'),('users','name','text'),('users','role','text'),('workers','id','uuid'),('workers','name','text'),
 ('attendance','worker_id','uuid'),('attendance','date','date'),('payroll','worker_id','uuid'),('payroll','period_start','date'),('payroll','period_end','date'),
 ('supervisor_daily_attendance','id','uuid'),('supervisor_daily_attendance','supervisor_id','uuid'),('supervisor_daily_attendance','work_date','date'),('supervisor_daily_attendance','work_status','text'),('supervisor_daily_attendance','status','text'),
 ('supervisor_leave_requests','id','uuid'),('supervisor_leave_requests','supervisor_id','uuid'),('supervisor_leave_requests','start_date','date'),('supervisor_leave_requests','end_date','date'),('supervisor_leave_requests','status','text')) AS required(rel,col,typ)
 LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=pg_catalog.to_regclass('public.'||required.rel) AND a.attname=required.col AND a.attnum>0 AND NOT a.attisdropped
 WHERE a.attname IS NULL OR pg_catalog.format_type(a.atttypid,a.atttypmod) IS DISTINCT FROM required.typ;
 IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'Supervisor preview prerequisite columns missing or different: %',v_missing; END IF;
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid IN ('public.supervisor_daily_attendance'::regclass,'public.supervisor_leave_requests'::regclass) AND (NOT relrowsecurity OR relkind<>'r')) THEN RAISE EXCEPTION 'Supervisor preview tables not locked by RLS'; END IF;
 IF has_table_privilege('authenticated','public.supervisor_daily_attendance','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_table_privilege('anon','public.supervisor_daily_attendance','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   OR has_table_privilege('authenticated','public.supervisor_leave_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_table_privilege('anon','public.supervisor_leave_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
  RAISE EXCEPTION 'Unexpected Supervisor table privileges'; END IF;
END;
$preflight$;

CREATE FUNCTION public.supervisor_payroll_preview_catalog() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_items jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF (SELECT count(*) FROM public.users WHERE role='supervisor')>2000 THEN RAISE EXCEPTION 'Supervisor catalog exceeds preview limit' USING ERRCODE='54000'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY name,id),'[]'::jsonb) INTO v_items FROM public.users WHERE role='supervisor';
 RETURN jsonb_build_object('supervisors',v_items);
END;
$$;
REVOKE ALL ON FUNCTION public.supervisor_payroll_preview_catalog() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.supervisor_payroll_preview_catalog() TO authenticated;

CREATE FUNCTION public.supervisor_payroll_preview_inputs(p_supervisor uuid,p_start date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_end date; v_name text; v_days jsonb; v_leave jsonb; v_legacy bigint; v_vouchers bigint; v_identity boolean;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF p_start IS NULL OR p_start<'1900-01-01'::date OR p_start>'9998-12-16'::date OR extract(day from p_start) NOT IN (1,16) OR p_supervisor IS NULL THEN RAISE EXCEPTION 'Invalid Supervisor period' USING ERRCODE='22023'; END IF;
 v_end:=CASE WHEN extract(day from p_start)=1 THEN p_start+14 ELSE (p_start+interval '1 month' - interval '16 days')::date END;
 SELECT name INTO v_name FROM public.users WHERE id=p_supervisor AND role='supervisor';
 IF NOT FOUND THEN RAISE EXCEPTION 'Supervisor unavailable' USING ERRCODE='P0002'; END IF;
 IF (SELECT count(*) FROM public.supervisor_daily_attendance WHERE supervisor_id=p_supervisor AND work_date BETWEEN p_start AND v_end AND status IN ('pending','approved'))>100
 OR (SELECT count(*) FROM public.supervisor_leave_requests WHERE supervisor_id=p_supervisor AND start_date<=v_end AND end_date>=p_start AND status IN ('pending','approved'))>100 THEN
  RAISE EXCEPTION 'Supervisor payroll preview exceeds record limit' USING ERRCODE='54000'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'date',work_date,'work_status',work_status,'status',status) ORDER BY work_date,id),'[]'::jsonb) INTO v_days
 FROM public.supervisor_daily_attendance WHERE supervisor_id=p_supervisor AND work_date BETWEEN p_start AND v_end AND status IN ('pending','approved');
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'start',start_date,'end',end_date,'status',status) ORDER BY start_date,id),'[]'::jsonb) INTO v_leave
 FROM public.supervisor_leave_requests WHERE supervisor_id=p_supervisor AND start_date<=v_end AND end_date>=p_start AND status IN ('pending','approved');
 -- UUID and case-folded names are warnings, not verified identity links. False
 -- negatives remain possible, so absence of these signals is never proof.
 SELECT NOT EXISTS(SELECT 1 FROM public.workers WHERE id=p_supervisor)
   OR EXISTS(SELECT 1 FROM public.workers WHERE id<>p_supervisor AND lower(btrim(name))=lower(btrim(v_name)))
   OR EXISTS(SELECT 1 FROM public.users WHERE id<>p_supervisor AND role='supervisor' AND lower(btrim(name))=lower(btrim(v_name))) INTO v_identity;
 SELECT count(*) INTO v_legacy FROM public.attendance a JOIN public.workers w ON w.id=a.worker_id
 WHERE (w.id=p_supervisor OR lower(btrim(w.name))=lower(btrim(v_name))) AND a.date BETWEEN p_start AND v_end;
 SELECT count(*) INTO v_vouchers FROM public.payroll p JOIN public.workers w ON w.id=p.worker_id
 WHERE (w.id=p_supervisor OR lower(btrim(w.name))=lower(btrim(v_name))) AND p.period_start<=v_end AND p.period_end>=p_start;
 RETURN jsonb_build_object('supervisor_id',p_supervisor,'start',p_start,'end',v_end,'days',v_days,'leave',v_leave,
   'identity_needs_review',v_identity,'legacy_count',v_legacy,'overlapping_vouchers',v_vouchers);
END;
$$;
REVOKE ALL ON FUNCTION public.supervisor_payroll_preview_inputs(uuid,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.supervisor_payroll_preview_inputs(uuid,date) TO authenticated;
DO $postflight$
DECLARE s text;
BEGIN
 FOREACH s IN ARRAY ARRAY['public.supervisor_payroll_preview_catalog()','public.supervisor_payroll_preview_inputs(uuid,date)'] LOOP
  IF has_function_privilege('anon',s,'EXECUTE') OR NOT has_function_privilege('authenticated',s,'EXECUTE') THEN RAISE EXCEPTION 'Unexpected Supervisor payroll preview function privileges'; END IF;
 END LOOP;
END;
$postflight$;
