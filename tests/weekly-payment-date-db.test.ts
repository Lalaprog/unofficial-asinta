import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const id = (n:number) => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const [founder,supervisor,worker,project,pay,advance,request] = [1,2,3,4,5,6,7].map(id);
const sql=(path:string)=>readFileSync(path,'utf8');

async function setup(withGuard=true) {
 const db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
  CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.aal',true)='yes'$$;
  CREATE TABLE public.users(id uuid primary key,name text,email text,role text);
  CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT public.session_assurance_satisfied() AND EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder')$$;
  CREATE TABLE public.workers(id uuid primary key,name text,position text);
  CREATE TABLE public.attendance(worker_id uuid,date date,recorded_by uuid,notes text);
  CREATE TABLE public.advances(id uuid primary key default gen_random_uuid(),worker_id uuid,project_id uuid,amount numeric(10,2),amount_deducted numeric(10,2),reason text,date date,status text,created_at timestamptz default now());
  CREATE TABLE public.advance_requests(id uuid primary key,worker_id uuid,project_id uuid,requested_amount numeric(10,2),status text,issued_at timestamptz,issued_advance_id uuid unique);
  CREATE TABLE public.payroll(id uuid primary key,worker_id uuid,period_start date,period_end date,gross_pay numeric(10,2),bale_deduction numeric(10,2),other_deductions numeric(10,2),net_pay numeric(10,2),status text,days_worked numeric,hours_worked numeric,notes text);
  CREATE TABLE public.audit_log(actor_id uuid,actor_email text,action text,table_name text,record_id uuid,before_row jsonb,after_row jsonb);
  INSERT INTO public.users VALUES ('${founder}','Founder','founder@example.invalid','founder'),('${supervisor}','Supervisor','supervisor@example.invalid','supervisor');
  INSERT INTO public.workers VALUES ('${worker}','Worker','Mason');
  INSERT INTO public.payroll VALUES ('${pay}','${worker}','2024-11-03','2024-11-09',500,100.25,0,399.75,'draft',1,8,NULL);
  INSERT INTO public.advances(id,worker_id,project_id,amount,amount_deducted,reason,date,status) VALUES ('${advance}','${worker}','${project}',100.25,0,'Fixture','2024-11-06','active');
  INSERT INTO public.advance_requests VALUES ('${request}','${worker}','${project}',100.25,'issued','2024-11-06T04:00:00Z','${advance}');
  GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role;
  GRANT SELECT,INSERT,UPDATE,DELETE ON public.payroll,public.advances TO authenticated;`);
 await db.exec(sql('supabase/migrations/20261102000000_atomic_payroll_payments.sql'));
 if(withGuard) await db.exec(sql('supabase/drafts/guard_legacy_bale_payment.sql'));
 return db;
}
async function install(db:PGlite) { await db.exec(sql('supabase/drafts/weekly_payment_date.sql')); }
async function founderSession(db:PGlite) { await db.exec(`SET test.uid='${founder}'; SET test.aal='yes'; SET ROLE authenticated;`); }
const approve=(db:PGlite)=>db.query("SELECT public.set_payroll_status_atomic($1,'approved')",[pay]);
const record=(db:PGlite,date='2024-11-09')=>db.query<{result:{outcome:string;payment_date:string}}>('SELECT public.record_guarded_weekly_payment($1,$2) result',[pay,date]);

describe('draft atomic weekly payment date',()=>{
 it('fails installation without the prior guarded Bale transition',async()=>{
  const db=await setup(false);try{await expect(install(db)).rejects.toThrow(/guard is required/);}finally{await db.close();}
 },30000);
 it('records actual date, paid status and same-week Bale once in a single transaction',async()=>{
  const db=await setup();try{
   await install(db);await founderSession(db);await approve(db);
   expect((await record(db)).rows[0].result).toMatchObject({outcome:'updated',payment_date:'2024-11-09'});
   expect((await record(db)).rows[0].result.outcome).toBe('already_recorded');
   await expect(record(db,'2024-11-08')).rejects.toThrow(/differs/);
   expect((await db.query('SELECT payment_date::text,recorded_by FROM public.payroll_payment_dates')).rows).toEqual([{payment_date:'2024-11-09',recorded_by:founder}]);
   expect((await db.query('SELECT status,amount_deducted::text FROM public.advances')).rows).toEqual([{status:'fully_deducted',amount_deducted:'100.25'}]);
   await db.exec('RESET ROLE');expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.audit_log')).rows[0].n).toBe(3);
  }finally{await db.close();}
 },30000);
 it('rolls back payment and Bale if storing the date fails',async()=>{
  const db=await setup();try{
   await install(db);await db.exec(`CREATE FUNCTION public.reject_test_date() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic evidence failure'; END$$; CREATE TRIGGER reject_test BEFORE INSERT ON public.payroll_payment_dates FOR EACH ROW EXECUTE FUNCTION public.reject_test_date();`);
   await founderSession(db);await approve(db);await expect(record(db)).rejects.toThrow(/synthetic evidence failure/);
   expect((await db.query('SELECT status FROM public.payroll')).rows).toEqual([{status:'approved'}]);
   expect((await db.query('SELECT amount_deducted::text,status FROM public.advances')).rows).toEqual([{amount_deducted:'0.00',status:'active'}]);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.payroll_payment_dates')).rows[0].n).toBe(0);
  }finally{await db.close();}
 },30000);
 it('rejects undated old-client payment, direct writes, future dates and unauthorized callers',async()=>{
  const db=await setup();try{
   await install(db);await founderSession(db);await approve(db);
   await expect(db.query("SELECT public.set_payroll_status_atomic($1,'paid')",[pay])).rejects.toThrow(/actual date/);
   await expect(db.query("SELECT public.weekly_guarded_status_internal($1,'paid')",[pay])).rejects.toThrow(/permission denied/);
   await expect(db.query('INSERT INTO public.payroll_payment_dates(payroll_id,payment_date,recorded_by) VALUES ($1,$2,$3)',[pay,'2024-11-09',founder])).rejects.toThrow(/permission denied/);
   await expect(record(db,'9998-12-31')).rejects.toThrow(/future date/);
   await expect(record(db,'2024-11-05')).rejects.toThrow(/precedes a recorded Bale release/);
   await db.exec(`SET test.uid='${supervisor}'`);await expect(record(db)).rejects.toThrow(/Founder access/);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.payroll_payment_dates')).rows[0].n).toBe(0);
   await db.exec(`SET test.uid='${founder}'; SET test.aal='no'`);await expect(record(db)).rejects.toThrow(/Founder access/);
  }finally{await db.close();}
 },30000);
 it('does not carry older Bale or fabricate a date for existing paid history',async()=>{
  const db=await setup();try{
   await db.exec(`INSERT INTO public.advances(worker_id,project_id,amount,amount_deducted,reason,date,status) VALUES ('${worker}','${project}',15,0,'Old','2024-10-30','active');`);
   await install(db);await founderSession(db);await approve(db);await expect(record(db)).rejects.toThrow(/outside this period/);
   await db.exec('RESET ROLE');await db.exec(`UPDATE public.payroll SET status='paid' WHERE id='${pay}'`);
   await founderSession(db);await expect(record(db)).rejects.toThrow(/historical payments separately/);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.payroll_payment_dates')).rows[0].n).toBe(0);
  }finally{await db.close();}
 },30000);
 it('rejects non-weekly and possible Supervisor vouchers',async()=>{
  const db=await setup();try{
   await install(db);await db.exec(`UPDATE public.payroll SET period_end='2024-11-08' WHERE id='${pay}'`);await founderSession(db);await approve(db);
   await expect(record(db)).rejects.toThrow(/Sunday–Saturday/);
   await db.exec('RESET ROLE');await db.exec(`UPDATE public.payroll SET status='draft' WHERE id='${pay}'; UPDATE public.payroll SET period_end='2024-11-09' WHERE id='${pay}'; UPDATE public.workers SET position='Site Supervisor' WHERE id='${worker}'`);
   await founderSession(db);await approve(db);await expect(record(db)).rejects.toThrow(/Possible Supervisor/);
  }finally{await db.close();}
 },30000);
});
