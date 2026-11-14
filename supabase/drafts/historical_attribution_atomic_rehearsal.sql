-- HELD: ISOLATED SYNTHETIC REHEARSAL ONLY. NOT AN INSTALLER.
-- This must be executed as ONE transaction; all steps roll back together.
-- Source pins: supabase/drafts/historical_attribution_case_binding.sql=3d6b9dadca381737489c7a8a5e488cdc55e71565120a4d8697c939d596914a37 supabase/drafts/historical_attribution_write_barrier.sql=44907d0e8b415027ec0caf711f00db1fb09c4e4d898b0eee92ff74cdf46e0c52
-- Existing unbound rows halt the exercise; nothing is silently upgraded.
-- Owners, privileged/dynamic writers, deployment, recovery, real Auth and
-- full dependency/lock compatibility remain unverified. Do not run on shared DBs.
DO $hold$ BEGIN IF current_setting('app.historical_case_atomic_rehearsal',true) IS DISTINCT FROM 'synthetic-only' THEN RAISE EXCEPTION 'Held historical atomic cutover: synthetic rehearsal only'; END IF; END $hold$;
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
-- Wait for old insert transactions; a later old insert hits the barrier.
LOCK TABLE public.historical_worker_attributions IN ACCESS EXCLUSIVE MODE;
DO $preflight$ BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Read committed required'; END IF;
 IF EXISTS(SELECT 1 FROM public.historical_worker_attributions) OR EXISTS(SELECT 1 FROM public.historical_worker_attribution_sites) THEN RAISE EXCEPTION 'Existing unbound historical attribution requires separate review'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid IN ('public.historical_worker_attributions'::regclass,'public.historical_worker_attribution_sites'::regclass) AND (pg_get_userbyid(c.relowner)<>'postgres' OR NOT c.relrowsecurity OR c.relforcerowsecurity)) THEN RAISE EXCEPTION 'Attribution table owner or RLS changed'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r CROSS JOIN unnest(ARRAY['public.historical_worker_attributions','public.historical_worker_attribution_sites']) t WHERE has_table_privilege(r,t,'INSERT,UPDATE,DELETE,TRUNCATE') OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=to_regclass(t) AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r,a.attrelid,a.attname,'INSERT,UPDATE'))) THEN RAISE EXCEPTION 'Attribution direct write privilege exists'; END IF;
END $preflight$;
SET LOCAL app.historical_case_binding_candidate='synthetic-only';
-- HELD, UNINSTALLED EXPERIMENT. Do not install on a shared database.
-- Bind the complete reviewed external-worker case list to one immutable
-- original-gross attribution. This does NOT disable the old writer, switch
-- clients, prove distinct costs/payment, reconcile other sources, or protect
-- against privileged/in-flight old writers. A coordinated cutover and
-- separate lock/ACL/old-client review are required before any installation.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $hold$ BEGIN
 IF current_setting('app.historical_case_binding_candidate',true) IS DISTINCT FROM 'synthetic-only' THEN
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
  ('public.record_historical_worker_attribution(uuid,uuid,jsonb,jsonb,text,boolean)','77d94425c8d1529a1ac25a6b4ba8fa0000586b3a2db88559b993064ed14b7403','v'),
  ('public.historical_worker_attribution(uuid)','2bb4d81bf395add1e1df773a560575e95b0fd15eaa727c202f4e4c281e03779d','s'),
  ('public.paid_period_assertion_case_list(text,uuid)','ca15174233d43ffac3f4ca821a1f1d3279a2a58026186bad54492c8e9c060583','s'),
  ('public.open_paid_period_assertion_case(uuid,text,uuid,jsonb,numeric,text)','4b1ff44d02fa17a5ea8fc359288b84e4851f32e1924aa06145cc8089aeb49ce8','v'),
  ('public.resolve_paid_period_assertion_case(uuid,text,date,text,boolean)','b16ee3003b157c2952613c85e7c7559389e4f3c8c686afcbdee15df92785742e','v')
 ) AS expected(signature,sha,volatility) LEFT JOIN pg_catalog.pg_proc p ON p.oid=to_regprocedure(expected.signature)
 WHERE p.oid IS NULL OR NOT p.prosecdef OR p.provolatile::text<>expected.volatility OR pg_catalog.pg_get_userbyid(p.proowner)<>'postgres' OR NOT coalesce(p.proconfig @> ARRAY['search_path=""'],false) OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex')<>expected.sha) THEN RAISE EXCEPTION 'Historical case-binding dependency changed'; END IF;
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

SET LOCAL app.historical_case_barrier_candidate='synthetic-only';
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
 IF current_setting('app.historical_case_barrier_candidate',true) IS DISTINCT FROM 'synthetic-only' THEN RAISE EXCEPTION 'Held historical write barrier: synthetic rehearsal only'; END IF;
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
