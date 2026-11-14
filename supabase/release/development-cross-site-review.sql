-- HELD DEVELOPMENT PREPARATION ONLY. One managed transaction required.
-- Catalog and account counts do not identify a target or prove isolation.
-- Pinned source files:
-- supabase/drafts/project_cost_correction_original_context.sql 727afdb3cf631e5862690eaa4cc6a4816f5518fe95237fe9d4c1c009498ac846
-- supabase/drafts/project_cost_cross_site_preview.sql 45c333401d03f022c5c30ded319634c31aa24279e7bf612cdea36edc007efe1c
-- supabase/drafts/project_cost_cross_site_review_context.sql e259348f3f25013e7420035bf106145cf00a30d1f139803b1431b9830c23bbfc
-- supabase/drafts/project_cost_cross_site_corrected_preview.sql 1b0cc8c54fd16a148889aa851a7aaa43c2418126d88b68405665913a330db932
-- supabase/drafts/project_cost_cross_site_review_ledger.sql 444383e22c370ae21a51b8112eefc96fa8d67fe1af838430043f6765b142bce9
-- supabase/preflight/development-corrected-writer-audit.sql aa19030da7bd968b49627327401dcbc81c07717205539e22f9293e3caf6ac738
DO $manual_hold$ BEGIN IF current_setting('app.cross_site_development_reviewed',true) IS DISTINCT FROM 'yes' THEN RAISE EXCEPTION 'Cross-site preparation held pending target verification and rehearsal'; END IF; END $manual_hold$;

-- Snapshot-specific checks do not establish the target, isolate production, or
-- prove an exhaustive writer audit. Rehearse and independently verify first.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
LOCK TABLE public.users,public.workers,public.projects,public.payroll,public.expenses,public.confirmed_rental_expenses,public.weekly_worker_paid_allocations,public.weekly_worker_draft_sources,public.payroll_payment_dates,public.historical_external_worker_payroll,public.historical_worker_attributions,public.historical_worker_attribution_sites,public.paid_payroll_adjustment_cases,public.paid_period_assertion_cases,public.project_cost_correction_attributions,public.project_cost_correction_sites,public.project_cost_corrected_reviews IN SHARE ROW EXCLUSIVE MODE;
DO $cross_site_development_preflight$
DECLARE r record; f oid;
BEGIN
 IF current_database()<>'postgres' OR (SELECT count(*) FROM auth.users)<>2 OR (SELECT count(*) FROM public.users)<>2 OR (SELECT count(*) FROM public.users WHERE role='founder')<>1 OR (SELECT count(*) FROM public.users WHERE role='supervisor')<>1 THEN RAISE EXCEPTION 'Development database or accounts changed'; END IF;
 IF EXISTS(SELECT 1 FROM public.workers) OR EXISTS(SELECT 1 FROM public.projects) OR EXISTS(SELECT 1 FROM public.payroll) OR EXISTS(SELECT 1 FROM public.expenses) OR EXISTS(SELECT 1 FROM public.confirmed_rental_expenses) OR EXISTS(SELECT 1 FROM public.weekly_worker_paid_allocations) OR EXISTS(SELECT 1 FROM public.weekly_worker_draft_sources) OR EXISTS(SELECT 1 FROM public.payroll_payment_dates) OR EXISTS(SELECT 1 FROM public.historical_external_worker_payroll) OR EXISTS(SELECT 1 FROM public.historical_worker_attributions) OR EXISTS(SELECT 1 FROM public.historical_worker_attribution_sites) OR EXISTS(SELECT 1 FROM public.paid_payroll_adjustment_cases) OR EXISTS(SELECT 1 FROM public.paid_period_assertion_cases) OR EXISTS(SELECT 1 FROM public.project_cost_correction_attributions) OR EXISTS(SELECT 1 FROM public.project_cost_correction_sites) OR EXISTS(SELECT 1 FROM public.project_cost_corrected_reviews) THEN RAISE EXCEPTION 'Development source data changed; re-review'; END IF;
 FOR r IN SELECT * FROM (VALUES
  ('app_private.project_cost_correction_case(text,uuid)','8276d60c11070b540d48ee4e9e35691fcd8aad4b716726834b1619ea7936e09a',false),
  ('public.project_cost_historical_review(uuid)','e625c812572026a66fe2e61c98f5bd2615ec5ed6b0b8aa9c1e0b4e63bd590f73',true),
  ('public.project_cost_correction_inventory(uuid)','b2c7b2af869603fe8e1eaf28f5110a8ff20b90e158d00cda135473707021b1f1',true),
  ('public.project_cost_correction_attribution(text,uuid,integer)','d329c05825457871dee936776304b84cd893bf3573f84e9eb82f63fb3e317eb1',true),
  ('public.project_cost_corrected_preview(uuid,jsonb,jsonb,boolean)','71a132dc3a78d47b43fa9b01c641dfd0699c274b55189ce25c9bae94f0e6a33d',true),
  ('public.project_cost_corrected_review(uuid,integer)','ff58e3b14ca9d39d6e76116e9c81fbb35ce232ea9803e4dab5ac680c4becd8f0',true),
  ('public.is_founder()','fa022685cbf0e33ef812828fe537dd307a57712ad05e21bb2d47eb72feb341a3',true),
  ('public.session_assurance_satisfied()','d4c6a53f7792703119ac26443213db4f4cf695d0b390f008a5926f3b32569850',true)
 ) AS expected(signature,digest,authenticated_execute) LOOP
  f:=to_regprocedure(r.signature);
  IF f IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f AND p.prokind='f' AND p.prosecdef AND pg_get_userbyid(p.proowner)='postgres') OR encode(sha256(convert_to(pg_get_functiondef(f),'UTF8')),'hex') IS DISTINCT FROM r.digest OR (r.signature NOT IN ('public.is_founder()','public.session_assurance_satisfied()') AND (has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('service_role',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') IS DISTINCT FROM r.authenticated_execute)) THEN RAISE EXCEPTION 'Cross-site dependency changed: %',r.signature; END IF;
 END LOOP;
END $cross_site_development_preflight$;

-- DEVELOPMENT PREPARATION ONLY. Read-only, point-in-time catalog guard for
-- selected direct textual writers of the correction review's source tables.
-- This is NOT an exhaustive writer audit: dynamic SQL, quoted identifiers,
-- indirect calls, owner actions, triggers and DDL changes can evade this
-- search. The operator must independently verify the target and coordinate
-- a quiet migration; this does not lock function definitions against DDL.
DO $corrected_writer_audit$
DECLARE r record; v_oid oid; v_known oid[]:='{}'::oid[]; v_found integer;
BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('public.confirm_rental_expense(uuid,uuid,uuid,numeric,date,text,text,text,integer,date,date)','fed9d8ec95c7a119fe4fe9ca59b3e91a62ddee3d5662143f1c8cc8d2ea504198',true),
  ('public.create_weekly_worker_draft(uuid,uuid,date)','303f3a42eceb0f16eb01063de08636ededaa9de169f3c830f7c7c29268924018',true),
  ('public.open_paid_payroll_adjustment(uuid,uuid,jsonb,numeric,text)','ff403a8ef943eb27208a00005ba51d493f5b01bb13171d10f15607977696cfb4',true),
  ('public.open_paid_period_assertion_case(uuid,text,uuid,jsonb,numeric,text)','c6d3c6c12c7c59bf020a0c3b7401f935b654f20ef2962c39bbe8f95570a38a5d',true),
  ('public.record_historical_worker_attribution(uuid,uuid,jsonb,jsonb,text,boolean)','ee533b4a2c620cf011bc3df71e3cff322c087b70bda9ab181d7330b77ca4792d',true),
  ('public.refresh_weekly_worker_draft(uuid,uuid,bigint)','cf6ed49a80b94bf27d7a2cf1a789cfc99cf17b3609185d2c33a89b71a684822c',true),
  ('public.resolve_paid_payroll_adjustment(uuid,text,date,text)','32c702ee23f4ad1b55fb06cca419fdc0494c3dd42a9cee4d023f4fab0ec25e37',true),
  ('public.resolve_paid_period_assertion_case(uuid,text,date,text,boolean)','11aa2505d96e023a116d33fd672ccb442bfd80b464f5c2803a410f92fe30869e',true),
  ('public.return_weekly_worker_to_draft(uuid,uuid,bigint,text)','8dfde320739baef335c2ba9b5a18b48e7233f1458d441d76caac920462cf5bfb',true),
  ('public.weekly_payment_date_internal(uuid,date)','7aff33302c8ce5b9dca2bd2a6ca67b27868a31cbfed04a50b23346886ea95ef0',false),
  ('public.weekly_worker_approval_internal(uuid)','34f2ce1bb4173312d76c74acb65cc72c28af1846088dec3e67c5ad7481ae5f93',false),
  ('public.weekly_worker_payment_internal(uuid,date)','a124cbfb4c8e3a8d035fe0cd90c4280899ab33be3795dd46c8a6d94080415f36',false)
 ) AS expected(signature,digest,authenticated_execute) LOOP
  v_oid:=to_regprocedure(r.signature);
  IF v_oid IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=v_oid AND p.prokind='f' AND p.prosecdef AND pg_get_userbyid(p.proowner)='postgres') OR encode(sha256(convert_to(pg_get_functiondef(v_oid),'UTF8')),'hex') IS DISTINCT FROM r.digest OR has_function_privilege('anon',v_oid,'EXECUTE') OR has_function_privilege('service_role',v_oid,'EXECUTE') OR has_function_privilege('authenticated',v_oid,'EXECUTE') IS DISTINCT FROM r.authenticated_execute THEN
   RAISE EXCEPTION 'Selected development source writer changed: %',r.signature;
  END IF;
  v_known:=array_append(v_known,v_oid);
 END LOOP;
 SELECT count(*) INTO v_found FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN ('public','app_private') AND p.prokind='f'
  AND p.prosrc ~* '(insert\s+into|update|delete\s+from|truncate)\s+(public\.)?(expenses|confirmed_rental_expenses|weekly_worker_paid_allocations|weekly_worker_draft_sources|payroll_payment_dates|historical_worker_attributions|historical_worker_attribution_sites|paid_payroll_adjustment_cases|paid_period_assertion_cases)'
  AND NOT(p.oid=ANY(v_known));
 IF v_found<>0 THEN RAISE EXCEPTION 'Additional selected textual source writer found; review required'; END IF;
END $corrected_writer_audit$;

-- UNINSTALLED, READ-ONLY CANDIDATE. Collect original site evidence for a
-- correction whose reviewed split may point to another site. This is NOT a
-- cross-site posting, a decision to include any original, proof of payment, or
-- a complete project cost. The existing site review must still block unlinked
-- corrections until an independently reviewed integration is implemented.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regprocedure('app_private.project_cost_correction_case(text,uuid)') IS NULL OR to_regprocedure('public.project_cost_historical_review(uuid)') IS NULL OR to_regclass('public.weekly_worker_paid_allocations') IS NULL OR to_regclass('public.historical_worker_attributions') IS NULL OR to_regclass('public.historical_worker_attribution_sites') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Original-site context prerequisites missing'; END IF;
 IF to_regprocedure('public.project_cost_correction_original_context(text,uuid)') IS NOT NULL THEN RAISE EXCEPTION 'Original-site context name collision'; END IF;
END $preflight$;
CREATE FUNCTION public.project_cost_correction_original_context(p_kind text,p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_case jsonb;v_original jsonb;v_source uuid;v_worker uuid;v_start date;v_end date;v_paid date;v_gross numeric;v_sites uuid[];v_site uuid;v_history jsonb;v_rows jsonb;v_row jsonb;v_value numeric;v_sum numeric:=0;v_items jsonb:='[]'::jsonb;v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_kind IS NULL OR p_kind NOT IN ('voucher','external_worker') OR p_case IS NULL THEN RAISE EXCEPTION 'Invalid original-site context request' USING ERRCODE='22023'; END IF;
 -- This verified case reader refuses missing/changed source or sibling evidence.
 v_case:=app_private.project_cost_correction_case(p_kind,p_case);
 IF jsonb_typeof(v_case) IS DISTINCT FROM 'object' OR jsonb_typeof(v_case->'related_cases') IS DISTINCT FROM 'array' OR octet_length(v_case::text)>65536 THEN RAISE EXCEPTION 'Original case evidence unavailable' USING ERRCODE='22023'; END IF;
 IF p_kind='voucher' THEN
  v_original:=v_case->'original_voucher';v_source:=(v_case->>'payroll_id')::uuid;v_worker:=(v_case->>'worker_id')::uuid;
  v_start:=(v_original->>'period_start')::date;v_end:=(v_original->>'period_end')::date;v_gross:=(v_original->>'gross_pay')::numeric;
  IF v_original->>'id' IS DISTINCT FROM v_source::text OR v_original->>'worker_id' IS DISTINCT FROM v_worker::text OR v_original->>'status' IS DISTINCT FROM 'paid' THEN RAISE EXCEPTION 'Original voucher identity differs' USING ERRCODE='22023'; END IF;
  SELECT array_agg(project_id ORDER BY project_id) INTO v_sites FROM (SELECT project_id FROM public.weekly_worker_paid_allocations WHERE payroll_id=v_source ORDER BY project_id LIMIT 51) s;
 ELSE
  v_original:=v_case->'original_snapshot';v_source:=(v_case->>'external_worker_id')::uuid;v_worker:=(v_original->>'person_id')::uuid;
  v_start:=(v_original->>'start')::date;v_end:=(v_original->>'end')::date;v_paid:=(v_original->>'paid_on')::date;v_gross:=(v_original->>'gross')::numeric;
  IF v_case->>'source_kind' IS DISTINCT FROM 'external_worker' OR v_original->>'kind' IS DISTINCT FROM 'external_worker' OR v_original->>'id' IS DISTINCT FROM v_source::text THEN RAISE EXCEPTION 'Original historical identity differs' USING ERRCODE='22023'; END IF;
  SELECT array_agg(project_id ORDER BY project_id) INTO v_sites FROM (SELECT s.project_id FROM public.historical_worker_attributions a JOIN public.historical_worker_attribution_sites s ON s.attribution_id=a.request_id WHERE a.source_id=v_source ORDER BY s.project_id LIMIT 51) x;
 END IF;
 IF v_source IS NULL OR v_worker IS NULL OR v_start IS NULL OR v_end IS NULL OR NOT isfinite(v_start) OR NOT isfinite(v_end) OR v_start>v_end OR v_gross IS NULL OR v_gross='NaN'::numeric OR v_gross<0 OR v_gross<>round(v_gross,2) OR v_gross>=10000000000 OR (p_kind='external_worker' AND (v_paid IS NULL OR NOT isfinite(v_paid))) THEN RAISE EXCEPTION 'Original source evidence invalid' USING ERRCODE='22023'; END IF;
 IF coalesce(cardinality(v_sites),0) NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Original site allocation unavailable or exceeds 50 sites' USING ERRCODE='54000'; END IF;
 IF (SELECT count(DISTINCT x) FROM unnest(v_sites) x)<>cardinality(v_sites) OR array_position(v_sites,NULL) IS NOT NULL THEN RAISE EXCEPTION 'Original sites are duplicated or unavailable' USING ERRCODE='22023'; END IF;
 FOREACH v_site IN ARRAY v_sites LOOP
  -- The existing bounded site reader validates allocation and historical split
  -- integrity. Oversized or inconsistent sites fail the entire context closed.
  v_history:=public.project_cost_historical_review(v_site);
  IF v_history->>'project_id' IS DISTINCT FROM v_site::text THEN RAISE EXCEPTION 'Original site identity differs' USING ERRCODE='22023'; END IF;
  v_rows:=CASE WHEN p_kind='voucher' THEN v_history->'base'->'paid_allocations' ELSE v_history->'historical' END;
  IF jsonb_typeof(v_rows) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Original site evidence unavailable' USING ERRCODE='22023'; END IF;
  SELECT jsonb_agg(x) INTO v_row FROM jsonb_array_elements(v_rows) x WHERE CASE WHEN p_kind='voucher' THEN x->>'payroll_id'=v_source::text ELSE x->>'source_id'=v_source::text END;
  IF coalesce(jsonb_array_length(v_row),0)<>1 THEN RAISE EXCEPTION 'Original site source missing or ambiguous' USING ERRCODE='22023'; END IF;
  v_row:=v_row->0;
  IF v_row->>'worker_id' IS DISTINCT FROM v_worker::text OR v_row->>'period_start' IS DISTINCT FROM v_start::text OR v_row->>'period_end' IS DISTINCT FROM v_end::text THEN RAISE EXCEPTION 'Original site source identity differs' USING ERRCODE='22023'; END IF;
  IF p_kind='voucher' THEN
   IF (v_row->>'voucher_gross')::numeric IS DISTINCT FROM v_gross THEN RAISE EXCEPTION 'Original voucher gross differs' USING ERRCODE='22023'; END IF;
   v_value:=(v_row->>'gross')::numeric;
  ELSE
   IF (v_row->>'original_gross')::numeric IS DISTINCT FROM v_gross OR (v_row->>'paid_on')::date IS DISTINCT FROM v_paid OR (v_row->>'overlapping_vouchers')::bigint IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'Original historical evidence or voucher overlap requires review' USING ERRCODE='22023'; END IF;
   v_value:=(v_row->>'site_gross')::numeric;
  END IF;
  IF v_value IS NULL OR v_value='NaN'::numeric OR v_value<0 OR v_value<>round(v_value,2) OR v_value>=10000000000 THEN RAISE EXCEPTION 'Original site amount invalid' USING ERRCODE='22023'; END IF;
  v_sum:=v_sum+v_value;v_items:=v_items||jsonb_build_array(jsonb_build_object('project_id',v_site,'gross',v_value::numeric(12,2)::text));
 END LOOP;
 IF v_sum IS DISTINCT FROM v_gross THEN RAISE EXCEPTION 'Original site total differs from source' USING ERRCODE='22023'; END IF;
 -- The fingerprint ties this context to the entire verified case and sibling
 -- snapshot. It is a freshness signal, not proof of correctness or payment.
 v_result:=jsonb_build_object('source_kind',p_kind,'case_id',p_case,'source_id',v_source,'worker_id',v_worker,'period_start',v_start,'period_end',v_end,'original_gross',v_gross::numeric(12,2)::text,'case_snapshot',v_case,'case_fingerprint',encode(sha256(convert_to(v_case::text,'UTF8')),'hex'),'sites',v_items);
 IF octet_length(v_result::text)>131072 THEN RAISE EXCEPTION 'Original site context too large' USING ERRCODE='54000'; END IF;
 RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.project_cost_correction_original_context(text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_correction_original_context(text,uuid) TO authenticated;
DO $postflight$ BEGIN
 IF has_function_privilege('anon','public.project_cost_correction_original_context(text,uuid)','EXECUTE') OR has_function_privilege('service_role','public.project_cost_correction_original_context(text,uuid)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_correction_original_context(text,uuid)','EXECUTE') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.project_cost_correction_original_context(text,uuid)'::regprocedure AND prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION 'Unexpected original-site context privileges'; END IF;
END $postflight$;

-- UNINSTALLED, READ-ONLY CANDIDATE. One-source, all-site gross illustration.
-- Nothing is saved or posted; this is not a project total, transfer or proof
-- of payment. It must not be added to per-project review totals. Existing
-- corrected project reviews continue to block unlinked corrections.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regprocedure('public.project_cost_correction_original_context(text,uuid)') IS NULL OR to_regprocedure('public.project_cost_correction_attribution(text,uuid,integer)') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Cross-site preview prerequisites missing'; END IF;
 IF to_regprocedure('public.project_cost_cross_site_evidence(text,uuid)') IS NOT NULL OR to_regprocedure('public.project_cost_cross_site_preview(text,uuid,jsonb,boolean)') IS NOT NULL THEN RAISE EXCEPTION 'Cross-site preview name collision'; END IF;
END $preflight$;
CREATE FUNCTION public.project_cost_cross_site_evidence(p_kind text,p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_original jsonb;v_correction jsonb;v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_kind IS NULL OR p_kind NOT IN ('voucher','external_worker') OR p_case IS NULL THEN RAISE EXCEPTION 'Invalid cross-site evidence request' USING ERRCODE='22023'; END IF;
 -- Both STABLE readers share this statement snapshot. They do not lock later
 -- writers or prove the evidence is complete in the real world.
 v_original:=public.project_cost_correction_original_context(p_kind,p_case);
 v_correction:=public.project_cost_correction_attribution(p_kind,p_case,NULL);
 IF v_original->>'source_kind' IS DISTINCT FROM p_kind OR v_original->>'case_id' IS DISTINCT FROM p_case::text OR v_correction->>'source_kind' IS DISTINCT FROM p_kind OR v_correction->>'case_id' IS DISTINCT FROM p_case::text OR v_original->'case_snapshot' IS DISTINCT FROM v_correction->'case' THEN RAISE EXCEPTION 'Cross-site case evidence differs' USING ERRCODE='22023'; END IF;
 v_result:=jsonb_build_object('source_kind',p_kind,'case_id',p_case,'original',v_original,'correction',v_correction);
 IF octet_length(v_result::text)>262144 THEN RAISE EXCEPTION 'Cross-site evidence too large' USING ERRCODE='54000'; END IF;
 RETURN v_result;
END $$;

CREATE FUNCTION public.project_cost_cross_site_preview(p_kind text,p_case uuid,p_expected jsonb,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_now jsonb;v_original jsonb;v_correction jsonb;v_case jsonb;v_attribution jsonb;v_sites jsonb;v_split jsonb;v_row record;v_initial numeric;v_change numeric;v_sum_initial numeric:=0;v_sum_change numeric:=0;v_gross numeric;v_total numeric;v_result jsonb;v_items jsonb:='[]'::jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_kind IS NULL OR p_kind NOT IN ('voucher','external_worker') OR p_case IS NULL OR p_ack IS DISTINCT FROM true OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object' OR octet_length(p_expected::text)>262144 THEN RAISE EXCEPTION 'Invalid cross-site review' USING ERRCODE='22023'; END IF;
 v_now:=public.project_cost_cross_site_evidence(p_kind,p_case);
 IF v_now IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Cross-site evidence changed; reload and review' USING ERRCODE='40001'; END IF;
 v_original:=v_now->'original';v_correction:=v_now->'correction';v_case:=v_correction->'case';v_attribution:=v_correction->'attribution';v_sites:=v_original->'sites';
 IF jsonb_typeof(v_attribution) IS DISTINCT FROM 'object' OR (v_attribution->>'case_changed')::boolean IS DISTINCT FROM false OR v_attribution->'case_snapshot' IS DISTINCT FROM v_case OR coalesce(v_case->>'status','') NOT IN ('settled_external','no_transfer') OR jsonb_typeof(v_case->'related_cases') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Current resolved correction evidence required' USING ERRCODE='22023'; END IF;
 -- Until a reviewed multi-case cross-site protocol exists, do not silently
 -- ignore any sibling case even if it is resolved or has a zero split.
 IF jsonb_array_length(v_case->'related_cases')<>1 OR v_case->'related_cases'->0->>'id' IS DISTINCT FROM p_case::text OR v_case->'related_cases'->0->>'status' IS DISTINCT FROM v_case->>'status' THEN RAISE EXCEPTION 'Cross-site review requires exactly one original-period case' USING ERRCODE='22023'; END IF;
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
  IF v_initial='NaN'::numeric OR v_change='NaN'::numeric OR v_initial<0 OR v_initial>=10000000000 OR abs(v_change)>=10000000000 OR v_initial<>round(v_initial,2) OR v_change<>round(v_change,2) OR v_initial+v_change<0 THEN RAISE EXCEPTION 'Correction exceeds or invalidates original site cost' USING ERRCODE='22023'; END IF;
  v_sum_initial:=v_sum_initial+v_initial;v_sum_change:=v_sum_change+v_change;
  v_items:=v_items||jsonb_build_array(jsonb_build_object('project_id',v_row.project_id,'original_gross',v_initial::numeric(12,2)::text,'gross_change',v_change::numeric(12,2)::text,'corrected_gross',(v_initial+v_change)::numeric(13,2)::text));
 END LOOP;
 IF v_sum_initial IS DISTINCT FROM v_gross OR v_sum_change IS DISTINCT FROM v_total OR v_gross+v_total<0 THEN RAISE EXCEPTION 'Cross-site totals differ from reviewed source evidence' USING ERRCODE='22023'; END IF;
 v_result:=jsonb_build_object('source_kind',p_kind,'case_id',p_case,'source_id',v_original->>'source_id','original_gross',v_gross::numeric(12,2)::text,'gross_change',v_total::numeric(12,2)::text,'corrected_gross',(v_gross+v_total)::numeric(13,2)::text,'sites',v_items,'incomplete',true);
 RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.project_cost_cross_site_evidence(text,uuid),public.project_cost_cross_site_preview(text,uuid,jsonb,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_cross_site_evidence(text,uuid),public.project_cost_cross_site_preview(text,uuid,jsonb,boolean) TO authenticated;
DO $postflight$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['public.project_cost_cross_site_evidence(text,uuid)','public.project_cost_cross_site_preview(text,uuid,jsonb,boolean)'] LOOP
  IF has_function_privilege('anon',r,'EXECUTE') OR has_function_privilege('service_role',r,'EXECUTE') OR NOT has_function_privilege('authenticated',r,'EXECUTE') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(r) AND prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION 'Unexpected cross-site preview privileges'; END IF;
 END LOOP;
END $postflight$;

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

-- UNINSTALLED, read-only integration for a destination project. Builds on the
-- existing corrected preview and requires exact saved source-site decisions.
-- Supports one-case positive incoming corrections only. No review is saved,
-- no original payroll changes, and the result remains an incomplete estimate.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regprocedure('public.project_cost_corrected_preview(uuid,jsonb,jsonb,boolean)') IS NULL OR to_regprocedure('public.project_cost_cross_site_review_context(uuid,text,uuid)') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Cross-site corrected preview prerequisites missing'; END IF;
 IF to_regprocedure('public.project_cost_cross_site_corrected_preview(uuid,jsonb,jsonb,jsonb,boolean)') IS NOT NULL THEN RAISE EXCEPTION 'Cross-site corrected preview name collision'; END IF;
END $preflight$;
CREATE FUNCTION public.project_cost_cross_site_corrected_preview(p_project uuid,p_snapshot jsonb,p_choices jsonb,p_cross_sites jsonb,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_row jsonb;v_choice jsonb;v_base_choices jsonb;v_base jsonb;v_context jsonb;v_expected jsonb;v_destination jsonb;v_key text;v_change numeric;v_incoming numeric:=0;v_count integer:=0;v_total numeric;v_correction numeric;
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
  IF v_destination->>'original_gross' IS DISTINCT FROM '0.00' OR v_destination->>'gross_change' IS DISTINCT FROM v_row->>'site_gross_change' OR v_destination->>'gross_change' IS DISTINCT FROM v_destination->>'corrected_gross' OR v_destination->>'gross_change' !~ '^(0|[1-9][0-9]{0,9})\.[0-9]{2}$' THEN RAISE EXCEPTION 'Incoming correction amount differs' USING ERRCODE='22023'; END IF;
  v_change:=(v_destination->>'gross_change')::numeric;
  IF v_change IS NULL OR v_change<=0 THEN RAISE EXCEPTION 'Incoming correction must be positive' USING ERRCODE='22023'; END IF;
  -- The existing preview validates all decisions and the destination's exact
  -- inventory; replace only this incoming inclusion with an explicit omission
  -- for its calculation, then add the separately verified positive effect.
  v_base_choices:=jsonb_set(v_base_choices,ARRAY['corrections',v_key,'decision'],'"exclude"'::jsonb);
  v_count:=v_count+1;v_incoming:=v_incoming+v_change;
 END LOOP;
 IF (SELECT count(*) FROM jsonb_object_keys(p_cross_sites))<>v_count THEN RAISE EXCEPTION 'Unexpected or missing cross-site evidence' USING ERRCODE='22023'; END IF;
 v_base:=public.project_cost_corrected_preview(p_project,p_snapshot,v_base_choices,true);
 IF v_base->>'project_id' IS DISTINCT FROM p_project::text OR v_base->'incomplete' IS DISTINCT FROM 'true'::jsonb OR (v_base->>'excluded_cases')::integer<v_count THEN RAISE EXCEPTION 'Base corrected preview differs' USING ERRCODE='22023'; END IF;
 v_total:=(v_base->>'incomplete_total')::numeric+v_incoming;v_correction:=(v_base->>'correction_gross')::numeric+v_incoming;
 IF v_total IS NULL OR v_total<0 OR v_total>=100000000000000 OR v_correction IS NULL OR abs(v_correction)>=100000000000000 THEN RAISE EXCEPTION 'Cross-site corrected total invalid' USING ERRCODE='22023'; END IF;
 RETURN v_base||jsonb_build_object('incomplete_total',v_total::numeric(16,2)::text,'correction_gross',v_correction::numeric(16,2)::text,'excluded_cases',(v_base->>'excluded_cases')::integer-v_count,'cross_site_gross',v_incoming::numeric(16,2)::text,'cross_site_cases',v_count);
END $$;
REVOKE ALL ON FUNCTION public.project_cost_cross_site_corrected_preview(uuid,jsonb,jsonb,jsonb,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_cross_site_corrected_preview(uuid,jsonb,jsonb,jsonb,boolean) TO authenticated;
DO $postflight$ BEGIN
 IF has_function_privilege('anon','public.project_cost_cross_site_corrected_preview(uuid,jsonb,jsonb,jsonb,boolean)','EXECUTE') OR has_function_privilege('service_role','public.project_cost_cross_site_corrected_preview(uuid,jsonb,jsonb,jsonb,boolean)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_cross_site_corrected_preview(uuid,jsonb,jsonb,jsonb,boolean)','EXECUTE') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.project_cost_cross_site_corrected_preview(uuid,jsonb,jsonb,jsonb,boolean)'::regprocedure AND prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION 'Unexpected cross-site corrected preview privileges'; END IF;
END $postflight$;

-- UNINSTALLED. Separate durable revisions for incomplete cross-site project
-- reviews. Never alters earlier reviews, payroll, expenses, or payments. A
-- matching read is point-in-time evidence, not completeness or a source lock.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regclass('public.projects') IS NULL OR to_regclass('public.users') IS NULL OR to_regprocedure('public.project_cost_correction_inventory(uuid)') IS NULL OR to_regprocedure('public.project_cost_cross_site_corrected_preview(uuid,jsonb,jsonb,jsonb,boolean)') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Cross-site review ledger prerequisites missing'; END IF;
 IF to_regclass('public.project_cost_cross_site_reviews') IS NOT NULL OR to_regprocedure('public.record_project_cost_cross_site_review(uuid,uuid,integer,jsonb,jsonb,jsonb,text,boolean)') IS NOT NULL OR to_regprocedure('public.project_cost_cross_site_review(uuid,integer)') IS NOT NULL OR to_regprocedure('app_private.guard_project_cost_cross_site_review_immutable()') IS NOT NULL THEN RAISE EXCEPTION 'Cross-site review ledger name collision'; END IF;
END $preflight$;
CREATE TABLE public.project_cost_cross_site_reviews (
 request_id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 revision integer NOT NULL CHECK(revision>0),expected_revision integer NOT NULL CHECK(expected_revision>=0 AND revision=expected_revision+1),
 actor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=2097152),
 choices jsonb NOT NULL CHECK(jsonb_typeof(choices)='object' AND octet_length(choices::text)<=500000),
 cross_sites jsonb NOT NULL CHECK(jsonb_typeof(cross_sites)='object' AND octet_length(cross_sites::text)<=500000),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object' AND result @> '{"incomplete":true}'::jsonb),
 note text NOT NULL CHECK(length(note) BETWEEN 1 AND 500 AND note=btrim(note)),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(project_id,revision)
);
ALTER TABLE public.project_cost_cross_site_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_cost_cross_site_reviews FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION app_private.guard_project_cost_cross_site_review_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$BEGIN RAISE EXCEPTION 'Cross-site review history is immutable' USING ERRCODE='23514';END$$;
REVOKE ALL ON FUNCTION app_private.guard_project_cost_cross_site_review_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_project_cost_cross_site_review_immutable BEFORE UPDATE OR DELETE ON public.project_cost_cross_site_reviews FOR EACH ROW EXECUTE FUNCTION app_private.guard_project_cost_cross_site_review_immutable();
CREATE FUNCTION public.record_project_cost_cross_site_review(p_request uuid,p_project uuid,p_expected_revision integer,p_snapshot jsonb,p_choices jsonb,p_cross_sites jsonb,p_note text,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=auth.uid();v_existing public.project_cost_cross_site_reviews%ROWTYPE;v_latest integer;v_now jsonb;v_result jsonb;v_note text;
BEGIN
 IF v_actor IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Cross-site review requires read committed' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_project IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0 OR p_expected_revision>=2147483647 OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' OR octet_length(p_snapshot::text)>2097152 OR jsonb_typeof(p_choices) IS DISTINCT FROM 'object' OR octet_length(p_choices::text)>500000 OR jsonb_typeof(p_cross_sites) IS DISTINCT FROM 'object' OR octet_length(p_cross_sites::text)>500000 OR p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 500 OR btrim(p_note) ~ '[[:cntrl:]]' OR p_ack IS DISTINCT FROM true THEN RAISE EXCEPTION 'Invalid cross-site review' USING ERRCODE='22023'; END IF;
 v_note:=btrim(p_note);
 PERFORM 1 FROM public.users WHERE id=v_actor AND role='founder' FOR SHARE;
 IF NOT FOUND OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cross-site-cost-review-request:'||p_request::text,0));
 SELECT * INTO v_existing FROM public.project_cost_cross_site_reviews WHERE request_id=p_request;
 IF FOUND THEN
  IF (v_existing.project_id,v_existing.actor_id,v_existing.expected_revision,v_existing.snapshot #- '{historical_review,base,captured_at}',v_existing.choices,v_existing.cross_sites,v_existing.note) IS DISTINCT FROM (p_project,v_actor,p_expected_revision,p_snapshot #- '{historical_review,base,captured_at}',p_choices,p_cross_sites,v_note) THEN RAISE EXCEPTION 'Cross-site review request already used for different details' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('request_id',p_request,'project_id',p_project,'revision',v_existing.revision,'replayed',true);
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cross-site-cost-review-project:'||p_project::text,0));
 PERFORM 1 FROM public.projects WHERE id=p_project FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='42501'; END IF;
 SELECT coalesce(max(revision),0) INTO v_latest FROM public.project_cost_cross_site_reviews WHERE project_id=p_project;
 IF v_latest<>p_expected_revision THEN RAISE EXCEPTION 'Cross-site review changed; reload and review' USING ERRCODE='40001'; END IF;
 v_now:=public.project_cost_correction_inventory(p_project);
 IF v_now #- '{historical_review,base,captured_at}' IS DISTINCT FROM p_snapshot #- '{historical_review,base,captured_at}' THEN RAISE EXCEPTION 'Project evidence changed; reload and review' USING ERRCODE='40001'; END IF;
 -- This checks every source decision in the same statement snapshot. Source
 -- writers are not locked, and a review may become stale before commit.
 v_result:=public.project_cost_cross_site_corrected_preview(p_project,v_now,p_choices,p_cross_sites,true);
 INSERT INTO public.project_cost_cross_site_reviews(request_id,project_id,revision,expected_revision,actor_id,snapshot,choices,cross_sites,result,note)
 VALUES(p_request,p_project,v_latest+1,v_latest,v_actor,v_now,p_choices,p_cross_sites,v_result,v_note);
 RETURN jsonb_build_object('request_id',p_request,'project_id',p_project,'revision',v_latest+1,'replayed',false);
END $$;
CREATE FUNCTION public.project_cost_cross_site_review(p_project uuid,p_revision integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_row public.project_cost_cross_site_reviews%ROWTYPE;v_latest integer;v_now jsonb;v_result jsonb;v_status text:='unavailable';
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR (p_revision IS NOT NULL AND p_revision<1) OR NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Cross-site review unavailable' USING ERRCODE='22023'; END IF;
 SELECT coalesce(max(revision),0) INTO v_latest FROM public.project_cost_cross_site_reviews WHERE project_id=p_project;
 IF v_latest=0 AND p_revision IS NULL THEN RETURN jsonb_build_object('project_id',p_project,'found',false,'latest_revision',0); END IF;
 SELECT * INTO v_row FROM public.project_cost_cross_site_reviews WHERE project_id=p_project AND revision=coalesce(p_revision,v_latest);
 IF NOT FOUND THEN RAISE EXCEPTION 'Cross-site review unavailable' USING ERRCODE='P0002'; END IF;
 BEGIN
  v_now:=public.project_cost_correction_inventory(p_project);
  IF v_now #- '{historical_review,base,captured_at}' IS DISTINCT FROM v_row.snapshot #- '{historical_review,base,captured_at}' THEN v_status:='changed';
  ELSE
   v_result:=public.project_cost_cross_site_corrected_preview(p_project,v_now,v_row.choices,v_row.cross_sites,true);
   v_status:=CASE WHEN v_result=v_row.result THEN 'matches' ELSE 'changed' END;
  END IF;
 EXCEPTION WHEN serialization_failure THEN v_status:='changed'; WHEN others THEN v_status:='unavailable'; END;
 RETURN jsonb_build_object('project_id',p_project,'found',true,'latest_revision',v_latest,'revision',v_row.revision,'request_id',v_row.request_id,'actor_id',v_row.actor_id,'recorded_at',v_row.recorded_at,'snapshot',v_row.snapshot,'choices',v_row.choices,'cross_sites',v_row.cross_sites,'result',v_row.result,'note',v_row.note,'freshness',v_status);
END $$;
REVOKE ALL ON FUNCTION public.record_project_cost_cross_site_review(uuid,uuid,integer,jsonb,jsonb,jsonb,text,boolean),public.project_cost_cross_site_review(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_project_cost_cross_site_review(uuid,uuid,integer,jsonb,jsonb,jsonb,text,boolean),public.project_cost_cross_site_review(uuid,integer) TO authenticated;
DO $postflight$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_table_privilege(r,'public.project_cost_cross_site_reviews','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.project_cost_cross_site_reviews'::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r,a.attrelid,a.attname,'SELECT,INSERT,UPDATE,REFERENCES')) OR has_function_privilege(r,'app_private.guard_project_cost_cross_site_review_immutable()','EXECUTE') THEN RAISE EXCEPTION 'Unexpected cross-site review direct access'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','service_role']) roles(r) WHERE has_function_privilege(roles.r,'public.record_project_cost_cross_site_review(uuid,uuid,integer,jsonb,jsonb,jsonb,text,boolean)','EXECUTE') OR has_function_privilege(roles.r,'public.project_cost_cross_site_review(uuid,integer)','EXECUTE')) OR NOT has_function_privilege('authenticated','public.record_project_cost_cross_site_review(uuid,uuid,integer,jsonb,jsonb,jsonb,text,boolean)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_cross_site_review(uuid,integer)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected cross-site review RPC access'; END IF;
END $postflight$;

DO $cross_site_development_postflight$ BEGIN
 IF EXISTS(SELECT 1 FROM public.project_cost_cross_site_reviews) OR NOT coalesce((SELECT relrowsecurity FROM pg_class WHERE oid='public.project_cost_cross_site_reviews'::regclass),false) THEN RAISE EXCEPTION 'Cross-site development postflight failed'; END IF;
END $cross_site_development_postflight$;
