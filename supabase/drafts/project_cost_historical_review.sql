-- UNINSTALLED, READ-ONLY CANDIDATE. Combine bounded current project-cost
-- evidence and attributed external worker history in ONE statement snapshot.
-- No payment, accounting posting, saved review, allocation, or transfer.
-- A same-worker overlapping voucher is only a duplicate signal; it does not
-- prove payment or find duplicate expenses/identities/external transactions.
-- Historical case counts are whole-period signals, not site corrections.
-- Requires both exact reviewed underlying candidates and coordinated cutover.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF to_regprocedure('public.project_cost_reconciliation_preview(uuid)') IS NULL OR
    to_regprocedure('public.project_historical_worker_attributions(uuid)') IS NULL OR
    to_regclass('public.payroll') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR
    to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN
  RAISE EXCEPTION 'Combined project review prerequisites missing'; END IF;
 IF to_regprocedure('public.project_cost_historical_review(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'Combined project review already exists'; END IF;
END;
$preflight$;
CREATE FUNCTION public.project_cost_historical_review(p_project uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_base jsonb;v_history jsonb;v_items jsonb;v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 v_base:=public.project_cost_reconciliation_preview(p_project);
 v_history:=public.project_historical_worker_attributions(p_project);
 -- Count matching worker/date-range vouchers at ANY project and ANY status.
 -- Even a draft may signal a duplicate; never infer a real-world payment.
 SELECT coalesce(jsonb_agg(item.value||jsonb_build_object('overlapping_vouchers',
  (SELECT count(*) FROM public.payroll p WHERE p.worker_id=(item.value->>'worker_id')::uuid
   AND p.period_start<=(item.value->>'period_end')::date AND p.period_end>=(item.value->>'period_start')::date))
  ORDER BY item.ordinality),'[]'::jsonb) INTO v_items
 FROM jsonb_array_elements(v_history->'items') WITH ORDINALITY item(value,ordinality);
 v_result:=jsonb_build_object('project_id',p_project,'base',v_base,'historical',v_items);
 IF octet_length(v_result::text)>2097152 THEN RAISE EXCEPTION 'Combined review too large' USING ERRCODE='54000'; END IF;
 RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.project_cost_historical_review(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_historical_review(uuid) TO authenticated;
DO $postflight$
BEGIN
 IF has_function_privilege('anon','public.project_cost_historical_review(uuid)','EXECUTE') OR
    has_function_privilege('service_role','public.project_cost_historical_review(uuid)','EXECUTE') OR
    NOT has_function_privilege('authenticated','public.project_cost_historical_review(uuid)','EXECUTE') OR
    NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.project_cost_historical_review(uuid)'::regprocedure AND prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""']) THEN
  RAISE EXCEPTION 'Unexpected combined project review privileges'; END IF;
END;
$postflight$;
