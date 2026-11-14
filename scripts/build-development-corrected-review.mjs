#!/usr/bin/env node
// Preparation only: exact observed development state, not an approved release.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
if(process.argv.length!==2)throw Error('No arguments expected');
const pinned=[
 ['supabase/release/development-correction-attribution.sql','9c77f30cc857a3d66cbb4e81851b76c8738c394543a1d31e79a7f643204c9ff1'],
 ['supabase/drafts/project_cost_correction_inventory.sql','8363739c53e3a5f60f208e58f779429fbd3a76907fb1e4552415092815fed1a9'],
 ['supabase/drafts/project_cost_corrected_preview.sql','775af2bd36dcda536db802c2291294750442ee862ac43e464391af4226df5493'],
 ['supabase/drafts/project_cost_corrected_review_ledger.sql','a339e5c9d14cb98d0981e0ffd526b8756487cdf2971fff6cb300c21ba27b1c4d'],
];
const parts=pinned.map(([path,hash])=>{const text=readFileSync(path,'utf8');if(createHash('sha256').update(text).digest('hex')!==hash)throw Error(`${path} changed; review and re-pin`);if(/^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\s*;/im.test(text)||/^\s*\\/m.test(text))throw Error(`Unexpected transaction control in ${path}`);return text;});
const preflight=`
-- PREPARATION ONLY, NOT APPROVED FOR EXECUTION. Verify the target project
-- reference independently and perform hosted rollback/security review first.
-- Locks and exact empty-state/function pins are specific to the observed demo.
LOCK TABLE public.expenses,public.confirmed_rental_expenses,public.weekly_worker_paid_allocations,public.weekly_worker_draft_sources,public.payroll_payment_dates,public.historical_worker_attributions,public.historical_worker_attribution_sites IN SHARE ROW EXCLUSIVE MODE;
DO $corrected_development_preflight$
DECLARE r record;
BEGIN
 IF EXISTS(SELECT 1 FROM public.expenses) OR EXISTS(SELECT 1 FROM public.historical_worker_attributions) OR EXISTS(SELECT 1 FROM public.historical_worker_attribution_sites) OR EXISTS(SELECT 1 FROM public.weekly_worker_paid_allocations) OR EXISTS(SELECT 1 FROM public.confirmed_rental_expenses) OR EXISTS(SELECT 1 FROM public.weekly_worker_draft_sources) OR EXISTS(SELECT 1 FROM public.payroll_payment_dates) THEN RAISE EXCEPTION 'Development source data changed; re-review'; END IF;
 FOR r IN SELECT * FROM (VALUES
  ('public.project_cost_historical_review(uuid)','e625c812572026a66fe2e61c98f5bd2615ec5ed6b0b8aa9c1e0b4e63bd590f73'),
  ('public.project_cost_reconciliation_preview(uuid)','6fb6b32b0503f0e135c3afbaab65a6cbc7b48c21e46257eaf3beea4bd32aed2f'),
  ('public.project_historical_worker_attributions(uuid)','dfdffffcc44ca28f409bcac76f2ef74706887e7c886503ffed24c7184b5ae70f'),
  ('public.historical_external_worker_lookup(uuid)','45450f8f890a4871dace8b90035c2c05dd5292df28fc79ba2388c67e1c5229c8'),
  ('public.project_paid_worker_evidence(uuid,date,uuid,integer)','87265e59d92156f94e0562ccbdc7cd827b985e46cddf17594b98a2e6212315cb'),
  ('public.project_confirmed_rentals(uuid)','51c5ee154793692183f63e71a51f27312a6dd877375542bd1a1f20c7ddcb9c5e'),
  ('public.record_project_cost_review(uuid,uuid,integer,jsonb,jsonb,text)','a30d6e9f98e3c29aec28a28930016cfbec18fd5f0a621c6b9093ff9052db2cc5'),
  ('public.project_cost_review(uuid,integer)','22c6987706c81a60b91bb449374abc91415afd739df7b554348becef860f224e')
 ) AS f(signature,digest) LOOP
  IF to_regprocedure(r.signature) IS NULL OR encode(sha256(convert_to(pg_get_functiondef(to_regprocedure(r.signature)),'UTF8')),'hex') IS DISTINCT FROM r.digest THEN RAISE EXCEPTION 'Corrected review dependency drift: %',r.signature; END IF;
 END LOOP;
END $corrected_development_preflight$;
`;
const artifact=`-- NOT APPROVED FOR EXECUTION. Development preparation only. One managed transaction required.\n-- Pinned files:\n${pinned.map(([p,h])=>`-- ${p} ${h}`).join('\n')}\nDO $manual_hold$ BEGIN IF current_setting('app.corrected_development_reviewed',true) IS DISTINCT FROM 'yes' THEN RAISE EXCEPTION 'Corrected review preparation is held pending target verification and rehearsal'; END IF; END $manual_hold$;\n${parts[0]}\n${preflight}\n${parts.slice(1).join('\n')}\nDO $corrected_development_postflight$ BEGIN\n IF EXISTS(SELECT 1 FROM public.project_cost_corrected_reviews) OR NOT coalesce((SELECT relrowsecurity FROM pg_class WHERE oid='public.project_cost_corrected_reviews'::regclass),false) THEN RAISE EXCEPTION 'Corrected review postflight failed'; END IF;\nEND $corrected_development_postflight$;\n`;
writeFileSync('supabase/release/development-corrected-review.sql',artifact);
