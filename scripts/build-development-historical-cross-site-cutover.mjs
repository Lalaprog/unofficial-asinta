#!/usr/bin/env node
// Produces a target-specific, fail-closed candidate. Installation still needs
// explicit target verification, a rollback-only rehearsal and a quiet window.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const files=[
 ['supabase/drafts/historical_attribution_atomic_rehearsal.sql','app.historical_case_atomic_rehearsal','bde7b9c10bc6dc29ec28d5cb21653a452e8d9aa7f177b0359499a727e7d8b8cc'],
 ['supabase/drafts/project_cost_evidence_lock_rehearsal.sql','app.cost_evidence_lock_candidate','07cd6962f704228cc2155c99da454710ba8a9ff71b4a4bb52bc5ccfc809b1d68'],
 ['supabase/drafts/project_cost_multi_case_upgrade.sql','app.cross_site_multicase_candidate','d4a1884351242671e23a01dc65a6bfbf326bf40722a9c19646507970db09b1f8'],
];
const sha=x=>createHash('sha256').update(x).digest('hex');
const content=files.map(([p,flag,expected])=>{const s=readFileSync(p,'utf8');if(sha(s)!==expected)throw Error(`Source changed: ${p}`);return `\nSET LOCAL ${flag}='development-reviewed';\n${s.replaceAll("'synthetic-only'","'development-reviewed'")}`;});
const prerequisites=[
 ['app_private.paid_adjustment_voucher_snapshot(public.payroll)','9a47eb635aa8c44e9dd8162caa010f55a5750bf00c16cb67896b477bf437ad90',false],
 ['app_private.project_cost_correction_case(text,uuid)','1375c11a08cde8f6fe122ecfb898514727275b0e729fd857c898d23579e90514',true],
 ['public.historical_external_worker_lookup(uuid)','970d57146aab869178c6ba88905f5472620d8dcac6ca0bcfde349b654cebb4fa',true],
 ['public.historical_worker_attribution(uuid)','2bb4d81bf395add1e1df773a560575e95b0fd15eaa727c202f4e4c281e03779d',true],
 ['public.paid_period_assertion_snapshot(text,uuid)','4f6526d6abb2137c9da2669b2af40d452b05efee6badab62a353950b236ff0b7',true],
 ['public.project_confirmed_rentals(uuid)','3b6acde08e68c4e0d3ded3f48528ff6daf1b8d4430aec00ca052dbf46f59963a',true],
 ['public.project_cost_corrected_preview(uuid,jsonb,jsonb,boolean)','71df66018f34300fa4e65a2bcdc2a682974cf39321ca7d4b32cb40d7d3442700',true],
 ['public.project_cost_corrected_review(uuid,integer)','a252e39432970bed54ec4a1b0d523ccd724da62ba5183517e44773656af02b6e',true],
 ['public.project_cost_correction_attribution(text,uuid,integer)','cc8bd4009b65678e1a21d34871d28920aae34acbcc9d0575b70e4af92cdd8b32',true],
 ['public.project_cost_correction_inventory(uuid)','62de60a3384fb7833db30f547c31c962afdcef52c7760049d811f645f436fb53',true],
 ['public.project_cost_correction_original_context(text,uuid)','4e4b10c1270f39b5363ccfd5354cb33e5b19493e84a0cb8faf2e76f1dfe9a10c',true],
 ['public.project_cost_cross_site_evidence(text,uuid)','90650306e30ad02b880f512165371bad49f1a2305a3a588971998fd15c181e83',true],
 ['public.project_cost_cross_site_review(uuid,integer)','2aaeb2c4327f755010cafa28c33a0c431e8b5580d1ea7b9b64f87d44ad47b997',true],
 ['public.project_cost_historical_review(uuid)','f9c149642834e0036fab43918d91aaad954dff426d4892cee9cda30d744607b1',true],
 ['public.project_cost_reconciliation_preview(uuid)','b5fd0f18d810bb57ec2ce7288955af932a657fd932c071419f8b240374915e05',true],
 ['public.project_historical_worker_attributions(uuid)','9ebfbcb014c5b331fd04e47254a63af21fecb72fda36f0a5d5dcd6894030729d',true],
 ['public.project_paid_worker_evidence(uuid,date,uuid,integer)','922f40a70aad7883d0cfbcc06eeece8112dd26c61125537c3fb02c8c95851a57',true],
];
const header=`-- DEVELOPMENT CUTOVER CANDIDATE; SINGLE TRANSACTION ONLY.\n-- Not a general Supabase migration; do not use db push or run on a different target.\n-- The operator must establish the project identity and compatible client build.\n-- Source pins:\n${files.map(([p],i)=>`-- ${p} ${sha(readFileSync(p,'utf8'))}`).join('\n')}\nDO $hold$ BEGIN IF current_setting('app.asinta_development_historical_cross_site_cutover',true) IS DISTINCT FROM 'reviewed-target' THEN RAISE EXCEPTION 'Development cutover held pending reviewed target'; END IF; END $hold$;\nSET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';\nLOCK TABLE public.project_cost_corrected_reviews,public.project_cost_cross_site_reviews,public.historical_worker_attributions IN SHARE ROW EXCLUSIVE MODE;\nDO $preflight$ DECLARE r record; f oid; BEGIN\n IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Read committed required'; END IF;\n IF EXISTS(SELECT 1 FROM public.historical_worker_attributions) OR EXISTS(SELECT 1 FROM public.historical_worker_attribution_sites) OR EXISTS(SELECT 1 FROM public.project_cost_corrected_reviews) OR EXISTS(SELECT 1 FROM public.project_cost_cross_site_reviews) THEN RAISE EXCEPTION 'Existing review or unbound history requires separate reconciliation'; END IF;\n FOR r IN SELECT * FROM (VALUES\n${prerequisites.map(([sig,h,definer])=>` ('${sig}','${h}',${definer})`).join(',\n')}\n ) AS x(signature,digest,definer) LOOP\n  f:=to_regprocedure(r.signature);\n  IF f IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=f AND p.prosecdef=r.definer AND p.provolatile='s' AND p.proconfig @> ARRAY['search_path=""'] AND pg_catalog.pg_get_userbyid(p.proowner)='postgres' AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex')=r.digest) THEN RAISE EXCEPTION 'Historical/cross-site dependency changed: %',r.signature; END IF;\n END LOOP;\nEND $preflight$;\n`;
const artifact=header+content.join('\n');const path='supabase/release/development-historical-cross-site-candidate.sql';
if(process.argv[2]==='--check'){if(readFileSync(path,'utf8')!==artifact)throw Error('Cutover candidate drift');}else if(process.argv.length===2)writeFileSync(path,artifact);else throw Error('Unknown option');console.log(sha(artifact));
