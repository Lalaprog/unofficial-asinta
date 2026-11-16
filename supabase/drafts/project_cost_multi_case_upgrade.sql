-- HELD MULTI-CASE SYNTHETIC CANDIDATE. Do not install on a shared database.
-- Full source-site inclusion, distinct-effects assertions and nonnegative grouped
-- destination effects are mandatory. This is not a payment or complete ledger.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $hold$ BEGIN IF current_setting('app.cross_site_multicase_candidate',true) IS DISTINCT FROM 'synthetic-only' THEN RAISE EXCEPTION 'Multi-case candidate held for synthetic rehearsal'; END IF; END $hold$;
DO $preflight$ DECLARE r record; f oid; BEGIN
 FOR r IN SELECT * FROM (VALUES
 ('public.project_cost_cross_site_preview(text,uuid,jsonb,boolean)','c3950091e6713d4837d32ecca2d74a6599bb5eccb9354e1fad144d675d421e70'),
 ('public.project_cost_cross_site_review_context(uuid,text,uuid)','99de53ea775450f08f1b6b03aef1fec9f195a3cae5483a4bed14bef64b442613'),
 ('public.project_cost_cross_site_corrected_preview(uuid,jsonb,jsonb,jsonb,boolean)','9ce407bf3ffc2d4f056ce7e366b8f5016c7e2fcc792016be0356d8b88424ddc9')
 ) AS x(signature,digest) LOOP
  f:=to_regprocedure(r.signature);
  IF f IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=f AND p.prosecdef AND p.provolatile='s' AND p.proconfig @> ARRAY['search_path=""'] AND pg_catalog.pg_get_userbyid(p.proowner)='postgres' AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=r.digest) OR NOT has_function_privilege('authenticated',f,'EXECUTE') OR has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'Multi-case dependency changed: %',r.signature; END IF;
 END LOOP;
END $preflight$;
CREATE OR REPLACE FUNCTION public.project_cost_cross_site_preview(p_kind text,p_case uuid,p_expected jsonb,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_now jsonb;v_original jsonb;v_correction jsonb;v_case jsonb;v_attribution jsonb;v_sites jsonb;v_split jsonb;v_row record;v_initial numeric;v_change numeric;v_sum_initial numeric:=0;v_sum_change numeric:=0;v_gross numeric;v_total numeric;v_result jsonb;v_items jsonb:='[]'::jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_kind IS NULL OR p_kind NOT IN ('voucher','external_worker') OR p_case IS NULL OR p_ack IS DISTINCT FROM true OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object' OR octet_length(p_expected::text)>262144 THEN RAISE EXCEPTION 'Invalid cross-site review' USING ERRCODE='22023'; END IF;
 v_now:=public.project_cost_cross_site_evidence(p_kind,p_case);
 IF v_now IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Cross-site evidence changed; reload and review' USING ERRCODE='40001'; END IF;
 v_original:=v_now->'original';v_correction:=v_now->'correction';v_case:=v_correction->'case';v_attribution:=v_correction->'attribution';v_sites:=v_original->'sites';
 IF jsonb_typeof(v_attribution) IS DISTINCT FROM 'object' OR (v_attribution->>'case_changed')::boolean IS DISTINCT FROM false OR v_attribution->'case_snapshot' IS DISTINCT FROM v_case OR coalesce(v_case->>'status','') NOT IN ('settled_external','no_transfer') OR jsonb_typeof(v_case->'related_cases') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Current resolved correction evidence required' USING ERRCODE='22023'; END IF;
 IF jsonb_array_length(v_case->'related_cases') NOT BETWEEN 1 AND 100 OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_case->'related_cases') s WHERE jsonb_typeof(s) IS DISTINCT FROM 'object' OR coalesce(s->>'id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR coalesce(s->>'status','') NOT IN ('settled_external','no_transfer')) OR (SELECT count(DISTINCT s->>'id') FROM jsonb_array_elements(v_case->'related_cases') s)<>jsonb_array_length(v_case->'related_cases') OR (SELECT count(*) FROM jsonb_array_elements(v_case->'related_cases') s WHERE s->>'id'=p_case::text AND s->>'status'=v_case->>'status')<>1 THEN RAISE EXCEPTION 'Current resolved sibling cases required' USING ERRCODE='22023'; END IF;
 v_split:=v_attribution->'split';
 IF jsonb_typeof(v_sites) IS DISTINCT FROM 'array' OR jsonb_array_length(v_sites) NOT BETWEEN 1 AND 50 OR jsonb_typeof(v_split) IS DISTINCT FROM 'array' OR jsonb_array_length(v_split)>50 THEN RAISE EXCEPTION 'Cross-site split unavailable or too large' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_sites) s WHERE jsonb_typeof(s) IS DISTINCT FROM 'object' OR jsonb_typeof(s->'project_id') IS DISTINCT FROM 'string' OR (s->>'project_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR jsonb_typeof(s->'gross') IS DISTINCT FROM 'string' OR (s->>'gross') !~ '^(0|[1-9][0-9]{0,9})\.[0-9]{2}$') OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_split) s WHERE jsonb_typeof(s) IS DISTINCT FROM 'object' OR jsonb_typeof(s->'project_id') IS DISTINCT FROM 'string' OR (s->>'project_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR jsonb_typeof(s->'gross_change') IS DISTINCT FROM 'string' OR (s->>'gross_change') !~ '^-?(0|[1-9][0-9]{0,9})\.[0-9]{2}$' OR (s->>'gross_change')::numeric=0) THEN RAISE EXCEPTION 'Invalid cross-site amount or identity' USING ERRCODE='22023'; END IF;
 IF jsonb_array_length(v_sites)<>(SELECT count(DISTINCT s->>'project_id') FROM jsonb_array_elements(v_sites) s) OR jsonb_array_length(v_split)<>(SELECT count(DISTINCT s->>'project_id') FROM jsonb_array_elements(v_split) s) THEN RAISE EXCEPTION 'Duplicate or missing cross-site identity' USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(v_original->'original_gross') IS DISTINCT FROM 'string' OR (v_original->>'original_gross') !~ '^(0|[1-9][0-9]{0,9})\.[0-9]{2}$' OR jsonb_typeof(v_attribution->'gross_change') IS DISTINCT FROM 'string' OR (v_attribution->>'gross_change') !~ '^-?(0|[1-9][0-9]{0,9})\.[0-9]{2}$' THEN RAISE EXCEPTION 'Invalid source amounts' USING ERRCODE='22023'; END IF;
 v_gross:=(v_original->>'original_gross')::numeric;v_total:=(v_attribution->>'gross_change')::numeric;
 IF v_gross IS NULL OR v_gross='NaN'::numeric OR v_gross<0 OR v_gross<>round(v_gross,2) OR v_gross>=10000000000 OR v_total IS NULL OR v_total='NaN'::numeric OR abs(v_total)>=10000000000 OR v_total<>round(v_total,2) THEN RAISE EXCEPTION 'Invalid source amounts' USING ERRCODE='22023'; END IF;
 FOR v_row IN SELECT project_id FROM (
  SELECT (s->>'project_id')::uuid project_id FROM jsonb_array_elements(v_sites) s
  UNION SELECT (s->>'project_id')::uuid FROM jsonb_array_elements(v_split) s
 ) ids ORDER BY project_id LOOP
  IF v_row.project_id IS NULL THEN RAISE EXCEPTION 'Missing site identity' USING ERRCODE='22023'; END IF;
  SELECT (s->>'gross')::numeric INTO v_initial FROM jsonb_array_elements(v_sites) s WHERE (s->>'project_id')::uuid=v_row.project_id;
  SELECT (s->>'gross_change')::numeric INTO v_change FROM jsonb_array_elements(v_split) s WHERE (s->>'project_id')::uuid=v_row.project_id;
  -- Zero here is permitted only because both complete validated arrays were
  -- present; missing evidence is rejected, not substituted with zero.
  v_initial:=coalesce(v_initial,0);v_change:=coalesce(v_change,0);
  IF v_initial='NaN'::numeric OR v_change='NaN'::numeric OR v_initial<0 OR v_initial>=10000000000 OR abs(v_change)>=10000000000 OR v_initial<>round(v_initial,2) OR v_change<>round(v_change,2) OR (jsonb_array_length(v_case->'related_cases')=1 AND v_initial+v_change<0) THEN RAISE EXCEPTION 'Correction exceeds or invalidates original site cost' USING ERRCODE='22023'; END IF;
  v_sum_initial:=v_sum_initial+v_initial;v_sum_change:=v_sum_change+v_change;
  v_items:=v_items||jsonb_build_array(jsonb_build_object('project_id',v_row.project_id,'original_gross',v_initial::numeric(12,2)::text,'gross_change',v_change::numeric(12,2)::text,'corrected_gross',(v_initial+v_change)::numeric(13,2)::text));
 END LOOP;
 IF v_sum_initial IS DISTINCT FROM v_gross OR v_sum_change IS DISTINCT FROM v_total OR (jsonb_array_length(v_case->'related_cases')=1 AND v_gross+v_total<0) THEN RAISE EXCEPTION 'Cross-site totals differ from reviewed source evidence' USING ERRCODE='22023'; END IF;
 v_result:=jsonb_build_object('source_kind',p_kind,'case_id',p_case,'source_id',v_original->>'source_id','original_gross',v_gross::numeric(12,2)::text,'gross_change',v_total::numeric(12,2)::text,'corrected_gross',(v_gross+v_total)::numeric(13,2)::text,'sites',v_items,'incomplete',true);
 RETURN v_result;
END $$;
CREATE OR REPLACE FUNCTION public.project_cost_cross_site_review_context(p_destination uuid,p_kind text,p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_evidence jsonb;v_original jsonb;v_illustration jsonb;v_destination jsonb;v_source_site jsonb;v_review jsonb;v_original_row jsonb;v_case_row jsonb;v_sources jsonb:='[]'::jsonb;v_key text;v_result jsonb;v_sibling jsonb;v_sibling_row jsonb;v_sibling_current jsonb;
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
 IF v_destination->>'original_gross' IS DISTINCT FROM '0.00' OR (v_destination->>'gross_change')::numeric=0 OR v_destination->>'gross_change' IS DISTINCT FROM v_destination->>'corrected_gross' THEN RAISE EXCEPTION 'Incoming destination amount invalid' USING ERRCODE='22023'; END IF;
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
  -- Each original site must include every sibling against the exact current
  -- attribution, not just the particular incoming case under inspection.
  FOR v_sibling IN SELECT value FROM jsonb_array_elements(v_evidence->'correction'->'case'->'related_cases') LOOP
   SELECT jsonb_agg(x) INTO v_sibling_row FROM jsonb_array_elements(v_review->'snapshot'->'corrections') x WHERE x->>'kind'=p_kind AND x->>'case_id'=v_sibling->>'id';
   IF coalesce(jsonb_array_length(v_sibling_row),0)<>1 THEN RAISE EXCEPTION 'Original sibling missing from site review' USING ERRCODE='22023'; END IF;
   v_sibling_row:=v_sibling_row->0;
   v_sibling_current:=public.project_cost_correction_attribution(p_kind,(v_sibling->>'id')::uuid,NULL);
   IF v_sibling_row->'source_in_snapshot' IS DISTINCT FROM 'true'::jsonb OR v_sibling_row->'evidence' IS DISTINCT FROM v_sibling_current OR v_sibling_current->'case'->'related_cases' IS DISTINCT FROM v_evidence->'correction'->'case'->'related_cases' OR v_sibling_current->'attribution' IS NULL OR v_sibling_current->'attribution'='null'::jsonb OR (v_sibling_current->'attribution'->>'case_changed')::boolean IS DISTINCT FROM false OR v_review->'choices'->'corrections'->(p_kind||':'||(v_sibling->>'id'))->>'decision' IS DISTINCT FROM 'include' THEN RAISE EXCEPTION 'Current sibling inclusions required at every original site' USING ERRCODE='22023'; END IF;
  END LOOP;
  v_sources:=v_sources||jsonb_build_array(jsonb_build_object('project_id',v_source_site->>'project_id','original_gross',v_source_site->>'gross','gross_change',v_case_row->>'site_gross_change','request_id',v_review->>'request_id','revision',(v_review->>'revision')::integer,'actor_id',v_review->>'actor_id','recorded_at',v_review->>'recorded_at'));
 END LOOP;
 v_result:=jsonb_build_object('destination',p_destination,'source_kind',p_kind,'case_id',p_case,'source_evidence',v_evidence,'illustration',v_illustration,'original_site_reviews',v_sources,'incomplete',true);
 IF octet_length(v_result::text)>524288 THEN RAISE EXCEPTION 'Cross-site review context too large' USING ERRCODE='54000'; END IF;
 RETURN v_result;
END $$;
CREATE OR REPLACE FUNCTION public.project_cost_cross_site_corrected_preview(p_project uuid,p_snapshot jsonb,p_choices jsonb,p_cross_sites jsonb,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_row jsonb;v_choice jsonb;v_base_choices jsonb;v_base jsonb;v_context jsonb;v_expected jsonb;v_destination jsonb;v_key text;v_change numeric;v_incoming numeric:=0;v_count integer:=0;v_total numeric;v_correction numeric;v_groups jsonb:='{}'::jsonb;v_source_key text;v_group jsonb;v_sibling jsonb;v_review jsonb;v_ids jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR p_ack IS DISTINCT FROM true OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' OR jsonb_typeof(p_snapshot->'corrections') IS DISTINCT FROM 'array' OR jsonb_array_length(p_snapshot->'corrections')>500 OR jsonb_typeof(p_choices) IS DISTINCT FROM 'object' OR jsonb_typeof(p_choices->'corrections') IS DISTINCT FROM 'object' OR jsonb_typeof(p_cross_sites) IS DISTINCT FROM 'object' OR octet_length(p_cross_sites::text)>500000 THEN RAISE EXCEPTION 'Invalid cross-site corrected review' USING ERRCODE='22023'; END IF;
 v_base_choices:=p_choices;
 FOR v_row IN SELECT value FROM jsonb_array_elements(p_snapshot->'corrections') LOOP
  v_key:=(v_row->>'kind')||':'||(v_row->>'case_id');v_choice:=p_choices->'corrections'->v_key;
  IF v_row->'source_in_snapshot' IS DISTINCT FROM 'false'::jsonb OR v_choice->>'decision' IS DISTINCT FROM 'include' THEN CONTINUE; END IF;
  IF v_row->>'kind' NOT IN ('voucher','external_worker') OR v_row->>'case_id' IS NULL THEN RAISE EXCEPTION 'Invalid incoming correction identity' USING ERRCODE='22023'; END IF;
  v_expected:=p_cross_sites->v_key;
  IF jsonb_typeof(v_expected) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Saved original-site review evidence required' USING ERRCODE='22023'; END IF;
  v_context:=public.project_cost_cross_site_review_context(p_project,v_row->>'kind',(v_row->>'case_id')::uuid);
  IF v_context IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'Original-site review evidence changed; reload and review' USING ERRCODE='40001'; END IF;
  IF v_context->>'destination' IS DISTINCT FROM p_project::text OR v_context->>'source_kind' IS DISTINCT FROM v_row->>'kind' OR v_context->>'case_id' IS DISTINCT FROM v_row->>'case_id' OR v_context->'incomplete' IS DISTINCT FROM 'true'::jsonb OR v_context->'source_evidence'->'correction' IS DISTINCT FROM v_row->'evidence' THEN RAISE EXCEPTION 'Incoming correction evidence differs' USING ERRCODE='22023'; END IF;
  SELECT jsonb_agg(s) INTO v_destination FROM jsonb_array_elements(v_context->'illustration'->'sites') s WHERE s->>'project_id'=p_project::text;
  IF coalesce(jsonb_array_length(v_destination),0)<>1 THEN RAISE EXCEPTION 'Incoming correction destination unavailable' USING ERRCODE='22023'; END IF;
  v_destination:=v_destination->0;
  IF v_destination->>'original_gross' IS DISTINCT FROM '0.00' OR v_destination->>'gross_change' IS DISTINCT FROM v_row->>'site_gross_change' OR v_destination->>'gross_change' IS DISTINCT FROM v_destination->>'corrected_gross' OR v_destination->>'gross_change' !~ '^-?(0|[1-9][0-9]{0,9})\.[0-9]{2}$' THEN RAISE EXCEPTION 'Incoming correction amount differs' USING ERRCODE='22023'; END IF;
  v_change:=(v_destination->>'gross_change')::numeric;
  IF v_change IS NULL OR v_change=0 THEN RAISE EXCEPTION 'Incoming correction must be nonzero' USING ERRCODE='22023'; END IF;
  v_source_key:=(v_row->>'kind')||':'||(v_context->'source_evidence'->'original'->>'source_id');
  IF v_source_key !~ '^(voucher|external_worker):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Incoming source identity unavailable' USING ERRCODE='22023'; END IF;
  v_group:=coalesce(v_groups->v_source_key,jsonb_build_object('amount',0,'ids','[]'::jsonb));
  v_group:=jsonb_set(v_group,'{amount}',to_jsonb((v_group->>'amount')::numeric+v_change));
  v_group:=jsonb_set(v_group,'{ids}',(v_group->'ids')||jsonb_build_array(v_key));
  v_groups:=jsonb_set(v_groups,ARRAY[v_source_key],v_group,true);
  -- The existing preview validates all decisions and the destination's exact
  -- inventory; replace only this incoming inclusion with an explicit omission
  -- for its calculation, then add the separately verified positive effect.
  v_base_choices:=jsonb_set(v_base_choices,ARRAY['corrections',v_key,'decision'],'"exclude"'::jsonb);
  v_count:=v_count+1;v_incoming:=v_incoming+v_change;
 END LOOP;
 -- A source's destination effects are one decision: do not omit a sibling
 -- named in this destination inventory while including another sibling.
 FOR v_source_key,v_group IN SELECT key,value FROM jsonb_each(v_groups) LOOP
  IF (v_group->>'amount')::numeric<0 THEN RAISE EXCEPTION 'Incoming source total cannot be negative' USING ERRCODE='22023'; END IF;
  FOR v_sibling IN SELECT value FROM jsonb_array_elements(p_snapshot->'corrections') LOOP
   IF v_sibling->'source_in_snapshot'='false'::jsonb AND ((v_sibling->>'kind')||':'||(CASE v_sibling->>'kind' WHEN 'voucher' THEN v_sibling->'evidence'->'case'->>'payroll_id' WHEN 'external_worker' THEN v_sibling->'evidence'->'case'->>'external_worker_id' END))=v_source_key AND NOT (v_group->'ids' ? ((v_sibling->>'kind')||':'||(v_sibling->>'case_id'))) THEN RAISE EXCEPTION 'Include all incoming siblings for the same source' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF jsonb_array_length(v_group->'ids')>1 THEN
   SELECT jsonb_agg(value ORDER BY value COLLATE "C") INTO v_ids FROM jsonb_array_elements_text(v_group->'ids');
   v_review:=p_choices->'source_reviews'->v_source_key;
   IF jsonb_typeof(v_review) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(v_review)='object' THEN v_review ELSE '{}'::jsonb END))<>3 OR NOT(v_review ?& ARRAY['case_ids','note','non_overlapping']) OR v_review->'case_ids' IS DISTINCT FROM v_ids OR v_review->'non_overlapping' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(v_review->'note') IS DISTINCT FROM 'string' OR length(btrim(v_review->>'note')) NOT BETWEEN 1 AND 300 OR btrim(v_review->>'note') IS DISTINCT FROM v_review->>'note' OR (v_review->>'note') ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'Multiple incoming corrections require an exact distinct-effects review' USING ERRCODE='22023'; END IF;
   v_base_choices:=jsonb_set(v_base_choices,'{source_reviews}',(v_base_choices->'source_reviews')-v_source_key);
  END IF;
 END LOOP;
 IF (SELECT count(*) FROM jsonb_object_keys(p_cross_sites))<>v_count THEN RAISE EXCEPTION 'Unexpected or missing cross-site evidence' USING ERRCODE='22023'; END IF;
 v_base:=public.project_cost_corrected_preview(p_project,p_snapshot,v_base_choices,true);
 IF v_base->>'project_id' IS DISTINCT FROM p_project::text OR v_base->'incomplete' IS DISTINCT FROM 'true'::jsonb OR (v_base->>'excluded_cases')::integer<v_count THEN RAISE EXCEPTION 'Base corrected preview differs' USING ERRCODE='22023'; END IF;
 v_total:=(v_base->>'incomplete_total')::numeric+v_incoming;v_correction:=(v_base->>'correction_gross')::numeric+v_incoming;
 IF v_total IS NULL OR v_total<0 OR v_total>=100000000000000 OR v_correction IS NULL OR abs(v_correction)>=100000000000000 THEN RAISE EXCEPTION 'Cross-site corrected total invalid' USING ERRCODE='22023'; END IF;
 RETURN v_base||jsonb_build_object('incomplete_total',v_total::numeric(16,2)::text,'correction_gross',v_correction::numeric(16,2)::text,'excluded_cases',(v_base->>'excluded_cases')::integer-v_count,'cross_site_gross',v_incoming::numeric(16,2)::text,'cross_site_cases',v_count);
END $$;
