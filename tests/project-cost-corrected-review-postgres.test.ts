// Opt-in only: isolated, empty, local PostgreSQL database; all data synthetic.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
const url=process.env.CORRECTED_REVIEW_TEST_DATABASE_URL,suite=url?describe:describe.skip;
const founder='00000000-0000-0000-0000-000000000001',site='00000000-0000-0000-0000-000000000002';
const id=(n:number)=>`94000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let admin:Client,a:Client,b:Client;
const choices={expenses:{},historical:{},corrections:{}};
const call=(client:Client,request:string,rev:number,s:unknown)=>client.query<{v:{revision:number;replayed:boolean}}>('SELECT public.record_project_cost_corrected_review($1,$2,$3,$4::jsonb,$5::jsonb,$6,true) v',[request,site,rev,JSON.stringify(s),JSON.stringify(choices),'Synthetic review']);
const snap=async()=>(await a.query<{v:unknown}>('SELECT public.project_cost_correction_inventory($1) v',[site])).rows[0].v;
async function waitForLock(client:Client){
 const name=client===a?'corrected-a':'corrected-b';const pid=(await admin.query<{pid:number}>('SELECT pid FROM pg_stat_activity WHERE application_name=$1',[name])).rows[0]?.pid;if(!pid)throw Error('Missing test connection');
 for(let i=0;i<150;i++){const row=(await admin.query<{waiting:boolean}>("SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0];if(row?.waiting)return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Test query did not reach a lock wait');
}
suite('corrected review concurrency, synthetic PostgreSQL',()=>{
 beforeAll(async()=>{
  const u=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||!u.pathname.slice(1).startsWith('asinta_test_')||u.search||u.hash)throw Error('Use an empty local asinta_test_* database');
  admin=new Client({connectionString:url});a=new Client({connectionString:url});b=new Client({connectionString:url});await Promise.all([admin.connect(),a.connect(),b.connect()]);
  const existing=(await admin.query("SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S'))::int objects,(SELECT count(*) FROM pg_namespace WHERE nspname IN ('auth','app_private','storage'))::int schemas")).rows[0];if(existing.objects||existing.schemas)throw Error('Database must be empty');
  await admin.query(`DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END$$;
   CREATE SCHEMA auth;CREATE SCHEMA app_private;
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
   CREATE TABLE public.users(id uuid PRIMARY KEY,role text NOT NULL);INSERT INTO public.users VALUES('${founder}','founder');
   CREATE TABLE public.projects(id uuid PRIMARY KEY);INSERT INTO public.projects VALUES('${site}');
   CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.assurance',true)='yes'$$;
   CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder')$$;
   CREATE TABLE public.test_inventory(value jsonb NOT NULL);
   INSERT INTO public.test_inventory VALUES ('{"project_id":"${site}","historical_review":{"project_id":"${site}","base":{"captured_at":"2026-01-01T00:00:00Z","expenses":[],"paid_allocations":[],"adjustment_cases":[]},"historical":[]},"corrections":[]}');
   CREATE FUNCTION public.project_cost_correction_inventory(p uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$SELECT value FROM public.test_inventory WHERE value->>'project_id'=p::text$$;
   GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role;`);
  for(const name of ['project_cost_corrected_preview','project_cost_corrected_review_ledger'])await admin.query(`BEGIN;${readFileSync(`supabase/drafts/${name}.sql`,'utf8')} COMMIT;`);
  await a.query("SET application_name='corrected-a'");await b.query("SET application_name='corrected-b'");for(const c of [a,b])await c.query(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),a?.end(),b?.end()]);});
 it('serializes exact concurrent retries into one review',async()=>{const s=await snap();await a.query('BEGIN');try{
  expect((await call(a,id(1),0,s)).rows[0].v).toMatchObject({revision:1,replayed:false});let done=false;const pending=call(b,id(1),0,s).finally(()=>{done=true});await waitForLock(b);expect(done).toBe(false);await a.query('COMMIT');expect((await pending).rows[0].v).toMatchObject({revision:1,replayed:true});
 }finally{await a.query('ROLLBACK');}expect((await admin.query('SELECT count(*)::int n FROM public.project_cost_corrected_reviews')).rows[0].n).toBe(1);},15000);
 it('rejects competing revisions and rechecks a changed snapshot after waiting',async()=>{const s=await snap();await a.query('BEGIN');try{
  await call(a,id(2),1,s);const pending=call(b,id(3),1,s).then(()=>null,e=>e);await waitForLock(b);await a.query('COMMIT');expect(await pending).toMatchObject({code:'40001'});
 }finally{await a.query('ROLLBACK');}
 await admin.query('BEGIN');try{
  await admin.query("SELECT pg_advisory_xact_lock(hashtextextended('corrected-cost-review-project:'||$1::text,0))",[site]);
  await admin.query("UPDATE public.test_inventory SET value=jsonb_set(value,'{historical_review,base,expenses}', '[{\"id\":\"94000000-0000-4000-8000-000000000020\",\"amount\":\"1.00\"}]'::jsonb)");
  const pending=call(b,id(4),2,s).then(()=>null,e=>e);await waitForLock(b);await admin.query('COMMIT');expect(await pending).toMatchObject({code:'40001'});
 }finally{await admin.query('ROLLBACK');}
 expect((await admin.query('SELECT count(*)::int n FROM public.project_cost_corrected_reviews')).rows[0].n).toBe(2);},15000);
 it('rejects a Founder demotion while waiting on the actor row',async()=>{const s=await snap();await admin.query('BEGIN');try{
  await admin.query("UPDATE public.users SET role='supervisor' WHERE id=$1",[founder]);const pending=call(b,id(5),2,s).then(()=>null,e=>e);await waitForLock(b);await admin.query('COMMIT');expect(await pending).toMatchObject({code:'42501'});
 }finally{await admin.query('ROLLBACK');await admin.query("UPDATE public.users SET role='founder' WHERE id=$1",[founder]);}},15000);
 it('reports changed evidence when a source commits after capture but before the review commits',async()=>{
  // This deliberately models an unlocked source writer. Saving a statement
  // snapshot is not a guarantee that the source is unchanged at commit.
  await admin.query("UPDATE public.test_inventory SET value=jsonb_set(value,'{historical_review,base,expenses}','[]'::jsonb)");
  const s=await snap();await a.query('BEGIN');try{
   expect((await call(a,id(6),2,s)).rows[0].v).toMatchObject({revision:3,replayed:false});
   await admin.query("UPDATE public.test_inventory SET value=jsonb_set(value,'{historical_review,base,expenses}', '[{\"id\":\"94000000-0000-4000-8000-000000000021\",\"amount\":\"2.00\"}]'::jsonb)");
   await a.query('COMMIT');
  }finally{await a.query('ROLLBACK');}
  const review=(await b.query<{v:{revision:number;freshness:string}}>('SELECT public.project_cost_corrected_review($1,3) v',[site])).rows[0].v;
  expect(review).toMatchObject({revision:3,freshness:'changed'});
  expect((await admin.query('SELECT count(*)::int n FROM public.project_cost_corrected_reviews')).rows[0].n).toBe(3);
 },15000);
});
