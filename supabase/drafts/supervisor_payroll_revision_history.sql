-- Read-only Founder history for the separately installed revision ledger.
-- No event or source is modified. Install in a transaction after the revision upgrade.
DO $$ BEGIN
 IF to_regclass('public.supervisor_payroll_revision_events') IS NULL OR to_regprocedure('public.supervisor_payroll_revision_action(uuid,uuid,bigint,text,numeric,jsonb,text,date,boolean)') IS NULL OR to_regprocedure('public.supervisor_payroll_revision_history(uuid,bigint)') IS NOT NULL THEN RAISE EXCEPTION 'Revision history prerequisites or name collision'; END IF;
END $$;
CREATE FUNCTION public.supervisor_payroll_revision_history(p_payroll uuid,p_before bigint DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_items jsonb; v_more boolean;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF p_payroll IS NULL OR (p_before IS NOT NULL AND p_before<0) THEN RAISE EXCEPTION 'Invalid history cursor' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.supervisor_period_payroll WHERE id=p_payroll) THEN RAISE EXCEPTION 'Payroll not found' USING ERRCODE='P0002'; END IF;
 IF EXISTS(SELECT 1 FROM public.supervisor_payroll_revision_events WHERE payroll_id=p_payroll GROUP BY expected_revision HAVING count(*)>1) THEN RAISE EXCEPTION 'Duplicate revision evidence; investigate' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('request_id',e.request_id,'actor_id',e.actor_id,'action',e.action,'revision',e.expected_revision::text,'occurred_at',e.occurred_at,'reason',e.arguments->>'reason','before_status',e.before_row->>'status','after_status',e.after_row->>'status','before_rate',e.before_row->>'daily_rate','after_rate',e.after_row->>'daily_rate','before_gross',e.before_row->>'gross','after_gross',e.after_row->>'gross','paid_on',e.after_row->>'paid_on') ORDER BY e.expected_revision DESC,e.request_id DESC),'[]'::jsonb)
 INTO v_items FROM (SELECT * FROM public.supervisor_payroll_revision_events WHERE payroll_id=p_payroll AND (p_before IS NULL OR expected_revision<p_before) ORDER BY expected_revision DESC,request_id DESC LIMIT 50) e;
 SELECT EXISTS(SELECT 1 FROM public.supervisor_payroll_revision_events WHERE payroll_id=p_payroll AND (p_before IS NULL OR expected_revision<p_before) OFFSET 50) INTO v_more;
 RETURN jsonb_build_object('payroll_id',p_payroll,'items',v_items,'has_more',v_more);
END $$;
REVOKE ALL ON FUNCTION public.supervisor_payroll_revision_history(uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.supervisor_payroll_revision_history(uuid,bigint) TO authenticated;
DO $$ BEGIN
 IF NOT has_function_privilege('authenticated','public.supervisor_payroll_revision_history(uuid,bigint)','EXECUTE') OR has_function_privilege('anon','public.supervisor_payroll_revision_history(uuid,bigint)','EXECUTE') OR has_function_privilege('service_role','public.supervisor_payroll_revision_history(uuid,bigint)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected revision history access'; END IF;
END $$;
