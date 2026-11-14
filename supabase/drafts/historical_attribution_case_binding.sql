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
