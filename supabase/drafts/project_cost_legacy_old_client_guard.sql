-- HELD: synthetic rehearsal only. Old clients cannot account for older voucher
-- splits. After a split is recorded, their ordinary/cross-site saved amounts
-- must fail closed. Updated clients may inspect the guarded base only alongside
-- independently verified legacy coverage; this is not a payment or posting.
-- Coordinated installation, old-client compatibility and lock tests remain required.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF current_setting('app.legacy_old_client_guard_candidate',true) IS DISTINCT FROM 'synthetic-only' THEN RAISE EXCEPTION 'Held for synthetic rehearsal'; END IF;
 IF to_regclass('public.legacy_paid_voucher_attributions') IS NULL OR to_regclass('public.legacy_paid_voucher_attribution_sites') IS NULL OR to_regclass('public.project_cost_correction_attributions') IS NULL OR to_regclass('public.project_cost_correction_sites') IS NULL OR to_regclass('public.paid_payroll_adjustment_cases') IS NULL OR to_regprocedure('app_private.project_cost_corrected_review_before_legacy_guard(uuid,integer)') IS NOT NULL OR to_regprocedure('app_private.project_cost_cross_site_review_before_legacy_guard(uuid,integer)') IS NOT NULL OR to_regprocedure('app_private.project_cost_legacy_site_guard(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'Legacy old-client guard prerequisites missing or collision'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.project_cost_corrected_review(uuid,integer)') AND md5(prosrc)='a5a2b78df46d98e5736b2cb0e97382ea' AND prosecdef AND provolatile='s') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.project_cost_cross_site_review(uuid,integer)') AND md5(prosrc)='44a016ef665816798689061e9dbf2bb3' AND prosecdef AND provolatile='s') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.project_cost_cross_site_review_context(uuid,text,uuid)') AND md5(prosrc) IN ('a6e51c1c3d2b39dfedc223f8f5b6d950','8653ebc231881861173d539bd9062c67') AND prosecdef AND provolatile='s') THEN RAISE EXCEPTION 'Unexpected saved-review readers'; END IF;
END $preflight$;
ALTER FUNCTION public.project_cost_corrected_review(uuid,integer) RENAME TO project_cost_corrected_review_before_legacy_guard;
ALTER FUNCTION public.project_cost_corrected_review_before_legacy_guard(uuid,integer) SET SCHEMA app_private;
ALTER FUNCTION public.project_cost_cross_site_review(uuid,integer) RENAME TO project_cost_cross_site_review_before_legacy_guard;
ALTER FUNCTION public.project_cost_cross_site_review_before_legacy_guard(uuid,integer) SET SCHEMA app_private;
REVOKE ALL ON FUNCTION app_private.project_cost_corrected_review_before_legacy_guard(uuid,integer),app_private.project_cost_cross_site_review_before_legacy_guard(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
-- Source-context verification checks the ordinary source evidence, not the
-- site's complete cost. Keep that internal check working without exposing the
-- unguarded reader as a public RPC. Reject any unfamiliar function definition.
DO $context$ DECLARE definition text;updated text;needle text:='public.project_cost_corrected_review((v_source_site->>''project_id'')::uuid,NULL)'; BEGIN
 SELECT pg_get_functiondef('public.project_cost_cross_site_review_context(uuid,text,uuid)'::regprocedure) INTO definition;
 updated:=replace(definition,needle,'app_private.project_cost_corrected_review_before_legacy_guard((v_source_site->>''project_id'')::uuid,NULL)');
 IF updated=definition OR (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'Unexpected source context definition'; END IF;
 EXECUTE updated;
END $context$;
CREATE FUNCTION app_private.project_cost_legacy_site_guard(p_project uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.legacy_paid_voucher_attributions a
  WHERE EXISTS(SELECT 1 FROM public.legacy_paid_voucher_attribution_sites s WHERE s.attribution_id=a.request_id AND s.project_id=p_project)
  OR EXISTS(SELECT 1 FROM public.paid_payroll_adjustment_cases c JOIN public.project_cost_correction_attributions ca ON ca.voucher_case_id=c.id AND ca.source_kind='voucher' JOIN public.project_cost_correction_sites cs ON cs.request_id=ca.request_id WHERE c.payroll_id=a.payroll_id AND cs.project_id=p_project AND ca.revision=(SELECT max(b.revision) FROM public.project_cost_correction_attributions b WHERE b.source_kind='voucher' AND b.voucher_case_id=c.id)))
$$;
REVOKE ALL ON FUNCTION app_private.project_cost_legacy_site_guard(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.project_cost_corrected_review(p_project uuid,p_revision integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v jsonb;
BEGIN
 v:=app_private.project_cost_corrected_review_before_legacy_guard(p_project,p_revision);
 IF v->'found'='true'::jsonb AND v->>'freshness'='matches' AND app_private.project_cost_legacy_site_guard(p_project) THEN
  v:=v||jsonb_build_object('freshness','changed','legacy_guarded',true);
 END IF;
 RETURN v;
END $$;
CREATE FUNCTION public.project_cost_cross_site_review(p_project uuid,p_revision integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v jsonb;
BEGIN
 v:=app_private.project_cost_cross_site_review_before_legacy_guard(p_project,p_revision);
 IF v->'found'='true'::jsonb AND v->>'freshness'='matches' AND app_private.project_cost_legacy_site_guard(p_project) THEN
  v:=v||jsonb_build_object('freshness','changed','legacy_guarded',true);
 END IF;
 RETURN v;
END $$;
REVOKE ALL ON FUNCTION public.project_cost_corrected_review(uuid,integer),public.project_cost_cross_site_review(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_corrected_review(uuid,integer),public.project_cost_cross_site_review(uuid,integer) TO authenticated;
DO $postflight$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_function_privilege(r,'app_private.project_cost_corrected_review_before_legacy_guard(uuid,integer)','EXECUTE') OR has_function_privilege(r,'app_private.project_cost_cross_site_review_before_legacy_guard(uuid,integer)','EXECUTE') OR has_function_privilege(r,'app_private.project_cost_legacy_site_guard(uuid)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected private reader privilege'; END IF;
 END LOOP;
 IF has_function_privilege('anon','public.project_cost_corrected_review(uuid,integer)','EXECUTE') OR has_function_privilege('service_role','public.project_cost_corrected_review(uuid,integer)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_corrected_review(uuid,integer)','EXECUTE') OR has_function_privilege('anon','public.project_cost_cross_site_review(uuid,integer)','EXECUTE') OR has_function_privilege('service_role','public.project_cost_cross_site_review(uuid,integer)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_cross_site_review(uuid,integer)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected guarded-reader privilege'; END IF;
END $postflight$;
