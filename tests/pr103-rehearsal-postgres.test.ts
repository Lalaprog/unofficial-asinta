// Opt-in only: creates roles, schema and synthetic data in a fresh local cluster.
// Never point this at a hosted or shared PostgreSQL instance.
import {Client} from 'pg';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';

const url=process.env.PR103_REHEARSAL_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const sql=(file:string)=>readFileSync(`supabase/migrations/${file}`,'utf8');
const earlier=['20261103000001_attendance_history.sql','20261107000002_project_worker_lists.sql','20261112000000_guarded_single_project_worker.sql','20261112000001_payslip_batch_snapshot.sql','20261112000002_project_attendance_calendar.sql','20261112000003_project_expense_ledger.sql','20261112000004_receipt_photo_inbox.sql','20261112000005_attendance_history_calendar.sql','20261112000006_revoke_client_truncate.sql'];

suite('PR 103 rollback rehearsal on disposable PostgreSQL',()=>{
 it('checks guard, rolls back a late collision, and preserves existing financial rows',async()=>{
  const parsed=new URL(url!);
  if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||!parsed.pathname.slice(1).startsWith('asinta_test_')||parsed.search||parsed.hash)
   throw new Error('Use a fresh local disposable cluster and empty database named asinta_test_* without URL options.');
  const db=new Client({connectionString:url});await db.connect();
  try{
   const existing=await db.query(`SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S'))::int AS objects,
     (SELECT count(*) FROM pg_namespace WHERE nspname IN ('auth','app_private','storage'))::int AS schemas,
     (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role'))::int AS roles`);
   if(Object.values(existing.rows[0]).some(value=>value!==0))throw new Error('Use a fresh disposable cluster with an empty database and no Supabase roles.');
   await db.query(baseFixture);
   for(const file of earlier)await db.query(sql(file));
   const rehearsal=execFileSync('node',['scripts/build-pr103-rehearsal.mjs'],{encoding:'utf8'});
   await expect(db.query(rehearsal)).rejects.toThrow(/site guard is missing or different/);await db.query('ROLLBACK');
   await db.query(sql('20261113000004_bale_request_site_guard.sql'));
   await db.query('ALTER TABLE public.advance_requests DISABLE TRIGGER guard_advance_request_site');
   await expect(db.query(rehearsal)).rejects.toThrow(/site guard trigger is missing or different/);await db.query('ROLLBACK');
   await db.query('ALTER TABLE public.advance_requests ENABLE TRIGGER guard_advance_request_site');
   await expect(db.query(rehearsal)).rejects.toThrow(/weekly base function is missing/);await db.query('ROLLBACK');
   await db.query(sql('20261113000000_weekly_worker_preview.sql'));
   await expect(db.query(rehearsal)).rejects.toThrow(/Locked Supervisor table missing or different/);await db.query('ROLLBACK');
   await db.query(readFileSync('supabase/drafts/supervisor_table_foundation.sql','utf8'));
   const supervisorRollout=readFileSync('supabase/drafts/supervisor_rpc_rollout.sql','utf8');
   await db.query(`BEGIN; ${supervisorRollout} ROLLBACK;`);
   expect((await db.query("SELECT to_regprocedure('public.submit_supervisor_day(uuid,date,text)') IS NULL AS missing")).rows[0].missing).toBe(true);
   await db.query(`CREATE FUNCTION public.attendance_time_detail_latest(uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$;`);
   await expect(db.query(rehearsal)).rejects.toThrow(/already exists/);await db.query('ROLLBACK');
   expect((await db.query("SELECT to_regclass('public.attendance_time_details') IS NULL AS absent, to_regprocedure('public.weekly_worker_preview_inputs(date)') IS NOT NULL AS function_present")).rows[0]).toEqual({absent:true,function_present:true});
   await db.query('DROP FUNCTION public.attendance_time_detail_latest(uuid)');
   const snapshot=async()=> (await db.query(`SELECT (SELECT md5(coalesce(string_agg(row_to_json(p)::text,',' ORDER BY id),'')) FROM public.payroll p) AS payroll, (SELECT md5(coalesce(string_agg(row_to_json(a)::text,',' ORDER BY id),'')) FROM public.advances a) AS advances, (SELECT md5(coalesce(string_agg(row_to_json(a)::text,',' ORDER BY id),'')) FROM public.attendance a) AS attendance`)).rows[0];
   const before=await snapshot();
   await db.query(rehearsal);
   expect(await snapshot()).toEqual(before);
   expect((await db.query("SELECT to_regclass('public.attendance_time_details') IS NULL AS absent, to_regprocedure('public.weekly_worker_preview_inputs(date)') IS NOT NULL AS function_present")).rows[0]).toEqual({absent:true,function_present:true});
   // Test post-commit read behavior only in this synthetic disposable database.
   if(!rehearsal.endsWith('ROLLBACK;\n\n'))throw new Error('Unexpected rehearsal transaction ending');
   await db.query(rehearsal.slice(0,-'ROLLBACK;\n\n'.length)+'COMMIT;');
   expect(await snapshot()).toEqual(before);
   await db.query("SET ROLE authenticated; SET test.uid='00000000-0000-0000-0000-000000000001'; SET test.assurance='yes'");
   expect((await db.query("SELECT public.weekly_worker_preview_inputs('2026-10-25') AS data")).rows[0].data).toMatchObject({start:'2026-10-25',end:'2026-10-31',attendance:[{status:'present'}],vouchers:[{status:'paid'}]});
   await db.query("SET test.uid='00000000-0000-0000-0000-000000000002'");
   await expect(db.query("SELECT public.weekly_worker_preview_inputs('2026-10-25')")).rejects.toThrow(/Founder/);
  }finally{await db.end();}
 },60000);
});
