-- UNINSTALLED: verify a single-case incoming cross-site correction against
-- current, explicitly saved reviews of every original site. No costs or reviews
-- are written. This is a prerequisite for a later destination review, NOT a
-- project total, posting, payment proof, or guarantee of future freshness.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regprocedure('public.project_cost_cross_site_evidence(text,uuid)') IS NULL OR to_regprocedure('public.project_cost_cross_site_preview(text,uuid,jsonb,boolean)') IS NULL OR to_regprocedure('public.project_cost_corrected_review(uuid,integer)') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Cross-site review context prerequisites missing'; END IF;
 IF to_regprocedure('public.project_cost_cross_site_review_context(uuid,text,uuid)') IS NOT NULL THEN RAISE EXCEPTION 'Cross-site review context name collision'; END IF;
END $preflight$;
CREATE FUNCTION public.project_cost_cross_site_review_context(p_destination uuid,p_kind text,p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_evidence jsonb;v_original jsonb;v_illustration jsonb;v_destination jsonb;v_source_site jsonb;v_review jsonb;v_original_row jsonb;v_case_row jsonb;v_sources jsonb:='[]'::jsonb;v_key text;v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_destination IS NULL OR p_kind IS NULL OR p_kind NOT IN ('voucher','external_worker') OR p_case IS NULL THEN RAISE EXCEPTION 'Invalid cross-site source review request' USING ERRCODE='22023'; END IF;
 -- All STABLE readers use the same statement snapshot. A later change can
 -- invalidate the context; callers must re-read and compare before saving.
 v_evidence:=public.project_cost_cross_site_evidence(p_kind,p_case);
 v_illustration:=public.project_cost_cross_site_preview(p_kind,p_case,v_evidence,true);
 v_original:=v_evidence->'original';v_key:=p_kind||':'||p_case::text;
 IF v_illustration->>'source_kind' IS DISTINCT FROM p_kind OR v_illustration->>'case_id' IS DISTINCT FROM p_case::text OR v_illustration->>'source_id' IS DISTINCT FROM v_original->>'source_id' OR v_illustration->'incomplete' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(v_illustration->'sites') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Cross-site illustration differs' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_original->'sites') s WHERE s->>'project_id'=p_destination::text) THEN RAISE EXCEPTION 'Destination already has an original allocation' USING ERRCODE='22023'; END IF;
 SELECT jsonb_agg(s) INTO v_destination FROM jsonb_array_elements(v_illustration->'sites') s WHERE s->>'project_id'=p_destination::text;
 IF coalesce(jsonb_array_length(v_destination),0)<>1 THEN RAISE EXCEPTION 'Incoming destination is unavailable' USING ERRCODE='22023'; END IF;
 v_destination:=v_destination->0;
 IF v_destination->>'original_gross' IS DISTINCT FROM '0.00' OR (v_destination->>'gross_change')::numeric<=0 OR v_destination->>'gross_change' IS DISTINCT FROM v_destination->>'corrected_gross' THEN RAISE EXCEPTION 'Incoming destination amount invalid' USING ERRCODE='22023'; END IF;
 FOR v_source_site IN SELECT value FROM jsonb_array_elements(v_original->'sites') LOOP
  v_review:=public.project_cost_corrected_review((v_source_site->>'project_id')::uuid,NULL);
  IF v_review->'found' IS DISTINCT FROM 'true'::jsonb OR v_review->>'freshness' IS DISTINCT FROM 'matches' OR v_review->>'project_id' IS DISTINCT FROM v_source_site->>'project_id' OR (v_review->>'revision')::integer IS DISTINCT FROM (v_review->>'latest_revision')::integer OR (v_review->>'revision')::integer<1 OR v_review->>'request_id' IS NULL OR v_review->>'actor_id' IS NULL OR v_review->'result'->'incomplete' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Current saved original-site review required' USING ERRCODE='22023'; END IF;
  IF p_kind='voucher' THEN
   SELECT jsonb_agg(x) INTO v_original_row FROM jsonb_array_elements(v_review->'snapshot'->'historical_review'->'base'->'paid_allocations') x WHERE x->>'payroll_id'=v_original->>'source_id';
  ELSE
   SELECT jsonb_agg(x) INTO v_original_row FROM jsonb_array_elements(v_review->'snapshot'->'historical_review'->'historical') x WHERE x->>'source_id'=v_original->>'source_id';
  END IF;
  IF coalesce(jsonb_array_length(v_original_row),0)<>1 THEN RAISE EXCEPTION 'Original missing from saved site review' USING ERRCODE='22023'; END IF;
  v_original_row:=v_original_row->0;
  IF (CASE WHEN p_kind='voucher' THEN v_original_row->>'gross' ELSE v_original_row->>'site_gross' END) IS DISTINCT FROM v_source_site->>'gross' THEN RAISE EXCEPTION 'Original site amount differs from saved review' USING ERRCODE='22023'; END IF;
  IF p_kind='external_worker' AND (v_original_row->>'overlapping_vouchers' IS DISTINCT FROM '0' OR v_review->'choices'->'historical'->(v_original_row->>'request_id')->>'decision' IS DISTINCT FROM 'include') THEN RAISE EXCEPTION 'Original historical inclusion required' USING ERRCODE='22023'; END IF;
  SELECT jsonb_agg(x) INTO v_case_row FROM jsonb_array_elements(v_review->'snapshot'->'corrections') x WHERE x->>'kind'=p_kind AND x->>'case_id'=p_case::text;
  IF coalesce(jsonb_array_length(v_case_row),0)<>1 THEN RAISE EXCEPTION 'Correction missing from saved original-site review' USING ERRCODE='22023'; END IF;
  v_case_row:=v_case_row->0;
  IF v_case_row->'source_in_snapshot' IS DISTINCT FROM 'true'::jsonb OR v_case_row->'evidence' IS DISTINCT FROM v_evidence->'correction' OR v_review->'choices'->'corrections'->v_key->>'decision' IS DISTINCT FROM 'include' OR v_case_row->>'site_gross_change' IS DISTINCT FROM (SELECT s->>'gross_change' FROM jsonb_array_elements(v_illustration->'sites') s WHERE s->>'project_id'=v_source_site->>'project_id') THEN RAISE EXCEPTION 'Saved original-site correction decision or evidence differs' USING ERRCODE='22023'; END IF;
  v_sources:=v_sources||jsonb_build_array(jsonb_build_object('project_id',v_source_site->>'project_id','original_gross',v_source_site->>'gross','gross_change',v_case_row->>'site_gross_change','request_id',v_review->>'request_id','revision',(v_review->>'revision')::integer,'actor_id',v_review->>'actor_id','recorded_at',v_review->>'recorded_at'));
 END LOOP;
 v_result:=jsonb_build_object('destination',p_destination,'source_kind',p_kind,'case_id',p_case,'source_evidence',v_evidence,'illustration',v_illustration,'original_site_reviews',v_sources,'incomplete',true);
 IF octet_length(v_result::text)>524288 THEN RAISE EXCEPTION 'Cross-site review context too large' USING ERRCODE='54000'; END IF;
 RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.project_cost_cross_site_review_context(uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_cross_site_review_context(uuid,text,uuid) TO authenticated;
DO $postflight$ BEGIN
 IF has_function_privilege('anon','public.project_cost_cross_site_review_context(uuid,text,uuid)','EXECUTE') OR has_function_privilege('service_role','public.project_cost_cross_site_review_context(uuid,text,uuid)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_cross_site_review_context(uuid,text,uuid)','EXECUTE') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.project_cost_cross_site_review_context(uuid,text,uuid)'::regprocedure AND prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION 'Unexpected cross-site review context privileges'; END IF;
END $postflight$;
