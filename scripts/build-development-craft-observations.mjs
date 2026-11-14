#!/usr/bin/env node
// Generate a target-specific, transaction-managed development-only artifact.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
if(process.argv.length!==2)throw Error('No arguments expected');
const source=readFileSync('supabase/drafts/recorded_craft_observations.sql','utf8');
if(/^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\s*;/im.test(source)||/^\s*\\/m.test(source))throw Error('Unexpected transaction control');
const artifact=`-- Target-specific empty DEVELOPMENT database only. Execute in one transaction.
-- Source SHA256 ${createHash('sha256').update(source).digest('hex')}
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
LOCK TABLE public.workers,public.attendance,public.payroll IN SHARE ROW EXCLUSIVE MODE;
DO $preflight$ BEGIN
 IF current_database()<>'postgres' THEN RAISE EXCEPTION 'Unexpected database'; END IF;
 IF EXISTS(SELECT 1 FROM public.workers) OR EXISTS(SELECT 1 FROM public.attendance) OR EXISTS(SELECT 1 FROM public.payroll) THEN RAISE EXCEPTION 'Business records exist; review this cutover again'; END IF;
 IF md5(pg_get_functiondef('public.attendance_history_matching(uuid,text,date,text)'::regprocedure))<>'3aaae3e747efbdb685143fbf7533a462' OR md5(pg_get_functiondef('public.attendance_history_page(text,uuid,text,date,text,date,uuid,uuid,integer)'::regprocedure))<>'68f8c544de35f3e564e1a939610bd724' OR md5(pg_get_functiondef('public.payslip_batch_snapshot(date,date)'::regprocedure))<>'6e5af85ca882e44d8349f92929644f21' THEN RAISE EXCEPTION 'Source function drift'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.workers'::regclass AND tgname='bind_worker_category' AND tgenabled='O') OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.attendance'::regclass AND tgname='guard_attendance_assignment' AND tgenabled='O') OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.payroll'::regclass AND tgname='require_weekly_worker_source_on_insert' AND tgenabled='O') THEN RAISE EXCEPTION 'Required cutover triggers missing'; END IF;
END $preflight$;
${source}
DO $postflight$ BEGIN
 IF EXISTS(SELECT 1 FROM public.attendance_craft_observations) OR EXISTS(SELECT 1 FROM public.payroll_craft_observations) OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.attendance'::regclass AND tgname='capture_attendance_craft' AND tgenabled='O') OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.payroll'::regclass AND tgname='capture_payroll_craft' AND tgenabled='O') THEN RAISE EXCEPTION 'Craft postflight failed'; END IF;
END $postflight$;
`;
writeFileSync('supabase/release/development-craft-observations.sql',artifact);
