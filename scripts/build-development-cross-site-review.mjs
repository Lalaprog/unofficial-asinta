#!/usr/bin/env node
// Development-only preparation. Do not run against an unverified target.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
if(process.argv.length!==2)throw Error('No arguments expected');
const pinned=[
 ['supabase/drafts/project_cost_correction_original_context.sql','727afdb3cf631e5862690eaa4cc6a4816f5518fe95237fe9d4c1c009498ac846'],
 ['supabase/drafts/project_cost_cross_site_preview.sql','45c333401d03f022c5c30ded319634c31aa24279e7bf612cdea36edc007efe1c'],
 ['supabase/drafts/project_cost_cross_site_review_context.sql','e259348f3f25013e7420035bf106145cf00a30d1f139803b1431b9830c23bbfc'],
 ['supabase/drafts/project_cost_cross_site_corrected_preview.sql','1b0cc8c54fd16a148889aa851a7aaa43c2418126d88b68405665913a330db932'],
 ['supabase/drafts/project_cost_cross_site_review_ledger.sql','444383e22c370ae21a51b8112eefc96fa8d67fe1af838430043f6765b142bce9'],
 ['supabase/preflight/development-corrected-writer-audit.sql','aa19030da7bd968b49627327401dcbc81c07717205539e22f9293e3caf6ac738'],
];
const parts=pinned.map(([path,hash])=>{const text=readFileSync(path,'utf8');if(createHash('sha256').update(text).digest('hex')!==hash)throw Error(`${path} changed; review and re-pin`);if(/^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\s*;/im.test(text)||/^\s*\\/m.test(text))throw Error(`Unexpected transaction control in ${path}`);return text;});
const preflight=`
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
`;
const artifact=`-- HELD DEVELOPMENT PREPARATION ONLY. One managed transaction required.\n-- Catalog and account counts do not identify a target or prove isolation.\n-- Pinned source files:\n${pinned.map(([p,h])=>`-- ${p} ${h}`).join('\n')}\nDO $manual_hold$ BEGIN IF current_setting('app.cross_site_development_reviewed',true) IS DISTINCT FROM 'yes' THEN RAISE EXCEPTION 'Cross-site preparation held pending target verification and rehearsal'; END IF; END $manual_hold$;\n${preflight}\n${parts[5]}\n${parts.slice(0,5).join('\n')}\nDO $cross_site_development_postflight$ BEGIN\n IF EXISTS(SELECT 1 FROM public.project_cost_cross_site_reviews) OR NOT coalesce((SELECT relrowsecurity FROM pg_class WHERE oid='public.project_cost_cross_site_reviews'::regclass),false) THEN RAISE EXCEPTION 'Cross-site development postflight failed'; END IF;\nEND $cross_site_development_postflight$;\n`;
writeFileSync('supabase/release/development-cross-site-review.sql',artifact);
