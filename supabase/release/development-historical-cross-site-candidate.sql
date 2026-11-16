-- DEVELOPMENT CUTOVER CANDIDATE; SINGLE TRANSACTION ONLY.
-- Not a general Supabase migration; do not use db push or run on a different target.
-- The operator must establish the project identity and compatible client build.
-- Source pins:
-- supabase/drafts/historical_attribution_atomic_rehearsal.sql bde7b9c10bc6dc29ec28d5cb21653a452e8d9aa7f177b0359499a727e7d8b8cc
-- supabase/drafts/project_cost_evidence_lock_rehearsal.sql 07cd6962f704228cc2155c99da454710ba8a9ff71b4a4bb52bc5ccfc809b1d68
-- supabase/drafts/project_cost_multi_case_upgrade.sql d4a1884351242671e23a01dc65a6bfbf326bf40722a9c19646507970db09b1f8
DO $hold$ BEGIN IF current_setting('app.asinta_development_historical_cross_site_cutover',true) IS DISTINCT FROM 'reviewed-target' THEN RAISE EXCEPTION 'Development cutover held pending reviewed target'; END IF; END $hold$;
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
LOCK TABLE public.project_cost_corrected_reviews,public.project_cost_cross_site_reviews,public.historical_worker_attributions IN SHARE ROW EXCLUSIVE MODE;
DO $preflight$ DECLARE r record; f oid; BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Read committed required'; END IF;
 IF EXISTS(SELECT 1 FROM public.historical_worker_attributions) OR EXISTS(SELECT 1 FROM public.historical_worker_attribution_sites) OR EXISTS(SELECT 1 FROM public.project_cost_corrected_reviews) OR EXISTS(SELECT 1 FROM public.project_cost_cross_site_reviews) THEN RAISE EXCEPTION 'Existing review or unbound history requires separate reconciliation'; END IF;
 FOR r IN SELECT * FROM (VALUES
 ('app_private.paid_adjustment_voucher_snapshot(public.payroll)','9a47eb635aa8c44e9dd8162caa010f55a5750bf00c16cb67896b477bf437ad90',false),
 ('app_private.project_cost_correction_case(text,uuid)','1375c11a08cde8f6fe122ecfb898514727275b0e729fd857c898d23579e90514',true),
 ('public.historical_external_worker_lookup(uuid)','970d57146aab869178c6ba88905f5472620d8dcac6ca0bcfde349b654cebb4fa',true),
 ('public.historical_worker_attribution(uuid)','2bb4d81bf395add1e1df773a560575e95b0fd15eaa727c202f4e4c281e03779d',true),
 ('public.paid_period_assertion_snapshot(text,uuid)','4f6526d6abb2137c9da2669b2af40d452b05efee6badab62a353950b236ff0b7',true),
 ('public.project_confirmed_rentals(uuid)','3b6acde08e68c4e0d3ded3f48528ff6daf1b8d4430aec00ca052dbf46f59963a',true),
 ('public.project_cost_corrected_preview(uuid,jsonb,jsonb,boolean)','71df66018f34300fa4e65a2bcdc2a682974cf39321ca7d4b32cb40d7d3442700',true),
 ('public.project_cost_corrected_review(uuid,integer)','a252e39432970bed54ec4a1b0d523ccd724da62ba5183517e44773656af02b6e',true),
 ('public.project_cost_correction_attribution(text,uuid,integer)','cc8bd4009b65678e1a21d34871d28920aae34acbcc9d0575b70e4af92cdd8b32',true),
 ('public.project_cost_correction_inventory(uuid)','62de60a3384fb7833db30f547c31c962afdcef52c7760049d811f645f436fb53',true),
 ('public.project_cost_correction_original_context(text,uuid)','4e4b10c1270f39b5363ccfd5354cb33e5b19493e84a0cb8faf2e76f1dfe9a10c',true),
 ('public.project_cost_cross_site_evidence(text,uuid)','90650306e30ad02b880f512165371bad49f1a2305a3a588971998fd15c181e83',true),
 ('public.project_cost_cross_site_review(uuid,integer)','2aaeb2c4327f755010cafa28c33a0c431e8b5580d1ea7b9b64f87d44ad47b997',true),
 ('public.project_cost_historical_review(uuid)','f9c149642834e0036fab43918d91aaad954dff426d4892cee9cda30d744607b1',true),
 ('public.project_cost_reconciliation_preview(uuid)','b5fd0f18d810bb57ec2ce7288955af932a657fd932c071419f8b240374915e05',true),
 ('public.project_historical_worker_attributions(uuid)','9ebfbcb014c5b331fd04e47254a63af21fecb72fda36f0a5d5dcd6894030729d',true),
 ('public.project_paid_worker_evidence(uuid,date,uuid,integer)','922f40a70aad7883d0cfbcc06eeece8112dd26c61125537c3fb02c8c95851a57',true)
 ) AS x(signature,digest,definer) LOOP
  f:=to_regprocedure(r.signature);
  IF f IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=f AND p.prosecdef=r.definer AND p.provolatile='s' AND p.proconfig @> ARRAY['search_path=""'] AND pg_catalog.pg_get_userbyid(p.proowner)='postgres' AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex')=r.digest) THEN RAISE EXCEPTION 'Historical/cross-site dependency changed: %',r.signature; END IF;
 END LOOP;
END $preflight$;

SET LOCAL app.historical_case_atomic_rehearsal='development-reviewed';
-- HELD: ISOLATED SYNTHETIC REHEARSAL ONLY. NOT AN INSTALLER.
-- This must be executed as ONE transaction; all steps roll back together.
-- Source pins: supabase/drafts/historical_attribution_case_binding.sql=7ff4dd7165efeb165a9b491d648a55d116b46eefef1fa0a81baec32b368f7a81 supabase/drafts/historical_attribution_write_barrier.sql=44907d0e8b415027ec0caf711f00db1fb09c4e4d898b0eee92ff74cdf46e0c52
-- Existing unbound rows halt the exercise; nothing is silently upgraded.
-- Owners, privileged/dynamic writers, deployment, recovery, real Auth and
-- full dependency/lock compatibility remain unverified. Do not run on shared DBs.
DO $hold$ BEGIN IF current_setting('app.historical_case_atomic_rehearsal',true) IS DISTINCT FROM 'development-reviewed' THEN RAISE EXCEPTION 'Held historical atomic cutover: synthetic rehearsal only'; END IF; END $hold$;
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
-- Wait for old insert transactions; a later old insert hits the barrier.
LOCK TABLE public.historical_worker_attributions IN ACCESS EXCLUSIVE MODE;
DO $preflight$ BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Read committed required'; END IF;
 IF EXISTS(SELECT 1 FROM public.historical_worker_attributions) OR EXISTS(SELECT 1 FROM public.historical_worker_attribution_sites) THEN RAISE EXCEPTION 'Existing unbound historical attribution requires separate review'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid IN ('public.historical_worker_attributions'::regclass,'public.historical_worker_attribution_sites'::regclass) AND (pg_get_userbyid(c.relowner)<>'postgres' OR NOT c.relrowsecurity OR c.relforcerowsecurity)) THEN RAISE EXCEPTION 'Attribution table owner or RLS changed'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r CROSS JOIN unnest(ARRAY['public.historical_worker_attributions','public.historical_worker_attribution_sites']) t WHERE has_table_privilege(r,t,'INSERT,UPDATE,DELETE,TRUNCATE') OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=to_regclass(t) AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r,a.attrelid,a.attname,'INSERT,UPDATE'))) THEN RAISE EXCEPTION 'Attribution direct write privilege exists'; END IF;
END $preflight$;
SET LOCAL app.historical_case_binding_candidate='development-reviewed';
-- HELD, UNINSTALLED EXPERIMENT. Do not install on a shared database.
-- Bind the complete reviewed external-worker case list to one immutable
-- original-gross attribution. This does NOT disable the old writer, switch
-- clients, prove distinct costs/payment, reconcile other sources, or protect
-- against privileged/in-flight old writers. A coordinated cutover and
-- separate lock/ACL/old-client review are required before any installation.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $hold$ BEGIN
 IF current_setting('app.historical_case_binding_candidate',true) IS DISTINCT FROM 'development-reviewed' THEN
  RAISE EXCEPTION 'Held historical case-binding candidate: synthetic rehearsal only';
 END IF;
 IF to_regprocedure('public.record_historical_worker_attribution(uuid,uuid,jsonb,jsonb,text,boolean)') IS NULL OR
    to_regprocedure('public.historical_worker_attribution(uuid)') IS NULL OR
    to_regprocedure('public.paid_period_assertion_case_list(text,uuid)') IS NULL OR
    to_regclass('public.historical_worker_attributions') IS NULL OR
    to_regclass('public.paid_period_assertion_case_events') IS NULL OR
    to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR
    to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Historical case-binding prerequisites missing'; END IF;
 IF to_regclass('public.historical_attribution_case_bindings') IS NOT NULL OR
    to_regprocedure('public.record_historical_attribution_with_cases(uuid,uuid,jsonb,jsonb,text,boolean,jsonb)') IS NOT NULL OR
    to_regprocedure('public.historical_attribution_case_binding(uuid)') IS NOT NULL OR
    to_regprocedure('public.guard_historical_attribution_case_binding()') IS NOT NULL THEN RAISE EXCEPTION 'Historical case-binding objects already exist'; END IF;
 -- Selected dependencies must be the exact bodies whose ordering and replay
 -- behavior this candidate exercises. This is not an exhaustive writer audit.
 IF EXISTS (SELECT 1 FROM (VALUES
  ('public.record_historical_worker_attribution(uuid,uuid,jsonb,jsonb,text,boolean)','77d94425c8d1529a1ac25a6b4ba8fa0000586b3a2db88559b993064ed14b7403','v',true),
  ('public.historical_worker_attribution(uuid)','2bb4d81bf395add1e1df773a560575e95b0fd15eaa727c202f4e4c281e03779d','s',true),
  ('public.paid_period_assertion_case_list(text,uuid)','ca15174233d43ffac3f4ca821a1f1d3279a2a58026186bad54492c8e9c060583','s',true),
  ('public.open_paid_period_assertion_case(uuid,text,uuid,jsonb,numeric,text)','4b1ff44d02fa17a5ea8fc359288b84e4851f32e1924aa06145cc8089aeb49ce8','v',true),
  ('public.resolve_paid_period_assertion_case(uuid,text,date,text,boolean)','b16ee3003b157c2952613c85e7c7559389e4f3c8c686afcbdee15df92785742e','v',true),
  ('public.historical_external_worker_lookup(uuid)','970d57146aab869178c6ba88905f5472620d8dcac6ca0bcfde349b654cebb4fa','s',true),
  ('public.paid_period_assertion_snapshot(text,uuid)','4f6526d6abb2137c9da2669b2af40d452b05efee6badab62a353950b236ff0b7','s',true),
  ('public.historical_worker_attribution_projects()','7fda05e64229056e34d5021790c4fe4fb396d9b5ca98857c3b6f98fb64d81075','s',true),
  ('public.guard_historical_worker_attribution_immutable()','01e420ed7d6ed5bbb018ecc2ed1347d70866cf63b99e41d138ce52186d5beac0','v',false),
  ('public.guard_historical_external_worker_immutable()','36dc33307bb6c2544761815ea33360d89dc73345b07761eff93106a8a0a04f2d','v',false),
  ('public.guard_paid_period_assertion_case_immutable()','d42ee9c37ab859e2b5b8ea99dccf00d189de2a0ff34e361ae0c6dc24ddf6b2f7','v',false)
 ) AS expected(signature,sha,volatility,definer) LEFT JOIN pg_catalog.pg_proc p ON p.oid=to_regprocedure(expected.signature)
 WHERE p.oid IS NULL OR p.prosecdef IS DISTINCT FROM expected.definer OR p.provolatile::text<>expected.volatility OR pg_catalog.pg_get_userbyid(p.proowner)<>'postgres' OR NOT coalesce(p.proconfig @> ARRAY['search_path=""'],false) OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex')<>expected.sha) THEN RAISE EXCEPTION 'Historical case-binding dependency changed'; END IF;
END $hold$;

CREATE TABLE public.historical_attribution_case_bindings (
 request_id uuid PRIMARY KEY REFERENCES public.historical_worker_attributions(request_id) ON DELETE RESTRICT,
 source_id uuid NOT NULL UNIQUE REFERENCES public.historical_external_worker_payroll(request_id) ON DELETE RESTRICT,
 actor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 reviewed_cases jsonb NOT NULL CHECK(jsonb_typeof(reviewed_cases)='object' AND octet_length(reviewed_cases::text)<=1048576),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.historical_attribution_case_bindings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.historical_attribution_case_bindings FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.guard_historical_attribution_case_binding() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN RAISE EXCEPTION 'Historical case-binding evidence is immutable' USING ERRCODE='23514'; END $$;
REVOKE ALL ON FUNCTION public.guard_historical_attribution_case_binding() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER historical_attribution_case_binding_immutable BEFORE UPDATE OR DELETE ON public.historical_attribution_case_bindings FOR EACH ROW EXECUTE FUNCTION public.guard_historical_attribution_case_binding();

CREATE FUNCTION public.record_historical_attribution_with_cases(p_request uuid,p_source uuid,p_expected jsonb,p_split jsonb,p_note text,p_ack boolean,p_cases jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=auth.uid();v_old public.historical_attribution_case_bindings%ROWTYPE;v_cases jsonb;v_result jsonb;
BEGIN
 IF v_actor IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Historical attribution requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_source IS NULL OR p_cases IS NULL OR jsonb_typeof(p_cases)<>'object' OR octet_length(p_cases::text)>1048576 THEN RAISE EXCEPTION 'Reviewed case inventory required' USING ERRCODE='22023'; END IF;
 -- Match the existing external-period case writers' global table order. Their
 -- case opens/resolutions cannot commit between our read and this write.
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 LOCK TABLE public.users,public.workers,public.supervisor_period_payroll,public.historical_external_worker_payroll,public.paid_period_assertion_cases,public.paid_period_assertion_case_events IN SHARE ROW EXCLUSIVE MODE;
 IF auth.uid() IS DISTINCT FROM v_actor OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('historical-case-binding-request:'||p_request::text,0));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('historical-case-binding-source:'||p_source::text,0));
 SELECT * INTO v_old FROM public.historical_attribution_case_bindings WHERE request_id=p_request;
 IF FOUND THEN
  IF (v_old.source_id,v_old.actor_id,v_old.reviewed_cases) IS DISTINCT FROM (p_source,v_actor,p_cases) THEN RAISE EXCEPTION 'Case-binding request ID used for different details' USING ERRCODE='22023'; END IF;
  -- The old writer independently verifies the original request/split/note and
  -- source evidence on exact replay; changed cases do not prevent recovery.
  v_result:=public.record_historical_worker_attribution(p_request,p_source,p_expected,p_split,p_note,p_ack);
  IF (v_result->>'replayed') IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Existing attribution evidence unavailable' USING ERRCODE='40001'; END IF;
  RETURN v_result;
 END IF;
 -- An old attribution without this envelope cannot be retroactively treated
 -- as a case-bound decision or silently upgraded on retry.
 IF EXISTS(SELECT 1 FROM public.historical_worker_attributions WHERE request_id=p_request OR source_id=p_source) THEN RAISE EXCEPTION 'Existing unbound attribution requires separate review' USING ERRCODE='23505'; END IF;
 v_cases:=public.paid_period_assertion_case_list('external_worker',p_source);
 IF v_cases IS DISTINCT FROM p_cases THEN RAISE EXCEPTION 'Case inventory changed; reload and review' USING ERRCODE='40001'; END IF;
 v_result:=public.record_historical_worker_attribution(p_request,p_source,p_expected,p_split,p_note,p_ack);
 IF (v_result->>'replayed') IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Unexpected existing attribution' USING ERRCODE='40001'; END IF;
 INSERT INTO public.historical_attribution_case_bindings(request_id,source_id,actor_id,reviewed_cases) VALUES(p_request,p_source,v_actor,v_cases);
 RETURN v_result;
END $$;

-- Current case comparison is point-in-time only. A false freshness flag does
-- not decide whether a correction overlaps or whether money actually moved.
CREATE FUNCTION public.historical_attribution_case_binding(p_source uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_row public.historical_attribution_case_bindings%ROWTYPE;v_original jsonb;v_current jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF p_source IS NULL THEN RAISE EXCEPTION 'Source required' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_row FROM public.historical_attribution_case_bindings WHERE source_id=p_source;
 IF NOT FOUND THEN RETURN jsonb_build_object('found',false); END IF;
 v_original:=public.historical_worker_attribution(p_source);
 IF (v_original->>'found') IS DISTINCT FROM 'true' OR (v_original->>'request_id')::uuid IS DISTINCT FROM v_row.request_id OR (v_original->>'actor_id')::uuid IS DISTINCT FROM v_row.actor_id THEN RAISE EXCEPTION 'Attribution evidence differs; investigate' USING ERRCODE='40001'; END IF;
 v_current:=public.paid_period_assertion_case_list('external_worker',p_source);
 RETURN jsonb_build_object('found',true,'request_id',v_row.request_id,'source_id',v_row.source_id,'actor_id',v_row.actor_id,'recorded_at',v_row.recorded_at,'reviewed_cases',v_row.reviewed_cases,'cases_changed',v_current IS DISTINCT FROM v_row.reviewed_cases,'source_changed',(v_original->>'source_changed')::boolean);
END $$;
REVOKE ALL ON FUNCTION public.record_historical_attribution_with_cases(uuid,uuid,jsonb,jsonb,text,boolean,jsonb),public.historical_attribution_case_binding(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_historical_attribution_with_cases(uuid,uuid,jsonb,jsonb,text,boolean,jsonb),public.historical_attribution_case_binding(uuid) TO authenticated;
DO $postflight$ BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r WHERE has_table_privilege(r,'public.historical_attribution_case_bindings','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a CROSS JOIN unnest(ARRAY['anon','authenticated','service_role']) r WHERE a.attrelid='public.historical_attribution_case_bindings'::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r,a.attrelid,a.attname,'SELECT,INSERT,UPDATE,REFERENCES')) THEN RAISE EXCEPTION 'Unexpected case-binding table privilege'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','service_role']) r CROSS JOIN unnest(ARRAY['public.record_historical_attribution_with_cases(uuid,uuid,jsonb,jsonb,text,boolean,jsonb)','public.historical_attribution_case_binding(uuid)']) f WHERE has_function_privilege(r,f,'EXECUTE')) OR NOT has_function_privilege('authenticated','public.record_historical_attribution_with_cases(uuid,uuid,jsonb,jsonb,text,boolean,jsonb)','EXECUTE') OR NOT has_function_privilege('authenticated','public.historical_attribution_case_binding(uuid)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected case-binding RPC privilege'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r WHERE has_function_privilege(r,'public.guard_historical_attribution_case_binding()','EXECUTE')) OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid='public.historical_attribution_case_bindings'::regclass AND t.tgname='historical_attribution_case_binding_immutable' AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal) THEN RAISE EXCEPTION 'Unexpected case-binding guard'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['public.record_historical_attribution_with_cases(uuid,uuid,jsonb,jsonb,text,boolean,jsonb)','public.historical_attribution_case_binding(uuid)']) f WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure(f) AND p.prosecdef AND p.proconfig @> ARRAY['search_path=""'])) THEN RAISE EXCEPTION 'Unsafe case-binding RPC definition'; END IF;
END $postflight$;

SET LOCAL app.historical_case_barrier_candidate='development-reviewed';
-- HELD SYNTHETIC EXPERIMENT, NOT A MIGRATION OR DEPLOYMENT PROCEDURE.
-- Guard new original-attribution inserts with a transaction-local, inaccessible
-- permit created only by the bound writer. This aims to reject an old function
-- invocation that passed EXECUTE before a later revoke. Owners, superusers,
-- DDL and unreviewed SECURITY DEFINER paths can still bypass it. Old clients,
-- service integrations, maintenance, snapshots, lock ordering, privileges,
-- recovery and real Auth/PostgREST remain unverified. Do not run on shared DBs.
-- Run only in a single caller-owned transaction against isolated test data.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $hold$ BEGIN
 IF current_setting('app.historical_case_barrier_candidate',true) IS DISTINCT FROM 'development-reviewed' THEN RAISE EXCEPTION 'Held historical write barrier: synthetic rehearsal only'; END IF;
 IF to_regclass('public.historical_attribution_write_permits') IS NOT NULL OR to_regprocedure('public.guard_historical_attribution_insert()') IS NOT NULL THEN RAISE EXCEPTION 'Barrier objects already exist'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.record_historical_attribution_with_cases(uuid,uuid,jsonb,jsonb,text,boolean,jsonb)') AND p.prosecdef AND pg_get_userbyid(p.proowner)='postgres' AND p.proconfig @> ARRAY['search_path=""'] AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='88072818f05fd0f2f8c846a756ca90515a7853ee5c3df81e1e17df790bf2b2f3') THEN RAISE EXCEPTION 'Bound writer changed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.record_historical_worker_attribution(uuid,uuid,jsonb,jsonb,text,boolean)') AND p.prosecdef AND pg_get_userbyid(p.proowner)='postgres' AND p.proconfig @> ARRAY['search_path=""'] AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='77d94425c8d1529a1ac25a6b4ba8fa0000586b3a2db88559b993064ed14b7403') THEN RAISE EXCEPTION 'Original writer changed'; END IF;
END $hold$;
-- Wait for existing table users before installing the trigger. A caller already
-- executing but not yet holding a conflicting table lock may continue later;
-- the trigger is intended to reject its new insert, not cancel the statement.
LOCK TABLE public.historical_worker_attributions IN ACCESS EXCLUSIVE MODE;
CREATE TABLE public.historical_attribution_write_permits (
 txid bigint NOT NULL, backend_id integer NOT NULL, request_id uuid NOT NULL, source_id uuid NOT NULL, actor_id uuid NOT NULL,
 PRIMARY KEY(txid,backend_id,request_id)
);
ALTER TABLE public.historical_attribution_write_permits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.historical_attribution_write_permits FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.guard_historical_attribution_insert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.historical_attribution_write_permits p WHERE p.txid=pg_catalog.txid_current() AND p.backend_id=pg_catalog.pg_backend_pid() AND p.request_id=NEW.request_id AND p.source_id=NEW.source_id AND p.actor_id=NEW.actor_id AND p.actor_id=auth.uid()) THEN RAISE EXCEPTION 'Historical attribution requires reviewed case binding' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_historical_attribution_insert() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER historical_attribution_insert_barrier BEFORE INSERT ON public.historical_worker_attributions FOR EACH ROW EXECUTE FUNCTION public.guard_historical_attribution_insert();

CREATE OR REPLACE FUNCTION public.record_historical_attribution_with_cases(p_request uuid,p_source uuid,p_expected jsonb,p_split jsonb,p_note text,p_ack boolean,p_cases jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=auth.uid();v_old public.historical_attribution_case_bindings%ROWTYPE;v_cases jsonb;v_result jsonb;
BEGIN
 IF v_actor IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Historical attribution requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_source IS NULL OR p_cases IS NULL OR jsonb_typeof(p_cases)<>'object' OR octet_length(p_cases::text)>1048576 THEN RAISE EXCEPTION 'Reviewed case inventory required' USING ERRCODE='22023'; END IF;
 -- Match the existing external-period case writers' global table order. Their
 -- case opens/resolutions cannot commit between our read and this write.
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 LOCK TABLE public.users,public.workers,public.supervisor_period_payroll,public.historical_external_worker_payroll,public.paid_period_assertion_cases,public.paid_period_assertion_case_events IN SHARE ROW EXCLUSIVE MODE;
 IF auth.uid() IS DISTINCT FROM v_actor OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('historical-case-binding-request:'||p_request::text,0));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('historical-case-binding-source:'||p_source::text,0));
 SELECT * INTO v_old FROM public.historical_attribution_case_bindings WHERE request_id=p_request;
 IF FOUND THEN
  IF (v_old.source_id,v_old.actor_id,v_old.reviewed_cases) IS DISTINCT FROM (p_source,v_actor,p_cases) THEN RAISE EXCEPTION 'Case-binding request ID used for different details' USING ERRCODE='22023'; END IF;
  -- The old writer independently verifies the original request/split/note and
  -- source evidence on exact replay; changed cases do not prevent recovery.
  v_result:=public.record_historical_worker_attribution(p_request,p_source,p_expected,p_split,p_note,p_ack);
  IF (v_result->>'replayed') IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Existing attribution evidence unavailable' USING ERRCODE='40001'; END IF;
  RETURN v_result;
 END IF;
 -- An old attribution without this envelope cannot be retroactively treated
 -- as a case-bound decision or silently upgraded on retry.
 IF EXISTS(SELECT 1 FROM public.historical_worker_attributions WHERE request_id=p_request OR source_id=p_source) THEN RAISE EXCEPTION 'Existing unbound attribution requires separate review' USING ERRCODE='23505'; END IF;
 v_cases:=public.paid_period_assertion_case_list('external_worker',p_source);
 IF v_cases IS DISTINCT FROM p_cases THEN RAISE EXCEPTION 'Case inventory changed; reload and review' USING ERRCODE='40001'; END IF;
 INSERT INTO public.historical_attribution_write_permits(txid,backend_id,request_id,source_id,actor_id) VALUES(pg_catalog.txid_current(),pg_catalog.pg_backend_pid(),p_request,p_source,v_actor);
 v_result:=public.record_historical_worker_attribution(p_request,p_source,p_expected,p_split,p_note,p_ack);
 DELETE FROM public.historical_attribution_write_permits WHERE txid=pg_catalog.txid_current() AND backend_id=pg_catalog.pg_backend_pid() AND request_id=p_request;
 IF (v_result->>'replayed') IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Unexpected existing attribution' USING ERRCODE='40001'; END IF;
 INSERT INTO public.historical_attribution_case_bindings(request_id,source_id,actor_id,reviewed_cases) VALUES(p_request,p_source,v_actor,v_cases);
 RETURN v_result;
END $$;

-- Revocation blocks new old-RPC calls, but cannot cancel an already started
-- invocation. The insert trigger is a separate limited barrier for that race.
REVOKE EXECUTE ON FUNCTION public.record_historical_worker_attribution(uuid,uuid,jsonb,jsonb,text,boolean) FROM PUBLIC,anon,authenticated,service_role;
DO $postflight$ BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r WHERE has_function_privilege(r,'public.record_historical_worker_attribution(uuid,uuid,jsonb,jsonb,text,boolean)','EXECUTE') OR has_function_privilege(r,'public.guard_historical_attribution_insert()','EXECUTE') OR has_table_privilege(r,'public.historical_attribution_write_permits','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.historical_attribution_write_permits'::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r,a.attrelid,a.attname,'SELECT,INSERT,UPDATE,REFERENCES'))) THEN RAISE EXCEPTION 'Unexpected historical barrier privilege'; END IF;
 IF NOT has_function_privilege('authenticated','public.record_historical_attribution_with_cases(uuid,uuid,jsonb,jsonb,text,boolean,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Bound writer unavailable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.historical_worker_attributions'::regclass AND t.tgname='historical_attribution_insert_barrier' AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal AND t.tgtype=7 AND t.tgfoid='public.guard_historical_attribution_insert()'::regprocedure) THEN RAISE EXCEPTION 'Insert barrier missing'; END IF;
END $postflight$;

DO $postflight$ BEGIN
 IF EXISTS(SELECT 1 FROM public.historical_worker_attributions) OR EXISTS(SELECT 1 FROM public.historical_attribution_case_bindings) OR EXISTS(SELECT 1 FROM public.historical_attribution_write_permits) THEN RAISE EXCEPTION 'Unexpected attribution evidence'; END IF;
 IF has_function_privilege('authenticated','public.record_historical_worker_attribution(uuid,uuid,jsonb,jsonb,text,boolean)','EXECUTE') OR NOT has_function_privilege('authenticated','public.record_historical_attribution_with_cases(uuid,uuid,jsonb,jsonb,text,boolean,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Writer cutover ACL failed'; END IF;
END $postflight$;


SET LOCAL app.cost_evidence_lock_candidate='development-reviewed';
-- HELD experimental snapshot capture locks, synthetic databases only.
-- Whole-table SHARE locks may block unrelated work. A deadlock or 3-second
-- lock timeout aborts one transaction; callers must reload before retrying.
-- This must not be deployed without full writer, function, role and target audit.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $hold$ BEGIN IF current_setting('app.cost_evidence_lock_candidate',true) IS DISTINCT FROM 'development-reviewed' THEN RAISE EXCEPTION 'Evidence lock candidate held for synthetic rehearsal'; END IF; END $hold$;
LOCK TABLE public.project_cost_corrected_reviews,public.project_cost_cross_site_reviews IN SHARE ROW EXCLUSIVE MODE;
DO $preflight$ DECLARE r record; f oid; BEGIN
 FOR r IN SELECT * FROM (VALUES
 ('public.record_project_cost_corrected_review(uuid,uuid,integer,jsonb,jsonb,text,boolean)','61fd78c7e4b02206b119f706fc4105410de11980082dd3b5b190f9f71ce75ce0'),
 ('public.record_project_cost_cross_site_review(uuid,uuid,integer,jsonb,jsonb,jsonb,text,boolean)','be890d31b8751f11ff18745fa7ad8d3010d6ae06e46980b3818f2c47743695dc')
 ) AS x(signature,digest) LOOP
  f:=to_regprocedure(r.signature);
  IF f IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=f AND p.prosecdef AND p.provolatile='v' AND p.proconfig @> ARRAY['search_path=""'] AND pg_catalog.pg_get_userbyid(p.proowner)='postgres' AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=r.digest) OR NOT has_function_privilege('authenticated',f,'EXECUTE') OR has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'Evidence writer dependency changed: %',r.signature; END IF;
 END LOOP;
END $preflight$;
CREATE OR REPLACE FUNCTION public.record_project_cost_corrected_review(p_request uuid,p_project uuid,p_expected_revision integer,p_snapshot jsonb,p_choices jsonb,p_note text,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=auth.uid();v_existing public.project_cost_corrected_reviews%ROWTYPE;v_latest integer;v_now jsonb;v_result jsonb;v_note text;
BEGIN
 IF v_actor IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Corrected review requires read committed' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_project IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0 OR p_expected_revision>=2147483647 OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' OR octet_length(p_snapshot::text)>2097152 OR jsonb_typeof(p_choices) IS DISTINCT FROM 'object' OR octet_length(p_choices::text)>500000 OR p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 500 OR btrim(p_note) ~ '[[:cntrl:]]' OR p_ack IS DISTINCT FROM true THEN RAISE EXCEPTION 'Invalid corrected review' USING ERRCODE='22023'; END IF;
 v_note:=btrim(p_note);
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 PERFORM 1 FROM public.users WHERE id=v_actor AND role='founder' FOR SHARE;
 IF NOT FOUND OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('corrected-cost-review-request:'||p_request::text,0));
 SELECT * INTO v_existing FROM public.project_cost_corrected_reviews WHERE request_id=p_request;
 IF FOUND THEN
  IF (v_existing.project_id,v_existing.actor_id,v_existing.expected_revision,v_existing.snapshot #- '{historical_review,base,captured_at}',v_existing.choices,v_existing.note) IS DISTINCT FROM (p_project,v_actor,p_expected_revision,p_snapshot #- '{historical_review,base,captured_at}',p_choices,v_note) THEN RAISE EXCEPTION 'Corrected review request already used for different details' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('request_id',p_request,'project_id',p_project,'revision',v_existing.revision,'replayed',true);
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('corrected-cost-review-project:'||p_project::text,0));
 PERFORM 1 FROM public.projects WHERE id=p_project FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='42501'; END IF;
 -- Relation SHARE locks protect this capture against concurrent inserts, updates
 -- and deletes, including evidence not yet present in the submitted snapshot.
 -- These are global and short-lived. Contention or a lock cycle aborts the
 -- transaction; no partial review is committed. They do not cover DDL/owners.
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 LOCK TABLE public.users,public.workers,public.projects,public.supervisor_period_payroll,public.historical_external_worker_payroll,public.paid_period_assertion_cases,public.paid_payroll_adjustment_cases,public.expenses,public.confirmed_rental_expenses,public.payroll,public.weekly_worker_draft_sources,public.weekly_worker_paid_allocations,public.payroll_payment_dates,public.historical_worker_attributions,public.historical_worker_attribution_sites,public.project_cost_correction_attributions,public.project_cost_correction_sites IN SHARE MODE;
 SELECT coalesce(max(revision),0) INTO v_latest FROM public.project_cost_corrected_reviews WHERE project_id=p_project;
 IF v_latest<>p_expected_revision THEN RAISE EXCEPTION 'Corrected review changed; reload and review' USING ERRCODE='40001'; END IF;
 -- Store server-captured evidence, not a caller-supplied capture time. Check
 -- both the submitted review and calculation against it. This does not lock
 -- every source writer; it can become stale before or after commit.
 v_now:=public.project_cost_correction_inventory(p_project);
 IF v_now #- '{historical_review,base,captured_at}' IS DISTINCT FROM p_snapshot #- '{historical_review,base,captured_at}' THEN RAISE EXCEPTION 'Project evidence changed; reload and review' USING ERRCODE='40001'; END IF;
 v_result:=public.project_cost_corrected_preview(p_project,v_now,p_choices,true);
 INSERT INTO public.project_cost_corrected_reviews(request_id,project_id,revision,expected_revision,actor_id,snapshot,choices,result,note)
 VALUES(p_request,p_project,v_latest+1,v_latest,v_actor,v_now,p_choices,v_result,v_note);
 RETURN jsonb_build_object('request_id',p_request,'project_id',p_project,'revision',v_latest+1,'replayed',false);
END $$;
CREATE OR REPLACE FUNCTION public.record_project_cost_cross_site_review(p_request uuid,p_project uuid,p_expected_revision integer,p_snapshot jsonb,p_choices jsonb,p_cross_sites jsonb,p_note text,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=auth.uid();v_existing public.project_cost_cross_site_reviews%ROWTYPE;v_latest integer;v_now jsonb;v_result jsonb;v_note text;v_source_project uuid;
BEGIN
 IF v_actor IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Cross-site review requires read committed' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_project IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0 OR p_expected_revision>=2147483647 OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' OR octet_length(p_snapshot::text)>2097152 OR jsonb_typeof(p_choices) IS DISTINCT FROM 'object' OR octet_length(p_choices::text)>500000 OR jsonb_typeof(p_cross_sites) IS DISTINCT FROM 'object' OR octet_length(p_cross_sites::text)>500000 OR p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 500 OR btrim(p_note) ~ '[[:cntrl:]]' OR p_ack IS DISTINCT FROM true THEN RAISE EXCEPTION 'Invalid cross-site review' USING ERRCODE='22023'; END IF;
 v_note:=btrim(p_note);
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
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
 -- Serialize against the exact project lock already used by the corrected
 -- source-review writer. Sort all distinct source projects to avoid cycles
 -- between independent destination reviews. Input remains untrusted; the
 -- preview below still validates every context and current source review.
 IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_each(p_cross_sites) x WHERE pg_catalog.jsonb_typeof(x.value) IS DISTINCT FROM 'object' OR pg_catalog.jsonb_typeof(x.value->'original_site_reviews') IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(CASE WHEN pg_catalog.jsonb_typeof(x.value->'original_site_reviews')='array' THEN x.value->'original_site_reviews' ELSE '[]'::jsonb END)>50) THEN RAISE EXCEPTION 'Invalid original-site review references' USING ERRCODE='22023'; END IF;
 IF (SELECT count(*) FROM pg_catalog.jsonb_each(p_cross_sites) x CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(x.value->'original_site_reviews') s)>100 OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_each(p_cross_sites) x CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(x.value->'original_site_reviews') s WHERE pg_catalog.jsonb_typeof(s.value) IS DISTINCT FROM 'object' OR coalesce(s.value->>'project_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN RAISE EXCEPTION 'Invalid original-site review references' USING ERRCODE='22023'; END IF;
 FOR v_source_project IN SELECT DISTINCT (s.value->>'project_id')::uuid FROM pg_catalog.jsonb_each(p_cross_sites) x CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(x.value->'original_site_reviews') s ORDER BY 1 LOOP
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('corrected-cost-review-project:'||v_source_project::text,0));
 END LOOP;
 -- Validate the bounded inventory, then block attribution INSERT/UPDATE/DELETE
 -- for all cases, including external and cases absent from this snapshot. Take
 -- the locks before recapturing the inventory. These are relation locks, not
 -- predicate locks; they serialize the whole attribution workload.
 IF pg_catalog.jsonb_typeof(p_snapshot->'corrections') IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(CASE WHEN pg_catalog.jsonb_typeof(p_snapshot->'corrections')='array' THEN p_snapshot->'corrections' ELSE '[]'::jsonb END)>500 THEN RAISE EXCEPTION 'Invalid correction case references' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(p_snapshot->'corrections') c WHERE pg_catalog.jsonb_typeof(c.value) IS DISTINCT FROM 'object' OR coalesce(c.value->>'kind','') NOT IN ('voucher','external_worker') OR coalesce(c.value->>'case_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN RAISE EXCEPTION 'Invalid correction case references' USING ERRCODE='22023'; END IF;
 -- Case relations precede attribution relations: the external attribution
 -- writer locks its case tables before inserting attribution rows. Never wait
 -- for its case lock while holding an attribution lock it needs.
 -- Relation SHARE locks protect this capture against concurrent inserts, updates
 -- and deletes, including evidence not yet present in the submitted snapshot.
 -- These are global and short-lived. Contention or a lock cycle aborts the
 -- transaction; no partial review is committed. They do not cover DDL/owners.
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 LOCK TABLE public.users,public.workers,public.projects,public.supervisor_period_payroll,public.historical_external_worker_payroll,public.paid_period_assertion_cases,public.paid_payroll_adjustment_cases,public.expenses,public.confirmed_rental_expenses,public.payroll,public.weekly_worker_draft_sources,public.weekly_worker_paid_allocations,public.payroll_payment_dates,public.historical_worker_attributions,public.historical_worker_attribution_sites,public.project_cost_correction_attributions,public.project_cost_correction_sites IN SHARE MODE;
 SELECT coalesce(max(revision),0) INTO v_latest FROM public.project_cost_cross_site_reviews WHERE project_id=p_project;
 IF v_latest<>p_expected_revision THEN RAISE EXCEPTION 'Cross-site review changed; reload and review' USING ERRCODE='40001'; END IF;
 v_now:=public.project_cost_correction_inventory(p_project);
 IF v_now #- '{historical_review,base,captured_at}' IS DISTINCT FROM p_snapshot #- '{historical_review,base,captured_at}' THEN RAISE EXCEPTION 'Project evidence changed; reload and review' USING ERRCODE='40001'; END IF;
 -- Attribution writes and selected source-review saves cannot commit here.
 -- Other evidence writers remain unlocked; freshness may still change.
 v_result:=public.project_cost_cross_site_corrected_preview(p_project,v_now,p_choices,p_cross_sites,true);
 INSERT INTO public.project_cost_cross_site_reviews(request_id,project_id,revision,expected_revision,actor_id,snapshot,choices,cross_sites,result,note)
 VALUES(p_request,p_project,v_latest+1,v_latest,v_actor,v_now,p_choices,p_cross_sites,v_result,v_note);
 RETURN jsonb_build_object('request_id',p_request,'project_id',p_project,'revision',v_latest+1,'replayed',false);
END $$;


SET LOCAL app.cross_site_multicase_candidate='development-reviewed';
-- HELD MULTI-CASE SYNTHETIC CANDIDATE. Do not install on a shared database.
-- Full source-site inclusion, distinct-effects assertions and nonnegative grouped
-- destination effects are mandatory. This is not a payment or complete ledger.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $hold$ BEGIN IF current_setting('app.cross_site_multicase_candidate',true) IS DISTINCT FROM 'development-reviewed' THEN RAISE EXCEPTION 'Multi-case candidate held for synthetic rehearsal'; END IF; END $hold$;
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
