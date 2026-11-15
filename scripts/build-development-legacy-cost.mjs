// Build one development-only transaction payload from the reviewed candidates.
// This is not an authorization to install; use the exact target and rehearse first.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
if(process.argv.length!==2)throw Error('No arguments accepted');
const files=[
 ['legacy_paid_voucher_attribution','c4fbfce753bb49e95d2ee32ec126ba45f246347e9398a94eb10d9d5c359939ea'],
 ['project_cost_legacy_voucher_preview','26c00f8736b72e9f2e67f0882115aefda19c9563eae73430d4e28816cf3ac0a8'],
 ['project_cost_legacy_review_ledger','e9f995a93c4aa2bb32d9f62705da6107e9633013758eae5a198f235cb04416d8'],
 ['project_cost_legacy_correction_context','c012553c450ecf2860f9cff22d701c47987d6940e0c3afa0bdb8a77f8428e2eb'],
 ['project_cost_legacy_corrected_source','0fc99530f02b4dc25b51c2619506793318ff0490977f8579ae85519dd1cec72b'],
 ['project_cost_legacy_corrected_review_upgrade','659677c0faa3f37032d714c07730c3ed0d238af4ddbba217b475eb03e5e0fbcb'],
 ['project_cost_legacy_recorded_coverage','da952f19aa83e65404b6e1e4451124d7d63f9e482ef59a75e0aa547ba1a7e7ef'],
 ['project_cost_legacy_recorded_snapshot','2df7e87a4b52447c90e73c3370e3aeeeb8a8deca7bf133c5f509a57535796d08'],
 ['project_cost_legacy_cross_site_overview','92030586234dabc7ea0f5d0b465cc824d50b14959ea519f84da8e1e045ae90e3'],
 ['project_cost_legacy_old_client_guard','841eadcd499323be666d19b76392ed9f18ae867cc1feb77600dbaf423d8788e9'],
];
const parts=files.map(([name,expected])=>{const text=readFileSync(`supabase/drafts/${name}.sql`,'utf8');if(createHash('sha256').update(text).digest('hex')!==expected)throw Error(`Candidate changed: ${name}`);return `\n-- Source: ${name}.sql SHA256 ${expected}\n${text}`;});
const header=`-- DEVELOPMENT CANDIDATE: execute in ONE managed transaction only.
-- This payload is held pending exact-target rollback rehearsal and client release.
-- It cannot ensure old open browser tabs refresh or prevent privileged writers.
DO $hold$ BEGIN IF current_setting('app.legacy_cost_development_reviewed',true) IS DISTINCT FROM 'yes' THEN RAISE EXCEPTION 'Legacy cost development rollout is held'; END IF; END $hold$;
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='60s';
DO $target$
DECLARE r record;f oid;
BEGIN
 IF current_database()<>'postgres' THEN RAISE EXCEPTION 'Unexpected development database'; END IF;
 FOR r IN SELECT * FROM (VALUES
  ('public.project_cost_corrected_preview(uuid,jsonb,jsonb,boolean)','2be1e27aa9b69d0076edc5e1c350d232',true),
  ('public.project_cost_correction_inventory(uuid)','77d2de8f891678789ec4ffc1fdf34079',true),
  ('public.project_cost_correction_attribution(text,uuid,integer)','a2b84f7beca7138cfd721216917efe32',true),
  ('public.project_cost_corrected_review(uuid,integer)','a5a2b78df46d98e5736b2cb0e97382ea',true),
  ('public.project_cost_cross_site_review(uuid,integer)','44a016ef665816798689061e9dbf2bb3',true),
  ('public.project_cost_cross_site_review_context(uuid,text,uuid)','8653ebc231881861173d539bd9062c67',true),
  ('public.project_cost_recorded_coverage(uuid)','95fa4a3a6f8d212b319e0fbde7be4df9',true),
  ('public.project_recorded_cost_snapshot(uuid)','a470f6a602c2327dd80ed477551dea7a',false),
  ('public.project_cost_cross_site_overview(uuid)','400f4c80ce4a6e5208df64fa3740a46d',false)
 ) AS e(signature,digest,definer) LOOP
  f:=to_regprocedure(r.signature);
  IF f IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f AND p.prokind='f' AND p.prosecdef=r.definer AND p.provolatile='s' AND pg_get_userbyid(p.proowner)='postgres' AND md5(p.prosrc)=r.digest) OR NOT has_function_privilege('authenticated',f,'EXECUTE') OR has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'Development dependency differs: %',r.signature; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_class c WHERE c.oid IN ('public.weekly_worker_paid_allocations'::regclass,'public.weekly_worker_draft_sources'::regclass,'public.paid_payroll_adjustment_cases'::regclass,'public.project_cost_correction_attributions'::regclass,'public.project_cost_correction_sites'::regclass,'public.project_cost_corrected_reviews'::regclass,'public.project_cost_cross_site_reviews'::regclass) AND (NOT c.relrowsecurity OR pg_get_userbyid(c.relowner)<>'postgres' OR has_table_privilege('anon',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') OR has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') OR has_table_privilege('service_role',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE'))) THEN RAISE EXCEPTION 'Unexpected evidence table permissions'; END IF;
END $target$;
-- The nested candidates remain held standalone; this reviewed bundle makes
-- their local hold settings explicit, inside the same transaction.
SET LOCAL app.legacy_correction_candidate='synthetic-only';
SET LOCAL app.legacy_old_client_guard_candidate='synthetic-only';
`;
const suffix=`\n-- Verify the replacement reader preserves the public API and private originals.\nDO $final$ BEGIN
 IF to_regprocedure('public.project_cost_legacy_recorded_snapshot(uuid)') IS NULL OR to_regprocedure('public.project_cost_legacy_cross_site_overview(uuid)') IS NULL OR to_regprocedure('public.record_legacy_paid_voucher_attribution(uuid,uuid,jsonb,jsonb,jsonb,text,boolean,jsonb)') IS NULL OR has_function_privilege('authenticated','app_private.project_cost_corrected_review_before_legacy_guard(uuid,integer)','EXECUTE') OR has_function_privilege('authenticated','app_private.project_cost_cross_site_review_before_legacy_guard(uuid,integer)','EXECUTE') THEN RAISE EXCEPTION 'Legacy development postflight failed'; END IF;
END $final$;\n`;
writeFileSync('supabase/release/development-legacy-project-cost-candidate.sql',header+parts.join('\n')+suffix);
