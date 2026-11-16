// Opt-in: creates synthetic tables and rows in an EMPTY local disposable DB.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
const url=process.env.WEEKLY_PAYMENT_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const [founder,worker1,worker2,pay1,pay2,site]=[1,2,3,4,5,6].map(id);
const pause=()=>new Promise(resolve=>setTimeout(resolve,150));
let admin:Client,first:Client,second:Client;
const record=(client:Client,pay:string,date:string)=>client.query('SELECT public.record_guarded_weekly_payment($1,$2) result',[pay,date]);

suite('draft weekly payment date concurrency on disposable PostgreSQL',()=>{
 beforeAll(async()=>{
  const parsed=new URL(url!);
  if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||!parsed.pathname.slice(1).startsWith('asinta_test_')||parsed.search||parsed.hash)throw new Error('Use an empty local disposable database named asinta_test_* without URL options.');
  admin=new Client({connectionString:url});first=new Client({connectionString:url});second=new Client({connectionString:url});await Promise.all([admin.connect(),first.connect(),second.connect()]);
  const objects=(await admin.query(`SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S'))::int objects,(SELECT count(*) FROM pg_namespace WHERE nspname IN ('auth','app_private','storage'))::int schemas`)).rows[0];
  if(objects.objects||objects.schemas)throw new Error('Use an empty disposable database.');
  await admin.query(`DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END$$;
   CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
   CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.assurance',true)='yes'$$;
   CREATE TABLE public.users(id uuid primary key,name text,email text,role text);
   CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT public.session_assurance_satisfied() AND EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder')$$;
   CREATE TABLE public.workers(id uuid primary key,name text,position text);
   CREATE TABLE public.attendance(worker_id uuid,date date,recorded_by uuid,notes text);
   CREATE TABLE public.payroll(id uuid primary key,worker_id uuid,period_start date,period_end date,gross_pay numeric(10,2),bale_deduction numeric(10,2),other_deductions numeric(10,2),net_pay numeric(10,2),status text,days_worked numeric,hours_worked numeric,notes text);
   CREATE TABLE public.advances(id uuid primary key default gen_random_uuid(),worker_id uuid,project_id uuid,amount numeric(10,2),amount_deducted numeric(10,2),reason text,date date,status text,created_at timestamptz default now());
   CREATE TABLE public.advance_requests(id uuid primary key,worker_id uuid,project_id uuid,requested_amount numeric(10,2),status text,issued_at timestamptz,issued_advance_id uuid unique);
   CREATE TABLE public.audit_log(actor_id uuid,actor_email text,action text,table_name text,record_id uuid,before_row jsonb,after_row jsonb);
   INSERT INTO public.users VALUES ('${founder}','Founder','founder@example.invalid','founder');
   INSERT INTO public.workers VALUES ('${worker1}','Worker One','Mason'),('${worker2}','Worker Two','Mason');
   INSERT INTO public.payroll VALUES ('${pay1}','${worker1}','2024-11-03','2024-11-09',500,0,0,500,'draft',1,8,NULL),('${pay2}','${worker2}','2024-11-03','2024-11-09',500,0,0,500,'draft',1,8,NULL);
   GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role; GRANT SELECT,INSERT,UPDATE,DELETE ON public.payroll,public.advances TO authenticated;`);
  for(const path of ['supabase/migrations/20261102000000_atomic_payroll_payments.sql','supabase/drafts/guard_legacy_bale_payment.sql','supabase/drafts/weekly_payment_date.sql'])await admin.query(readFileSync(path,'utf8'));
  await Promise.all([first.query(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'; SET lock_timeout='4s'`),second.query(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'; SET lock_timeout='4s'`)]);
  await first.query("SELECT public.set_payroll_status_atomic($1,'approved'), public.set_payroll_status_atomic($2,'approved')",[pay1,pay2]);
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),first?.end(),second?.end()]);});
 it('serializes two payment recordings and rejects a conflicting date',async()=>{
  await first.query('BEGIN');await second.query('BEGIN');try{
   expect((await record(first,pay1,'2024-11-09')).rows[0].result.outcome).toBe('updated');
   let finished=false;const conflicting=record(second,pay1,'2024-11-08').then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{finished=true});
   await pause();expect(finished).toBe(false);await first.query('COMMIT');expect((await conflicting).code).toBe('22023');await second.query('ROLLBACK');
   expect((await record(second,pay1,'2024-11-09')).rows[0].result.outcome).toBe('already_recorded');
   expect((await admin.query('SELECT payment_date::text FROM public.payroll_payment_dates WHERE payroll_id=$1',[pay1])).rows).toEqual([{payment_date:'2024-11-09'}]);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('serializes late Bale creation against recording payment',async()=>{
  await first.query('BEGIN');await second.query('BEGIN');try{
   await record(first,pay2,'2024-11-09');let finished=false;
   const late=second.query("INSERT INTO public.advances(worker_id,project_id,amount,amount_deducted,reason,date,status) VALUES ($1,$2,50,0,'Late','2024-11-06','active')",[worker2,site]).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{finished=true});
   await pause();expect(finished).toBe(false);await first.query('COMMIT');expect((await late).code).toBe('22023');await second.query('ROLLBACK');
   expect((await admin.query<{n:number}>('SELECT count(*)::int n FROM public.advances WHERE worker_id=$1',[worker2])).rows[0].n).toBe(0);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
});
