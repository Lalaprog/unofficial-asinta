#!/usr/bin/env node
// Generates a rollback-only rehearsal script, NOT a hosted deployment script.
// It excludes the hosted Bale guard, weekly preview base, locked Supervisor tables and paid-review RPC.
// Usage for an isolated disposable database: node scripts/build-pr103-rehearsal.mjs > /tmp/pr103-rehearsal.sql
// Never run this against a shared database: DDL can lock tables even on rollback.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const files=[
 '20261113000001_attendance_time_detail.sql',
 '20261114000001_protect_time_detail_sequence.sql',
 '20261113000002_worker_allowances.sql',
 '20261113000003_weekly_payroll_context.sql',
 '20261113000005_supervisor_leave.sql',
 '20261113000006_supervisor_daily_attendance.sql',
];
const sql=(file)=>readFileSync(join(root,'supabase','migrations',file),'utf8');
const guard=sql('20261113000004_bale_request_site_guard.sql');
const guardBody=guard.match(/RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS \$\$([\s\S]*?)\$\$;/)?.[1];
if(!guardBody)throw new Error('Could not identify the site guard body');
const hash=createHash('md5').update(guardBody).digest('hex');
const baseBody=sql('20261113000000_weekly_worker_preview.sql').match(/AS \$\$([\s\S]*?)\$\$;/)?.[1];
if(!baseBody)throw new Error('Could not identify the weekly preview base body');
const baseHash=createHash('md5').update(baseBody).digest('hex');
const tableNames={
 '20261113000005_supervisor_leave.sql':'supervisor_leave_requests',
 '20261113000006_supervisor_daily_attendance.sql':'supervisor_daily_attendance',
};
const chunks=files.map(name=>{
 const source=sql(name);
 let text=source;
 if(tableNames[name]){
  const marker=`REVOKE ALL ON public.${tableNames[name]} FROM PUBLIC,anon,authenticated;`;
  const index=source.indexOf(marker);
  if(index<0||source.indexOf(marker,index+1)>=0)throw new Error(`Ambiguous table boundary in ${name}`);
  text=source.slice(index+marker.length);
 }

 // Refuse transaction control and psql meta-commands in inputs. This is a
 // conservative tripwire, not a SQL parser or a substitute for reviewing SQL.
 if (/^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\s*;/im.test(text) || /^\s*\\/m.test(text))
  throw new Error(`Unexpected transaction control or psql command in ${name}`);
 const digest=createHash('sha256').update(source).digest('hex');
 return `\n-- Source: ${name} SHA-256 ${digest}\n${text}\n`;
});
console.log(`-- REHEARSAL ONLY — always rolls back. Never run against a shared database.
-- Existing site guard, weekly base, and locked Supervisor tables are checked, never applied again. No business data is inserted.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = public, pg_catalog;
DO $preflight$
DECLARE v_guard regprocedure := pg_catalog.to_regprocedure('public.guard_advance_request_site()');
 v_base regprocedure := pg_catalog.to_regprocedure('public.weekly_worker_preview_inputs(date)');
 v_name text; v_expected text; v_hash text;
BEGIN
 IF v_guard IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=v_guard AND p.prosecdef AND md5(p.prosrc)='${hash}') THEN
  RAISE EXCEPTION 'Expected installed Bale site guard is missing or different'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=pg_catalog.to_regclass('public.advance_requests') AND t.tgname='guard_advance_request_site' AND NOT t.tgisinternal AND t.tgenabled='O' AND t.tgfoid=v_guard) THEN
  RAISE EXCEPTION 'Expected enabled Bale site guard trigger is missing or different'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=pg_catalog.to_regclass('public.advance_requests') AND a.attnum>0 AND NOT a.attisdropped AND
   (pg_catalog.has_column_privilege('anon',a.attrelid,a.attname,'INSERT') OR
    (a.attname NOT IN ('worker_id','project_id','requested_amount','submitted_by') AND pg_catalog.has_column_privilege('authenticated',a.attrelid,a.attname,'INSERT')) OR
    (a.attname IN ('worker_id','project_id','requested_amount','submitted_by') AND NOT pg_catalog.has_column_privilege('authenticated',a.attrelid,a.attname,'INSERT')))) THEN
  RAISE EXCEPTION 'Unexpected Bale request INSERT privileges'; END IF;
 IF v_base IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=v_base AND NOT p.prosecdef AND p.provolatile='s' AND md5(p.prosrc)='${baseHash}') OR pg_catalog.has_function_privilege('anon',v_base,'EXECUTE') OR NOT pg_catalog.has_function_privilege('authenticated',v_base,'EXECUTE') THEN
  RAISE EXCEPTION 'Expected read-only weekly base function is missing, different, or has unexpected privileges'; END IF;
 IF pg_catalog.to_regprocedure('public.weekly_worker_preview_base_inputs(date)') IS NOT NULL OR pg_catalog.to_regprocedure('public.weekly_worker_time_preview_inputs(date)') IS NOT NULL THEN
  RAISE EXCEPTION 'Unexpected intermediate weekly preview function'; END IF;
 IF pg_catalog.to_regclass('public.attendance_time_details') IS NOT NULL OR pg_catalog.to_regclass('public.worker_allowances') IS NOT NULL THEN
  RAISE EXCEPTION 'Remaining PR 103 tables already exist; reconcile before proceeding'; END IF;
 -- Even this rollback-only rehearsal needs a stable empty-table check. A
 -- privileged writer otherwise could insert after the check and before DDL.
 -- Hold both locks through the transaction, in the same order as the separate
 -- Supervisor RPC candidate. Never run this rehearsal on a shared database.
 IF pg_catalog.to_regclass('public.supervisor_daily_attendance') IS NULL OR pg_catalog.to_regclass('public.supervisor_leave_requests') IS NULL THEN
  RAISE EXCEPTION 'Locked Supervisor table missing or different'; END IF;
 LOCK TABLE public.supervisor_daily_attendance, public.supervisor_leave_requests IN SHARE MODE;
 FOREACH v_name IN ARRAY ARRAY['supervisor_daily_attendance','supervisor_leave_requests'] LOOP
  v_expected:=CASE v_name WHEN 'supervisor_daily_attendance' THEN '70e3d6ee56b130b897505c5c19843b2d' ELSE '9739b77d0441a9714d982ee4ece68fdd' END;
  SELECT md5((jsonb_build_object('columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
   'constraints',(SELECT jsonb_agg(jsonb_build_array(con.conname,con.contype,pg_get_constraintdef(con.oid)) ORDER BY con.conname) FROM pg_constraint con WHERE con.conrelid=c.oid),
   'indexes',(SELECT jsonb_agg(jsonb_build_array(i.relname,pg_get_indexdef(i.oid)) ORDER BY i.relname) FROM pg_index ix JOIN pg_class i ON i.oid=ix.indexrelid WHERE ix.indrelid=c.oid)))::text) INTO v_hash
   FROM pg_class c WHERE c.oid=pg_catalog.to_regclass('public.'||v_name) AND c.relkind='r' AND c.relrowsecurity;
  IF v_hash IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'Locked Supervisor table missing or different: %',v_name; END IF;
  IF pg_catalog.has_table_privilege('anon','public.'||v_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR pg_catalog.has_table_privilege('authenticated','public.'||v_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
   RAISE EXCEPTION 'Unexpected client privileges on locked Supervisor table %',v_name; END IF;
  IF EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=pg_catalog.to_regclass('public.'||v_name) AND NOT t.tgisinternal) THEN
   RAISE EXCEPTION 'Unexpected trigger on locked Supervisor table %',v_name; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.supervisor_leave_requests) OR EXISTS(SELECT 1 FROM public.supervisor_daily_attendance) THEN
  RAISE EXCEPTION 'Locked Supervisor tables contain data; reconcile before proceeding'; END IF;
END;
$preflight$;
${chunks.join('\n')}
DO $postflight$
DECLARE v_name text; v_seq regclass;
BEGIN
 FOREACH v_name IN ARRAY ARRAY['attendance_time_details','worker_allowances','supervisor_leave_requests','supervisor_daily_attendance'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass('public.'||v_name) AND relrowsecurity) THEN
   RAISE EXCEPTION 'Missing RLS on %',v_name; END IF;
  IF pg_catalog.has_table_privilege('anon','public.'||v_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') OR pg_catalog.has_table_privilege('authenticated','public.'||v_name,'INSERT,UPDATE,DELETE,TRUNCATE') THEN
   RAISE EXCEPTION 'Unexpected client table privileges on %',v_name; END IF;
 END LOOP;
 v_seq:=pg_catalog.pg_get_serial_sequence('public.attendance_time_details','revision_id')::regclass;
 IF v_seq IS NULL OR pg_catalog.has_sequence_privilege('anon',v_seq,'USAGE,SELECT,UPDATE') OR pg_catalog.has_sequence_privilege('authenticated',v_seq,'USAGE,SELECT,UPDATE') THEN
  RAISE EXCEPTION 'Unexpected time-detail sequence privileges'; END IF;
 IF pg_catalog.to_regprocedure('public.weekly_worker_preview_inputs(date)') IS NULL OR pg_catalog.to_regprocedure('public.supervisor_day_list(integer)') IS NULL OR pg_catalog.to_regprocedure('public.supervisor_leave_list(integer)') IS NULL THEN
  RAISE EXCEPTION 'Required review functions are missing'; END IF;
END;
$postflight$;
ROLLBACK;
`);
