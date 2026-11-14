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
  await admin.query(`BEGIN; ${sql('paid_payroll_adjustments')} COMMIT;
   CREATE TABLE public.historical_external_worker_payroll(request_id uuid PRIMARY KEY,original jsonb);
   CREATE TABLE public.paid_period_assertion_cases(id uuid PRIMARY KEY,source_kind text,external_worker_id uuid REFERENCES public.historical_external_worker_payroll(request_id),original_snapshot jsonb,difference numeric,status text);
   CREATE FUNCTION public.paid_period_assertion_snapshot(text,uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT original FROM public.historical_external_worker_payroll WHERE request_id=$2$$;
   BEGIN; ${sql('project_cost_correction_attribution')} COMMIT;`);
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
 it('refuses repeatable-read writers',async()=>{await first.query('BEGIN ISOLATION LEVEL REPEATABLE READ');try{await expect(record(first,id(5),2,'20.00')).rejects.toMatchObject({code:'P1002'});}finally{await first.query('ROLLBACK');}});
});
