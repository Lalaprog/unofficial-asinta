import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const founder='00000000-0000-0000-0000-000000000001',supervisor='00000000-0000-0000-0000-000000000002',site='00000000-0000-0000-0000-000000000003',other='00000000-0000-0000-0000-000000000004',worker='00000000-0000-0000-0000-000000000005';
const id=(n:number)=>`10000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
async function fixture(){
 const db=new PGlite();await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role; CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
 CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.assurance',true)='yes'$$;
 CREATE TABLE public.users(id uuid primary key,role text);INSERT INTO public.users VALUES('${founder}','founder'),('${supervisor}','supervisor');
 CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder')$$;
 CREATE TABLE public.projects(id uuid primary key);INSERT INTO public.projects VALUES('${site}'),('${other}');
 CREATE TABLE public.workers(id uuid primary key,name text);INSERT INTO public.workers VALUES('${worker}','Ada');
 CREATE TABLE public.payroll(id uuid primary key,worker_id uuid,period_start date,period_end date,status text,gross_pay numeric(10,2),hours_worked numeric(8,2));
 CREATE TABLE public.weekly_worker_draft_sources(payroll_id uuid primary key,worker_id uuid,period_start date,approved_by uuid,approved_at timestamptz,approval_xid bigint,payment_actor uuid,payment_xid bigint,calculation jsonb);
 CREATE TABLE public.payroll_payment_dates(payroll_id uuid primary key,payment_date date,recorded_by uuid);
 CREATE TABLE public.weekly_worker_paid_allocations(payroll_id uuid,project_id uuid,hours numeric(8,2),wage numeric(10,2),allowance numeric(10,2),gross numeric(10,2),primary key(payroll_id,project_id));
 GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
 INSERT INTO public.payroll SELECT md5(g::text)::uuid,'${worker}','2026-11-15','2026-11-21','paid',100.25,9 FROM generate_series(1,30) g;
 INSERT INTO public.weekly_worker_draft_sources SELECT id,worker_id,period_start,'${founder}',now(),NULL,'${founder}',NULL,'{"wage":"100.00","allowance":"0.25","gross":"100.25"}'::jsonb FROM public.payroll;
 INSERT INTO public.payroll_payment_dates SELECT id,'2026-11-21','${founder}' FROM public.payroll;
 INSERT INTO public.weekly_worker_paid_allocations SELECT id,'${site}',8,88.89,0.25,89.14 FROM public.payroll;
 INSERT INTO public.weekly_worker_paid_allocations SELECT id,'${other}',1,11.11,0,11.11 FROM public.payroll;`);
 await db.exec(readFileSync('supabase/drafts/project_paid_payroll_evidence.sql','utf8'));await db.exec(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);return db;
}
type Row={payroll_id:string;period_start:string;gross:string};type Page={project_id:string;items:Row[];has_more:boolean};
describe('experimental project paid payroll evidence',()=>{
 it('paginates paid weekly project allocations without mixing sites or double-counting a voucher',async()=>{
  const db=await fixture();try{const get=(week:string|null=null,cursor:string|null=null)=>db.query<{data:Page}>('SELECT public.project_paid_worker_evidence($1,$2,$3,25) data',[site,week,cursor]);
   const first=(await get()).rows[0].data;expect(first.items).toHaveLength(25);expect(first.has_more).toBe(true);expect(first.items[0]).toMatchObject({worker_name:'Ada',gross:'89.14',period_start:'2026-11-15',payment_date:'2026-11-21'});
   const last=first.items.at(-1)!;const second=(await get(last.period_start,last.payroll_id)).rows[0].data;expect(second.items).toHaveLength(5);expect(second.has_more).toBe(false);expect(new Set([...first.items,...second.items].map(x=>x.payroll_id)).size).toBe(30);
   const out=(await db.query<{data:Page}>('SELECT public.project_paid_worker_evidence($1) data',[other])).rows[0].data;expect(out.items[0].gross).toBe('11.11');
  }finally{await db.close();}
 },30000);
 it('requires Founder assurance, valid bounded cursor and a real project',async()=>{
  const db=await fixture();try{
   await expect(db.query('SELECT public.project_paid_worker_evidence($1,$2,$3)',[site,'2026-11-15',null])).rejects.toThrow(/Invalid/);
   await expect(db.query('SELECT public.project_paid_worker_evidence($1,$2,$3)',[site,'2026-11-16',id(1)])).rejects.toThrow(/Invalid/);
   await expect(db.query('SELECT public.project_paid_worker_evidence($1)',[id(2)])).rejects.toThrow(/unavailable/);
   await db.exec(`SET test.uid='${supervisor}'`);await expect(db.query('SELECT public.project_paid_worker_evidence($1)',[site])).rejects.toThrow(/Founder/);
   await db.exec(`SET test.uid='${founder}';SET test.assurance='no'`);await expect(db.query('SELECT public.project_paid_worker_evidence($1)',[site])).rejects.toThrow(/Founder/);
   await db.exec('RESET ROLE;SET ROLE anon');await expect(db.query('SELECT public.project_paid_worker_evidence($1)',[site])).rejects.toThrow(/permission denied/);
  }finally{await db.close();}
 },30000);
 it('fails the entire page on incomplete paid evidence or unreconciled cross-site amounts',async()=>{
  const db=await fixture();try{await db.exec('RESET ROLE');const payroll=(await db.query<{id:string}>('SELECT id FROM public.payroll ORDER BY id DESC LIMIT 1')).rows[0].id;
   for(const mutation of ["UPDATE public.payroll SET status='approved' WHERE id=$1","UPDATE public.weekly_worker_draft_sources SET approved_by=NULL WHERE payroll_id=$1","DELETE FROM public.payroll_payment_dates WHERE payroll_id=$1","UPDATE public.weekly_worker_paid_allocations SET gross=12 WHERE payroll_id=$1 AND project_id='"+other+"'"]){
    await db.exec('BEGIN');await db.query(mutation,[payroll]);await db.exec('SET LOCAL ROLE authenticated');await expect(db.query('SELECT public.project_paid_worker_evidence($1)',[site])).rejects.toThrow(/inconsistent/);await db.exec('ROLLBACK');
   }
  }finally{await db.close();}
 },30000);
});
