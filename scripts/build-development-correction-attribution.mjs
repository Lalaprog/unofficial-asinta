#!/usr/bin/env node
// A guarded artifact for the known empty development target only. It does not
// post a cost or replace old reviews, and is never a generic migration bundle.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
if(process.argv.length!==2)throw Error('No arguments expected');
const source=readFileSync('supabase/drafts/project_cost_correction_attribution.sql','utf8');
const hash=createHash('sha256').update(source).digest('hex');
if(hash!=='4ba9dfb76ac350f62994b923c590cff79b3bc55f31ba1540cf56a23accce8e16')throw Error('Correction source changed; review and re-pin');
if(/^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\s*;/im.test(source)||/^\s*\\/m.test(source))throw Error('Unexpected transaction control');
const artifact=`-- PREPARATION ONLY: NOT YET APPROVED FOR EXECUTION. Known empty DEVELOPMENT
-- target only; the operator must independently verify the project reference.
-- A rollback rehearsal, writer/privilege audit and release review are required.
-- Execute only in a single managed transaction. Source SHA256 ${hash}.
-- No historical review or financial row is changed.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
LOCK TABLE public.users,public.workers,public.supervisor_period_payroll,public.historical_external_worker_payroll,public.paid_period_assertion_cases,public.paid_period_assertion_case_events,public.payroll,public.paid_payroll_adjustment_cases,public.projects,public.project_cost_reviews IN SHARE ROW EXCLUSIVE MODE;
DO $development_preflight$
DECLARE v_hash text; v_count integer; r record;
BEGIN
 IF current_database()<>'postgres' THEN RAISE EXCEPTION 'Unexpected database'; END IF;
 IF (SELECT count(*) FROM auth.users)<>2 OR (SELECT count(*) FROM public.users)<>2 OR (SELECT count(*) FROM public.users WHERE role='founder')<>1 OR (SELECT count(*) FROM public.users WHERE role='supervisor')<>1 THEN RAISE EXCEPTION 'Development accounts changed'; END IF;
 IF EXISTS(SELECT 1 FROM public.workers) OR EXISTS(SELECT 1 FROM public.payroll) OR EXISTS(SELECT 1 FROM public.historical_external_worker_payroll) OR EXISTS(SELECT 1 FROM public.paid_payroll_adjustment_cases) OR EXISTS(SELECT 1 FROM public.paid_period_assertion_cases) OR EXISTS(SELECT 1 FROM public.project_cost_reviews) THEN RAISE EXCEPTION 'Business state changed; re-review before installation'; END IF;
 SELECT encode(sha256(convert_to(string_agg(n.nspname||'.'||c.relname||':'||a.attnum||':'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text,E'\\n' ORDER BY c.relname,a.attnum),'UTF8')),'hex'),count(*) INTO v_hash,v_count
 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname=ANY(ARRAY['users','workers','payroll','projects','supervisor_period_payroll','historical_external_worker_payroll','paid_payroll_adjustment_cases','paid_period_assertion_cases','paid_period_assertion_case_events']) AND a.attnum>0 AND NOT a.attisdropped;
 IF v_hash IS DISTINCT FROM 'f517c3cbf49aebd218fd18e3fe92c2a79b57279af9cef6a147e32f9116b9ed5c' OR v_count<>102 THEN RAISE EXCEPTION 'Development schema differs'; END IF;
 FOR r IN SELECT * FROM (VALUES
  ('auth.uid()','7c1ff2ecbe653c9358b3115a2607db9573f88a2944ae4eca9e296a89cc5186a7'),
  ('public.is_founder()','fa022685cbf0e33ef812828fe537dd307a57712ad05e21bb2d47eb72feb341a3'),
  ('public.session_assurance_satisfied()','d4c6a53f7792703119ac26443213db4f4cf695d0b390f008a5926f3b32569850'),
  ('app_private.paid_adjustment_voucher_snapshot(public.payroll)','85f44e7ba0b829eeb6b33e2dd8c3d96281e2c8c9ecf48e8930d9770b54d891e5'),
  ('public.paid_period_assertion_snapshot(text,uuid)','dd0fa88ff40b9012e79ecd8f01cef720c884d2e7eb319fb1a5eee51293ca45ae'),
  ('public.open_paid_payroll_adjustment(uuid,uuid,jsonb,numeric,text)','ff403a8ef943eb27208a00005ba51d493f5b01bb13171d10f15607977696cfb4'),
  ('public.resolve_paid_payroll_adjustment(uuid,text,date,text)','32c702ee23f4ad1b55fb06cca419fdc0494c3dd42a9cee4d023f4fab0ec25e37'),
  ('public.open_paid_period_assertion_case(uuid,text,uuid,jsonb,numeric,text)','c6d3c6c12c7c59bf020a0c3b7401f935b654f20ef2962c39bbe8f95570a38a5d'),
  ('public.resolve_paid_period_assertion_case(uuid,text,date,text,boolean)','11aa2505d96e023a116d33fd672ccb442bfd80b464f5c2803a410f92fe30869e'),
  ('public.guard_paid_period_assertion_case_immutable()','121192dc972339fdee0b353b7bef697126e31624b4bb45279bb97afbd2fc0703'),
  ('public.guard_historical_external_worker_immutable()','9f39082f71f8439c20af30e90ac077529229bd3ce73445db2d2781f87eff3e32'),
  ('app_private.guard_paid_adjustment_immutable()','495aa427f7cba9675d8e085b92fcabe092cc7851888397ebd3357424646664a0'),
  ('public.historical_worker_attribution_projects()','dbf1cdb60d27faf5ffc89753ae4a5a547751fe43c97e4f455cf8ba93ecab95a4')
 ) AS f(signature,digest) LOOP
  IF to_regprocedure(r.signature) IS NULL OR encode(sha256(convert_to(pg_get_functiondef(to_regprocedure(r.signature)),'UTF8')),'hex') IS DISTINCT FROM r.digest THEN RAISE EXCEPTION 'Prerequisite function drift: %',r.signature; END IF;
 END LOOP;
 FOR r IN SELECT * FROM (VALUES
  ('public.paid_payroll_adjustment_cases','guard_paid_adjustment_case_history','app_private.guard_paid_adjustment_immutable()'),
  ('public.paid_period_assertion_cases','paid_period_case_immutable','public.guard_paid_period_assertion_case_immutable()'),
  ('public.historical_external_worker_payroll','historical_external_worker_immutable','public.guard_historical_external_worker_immutable()')
 ) AS t(table_name,trigger_name,function_name) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(r.table_name) AND tgname=r.trigger_name AND tgenabled='O' AND tgtype=27 AND tgfoid=to_regprocedure(r.function_name) AND NOT tgisinternal) THEN RAISE EXCEPTION 'Source history guard changed: %',r.table_name; END IF;
 END LOOP;
 FOR r IN SELECT * FROM (VALUES ('public.paid_payroll_adjustment_cases'),('public.paid_period_assertion_cases'),('public.paid_period_assertion_case_events'),('public.historical_external_worker_payroll')) AS t(table_name) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass(r.table_name) AND relrowsecurity AND pg_get_userbyid(relowner)='postgres') OR EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) roles(role_name) WHERE has_table_privilege(roles.role_name,r.table_name,'INSERT,UPDATE,DELETE,TRUNCATE') OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass(r.table_name) AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(roles.role_name,a.attrelid,a.attname,'INSERT,UPDATE'))) THEN RAISE EXCEPTION 'Source table owner, RLS or write privilege changed: %',r.table_name; END IF;
 END LOOP;
END $development_preflight$;
${source}
DO $development_postflight$ BEGIN
 IF EXISTS(SELECT 1 FROM public.project_cost_correction_attributions) OR EXISTS(SELECT 1 FROM public.project_cost_correction_sites) OR NOT coalesce((SELECT relrowsecurity FROM pg_class WHERE oid='public.project_cost_correction_attributions'::regclass),false) OR NOT coalesce((SELECT relrowsecurity FROM pg_class WHERE oid='public.project_cost_correction_sites'::regclass),false) THEN RAISE EXCEPTION 'Correction evidence postflight failed'; END IF;
END $development_postflight$;
`;
writeFileSync('supabase/release/development-correction-attribution.sql',artifact);
