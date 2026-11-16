-- HELD synthetic candidate. Changes legacy cost sources from original splits to
-- fully reconciled original-period sources (all cases, all sites). It does not
-- install by itself on the hosted project. A coordinated client and coverage
-- upgrade, old-writer cutover, lock audit and real-chain tests are required.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF current_setting('app.legacy_correction_candidate',true) IS DISTINCT FROM 'synthetic-only' THEN RAISE EXCEPTION 'Held for synthetic rehearsal'; END IF;
 IF to_regprocedure('public.project_cost_legacy_corrected_source(uuid)') IS NULL OR to_regprocedure('public.project_cost_legacy_voucher_inventory(uuid)') IS NULL OR to_regprocedure('public.project_cost_legacy_voucher_preview(uuid,jsonb,jsonb,jsonb,boolean)') IS NULL OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.project_cost_legacy_voucher_inventory(uuid)'::regprocedure)<>'76092c71deb0f1bb9b9c2e08558461dc' OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.project_cost_legacy_voucher_preview(uuid,jsonb,jsonb,jsonb,boolean)'::regprocedure)<>'4e9b2d52ff30dd1e3d9198f2ea262700' THEN RAISE EXCEPTION 'Legacy review dependency changed'; END IF;
END $preflight$;
CREATE OR REPLACE FUNCTION public.project_cost_legacy_voucher_inventory(p_project uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_base jsonb;v_row record;v_source jsonb;v_site jsonb;v_legacy jsonb:='[]'::jsonb;v_result jsonb;v_count bigint;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='42501'; END IF;
 v_base:=public.project_cost_correction_inventory(p_project);
 IF v_base->>'project_id' IS DISTINCT FROM p_project::text OR jsonb_typeof(v_base->'historical_review'->'base'->'paid_allocations') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Project cost inventory unavailable' USING ERRCODE='22023'; END IF;
 -- Include sources with an original split OR a latest correction at this site.
 -- Choosing the latest correction before filtering prevents old sites reappearing.
 SELECT count(*) INTO v_count FROM public.legacy_paid_voucher_attributions a WHERE EXISTS(SELECT 1 FROM public.legacy_paid_voucher_attribution_sites s WHERE s.attribution_id=a.request_id AND s.project_id=p_project) OR EXISTS(SELECT 1 FROM public.paid_payroll_adjustment_cases c JOIN public.project_cost_correction_attributions ca ON ca.voucher_case_id=c.id AND ca.source_kind='voucher' JOIN public.project_cost_correction_sites cs ON cs.request_id=ca.request_id WHERE c.payroll_id=a.payroll_id AND cs.project_id=p_project AND ca.revision=(SELECT max(b.revision) FROM public.project_cost_correction_attributions b WHERE b.source_kind='voucher' AND b.voucher_case_id=c.id));
 IF v_count>500 THEN RAISE EXCEPTION 'More than 500 legacy sources; separate reconciliation required' USING ERRCODE='54000'; END IF;
 FOR v_row IN SELECT a.request_id,a.payroll_id FROM public.legacy_paid_voucher_attributions a WHERE EXISTS(SELECT 1 FROM public.legacy_paid_voucher_attribution_sites s WHERE s.attribution_id=a.request_id AND s.project_id=p_project) OR EXISTS(SELECT 1 FROM public.paid_payroll_adjustment_cases c JOIN public.project_cost_correction_attributions ca ON ca.voucher_case_id=c.id AND ca.source_kind='voucher' JOIN public.project_cost_correction_sites cs ON cs.request_id=ca.request_id WHERE c.payroll_id=a.payroll_id AND cs.project_id=p_project AND ca.revision=(SELECT max(b.revision) FROM public.project_cost_correction_attributions b WHERE b.source_kind='voucher' AND b.voucher_case_id=c.id)) ORDER BY a.payroll_id LOOP
  v_source:=public.project_cost_legacy_corrected_source(v_row.payroll_id);
  IF v_source->'original'->>'request_id' IS DISTINCT FROM v_row.request_id::text OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_base->'historical_review'->'base'->'paid_allocations') p WHERE p->>'payroll_id'=v_row.payroll_id::text) THEN RAISE EXCEPTION 'Legacy source overlaps a paid allocation or differs' USING ERRCODE='40001'; END IF;
  SELECT x INTO v_site FROM jsonb_array_elements(v_source->'sites') x WHERE x->>'project_id'=p_project::text;
  IF v_site IS NULL THEN RAISE EXCEPTION 'Legacy site source unavailable' USING ERRCODE='40001'; END IF;
  v_legacy:=v_legacy||jsonb_build_array(jsonb_build_object('request_id',v_row.request_id,'payroll_id',v_row.payroll_id,'site_gross',v_site->>'corrected_gross','status',v_source->'original','corrected',v_source));
 END LOOP;
 v_result:=jsonb_build_object('project_id',p_project,'base',v_base,'legacy_vouchers',v_legacy);
 IF octet_length(v_result::text)>2097152 THEN RAISE EXCEPTION 'Legacy project inventory too large' USING ERRCODE='54000'; END IF;
 RETURN v_result;
END $$;
CREATE OR REPLACE FUNCTION public.project_cost_legacy_voucher_preview(p_project uuid,p_snapshot jsonb,p_choices jsonb,p_legacy_choices jsonb,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_now jsonb;v_base jsonb;v_item jsonb;v_choice jsonb;v_cases jsonb;v_ids jsonb;v_review jsonb;v_included numeric:=0;v_excluded numeric:=0;v_total numeric;v_count integer:=0;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR p_ack IS DISTINCT FROM true OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' OR octet_length(p_snapshot::text)>2097152 OR jsonb_typeof(p_legacy_choices) IS DISTINCT FROM 'object' OR octet_length(p_legacy_choices::text)>500000 THEN RAISE EXCEPTION 'Invalid legacy cost review' USING ERRCODE='22023'; END IF;
 v_now:=public.project_cost_legacy_voucher_inventory(p_project);
 IF v_now #- '{base,historical_review,base,captured_at}' IS DISTINCT FROM p_snapshot #- '{base,historical_review,base,captured_at}' THEN RAISE EXCEPTION 'Project evidence changed; reload and review' USING ERRCODE='40001'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p_legacy_choices))<>jsonb_array_length(v_now->'legacy_vouchers') THEN RAISE EXCEPTION 'Review every legacy voucher' USING ERRCODE='22023'; END IF;
 FOR v_item IN SELECT value FROM jsonb_array_elements(v_now->'legacy_vouchers') LOOP
  v_choice:=p_legacy_choices->(v_item->>'request_id');v_cases:=v_item->'corrected'->'cases';
  IF jsonb_typeof(v_choice) IS DISTINCT FROM 'object' OR NOT(v_choice ?& ARRAY['decision','reason']) OR coalesce(v_choice->>'decision','') NOT IN ('include','exclude') OR (v_choice->>'decision'='include' AND v_choice->'reason' IS DISTINCT FROM 'null'::jsonb) OR (v_choice->>'decision'='exclude' AND (jsonb_typeof(v_choice->'reason') IS DISTINCT FROM 'string' OR length(btrim(v_choice->>'reason')) NOT BETWEEN 1 AND 300 OR btrim(v_choice->>'reason') IS DISTINCT FROM v_choice->>'reason' OR (v_choice->>'reason')~'[[:cntrl:]]')) THEN RAISE EXCEPTION 'Invalid legacy voucher decision' USING ERRCODE='22023'; END IF;
  IF v_choice->>'decision'='include' AND jsonb_array_length(v_cases)>1 THEN
   v_review:=v_choice->'case_review';SELECT jsonb_agg(c->>'case_id' ORDER BY c->>'case_id' COLLATE "C") INTO v_ids FROM jsonb_array_elements(v_cases) c;
   IF (SELECT count(*) FROM jsonb_object_keys(v_choice))<>3 OR jsonb_typeof(v_review) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(v_review)='object' THEN v_review ELSE '{}'::jsonb END))<>3 OR NOT(v_review ?& ARRAY['case_ids','note','non_overlapping']) OR v_review->'case_ids' IS DISTINCT FROM v_ids OR v_review->'non_overlapping' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(v_review->'note') IS DISTINCT FROM 'string' OR length(btrim(v_review->>'note')) NOT BETWEEN 1 AND 300 OR btrim(v_review->>'note') IS DISTINCT FROM v_review->>'note' OR (v_review->>'note')~'[[:cntrl:]]' THEN RAISE EXCEPTION 'Distinct effects review required for every legacy case' USING ERRCODE='22023'; END IF;
  ELSIF (SELECT count(*) FROM jsonb_object_keys(v_choice))<>2 THEN RAISE EXCEPTION 'Unexpected legacy voucher decision fields' USING ERRCODE='22023'; END IF;
  -- The base inventory can also list these same corrections as incoming; they
  -- must be excluded there because the corrected source already contains them.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_cases) c JOIN jsonb_array_elements(v_now->'base'->'corrections') b ON b->>'kind'='voucher' AND b->>'case_id'=c->>'case_id' WHERE p_choices->'corrections'->('voucher:'||(c->>'case_id'))->>'decision' IS DISTINCT FROM 'exclude') THEN RAISE EXCEPTION 'Legacy correction must not also be included in base' USING ERRCODE='22023'; END IF;
  IF v_choice->>'decision'='include' THEN v_included:=v_included+(v_item->>'site_gross')::numeric;ELSE v_excluded:=v_excluded+(v_item->>'site_gross')::numeric;v_count:=v_count+1;END IF;
 END LOOP;
 v_base:=public.project_cost_corrected_preview(p_project,v_now->'base',p_choices,true);
 v_total:=(v_base->>'incomplete_total')::numeric+v_included;
 IF v_total<0 OR v_total>=100000000000000 THEN RAISE EXCEPTION 'Invalid legacy cost total' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('project_id',p_project,'base',v_base,'legacy_included_gross',v_included::numeric(16,2)::text,'legacy_excluded_gross',v_excluded::numeric(16,2)::text,'legacy_excluded_count',v_count,'incomplete_total',v_total::numeric(16,2)::text,'incomplete',true);
END $$;
