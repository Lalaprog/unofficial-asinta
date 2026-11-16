// Empty disposable local PostgreSQL only; never a Supabase database.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {estimateProjectCost,parseCostSnapshot} from '@/lib/projects/projectCostReconciliation';
import {candidatePaths,fixture,founder,payroll,site,worker} from './helpers/project-cost-reconciliation-fixture';
const url=process.env.LARGER_COST_REVIEW_TEST_DATABASE_URL,suite=url?describe:describe.skip;
let admin:Client,reader:Client;
suite('larger bounded review on PostgreSQL',()=>{
 beforeAll(async()=>{const u=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||!u.pathname.slice(1).startsWith('asinta_test_')||u.search||u.hash)throw Error('Use an empty local asinta_test_* database');admin=new Client({connectionString:url});reader=new Client({connectionString:url});await Promise.all([admin.connect(),reader.connect()]);
  const existing=(await admin.query("SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S'))::int objects,(SELECT count(*) FROM pg_namespace WHERE nspname IN ('auth','app_private','storage'))::int schemas")).rows[0];if(existing.objects||existing.schemas)throw Error('Database must be empty');
  await admin.query(`DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END$$;`);
  await admin.query(fixture);for(const path of candidatePaths)await admin.query(`BEGIN;${readFileSync(path,'utf8')} COMMIT;`);await admin.query(`BEGIN;${readFileSync('supabase/drafts/project_cost_larger_review.sql','utf8')} COMMIT;`);
  await reader.query(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),reader?.end()]);});
 it('returns all 1000 expenses and paid allocations, and rejects 1001 without a partial total',async()=>{
  await admin.query(`INSERT INTO public.expenses(id,project_id,description,category,amount,expense_date) SELECT md5(('expense'||g)::text)::uuid,'${site}','Extra '||g,'materials',1,'2024-11-04' FROM generate_series(1,997) g;
   INSERT INTO public.payroll SELECT md5(('largepay'||g)::text)::uuid,'${worker}','2024-11-03','2024-11-09','paid',100,0,0,100,8 FROM generate_series(1,999) g;
   INSERT INTO public.weekly_worker_draft_sources SELECT id,worker_id,period_start,'${founder}',now(),NULL,'${founder}',NULL,'{"wage":"100.00","allowance":"0.00","gross":"100.00","bale":"0.00","net":"100.00"}'::jsonb FROM public.payroll WHERE id<>'${payroll}';
   INSERT INTO public.payroll_payment_dates SELECT id,'2024-11-09','${founder}' FROM public.payroll WHERE id<>'${payroll}';
   INSERT INTO public.weekly_worker_paid_allocations SELECT id,'${site}',8,100,0,100 FROM public.payroll WHERE id<>'${payroll}';`);
  const raw=(await reader.query<{v:unknown}>('SELECT public.project_cost_reconciliation_preview($1) v',[site])).rows[0].v,parsed=parseCostSnapshot(raw,site);expect(parsed.expenses).toHaveLength(1000);expect(parsed.paid).toHaveLength(1000);expect(new Set(parsed.paid.map(p=>p.payrollId)).size).toBe(1000);
  const choices:Record<string,'include'>=Object.fromEntries(parsed.expenses.map(e=>[e.id,'include']));expect(estimateProjectCost(parsed,choices).total).toBe(10264700n);
  await admin.query(`INSERT INTO public.expenses(id,project_id,description,category,amount,expense_date) VALUES(md5('extra limit')::uuid,'${site}','Too many','other',1,'2024-11-04')`);await expect(reader.query('SELECT public.project_cost_reconciliation_preview($1)',[site])).rejects.toMatchObject({code:'54000'});
 },30000);
});
