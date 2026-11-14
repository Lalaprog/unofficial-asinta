// Opt-in only; destructive synthetic setup in a NEW empty local database.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const url=process.env.COST_CORRECTION_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const founder='00000000-0000-0000-0000-000000000001',voucher='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004';
const id=(n:number)=>`91000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sql=(name:string)=>readFileSync(`supabase/drafts/${name}.sql`,'utf8');
let admin:Client,first:Client,second:Client,evidence:unknown;
const pause=()=>new Promise(resolve=>setTimeout(resolve,150));
const record=(c:Client,request:string,revision:number,amount:string)=>c.query<{v:{replayed:boolean;revision:number}}>("SELECT public.record_project_cost_correction_attribution($1,'voucher',$2,$3,$4::jsonb,$5::numeric,$6::jsonb,'Reviewed',true) v",[request,id(1),revision,JSON.stringify(evidence),amount,JSON.stringify([{project_id:site,gross_change:amount}])]);
suite('correction attribution PostgreSQL races (synthetic candidate)',()=>{
 beforeAll(async()=>{
  const parsed=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||!parsed.pathname.slice(1).startsWith('asinta_test_')||parsed.search||parsed.hash)throw Error('Use a new empty local asinta_test_* database');
  admin=new Client({connectionString:url});first=new Client({connectionString:url});second=new Client({connectionString:url});await Promise.all([admin.connect(),first.connect(),second.connect()]);
  const o=(await admin.query("SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S'))::int objects,(SELECT count(*) FROM pg_namespace WHERE nspname IN ('auth','app_private','storage'))::int schemas")).rows[0];if(o.objects||o.schemas)throw Error('Database must be empty');
  await admin.query("DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END$$;");
  const prefix='CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; ';if(!baseFixture.startsWith(prefix))throw Error('Fixture bootstrap changed');await admin.query(baseFixture.slice(prefix.length));
  for(const name of ['supervisor_table_foundation','supervisor_rpc_rollout','supervisor_payroll_preview','historical_external_worker_payroll','supervisor_payroll_ledger','paid_period_assertion_adjustments','paid_payroll_adjustments','project_cost_correction_attribution'])await admin.query(`BEGIN; ${sql(name)} COMMIT;`);
  const snapshot=(await admin.query('SELECT app_private.paid_adjustment_voucher_snapshot(p) v FROM public.payroll p WHERE id=$1',[voucher])).rows[0].v;
  for(const c of [first,second])await c.query(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'; SET lock_timeout='4s'`);
  await first.query('SELECT public.open_paid_payroll_adjustment($1,$2,$3,50,$4)',[id(1),voucher,snapshot,'Synthetic case']);
  await first.query("SELECT public.resolve_paid_payroll_adjustment($1,'no_transfer',NULL,'Reviewed')",[id(1)]);
  evidence=(await first.query("SELECT public.project_cost_correction_attribution('voucher',$1,NULL) v",[id(1)])).rows[0].v.case;
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),first?.end(),second?.end()]);});
 it('serializes exact retries and rejects competing stale revisions',async()=>{
  await first.query('BEGIN');await second.query('BEGIN');try{
   expect((await record(first,id(2),0,'50.00')).rows[0].v.replayed).toBe(false);
   let done=false;const waiting=record(second,id(2),0,'50.00').finally(()=>{done=true;});await pause();expect(done).toBe(false);await first.query('COMMIT');expect((await waiting).rows[0].v.replayed).toBe(true);await second.query('COMMIT');
   await first.query('BEGIN');await second.query('BEGIN');expect((await record(first,id(3),1,'40.00')).rows[0].v.revision).toBe(2);
   let completed=false;const conflicting=record(second,id(4),1,'30.00').then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{completed=true;});await pause();expect(completed).toBe(false);await first.query('COMMIT');expect((await conflicting).code).toBe('40001');await second.query('ROLLBACK');
   const rows=(await admin.query('SELECT revision,gross_change::text FROM public.project_cost_correction_attributions ORDER BY revision')).rows;expect(rows).toEqual([{revision:1,gross_change:'50.00'},{revision:2,gross_change:'40.00'}]);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('holds Founder role stable during an attribution decision',async()=>{
  await first.query('BEGIN');await admin.query('BEGIN');try{
   await record(first,id(6),2,'20.00');let done=false;const demotion=admin.query("UPDATE public.users SET role='supervisor' WHERE id=$1",[founder]).finally(()=>{done=true;});await pause();expect(done).toBe(false);await first.query('COMMIT');await demotion;await admin.query('ROLLBACK');
   expect((await first.query("SELECT public.project_cost_correction_attribution('voucher',$1,NULL) v",[id(1)])).rows[0].v.latest_revision).toBe(3);
  }finally{await first.query('ROLLBACK');await admin.query('ROLLBACK');}
 },15000);
 it('serializes with the real external-period case writer without changing the original',async()=>{
  const review=(await first.query("SELECT public.historical_external_worker_review($1,'2024-11-03') v",[voucher])).rows[0].v;
  await first.query("SELECT public.record_historical_external_worker_payroll($1,$2,'2024-11-03','2024-11-09',600,100,0,500,'Synthetic ledger',$3,true)",[id(10),voucher,JSON.stringify(review.worker)]);
  const original=(await first.query("SELECT public.paid_period_assertion_case_list('external_worker',$1) v",[id(10)])).rows[0].v.snapshot;
  await first.query("SELECT public.open_paid_period_assertion_case($1,'external_worker',$2,$3,30,'Synthetic A')",[id(11),id(10),original]);await first.query("SELECT public.resolve_paid_period_assertion_case($1,'no_transfer',NULL,'Reviewed A',true)",[id(11)]);
  const expected=(await first.query("SELECT public.project_cost_correction_attribution('external_worker',$1,NULL) v",[id(11)])).rows[0].v.case;
  await first.query("SELECT public.open_paid_period_assertion_case($1,'external_worker',$2,$3,10,'Synthetic B')",[id(12),id(10),original]);
  await first.query('BEGIN');await second.query('BEGIN');try{
   await first.query("SELECT public.resolve_paid_period_assertion_case($1,'no_transfer',NULL,'Reviewed B',true)",[id(12)]);
   let done=false;const write=second.query("SELECT public.record_project_cost_correction_attribution($1,'external_worker',$2,0,$3,20,$4,'Reviewed',true) v",[id(13),id(11),expected,JSON.stringify([{project_id:site,gross_change:'20.00'}])]).finally(()=>{done=true;});await pause();expect(done).toBe(false);await first.query('COMMIT');expect((await write).rows[0].v.replayed).toBe(false);await second.query('COMMIT');
   expect((await admin.query('SELECT gross::text,net::text FROM public.historical_external_worker_payroll WHERE request_id=$1',[id(10)])).rows[0]).toEqual({gross:'600.00',net:'500.00'});
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('refuses repeatable-read writers',async()=>{await first.query('BEGIN ISOLATION LEVEL REPEATABLE READ');try{await expect(record(first,id(5),3,'20.00')).rejects.toMatchObject({code:'P1002'});}finally{await first.query('ROLLBACK');}});
});
