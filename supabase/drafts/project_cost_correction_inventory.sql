-- DRAFT ONLY, NOT INSTALLED. Bounded read-only source-period inventory for
-- designing original-period correction reconciliation. It is NOT a total,
-- posting, proof of payment, or evidence that all business costs were found.
-- Existing project-cost reviews remain unchanged and exclude corrections.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regprocedure('public.project_cost_historical_review(uuid)') IS NULL OR to_regprocedure('public.project_cost_correction_attribution(text,uuid,integer)') IS NULL OR to_regclass('public.project_cost_correction_attributions') IS NULL OR to_regclass('public.project_cost_correction_sites') IS NULL OR to_regclass('public.paid_payroll_adjustment_cases') IS NULL OR to_regclass('public.paid_period_assertion_cases') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Correction inventory prerequisites missing'; END IF;
 IF to_regprocedure('public.project_cost_correction_inventory(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'Correction inventory name collision'; END IF;
END $preflight$;
CREATE FUNCTION public.project_cost_correction_inventory(p_project uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_base jsonb;v_refs jsonb;v_items jsonb:='[]'::jsonb;v_ref jsonb;v_evidence jsonb;v_site text;v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 -- This function and its STABLE dependencies share one statement snapshot.
 -- The historical/base snapshot enforces its own bounds and integrity checks.
 v_base:=public.project_cost_historical_review(p_project);
 -- Inventory cases linked to included source evidence, PLUS cases whose latest
 -- correction split names this site even if the original is absent from it.
 -- Selecting latest BEFORE filtering site prevents older revisions reappearing.
 WITH refs AS (
  SELECT 'voucher'::text kind,(c->>'case_id')::uuid case_id,true source_in_snapshot
   FROM jsonb_array_elements(v_base->'base'->'adjustment_cases') c
  UNION ALL
  SELECT 'external_worker',c.id,true
   FROM jsonb_array_elements(v_base->'historical') h
   JOIN public.paid_period_assertion_cases c ON c.source_kind='external_worker' AND c.external_worker_id=(h->>'source_id')::uuid
  UNION ALL
  SELECT a.source_kind,coalesce(a.voucher_case_id,a.external_case_id),false
   FROM public.project_cost_correction_attributions a JOIN public.project_cost_correction_sites s ON s.request_id=a.request_id
   WHERE s.project_id=p_project AND a.revision=(SELECT max(b.revision) FROM public.project_cost_correction_attributions b WHERE b.source_kind=a.source_kind AND coalesce(b.voucher_case_id,b.external_case_id)=coalesce(a.voucher_case_id,a.external_case_id))
 ), grouped AS (SELECT kind,case_id,bool_or(source_in_snapshot) source_in_snapshot FROM refs GROUP BY kind,case_id ORDER BY kind,case_id LIMIT 501)
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',kind,'case_id',case_id,'source_in_snapshot',source_in_snapshot) ORDER BY kind,case_id),'[]'::jsonb) INTO v_refs FROM grouped;
 IF jsonb_array_length(v_refs)>500 THEN RAISE EXCEPTION 'More than 500 correction cases; separate reconciliation required' USING ERRCODE='54000'; END IF;
 FOR v_ref IN SELECT value FROM jsonb_array_elements(v_refs) LOOP
  -- The existing case reader validates the complete split, original source,
  -- all siblings and whether a saved revision matches the current case.
  v_evidence:=public.project_cost_correction_attribution(v_ref->>'kind',(v_ref->>'case_id')::uuid,NULL);
  v_site:=NULL;
  IF v_evidence->'attribution'<>'null'::jsonb THEN
   SELECT x->>'gross_change' INTO v_site FROM jsonb_array_elements(v_evidence->'attribution'->'split') x WHERE (x->>'project_id')::uuid=p_project;
   -- An explicit complete reviewed split without this site means zero here;
   -- a missing review remains NULL, not zero. Neither is a posting.
   v_site:=coalesce(v_site,'0.00');
  END IF;
  v_items:=v_items||jsonb_build_array(v_ref||jsonb_build_object('evidence',v_evidence,'site_gross_change',v_site));
 END LOOP;
 v_result:=jsonb_build_object('project_id',p_project,'historical_review',v_base,'corrections',v_items);
 IF octet_length(v_result::text)>2097152 THEN RAISE EXCEPTION 'Correction inventory too large; separate reconciliation required' USING ERRCODE='54000'; END IF;
 RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.project_cost_correction_inventory(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_correction_inventory(uuid) TO authenticated;
DO $postflight$ BEGIN
 IF has_function_privilege('anon','public.project_cost_correction_inventory(uuid)','EXECUTE') OR has_function_privilege('service_role','public.project_cost_correction_inventory(uuid)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_correction_inventory(uuid)','EXECUTE') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.project_cost_correction_inventory(uuid)'::regprocedure AND prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION 'Unexpected correction inventory privileges'; END IF;
END $postflight$;
