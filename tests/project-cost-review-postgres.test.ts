// Opt-in: only a newly created, empty, local PostgreSQL database.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {baleExpense,candidatePaths,confirmRental,fixture,founder,materialExpense,rentalExpense,site} from './helpers/project-cost-reconciliation-fixture';
const url=process.env.PROJECT_COST_REVIEW_TEST_DATABASE_URL,suite=url?describe:describe.skip;
let admin:Client,a:Client,b:Client;
async function waitForLock(client:Client){
 const pid=(await admin.query<{pid:number}>('SELECT pid FROM pg_stat_activity WHERE application_name=$1',[client===a?'review-a':'review-b'])).rows[0]?.pid;
 if(!pid)throw Error('Missing test connection');
 for(let i=0;i<150;i++){
  const row=(await admin.query<{waiting:boolean}>("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0];
  if(row?.waiting)return;
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 throw Error('Test query did not reach a lock wait');
}
const choices={[materialExpense]:{decision:'include',reason:null},[rentalExpense]:{decision:'include',reason:null},[baleExpense]:{decision:'exclude',reason:'Existing Bale already represented in gross'}};
const snap=async()=> (await a.query<{v:unknown}>('SELECT public.project_cost_reconciliation_preview($1) v',[site])).rows[0].v;
const call=(client:Client,id:string,rev:number,s:unknown)=>client.query<{v:{revision:number;replayed:boolean}}> ('SELECT public.record_project_cost_review($1,$2,$3,$4::jsonb,$5::jsonb,$6) v',[id,site,rev,JSON.stringify(s),JSON.stringify(choices),'Reviewed']);
const id=(n:number)=>`30000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
suite('project cost review concurrency in PostgreSQL',()=>{
 beforeAll(async()=>{
  const u=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||!u.pathname.slice(1).startsWith('asinta_test_')||u.search||u.hash)throw Error('Use an empty local asinta_test_* database');
  admin=new Client({connectionString:url});a=new Client({connectionString:url});b=new Client({connectionString:url});await Promise.all([admin.connect(),a.connect(),b.connect()]);
  const existing=(await admin.query("SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S'))::int objects,(SELECT count(*) FROM pg_namespace WHERE nspname IN ('auth','app_private','storage'))::int schemas")).rows[0];if(existing.objects||existing.schemas)throw Error('Database must be empty');
  await admin.query("DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END$$;");
  await admin.query(fixture);for(const path of [...candidatePaths,'supabase/drafts/project_cost_review_ledger.sql'])await admin.query(`BEGIN; ${readFileSync(path,'utf8')} COMMIT;`);
  await a.query("SET application_name='review-a'");await b.query("SET application_name='review-b'");
  for(const c of [a,b])await c.query(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);await a.query(confirmRental);
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),a?.end(),b?.end()]);});
 it('serializes identical retries into one immutable record',async()=>{
  const s=await snap();await a.query('BEGIN');try{expect((await call(a,id(1),0,s)).rows[0].v.replayed).toBe(false);let done=false;const pending=call(b,id(1),0,s).finally(()=>{done=true});await waitForLock(b);expect(done).toBe(false);await a.query('COMMIT');expect((await pending).rows[0].v).toMatchObject({revision:1,replayed:true});}finally{await a.query('ROLLBACK');}
  expect((await admin.query('SELECT count(*)::int n FROM public.project_cost_reviews')).rows[0].n).toBe(1);
 },15000);
 it('rejects a competing request based on a superseded revision',async()=>{
  const s=await snap();await a.query('BEGIN');try{await call(a,id(2),1,s);const pending=call(b,id(3),1,s).then(()=>null,e=>e);await waitForLock(b);await a.query('COMMIT');expect(await pending).toMatchObject({code:'40001'});}finally{await a.query('ROLLBACK');}
  expect((await admin.query('SELECT count(*)::int n FROM public.project_cost_reviews')).rows[0].n).toBe(2);
 },15000);
 it('rechecks evidence after waiting for the project lock',async()=>{
  const s=await snap();await admin.query('BEGIN');try{
   await admin.query("SELECT pg_advisory_xact_lock(hashtextextended('project-cost-review-project:'||$1::text,0))",[site]);
   await admin.query('UPDATE public.expenses SET amount=51 WHERE id=$1',[materialExpense]);
   let done=false;const pending=call(b,id(4),2,s).then(()=>null,e=>e).finally(()=>{done=true});await waitForLock(b);expect(done).toBe(false);await admin.query('COMMIT');expect(await pending).toMatchObject({code:'40001'});
  }finally{await admin.query('ROLLBACK');}
  expect((await admin.query('SELECT count(*)::int n FROM public.project_cost_reviews')).rows[0].n).toBe(2);
 },15000);
 it('cannot record when Founder role is revoked before the actor lock',async()=>{
  const s=await snap();await admin.query('BEGIN');try{
   await admin.query("UPDATE public.users SET role='supervisor' WHERE id=$1",[founder]);
   let done=false;const pending=call(b,id(5),2,s).then(()=>null,e=>e).finally(()=>{done=true});await waitForLock(b);expect(done).toBe(false);await admin.query('COMMIT');expect(await pending).toMatchObject({code:'42501'});
  }finally{await admin.query('ROLLBACK');await admin.query("UPDATE public.users SET role='founder' WHERE id=$1",[founder]);}
  expect((await admin.query('SELECT count(*)::int n FROM public.project_cost_reviews')).rows[0].n).toBe(2);
 },15000);
});
