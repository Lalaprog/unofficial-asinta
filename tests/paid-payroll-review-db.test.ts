import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {parsePaidReview,paidReviewSignals} from '@/lib/payroll/paidReview';
const migration=readFileSync('supabase/migrations/20261114000002_paid_payroll_review.sql','utf8');
const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const [founder,supervisor,worker]=[1,2,3].map(id);
async function fixture(){
 const db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
 CREATE TABLE public.users(id uuid primary key,role text);
 CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT current_setting('test.assurance',true)='yes' AND EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder')$$;
 CREATE TABLE public.workers(id uuid primary key,name text);
 CREATE TABLE public.payroll(id uuid primary key,worker_id uuid,period_start date,period_end date,gross_pay numeric(10,2),bale_deduction numeric(10,2),other_deductions numeric(10,2),net_pay numeric(10,2),status text);
 CREATE TABLE public.advances(id uuid primary key,worker_id uuid,date date,amount numeric(10,2),amount_deducted numeric(10,2),status text);
 CREATE TABLE public.advance_requests(id uuid primary key,worker_id uuid,issued_advance_id uuid,status text);
 INSERT INTO public.users VALUES ('${founder}','founder'),('${supervisor}','supervisor'); INSERT INTO public.workers VALUES ('${worker}','Fixture Worker');
 INSERT INTO public.payroll VALUES ('${id(5)}','${worker}','2026-10-25','2026-10-31',1000,100.25,0,899.75,'paid'),('${id(6)}','${worker}','2026-10-31','2026-11-06',200,0,0,200,'paid'),('${id(7)}','${worker}','2026-11-07','2026-11-13',200,0,0,200,'draft');
 INSERT INTO public.advances VALUES ('${id(8)}','${worker}','2026-10-28',100.25,100.25,'fully_deducted'),('${id(9)}','${worker}','2026-10-29',5.25,0,'active'),('${id(10)}','${worker}','2026-10-29',99,0,'cancelled');
 INSERT INTO public.advance_requests VALUES ('${id(11)}','${worker}','${id(8)}','issued');
 ALTER TABLE public.workers ENABLE ROW LEVEL SECURITY; ALTER TABLE public.payroll ENABLE ROW LEVEL SECURITY; ALTER TABLE public.advances ENABLE ROW LEVEL SECURITY; ALTER TABLE public.advance_requests ENABLE ROW LEVEL SECURITY;
 CREATE POLICY founder_worker ON public.workers FOR SELECT TO authenticated USING(public.is_founder()); CREATE POLICY founder_pay ON public.payroll FOR SELECT TO authenticated USING(public.is_founder()); CREATE POLICY founder_adv ON public.advances FOR SELECT TO authenticated USING(public.is_founder()); CREATE POLICY founder_req ON public.advance_requests FOR SELECT TO authenticated USING(public.is_founder());
 GRANT USAGE ON SCHEMA public,auth TO authenticated,anon; GRANT SELECT ON public.workers,public.payroll,public.advances,public.advance_requests TO authenticated;`);
 await db.exec(migration);await db.exec(`SET test.uid='${founder}'; SET test.assurance='yes'; SET ROLE authenticated;`);
 return db;
}
describe('paid payroll review',()=>{
 it('returns scoped signals without rewriting paid vouchers or advance balances',async()=>{
  const db=await fixture();try{
   const value=(await db.query<{data:unknown}>("SELECT public.paid_payroll_review('2026-10-25','2026-10-30') data")).rows[0].data;
   const parsed=parsePaidReview(value,'2026-10-25','2026-10-30');expect(parsed.vouchers).toHaveLength(1);
   expect(parsed.vouchers[0]).toMatchObject({id:id(5),worker_name:'Fixture Worker',overlapping_paid:true,period_bale_total:'105.50',period_bale_count:2,unlinked_period_bale_count:1});
   expect(paidReviewSignals(parsed.vouchers[0])).toHaveLength(3);
   const amounts=await db.query<{status:string;net_pay:string}>("SELECT status,net_pay FROM public.payroll WHERE id=$1",[id(5)]);expect(amounts.rows[0]).toEqual({status:'paid',net_pay:'899.75'});
   expect((await db.query<{amount_deducted:string}>("SELECT amount_deducted FROM public.advances WHERE id=$1",[id(8)])).rows[0].amount_deducted).toBe('100.25');
  }finally{await db.close();}
 },30000);
 it('fails rather than silently truncating a review with more than 500 vouchers',async()=>{
  const db=await fixture();try{
   await db.exec(`RESET ROLE; INSERT INTO public.payroll SELECT md5(n::text)::uuid,'${worker}','2026-10-25','2026-10-31',100,0,0,100,'paid' FROM generate_series(1000,1500) n; SET ROLE authenticated;`);
   await expect(db.query("SELECT public.paid_payroll_review('2026-10-25','2026-10-30')")).rejects.toThrow(/Too many paid vouchers/);
  }finally{await db.close();}
 },30000);
 it('requires Founder assurance, denies anon, bounds ranges and returns an honest empty result',async()=>{
  const db=await fixture();try{
   expect(parsePaidReview((await db.query<{data:unknown}>("SELECT public.paid_payroll_review('2020-01-01','2020-01-10') data")).rows[0].data,'2020-01-01','2020-01-10').vouchers).toEqual([]);
   await expect(db.query("SELECT public.paid_payroll_review('2026-01-01','2026-04-04')")).rejects.toThrow(/93 calendar days/);
   await expect(db.query("SELECT public.paid_payroll_review('2026-04-01','2026-01-01')")).rejects.toThrow(/valid review range/);
   await db.exec(`SET test.assurance='no'`);await expect(db.query("SELECT public.paid_payroll_review('2026-10-25','2026-10-30')")).rejects.toThrow(/Founder access/);
   await db.exec(`SET test.assurance='yes'; SET test.uid='${supervisor}'`);await expect(db.query("SELECT public.paid_payroll_review('2026-10-25','2026-10-30')")).rejects.toThrow(/Founder access/);
   await db.exec('RESET ROLE; SET ROLE anon');await expect(db.query("SELECT public.paid_payroll_review('2026-10-25','2026-10-30')")).rejects.toThrow(/permission denied/);
  }finally{await db.close();}
 },30000);
});
