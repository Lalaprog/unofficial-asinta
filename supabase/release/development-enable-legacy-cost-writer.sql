-- HELD: do not execute until the matching website is READY and promoted.
-- Development project only. This does not create a split or modify payroll.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $pre$ DECLARE r record; f oid; BEGIN
 IF current_setting('app.legacy_cost_website_ready',true) IS DISTINCT FROM 'yes' OR current_database()<>'postgres' THEN RAISE EXCEPTION 'Legacy writer is held for the matching website'; END IF;
 FOR r IN SELECT * FROM (VALUES
  ('public.record_legacy_paid_voucher_attribution(uuid,uuid,jsonb,jsonb,jsonb,text,boolean,jsonb)','5ef88137d0b2cc2aafaced3f33c3a40c',true,'v'),
  ('public.project_cost_corrected_review(uuid,integer)','e499413916de5c06c7ef17d1674ff5a4',true,'s'),
  ('public.project_cost_cross_site_review(uuid,integer)','bac5daa60d67c97207e80c0105bab2fd',true,'s'),
  ('public.project_cost_legacy_recorded_snapshot(uuid)','8439833ddf614208f7c8173482939d73',false,'s'),
  ('public.project_cost_legacy_cross_site_overview(uuid)','b4a1839b8f760044818aaa8260b3527d',false,'s')
 ) AS e(signature,digest,definer,volatility) LOOP
  f:=to_regprocedure(r.signature);
  IF f IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f AND p.prokind='f' AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef=r.definer AND p.provolatile=r.volatility::"char" AND md5(p.prosrc)=r.digest) THEN RAISE EXCEPTION 'Legacy writer dependency differs: %',r.signature; END IF;
 END LOOP;
 IF has_function_privilege('authenticated','public.record_legacy_paid_voucher_attribution(uuid,uuid,jsonb,jsonb,jsonb,text,boolean,jsonb)','EXECUTE') OR has_function_privilege('anon','public.record_legacy_paid_voucher_attribution(uuid,uuid,jsonb,jsonb,jsonb,text,boolean,jsonb)','EXECUTE') OR has_function_privilege('service_role','public.record_legacy_paid_voucher_attribution(uuid,uuid,jsonb,jsonb,jsonb,text,boolean,jsonb)','EXECUTE') OR has_function_privilege('authenticated','app_private.project_cost_corrected_review_before_legacy_guard(uuid,integer)','EXECUTE') OR has_function_privilege('authenticated','app_private.project_cost_cross_site_review_before_legacy_guard(uuid,integer)','EXECUTE') OR EXISTS(SELECT 1 FROM public.legacy_paid_voucher_attributions) THEN RAISE EXCEPTION 'Unexpected legacy writer state'; END IF;
END $pre$;
GRANT EXECUTE ON FUNCTION public.record_legacy_paid_voucher_attribution(uuid,uuid,jsonb,jsonb,jsonb,text,boolean,jsonb) TO authenticated;
DO $post$ BEGIN
 IF NOT has_function_privilege('authenticated','public.record_legacy_paid_voucher_attribution(uuid,uuid,jsonb,jsonb,jsonb,text,boolean,jsonb)','EXECUTE') OR has_function_privilege('anon','public.record_legacy_paid_voucher_attribution(uuid,uuid,jsonb,jsonb,jsonb,text,boolean,jsonb)','EXECUTE') OR has_function_privilege('service_role','public.record_legacy_paid_voucher_attribution(uuid,uuid,jsonb,jsonb,jsonb,text,boolean,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected legacy writer privileges'; END IF;
END $post$;
