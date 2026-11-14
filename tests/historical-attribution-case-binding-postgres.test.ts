// Destructive setup ONLY in a new local asinta_test_* database.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const url=process.env.HISTORICAL_CASE_BINDING_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const founder='00000000-0000-0000-0000-000000000001',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004';
const id=(n:number)=>`82000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sql=(name:string)=>readFileSync(`supabase/drafts/${name}.sql`,'utf8');
const pause=()=>new Promise(resolve=>setTimeout(resolve,150));
let admin:Client,first:Client,second:Client,source:unknown,reviewed:{snapshot:unknown;total:number;items:unknown[]};
const inventory=async(c:Client)=>(await c.query("SELECT public.paid_period_assertion_case_list('external_worker',$1) v",[id(1)])).rows[0].v;
const record=(c:Client,request:string,cases:unknown)=>c.query("SELECT public.record_historical_attribution_with_cases($1,$2,$3::jsonb,$4::jsonb,'Reviewed',true,$5::jsonb) v",[request,id(1),JSON.stringify(source),JSON.stringify([{project_id:site,gross:'600.00'}]),JSON.stringify(cases)]);
suite('historical attribution case binding PostgreSQL races (held candidate)',()=>{
 beforeAll(async()=>{
  const parsed=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||!parsed.pathname.slice(1).startsWith('asinta_test_')||parsed.search||parsed.hash)throw Error('Use a new empty local asinta_test_* database');
  admin=new Client({connectionString:url});first=new Client({connectionString:url});second=new Client({connectionString:url});await Promise.all([admin.connect(),first.connect(),second.connect()]);
  const o=(await admin.query("SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S'))::int objects,(SELECT count(*) FROM pg_namespace WHERE nspname IN ('auth','app_private','storage'))::int schemas")).rows[0];if(o.objects||o.schemas)throw Error('Database must be empty');
  await admin.query("DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END$$;");
  const prefix='CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; ';if(!baseFixture.startsWith(prefix))throw Error('Fixture bootstrap changed');await admin.query(baseFixture.slice(prefix.length));
  for(const name of ['supervisor_table_foundation','supervisor_rpc_rollout','supervisor_payroll_preview','historical_external_worker_payroll','supervisor_payroll_ledger','paid_period_assertion_adjustments','historical_worker_project_attribution'])await admin.query(`BEGIN;${sql(name)} COMMIT;`);
  await admin.query(`BEGIN;SET LOCAL app.historical_case_binding_candidate='synthetic-only';${sql('historical_attribution_case_binding')} COMMIT;`);
  for(const c of [first,second])await c.query(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes';SET lock_timeout='4s'`);
  const w=(await first.query("SELECT public.historical_external_worker_review($1,'2024-11-03') v",[worker])).rows[0].v.worker;
  await first.query("SELECT public.record_historical_external_worker_payroll($1,$2,'2024-11-03','2024-11-09',600,100,0,500,'Old ledger',$3,true)",[id(1),worker,w]);
  source=(await first.query('SELECT public.historical_external_worker_lookup($1) v',[id(1)])).rows[0].v;reviewed=await inventory(first);
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),first?.end(),second?.end()]);});
 it('waits for a case opening and rejects the stale list before writing',async()=>{
  await first.query('BEGIN');await second.query('BEGIN');try{
   await first.query("SELECT public.open_paid_period_assertion_case($1,'external_worker',$2,$3::jsonb,30,'Case')",[id(2),id(1),JSON.stringify(reviewed.snapshot)]);
   let finished=false;const write=record(second,id(3),reviewed).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{finished=true;});
   await pause();expect(finished).toBe(false);await first.query('COMMIT');expect((await write).code).toBe('40001');await second.query('ROLLBACK');
   expect((await admin.query('SELECT count(*)::int n FROM public.historical_worker_attributions')).rows[0].n).toBe(0);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('holds case resolution until the review commits and then reports changed cases; exact replay remains possible',async()=>{
  reviewed=await inventory(first);expect(reviewed.total).toBe(1);await first.query('BEGIN');await second.query('BEGIN');try{
   expect((await record(first,id(3),reviewed)).rows[0].v.replayed).toBe(false);
   let finished=false;const resolution=second.query("SELECT public.resolve_paid_period_assertion_case($1,'no_transfer',NULL,'Reviewed case',true)",[id(2)]).finally(()=>{finished=true;});
   await pause();expect(finished).toBe(false);await first.query('COMMIT');await resolution;await second.query('COMMIT');
   expect((await first.query('SELECT public.historical_attribution_case_binding($1) v',[id(1)])).rows[0].v.cases_changed).toBe(true);
   expect((await record(first,id(3),reviewed)).rows[0].v.replayed).toBe(true);
   expect((await admin.query('SELECT count(*)::int n FROM public.historical_attribution_case_bindings')).rows[0].n).toBe(1);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('rejects repeatable-read writers',async()=>{await first.query('BEGIN ISOLATION LEVEL REPEATABLE READ');try{await expect(record(first,id(3),reviewed)).rejects.toMatchObject({code:'P1002'});}finally{await first.query('ROLLBACK');}});
 it('replays and writes through the replacement after a direct old-writer revoke',async()=>{
  // Synthetic ACL change only, after the race tests. This does not drain old
  // invocations or test grants inherited through other roles on a target.
  await admin.query('REVOKE EXECUTE ON FUNCTION public.record_historical_worker_attribution(uuid,uuid,jsonb,jsonb,text,boolean) FROM PUBLIC,anon,authenticated,service_role');
  await expect(first.query("SELECT public.record_historical_worker_attribution($1,$2,$3::jsonb,$4::jsonb,'Reviewed',true)",[id(3),id(1),JSON.stringify(source),JSON.stringify([{project_id:site,gross:'600.00'}])])).rejects.toMatchObject({code:'42501'});
  expect((await record(first,id(3),reviewed)).rows[0].v.replayed).toBe(true);
  const w=(await first.query("SELECT public.historical_external_worker_review($1,'2024-11-10') v",[worker])).rows[0].v.worker;
  await first.query("SELECT public.record_historical_external_worker_payroll($1,$2,'2024-11-10','2024-11-16',600,100,0,500,'Second ledger',$3,true)",[id(4),worker,w]);
  const secondSource=(await first.query('SELECT public.historical_external_worker_lookup($1) v',[id(4)])).rows[0].v;
  const secondCases=(await first.query("SELECT public.paid_period_assertion_case_list('external_worker',$1) v",[id(4)])).rows[0].v;
  const result=await first.query("SELECT public.record_historical_attribution_with_cases($1,$2,$3::jsonb,$4::jsonb,'Reviewed',true,$5::jsonb) v",[id(5),id(4),JSON.stringify(secondSource),JSON.stringify([{project_id:site,gross:'600.00'}]),JSON.stringify(secondCases)]);
  expect(result.rows[0].v.replayed).toBe(false);
  expect((await admin.query('SELECT count(*)::int n FROM public.historical_attribution_case_bindings')).rows[0].n).toBe(2);
 },15000);
});
