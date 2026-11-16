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
