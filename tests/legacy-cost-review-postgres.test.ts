// Opt-in: disposable empty local PostgreSQL only. Synthetic sources.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
const url=process.env.LEGACY_COST_REVIEW_TEST_DATABASE_URL,suite=url?describe:describe.skip;
const founder='00000000-0000-0000-0000-000000000001',site='00000000-0000-0000-0000-000000000002';const id=(n:number)=>`ad000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let admin:Client,a:Client,b:Client;const choices={expenses:{},historical:{},corrections:{}};const json=JSON.stringify;
async function snapshot(c:Client){return (await c.query<{v:unknown}>('SELECT public.project_cost_legacy_voucher_inventory($1) v',[site])).rows[0].v;}
async function save(c:Client,r:string,rev:number,s:unknown){return (await c.query<{v:{revision:number;replayed:boolean}}>('SELECT public.record_project_cost_legacy_review($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,true) v',[r,site,rev,json(s),json(choices),'{}','Synthetic review'])).rows[0].v;}
async function waitForLock(c:Client){const name=c===a?'legacy-review-a':'legacy-review-b';const pid=(await admin.query<{pid:number}>('SELECT pid FROM pg_stat_activity WHERE application_name=$1',[name])).rows[0]?.pid;if(!pid)throw Error('Missing connection');for(let i=0;i<100;i++){if((await admin.query<{waiting:boolean}>("SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.waiting)return;await new Promise(r=>setTimeout(r,20));}throw Error('Expected lock wait');}
suite('legacy review writer serialization, synthetic PostgreSQL',()=>{
 beforeAll(async()=>{const u=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||!u.pathname.slice(1).startsWith('asinta_test_')||u.search||u.hash)throw Error('Use an empty local asinta_test_* database');
  admin=new Client({connectionString:url});a=new Client({connectionString:url});b=new Client({connectionString:url});await Promise.all([admin.connect(),a.connect(),b.connect()]);
  const existing=(await admin.query("SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S'))::int objects,(SELECT count(*) FROM pg_namespace WHERE nspname IN ('auth','app_private','storage'))::int schemas")).rows[0];if(existing.objects||existing.schemas)throw Error('Database must be empty');
  await admin.query(`DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END$$;
  CREATE SCHEMA auth;CREATE SCHEMA app_private;CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
  CREATE TABLE public.users(id uuid PRIMARY KEY,role text NOT NULL);INSERT INTO public.users VALUES('${founder}','founder');CREATE TABLE public.projects(id uuid PRIMARY KEY);INSERT INTO public.projects VALUES('${site}');
  CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.assurance',true)='yes'$$;CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder')$$;
  CREATE TABLE public.expenses(id int PRIMARY KEY,amount int);INSERT INTO public.expenses VALUES(1,100);
  CREATE TABLE public.workers(id uuid);CREATE TABLE public.supervisor_period_payroll(id uuid);CREATE TABLE public.historical_external_worker_payroll(id uuid);CREATE TABLE public.paid_period_assertion_cases(id uuid);CREATE TABLE public.paid_payroll_adjustment_cases(id uuid);CREATE TABLE public.confirmed_rental_expenses(id uuid);CREATE TABLE public.payroll(id uuid);CREATE TABLE public.weekly_worker_draft_sources(id uuid);CREATE TABLE public.weekly_worker_paid_allocations(id uuid);CREATE TABLE public.payroll_payment_dates(id uuid);CREATE TABLE public.historical_worker_attributions(id uuid);CREATE TABLE public.historical_worker_attribution_sites(id uuid);CREATE TABLE public.project_cost_correction_attributions(id uuid);CREATE TABLE public.project_cost_correction_sites(id uuid);CREATE TABLE public.legacy_paid_voucher_attributions(id uuid);CREATE TABLE public.legacy_paid_voucher_attribution_sites(id uuid);
  CREATE FUNCTION public.project_cost_legacy_voucher_inventory(p uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$SELECT jsonb_build_object('project_id',p,'base',jsonb_build_object('historical_review',jsonb_build_object('base',jsonb_build_object('captured_at',statement_timestamp(),'amount',(SELECT amount FROM public.expenses WHERE id=1)))))$$;
  CREATE FUNCTION public.project_cost_legacy_voucher_preview(p uuid,s jsonb,c jsonb,l jsonb,ack boolean) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$SELECT jsonb_build_object('incomplete',true,'total',s->'base'->'historical_review'->'base'->'amount')$$;
  GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role;GRANT SELECT,UPDATE ON public.expenses TO authenticated;`);
  await admin.query(`BEGIN;${readFileSync('supabase/drafts/project_cost_legacy_review_ledger.sql','utf8')} COMMIT;`);
  await a.query("SET application_name='legacy-review-a'");await b.query("SET application_name='legacy-review-b'");for(const c of [a,b])await c.query(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),a?.end(),b?.end()]);});
 it('waits for an expense change and rejects the stale snapshot',async()=>{const s=await snapshot(a);await admin.query('BEGIN');try{await admin.query('UPDATE public.expenses SET amount=101 WHERE id=1');const waiting=save(a,id(1),0,s).then(()=>null,e=>e);await waitForLock(a);await admin.query('COMMIT');expect(await waiting).toMatchObject({code:'40001'});}finally{await admin.query('ROLLBACK');}expect((await admin.query('SELECT count(*)::int n FROM public.project_cost_legacy_reviews')).rows[0].n).toBe(0);},15000);
 it('serializes identical retries and later marks the saved evidence stale',async()=>{const s=await snapshot(a);await a.query('BEGIN');try{expect(await save(a,id(2),0,s)).toMatchObject({revision:1,replayed:false});const waiting=save(b,id(2),0,s);await waitForLock(b);await a.query('COMMIT');expect(await waiting).toMatchObject({revision:1,replayed:true});}finally{await a.query('ROLLBACK');}
  await a.query('BEGIN');try{await save(a,id(3),1,await snapshot(a));const waiting=b.query('UPDATE public.expenses SET amount=102 WHERE id=1');await waitForLock(b);await a.query('COMMIT');await waiting;}finally{await a.query('ROLLBACK');}
  expect((await b.query<{v:{freshness:string}}>('SELECT public.project_cost_legacy_review($1,NULL) v',[site])).rows[0].v.freshness).toBe('changed');expect((await admin.query('SELECT count(*)::int n FROM public.project_cost_legacy_reviews')).rows[0].n).toBe(2);
 },15000);
 it('serializes the legacy attribution leading table locks in both directions',async()=>{
  // The legacy attribution writer takes these five locks before changing its
  // evidence. Exercise its actual lock order, not an unlocked mock writer.
  const leading='LOCK TABLE public.users,public.workers,public.projects,public.advances,public.payroll IN SHARE ROW EXCLUSIVE MODE';
  await admin.query('CREATE TABLE public.advances(id uuid)');
  const s=await snapshot(a);await a.query('BEGIN');await b.query('RESET ROLE');
  try{await save(a,id(4),2,s);await b.query('BEGIN');const waiting=b.query(leading);await waitForLock(b);await a.query('COMMIT');await waiting;await b.query('COMMIT');}finally{await a.query('ROLLBACK');await b.query('ROLLBACK');await b.query('SET ROLE authenticated');}
  const before=await snapshot(a);await b.query('RESET ROLE');await b.query('BEGIN');
  try{await b.query(leading);await b.query('UPDATE public.expenses SET amount=103 WHERE id=1');const waiting=save(a,id(5),3,before).then(()=>null,e=>e);await waitForLock(a);await b.query('COMMIT');expect(await waiting).toMatchObject({code:'40001'});}finally{await b.query('ROLLBACK');await b.query('SET ROLE authenticated');}
  expect((await admin.query('SELECT count(*)::int n FROM public.project_cost_legacy_reviews')).rows[0].n).toBe(3);
 },15000);
});
