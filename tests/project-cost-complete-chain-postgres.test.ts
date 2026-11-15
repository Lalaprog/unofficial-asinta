// Real SQL chain and concurrent real writer in an empty local PostgreSQL DB.
// No hosted credentials or business records are used.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
import {parseCorrectedInventory,calculateCorrected} from '@/lib/projects/correctedCostReview';
import {calculateCrossSite} from '@/lib/projects/crossSiteCostReview';
const url=process.env.CROSS_SITE_COMPLETE_CHAIN_TEST_DATABASE_URL,suite=url?describe:describe.skip;
const founder='00000000-0000-0000-0000-000000000001',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004',other='00000000-0000-0000-0000-000000000005',dest='00000000-0000-4000-8000-000000000006';
const id=(n:number)=>`bd000000-0000-4000-8000-${String(n).padStart(12,'0')}`,sql=(n:string)=>readFileSync(`supabase/drafts/${n}.sql`,'utf8'),j=JSON.stringify;
let admin:Client,a:Client,b:Client;
const read=async(c:Client,q:string,args:unknown[])=>(await c.query<{v:unknown}>(q,args)).rows[0].v;
const inventory=(c:Client,p:string)=>read(c,'SELECT public.project_cost_correction_inventory($1) v',[p]);
async function waitForLock(){const pid=(await admin.query<{pid:number}>("SELECT pid FROM pg_stat_activity WHERE application_name='complete-chain-b'")).rows[0].pid;for(let i=0;i<150;i++){if((await admin.query<{waiting:boolean}>("SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.waiting)return;await new Promise(r=>setTimeout(r,20));}throw Error('Writer did not block');}
async function sourceReview(project:string,request:string){const raw=await inventory(a,project),inv=parseCorrectedInventory(raw,project),group=`external_worker:${id(1)}`,keys=inv.cases.map(c=>c.key).sort();const choices={expenses:Object.fromEntries(inv.historical.base.expenses.map(e=>[e.id,{decision:'include',reason:null}])),historical:Object.fromEntries(inv.historical.historical.map(h=>[h.requestId,{decision:'include',reason:null}])),corrections:Object.fromEntries(inv.cases.map(c=>[c.key,{decision:'include',reason:'Reviewed'}])),source_reviews:{[group]:{case_ids:keys,note:'Different effects reviewed',non_overlapping:true}}};calculateCorrected(inv,choices);await read(a,'SELECT public.record_project_cost_corrected_review($1,$2,0,$3::jsonb,$4::jsonb,$5,true) v',[request,project,j(raw),j(choices),'Reviewed']);return read(a,'SELECT public.project_cost_corrected_review($1,NULL) v',[project]);}
suite('complete historical cross-site chain and selected races, PostgreSQL 17',()=>{
 beforeAll(async()=>{const u=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||!u.pathname.slice(1).startsWith('asinta_test_')||u.search||u.hash)throw Error('Use an empty local asinta_test_* database');admin=new Client({connectionString:url});a=new Client({connectionString:url});b=new Client({connectionString:url});await Promise.all([admin.connect(),a.connect(),b.connect()]);
  const empty=(await admin.query("SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S'))::int objects,(SELECT count(*) FROM pg_namespace WHERE nspname IN ('auth','app_private','storage'))::int schemas")).rows[0];if(empty.objects||empty.schemas)throw Error('Database must be empty');
  await admin.query("DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END$$;");const prefix='CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; ';if(!baseFixture.startsWith(prefix))throw Error('Fixture changed');await admin.query(baseFixture.slice(prefix.length));
  await admin.query(`INSERT INTO public.projects VALUES('${dest}','Destination');ALTER TABLE public.expenses ADD COLUMN ai_bale_detection boolean DEFAULT false;ALTER TABLE public.expenses ADD COLUMN revision bigint NOT NULL DEFAULT 0;
 CREATE TABLE public.weekly_worker_draft_sources(payroll_id uuid primary key,worker_id uuid,period_start date,approved_by uuid,approved_at timestamptz,approval_xid bigint,payment_actor uuid,payment_xid bigint,calculation jsonb);
 CREATE TABLE public.payroll_payment_dates(payroll_id uuid primary key,payment_date date,recorded_by uuid);
 CREATE TABLE public.weekly_worker_paid_allocations(payroll_id uuid,project_id uuid,hours numeric(8,2),wage numeric(10,2),allowance numeric(10,2),gross numeric(10,2),primary key(payroll_id,project_id));`);
  for(const n of ['supervisor_table_foundation','supervisor_rpc_rollout','supervisor_payroll_preview','historical_external_worker_payroll','supervisor_payroll_ledger','paid_period_assertion_adjustments','historical_worker_project_attribution'])await admin.query(`BEGIN;${sql(n)} COMMIT;`);
  for(const n of ['project_paid_payroll_evidence','confirmed_rental_expense_link','paid_payroll_adjustments','project_cost_reconciliation_preview','project_cost_historical_review','project_cost_correction_attribution','project_cost_correction_inventory','project_cost_corrected_preview','project_cost_corrected_review_ledger','project_cost_correction_original_context','project_cost_cross_site_preview','project_cost_cross_site_review_context','project_cost_cross_site_corrected_preview','project_cost_cross_site_review_ledger'])await admin.query(`BEGIN;${sql(n)} COMMIT;`);
  await admin.query(`BEGIN;SET LOCAL app.cross_site_source_lock_reviewed='yes';${sql('project_cost_cross_site_source_review_serialization')} COMMIT;`);
  await admin.query(`BEGIN;SET LOCAL app.cross_site_attribution_lock_reviewed='yes';${sql('project_cost_cross_site_attribution_serialization')} COMMIT;`);
  await admin.query(`BEGIN;SET LOCAL app.asinta_development_historical_cross_site_cutover='reviewed-target';${readFileSync('supabase/release/development-historical-cross-site-candidate.sql','utf8')} COMMIT;`);
  await a.query(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);await b.query(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes';SET application_name='complete-chain-b'`);
 },60000);
 afterAll(async()=>{await Promise.all([admin?.end(),a?.end(),b?.end()]);});
 it('saves signed grouped effects, blocks a real case writer, and hides stale results',async()=>{
  const review=await read(a,"SELECT public.historical_external_worker_review($1,'2024-11-03') v",[worker]) as {worker:unknown};
  await read(a,"SELECT public.record_historical_external_worker_payroll($1,$2,'2024-11-03','2024-11-09',600,100,0,500,'Original',$3::jsonb,true) v",[id(1),worker,j(review.worker)]);
  const source=await read(a,'SELECT public.historical_external_worker_lookup($1) v',[id(1)]),initial=await read(a,"SELECT public.paid_period_assertion_case_list('external_worker',$1) v",[id(1)]) as {snapshot:unknown};
  for(const n of [2,3]){await read(a,"SELECT public.open_paid_period_assertion_case($1,'external_worker',$2,$3::jsonb,30,'Correction') v",[id(n),id(1),j(initial.snapshot)]);await read(a,"SELECT public.resolve_paid_period_assertion_case($1,'no_transfer',NULL,'Reviewed',true) v",[id(n)]);}
  const cases=await read(a,"SELECT public.paid_period_assertion_case_list('external_worker',$1) v",[id(1)]);await read(a,'SELECT public.record_historical_attribution_with_cases($1,$2,$3::jsonb,$4::jsonb,$5,true,$6::jsonb) v',[id(4),id(1),j(source),j([{project_id:site,gross:'400.00'},{project_id:other,gross:'200.00'}]),'Original reviewed',j(cases)]);
  for(const [n,amount] of [[2,150],[3,-50]] as const){const evidence=await read(a,"SELECT public.project_cost_correction_attribution('external_worker',$1,NULL) v",[id(n)]) as {case:unknown};await read(a,"SELECT public.record_project_cost_correction_attribution($1,'external_worker',$2,0,$3::jsonb,0,$4::jsonb,'Reviewed',true) v",[id(n+10),id(n),j(evidence.case),j([{project_id:site,gross_change:(-amount).toFixed(2)},{project_id:dest,gross_change:amount.toFixed(2)}])]);}
  const sourceA=await sourceReview(site,id(20)),sourceB=await sourceReview(other,id(21)),raw=await inventory(a,dest),inv=parseCorrectedInventory(raw,dest),keys=[2,3].map(n=>`external_worker:${id(n)}`),sourceKey=`external_worker:${id(1)}`;
  const choices={expenses:{},historical:{},corrections:Object.fromEntries(keys.map(k=>[k,{decision:'include',reason:'Reviewed'}])),source_reviews:{[sourceKey]:{case_ids:keys,note:'Different effects reviewed',non_overlapping:true}}},contexts:Record<string,unknown>={},sources:Record<string,unknown>={};for(const [i,n] of [2,3].entries()){contexts[keys[i]]=await read(a,"SELECT public.project_cost_cross_site_review_context($1,'external_worker',$2) v",[dest,id(n)]);sources[keys[i]]={[site]:sourceA,[other]:sourceB};}
  expect(calculateCrossSite(inv,choices,contexts,sources).totals.total).toBe(10000n);
  await a.query('BEGIN');try{
   await read(a,'SELECT public.record_project_cost_cross_site_review($1,$2,0,$3::jsonb,$4::jsonb,$5::jsonb,$6,true) v',[id(22),dest,j(raw),j(choices),j(contexts),'Reviewed destination']);
   const pending=b.query("SELECT public.open_paid_period_assertion_case($1,'external_worker',$2,$3::jsonb,20,'Later correction')",[id(23),id(1),j(initial.snapshot)]);await waitForLock();await a.query('COMMIT');await pending;
  }finally{await a.query('ROLLBACK');}
  const saved=await read(a,'SELECT public.project_cost_cross_site_review($1,NULL) v',[dest]) as {freshness:string};expect(['changed','unavailable']).toContain(saved.freshness);
  expect((await admin.query("SELECT count(*)::int n FROM public.payroll WHERE period_start='2024-11-03'")).rows[0].n).toBe(0);
 },60000);
});
