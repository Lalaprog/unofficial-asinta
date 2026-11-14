#!/usr/bin/env node
// Development-only candidate after the separate attribution migration. The
// explicit hold remains; this is not a general install or a release sign-off.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
if(process.argv.length!==2)throw Error('No arguments expected');
const hash=s=>createHash('sha256').update(s).digest('hex');
const old=readFileSync('supabase/release/development-corrected-review.sql','utf8');
const attribution=readFileSync('supabase/release/development-correction-attribution.sql','utf8');
if(hash(old)!=='23f73114207afa9f1c4b0c8d320bcd7062dd18b3ace987147d0ad8130f3b955a'||hash(attribution)!=='9c77f30cc857a3d66cbb4e81851b76c8738c394543a1d31e79a7f643204c9ff1')throw Error('Pinned source changed; review before rebuilding');
if(old.split(attribution).length!==2)throw Error('Attribution bundle boundary changed');
const check=`-- DEVELOPMENT ONLY: verify the previously installed attribution layer.
-- Catalog fingerprints are drift detection, not an exhaustive security audit.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
LOCK TABLE public.users,public.workers,public.supervisor_period_payroll,public.historical_external_worker_payroll,public.paid_period_assertion_cases,public.paid_period_assertion_case_events,public.payroll,public.paid_payroll_adjustment_cases,public.projects,public.project_cost_reviews,public.project_cost_correction_attributions,public.project_cost_correction_sites IN SHARE ROW EXCLUSIVE MODE;
DO $installed_attribution_preflight$
DECLARE r record; h text; n integer; f oid;
BEGIN
 IF current_database()<>'postgres' OR (SELECT count(*) FROM auth.users)<>2 OR (SELECT count(*) FROM public.users)<>2 OR (SELECT count(*) FROM public.users WHERE role='founder')<>1 OR (SELECT count(*) FROM public.users WHERE role='supervisor')<>1 THEN RAISE EXCEPTION 'Development database or accounts changed'; END IF;
 IF EXISTS(SELECT 1 FROM public.workers) OR EXISTS(SELECT 1 FROM public.projects) OR EXISTS(SELECT 1 FROM public.payroll) OR EXISTS(SELECT 1 FROM public.historical_external_worker_payroll) OR EXISTS(SELECT 1 FROM public.paid_payroll_adjustment_cases) OR EXISTS(SELECT 1 FROM public.paid_period_assertion_cases) OR EXISTS(SELECT 1 FROM public.project_cost_reviews) OR EXISTS(SELECT 1 FROM public.project_cost_correction_attributions) OR EXISTS(SELECT 1 FROM public.project_cost_correction_sites) THEN RAISE EXCEPTION 'Development evidence changed; re-review'; END IF;
 SELECT encode(sha256(convert_to(string_agg(c.relname||':'||a.attnum||':'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text,E'\\n' ORDER BY c.relname,a.attnum),'UTF8')),'hex'),count(*) INTO h,n FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname='public' AND c.relname IN ('project_cost_correction_attributions','project_cost_correction_sites') AND a.attnum>0 AND NOT a.attisdropped;
 IF h IS DISTINCT FROM 'e3c5a3c836a536e78a26972bc45bf299df15780b403e6de7caa9b7642c2692b0' OR n<>14 THEN RAISE EXCEPTION 'Attribution columns changed'; END IF;
 FOR r IN SELECT * FROM (VALUES
  ('app_private.guard_project_cost_correction_immutable()','40f0cea53eb7561d309906ccf8a20b4241dee1b7bbf9622309ffa4f7647cb281',false,false),
  ('app_private.project_cost_correction_case(text,uuid)','8276d60c11070b540d48ee4e9e35691fcd8aad4b716726834b1619ea7936e09a',true,false),
  ('public.project_cost_correction_attribution_sites(uuid)','b1a5b4c64bea9f94659969f470b53fd8d1aef28ed3db14f7277722fa7766c061',true,true),
  ('public.project_cost_correction_attribution(text,uuid,integer)','d329c05825457871dee936776304b84cd893bf3573f84e9eb82f63fb3e317eb1',true,true),
  ('public.record_project_cost_correction_attribution(uuid,text,uuid,integer,jsonb,numeric,jsonb,text,boolean)','19dee6462d95cdf3e7c92bef4f85156bd0e85168e4ae3ba81dd0f4940c34937e',true,true)
 ) AS expected(signature,digest,definer,authenticated_execute) LOOP
  f:=to_regprocedure(r.signature);
  IF f IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f AND p.prokind='f' AND p.prosecdef=r.definer AND pg_get_userbyid(p.proowner)='postgres' AND p.proconfig @> ARRAY['search_path=""']) OR encode(sha256(convert_to(pg_get_functiondef(f),'UTF8')),'hex') IS DISTINCT FROM r.digest OR has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('service_role',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') IS DISTINCT FROM r.authenticated_execute THEN RAISE EXCEPTION 'Installed attribution function changed: %',r.signature; END IF;
 END LOOP;
 FOR r IN SELECT * FROM (VALUES ('public.project_cost_correction_attributions','guard_project_cost_correction_immutable'),('public.project_cost_correction_sites','guard_project_cost_correction_sites_immutable')) AS t(table_name,trigger_name) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass(r.table_name) AND c.relkind='r' AND c.relrowsecurity AND pg_get_userbyid(c.relowner)='postgres') OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass(r.table_name) AND t.tgname=r.trigger_name AND t.tgenabled='O' AND t.tgtype=27 AND t.tgfoid=to_regprocedure('app_private.guard_project_cost_correction_immutable()') AND NOT t.tgisinternal) OR EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) roles(role_name) WHERE has_table_privilege(roles.role_name,r.table_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass(r.table_name) AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(roles.role_name,a.attrelid,a.attname,'SELECT,INSERT,UPDATE,REFERENCES'))) THEN RAISE EXCEPTION 'Installed attribution table or privileges changed: %',r.table_name; END IF;
 END LOOP;
END $installed_attribution_preflight$;
`;
const header='-- POST-ATTRIBUTION DEVELOPMENT CANDIDATE: NOT APPROVED FOR EXECUTION.\n-- Old four-part artifact was adapted by replacing only its already-installed\n-- attribution section with a target-specific dependency preflight.\n';
const built=header+old.replace(attribution,check);
writeFileSync('supabase/release/development-corrected-after-attribution.sql',built);
