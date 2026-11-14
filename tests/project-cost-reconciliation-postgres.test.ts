// Opt-in only for a new, empty local disposable PostgreSQL database.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {parseCostSnapshot} from '@/lib/projects/projectCostReconciliation';
import {candidatePaths,confirmRental,fixture,founder,materialExpense,payroll,site,worker} from './helpers/project-cost-reconciliation-fixture';
const url=process.env.PROJECT_COST_RECONCILIATION_TEST_DATABASE_URL;const suite=url?describe:describe.skip;
let admin:Client,reader:Client;const pause=()=>new Promise(resolve=>setTimeout(resolve,150));
suite('project cost reconciliation snapshot on PostgreSQL 17',()=>{
 beforeAll(async()=>{
  const u=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||!u.pathname.slice(1).startsWith('asinta_test_')||u.search||u.hash)throw Error('Use an empty local asinta_test_* database');
  admin=new Client({connectionString:url});reader=new Client({connectionString:url});await Promise.all([admin.connect(),reader.connect()]);
  const existing=(await admin.query("SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S'))::int objects,(SELECT count(*) FROM pg_namespace WHERE nspname IN ('auth','app_private','storage'))::int schemas")).rows[0];if(existing.objects||existing.schemas)throw Error('Database must be empty');
  await admin.query("DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END$$;");
  await admin.query(fixture);for(const path of candidatePaths)await admin.query(`BEGIN; ${readFileSync(path,'utf8')} COMMIT;`);
  await reader.query(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'; ${confirmRental}`);
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),reader?.end()]);});
 it('keeps expenses and payroll on one statement snapshot across a concurrent commit',async()=>{
  // Test-only synchronization wrapper; neither the app nor the candidate has a sleep/lock hook.
  await admin.query(`ALTER FUNCTION public.project_paid_worker_evidence(uuid,date,uuid,integer) RENAME TO test_paid_worker_evidence_original;
   CREATE FUNCTION public.project_paid_worker_evidence(p uuid,w date,i uuid,n integer) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$BEGIN PERFORM pg_catalog.pg_advisory_xact_lock_shared(918376);RETURN public.test_paid_worker_evidence_original(p,w,i,n);END$$;`);
  await admin.query('BEGIN');try{
   await admin.query('SELECT pg_advisory_xact_lock(918376)');await admin.query('UPDATE public.expenses SET amount=70 WHERE id=$1',[materialExpense]);
   await admin.query('UPDATE public.payroll SET gross_pay=760,net_pay=660 WHERE id=$1',[payroll]);await admin.query('UPDATE public.weekly_worker_draft_sources SET calculation=$2 WHERE payroll_id=$1',[payroll,JSON.stringify({wage:'710.00',allowance:'50.00',gross:'760.00',bale:'100.00',net:'660.00'})]);await admin.query('UPDATE public.weekly_worker_paid_allocations SET wage=560,gross=610 WHERE payroll_id=$1 AND project_id=$2',[payroll,site]);
   await admin.query(`SET LOCAL test.uid='${founder}'; SET LOCAL test.assurance='yes'`);
   await admin.query("SELECT public.open_paid_payroll_adjustment('20000000-0000-0000-0000-000000000099',p.id,app_private.paid_adjustment_voucher_snapshot(p),25.50,'Separate case') FROM public.payroll p WHERE id=$1",[payroll]);
   let done=false;const pending=reader.query<{v:unknown}>('SELECT public.project_cost_reconciliation_preview($1) v',[site]).finally(()=>{done=true});await pause();expect(done).toBe(false);await admin.query('COMMIT');
   const previous=parseCostSnapshot((await pending).rows[0].v,site);expect(previous.expenses.find(x=>x.id===materialExpense)?.amount).toBe('50.00');expect(previous.paid[0].gross).toBe('600.00');expect(previous.adjustments).toEqual([]);
   const current=parseCostSnapshot((await reader.query<{v:unknown}>('SELECT public.project_cost_reconciliation_preview($1) v',[site])).rows[0].v,site);expect(current.expenses.find(x=>x.id===materialExpense)?.amount).toBe('70.00');expect(current.paid[0].gross).toBe('610.00');expect(current.adjustments).toMatchObject([{payrollId:payroll,status:'pending',difference:'25.50'}]);
  }finally{await admin.query('ROLLBACK');}
 },15000);
 it('rejects more than 500 paid allocations instead of returning a partial total',async()=>{
  await admin.query(`INSERT INTO public.payroll SELECT md5(('limit'||g)::text)::uuid,'${worker}','2024-11-03','2024-11-09','paid',100,0,0,100,8 FROM generate_series(1,499) g;
   INSERT INTO public.weekly_worker_draft_sources SELECT id,worker_id,period_start,'${founder}',now(),NULL,'${founder}',NULL,'{"wage":"100.00","allowance":"0.00","gross":"100.00","bale":"0.00","net":"100.00"}'::jsonb FROM public.payroll WHERE id<>'${payroll}';
   INSERT INTO public.payroll_payment_dates SELECT id,'2024-11-09','${founder}' FROM public.payroll WHERE id<>'${payroll}';
   INSERT INTO public.weekly_worker_paid_allocations SELECT id,'${site}',8,100,0,100 FROM public.payroll WHERE id<>'${payroll}';`);
  const full=parseCostSnapshot((await reader.query<{v:unknown}>('SELECT public.project_cost_reconciliation_preview($1) v',[site])).rows[0].v,site);expect(full.paid).toHaveLength(500);expect(new Set(full.paid.map(x=>x.payrollId)).size).toBe(500);
  await admin.query(`INSERT INTO public.payroll VALUES(md5('limit500')::uuid,'${worker}','2024-11-03','2024-11-09','paid',100,0,0,100,8);
   INSERT INTO public.weekly_worker_draft_sources VALUES(md5('limit500')::uuid,'${worker}','2024-11-03','${founder}',now(),NULL,'${founder}',NULL,'{"wage":"100.00","allowance":"0.00","gross":"100.00","bale":"0.00","net":"100.00"}');
   INSERT INTO public.payroll_payment_dates VALUES(md5('limit500')::uuid,'2024-11-09','${founder}');INSERT INTO public.weekly_worker_paid_allocations VALUES(md5('limit500')::uuid,'${site}',8,100,0,100);`);
  await expect(reader.query('SELECT public.project_cost_reconciliation_preview($1)',[site])).rejects.toMatchObject({code:'54000'});
 },30000);
 it('rejects more than 500 matching correction cases instead of returning partial signals',async()=>{
  // Clear only synthetic excess payroll from the previous boundary test.
  await admin.query("DELETE FROM public.weekly_worker_paid_allocations WHERE payroll_id=md5('limit500')::uuid;DELETE FROM public.payroll_payment_dates WHERE payroll_id=md5('limit500')::uuid;DELETE FROM public.weekly_worker_draft_sources WHERE payroll_id=md5('limit500')::uuid;DELETE FROM public.payroll WHERE id=md5('limit500')::uuid");
  await admin.query(`INSERT INTO public.paid_payroll_adjustment_cases(id,payroll_id,worker_id,original_voucher,difference,reason,status,created_by,resolved_by,resolved_at,resolution_note)
   SELECT md5(('case'||g)::text)::uuid,'${payroll}','${worker}','{}'::jsonb,1,'Synthetic','no_transfer','${founder}','${founder}',now(),'Synthetic' FROM generate_series(1,499) g`);
  const full=parseCostSnapshot((await reader.query<{v:unknown}>('SELECT public.project_cost_reconciliation_preview($1) v',[site])).rows[0].v,site);expect(full.adjustments).toHaveLength(500);
  await admin.query(`INSERT INTO public.paid_payroll_adjustment_cases(id,payroll_id,worker_id,original_voucher,difference,reason,status,created_by,resolved_by,resolved_at,resolution_note)
   VALUES(md5('case500')::uuid,'${payroll}','${worker}','{}',1,'Synthetic','no_transfer','${founder}','${founder}',now(),'Synthetic')`);
  await expect(reader.query('SELECT public.project_cost_reconciliation_preview($1)',[site])).rejects.toMatchObject({code:'54000'});
 },30000);
});
