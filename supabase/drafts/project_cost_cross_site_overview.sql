-- HELD read-only candidate: retrieve coverage, the destination review and every
-- referenced source review under one statement snapshot. This is point-in-time
-- evidence, not a lock, accounting completeness, or proof of payment.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regprocedure('public.project_cost_cross_site_overview(uuid)') IS NOT NULL OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.project_cost_recorded_coverage(uuid)') AND md5(prosrc)='95fa4a3a6f8d212b319e0fbde7be4df9' AND prosecdef AND provolatile='s') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.project_cost_cross_site_review(uuid,integer)') AND md5(prosrc)='44a016ef665816798689061e9dbf2bb3' AND prosecdef AND provolatile='s') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.project_cost_corrected_review(uuid,integer)') AND md5(prosrc)='a5a2b78df46d98e5736b2cb0e97382ea' AND prosecdef AND provolatile='s') THEN RAISE EXCEPTION 'Cross-site overview prerequisites differ or name collision'; END IF;
END $preflight$;
CREATE FUNCTION public.project_cost_cross_site_overview(p_project uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_coverage jsonb;v_cross jsonb;v_sources jsonb:='{}'::jsonb;v_group jsonb;v_context record;v_ref jsonb;v_source jsonb;v_site uuid;v_revision integer;v_count integer:=0;v_bytes bigint:=0;
BEGIN
 v_coverage:=public.project_cost_recorded_coverage(p_project);
 v_cross:=public.project_cost_cross_site_review(p_project,NULL);
 IF v_cross->'found'='true'::jsonb THEN
  IF jsonb_typeof(v_cross->'cross_sites') IS DISTINCT FROM 'object' OR octet_length((v_cross->'cross_sites')::text)>500000 THEN RAISE EXCEPTION 'Invalid cross-site contexts' USING ERRCODE='22023'; END IF;
  FOR v_context IN SELECT key,value FROM jsonb_each(v_cross->'cross_sites') LOOP
   IF v_context.key !~ '^(voucher|external_worker):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR jsonb_typeof(v_context.value->'original_site_reviews') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid cross-site source references' USING ERRCODE='22023'; END IF;
   v_group:='{}'::jsonb;
   FOR v_ref IN SELECT value FROM jsonb_array_elements(v_context.value->'original_site_reviews') LOOP
    v_count:=v_count+1;IF v_count>100 THEN RAISE EXCEPTION 'Too many cross-site sources' USING ERRCODE='54000'; END IF;
    IF coalesce(v_ref->>'project_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR coalesce(v_ref->>'revision','') !~ '^[1-9][0-9]{0,9}$' OR (v_ref->>'revision')::numeric>2147483647 OR v_group ? (v_ref->>'project_id') THEN RAISE EXCEPTION 'Invalid source reference' USING ERRCODE='22023'; END IF;
    v_site:=(v_ref->>'project_id')::uuid;v_revision:=(v_ref->>'revision')::integer;
    v_source:=public.project_cost_corrected_review(v_site,v_revision);v_bytes:=v_bytes+octet_length(v_source::text);
    IF v_bytes>8388608 THEN RAISE EXCEPTION 'Cross-site source evidence too large' USING ERRCODE='54000'; END IF;
    v_group:=v_group||jsonb_build_object(v_site::text,v_source);
   END LOOP;
   v_sources:=v_sources||jsonb_build_object(v_context.key,v_group);
  END LOOP;
 END IF;
 RETURN jsonb_build_object('project_id',p_project,'coverage',v_coverage,'cross',v_cross,'sources',v_sources);
END $$;
REVOKE ALL ON FUNCTION public.project_cost_cross_site_overview(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_cross_site_overview(uuid) TO authenticated;
DO $postflight$ BEGIN
 IF has_function_privilege('anon','public.project_cost_cross_site_overview(uuid)','EXECUTE') OR has_function_privilege('service_role','public.project_cost_cross_site_overview(uuid)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_cross_site_overview(uuid)','EXECUTE') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.project_cost_cross_site_overview(uuid)'::regprocedure AND NOT prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION 'Unexpected cross-site overview privileges'; END IF;
END $postflight$;
