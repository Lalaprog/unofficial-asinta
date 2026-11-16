// Destructive synthetic setup ONLY in a new, empty local asinta_test_* database.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const url=process.env.HISTORICAL_ATOMIC_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const founder='00000000-0000-0000-0000-000000000001',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004';
const id=(n:number)=>`84000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sql=(name:string)=>readFileSync(`supabase/drafts/${name}.sql`,'utf8');
let admin:Client,first:Client,source:unknown;
suite('held atomic historical cutover PostgreSQL race',()=>{
 beforeAll(async()=>{
  const parsed=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||!parsed.pathname.slice(1).startsWith('asinta_test_')||parsed.search||parsed.hash)throw Error('Use a new empty local asinta_test_* database');
  admin=new Client({connectionString:url});first=new Client({connectionString:url});await Promise.all([admin.connect(),first.connect()]);
  const o=(await admin.query("SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S'))::int objects,(SELECT count(*) FROM pg_namespace WHERE nspname IN ('auth','app_private','storage'))::int schemas")).rows[0];if(o.objects||o.schemas)throw Error('Database must be empty');
  await admin.query("DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END$$;");
  const prefix='CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; ';if(!baseFixture.startsWith(prefix))throw Error('Fixture bootstrap changed');await admin.query(baseFixture.slice(prefix.length));
  for(const name of ['supervisor_table_foundation','supervisor_rpc_rollout','supervisor_payroll_preview','historical_external_worker_payroll','supervisor_payroll_ledger','paid_period_assertion_adjustments','historical_worker_project_attribution'])await admin.query(`BEGIN;${sql(name)} COMMIT;`);
  await first.query(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes';SET lock_timeout='4s'`);
  const w=(await first.query("SELECT public.historical_external_worker_review($1,'2024-11-03') v",[worker])).rows[0].v.worker;
  await first.query("SELECT public.record_historical_external_worker_payroll($1,$2,'2024-11-03','2024-11-09',600,100,0,500,'Ledger',$3,true)",[id(1),worker,w]);source=(await first.query('SELECT public.historical_external_worker_lookup($1) v',[id(1)])).rows[0].v;
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),first?.end()]);});
 it('atomically installs while an old invocation waits, then rejects its insert and allows a bound write',async()=>{
  const pid=(await first.query('SELECT pg_backend_pid() pid')).rows[0].pid;const split=JSON.stringify([{project_id:site,gross:'600.00'}]);
  await admin.query('BEGIN');let oldCall:Promise<{code:string}>|undefined;
  try{
   await admin.query("SELECT pg_advisory_xact_lock(hashtextextended('historical-attribution-request:'||$1::text,0))",[id(2)]);
   let done=false;oldCall=first.query("SELECT public.record_historical_worker_attribution($1,$2,$3::jsonb,$4::jsonb,'Old caller',true)",[id(2),id(1),JSON.stringify(source),split]).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{done=true;});
   await new Promise(resolve=>setTimeout(resolve,150));expect(done).toBe(false);expect((await admin.query('SELECT cardinality(pg_blocking_pids($1))>0 blocked',[pid])).rows[0].blocked).toBe(true);
   await admin.query(`SET LOCAL app.historical_case_atomic_rehearsal='synthetic-only';${sql('historical_attribution_atomic_rehearsal')}`);await admin.query('COMMIT');
   expect((await oldCall).code).toBe('42501');expect((await admin.query('SELECT count(*)::int n FROM public.historical_worker_attributions')).rows[0].n).toBe(0);
   const cases=(await first.query("SELECT public.paid_period_assertion_case_list('external_worker',$1) v",[id(1)])).rows[0].v;
   expect((await first.query("SELECT public.record_historical_attribution_with_cases($1,$2,$3::jsonb,$4::jsonb,'Reviewed',true,$5::jsonb) v",[id(3),id(1),JSON.stringify(source),split,JSON.stringify(cases)])).rows[0].v.replayed).toBe(false);
   expect((await admin.query('SELECT count(*)::int n FROM public.historical_attribution_case_bindings')).rows[0].n).toBe(1);
   expect((await admin.query('SELECT count(*)::int n FROM public.historical_attribution_write_permits')).rows[0].n).toBe(0);
  }finally{await admin.query('ROLLBACK');if(oldCall)await oldCall;}
 },15000);
});
