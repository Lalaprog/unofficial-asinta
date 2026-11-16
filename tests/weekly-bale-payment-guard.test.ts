import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const founder=id(1),supervisor=id(2),worker=id(3),project=id(4),pay=id(5);
type Advance={id:string;date?:string;amount?:string;deducted?:string;status?:string;linked?:boolean;issuedAt?:string};
async function fixture({advances=[],deduction='0',net,otherVoucher=false}:{advances?:Advance[];deduction?:string;net?:string;otherVoucher?:boolean}={}){
 const db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
  CREATE TABLE public.users(id uuid primary key,email text,role text);
  CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder')$$;
  CREATE TABLE public.workers(id uuid primary key);
  CREATE TABLE public.advances(id uuid primary key default gen_random_uuid(),worker_id uuid,project_id uuid,amount numeric(10,2),amount_deducted numeric(10,2),reason text,date date,status text,created_at timestamptz default now());
  CREATE TABLE public.advance_requests(id uuid primary key,worker_id uuid,project_id uuid,requested_amount numeric(10,2),status text,issued_at timestamptz,issued_advance_id uuid unique);
  CREATE TABLE public.payroll(id uuid primary key,worker_id uuid,period_start date,period_end date,gross_pay numeric(10,2),bale_deduction numeric(10,2),other_deductions numeric(10,2),net_pay numeric(10,2),status text,days_worked numeric,hours_worked numeric,notes text);
  CREATE TABLE public.audit_log(actor_id uuid,actor_email text,action text,table_name text,record_id uuid,before_row jsonb,after_row jsonb);
  INSERT INTO public.users VALUES ('${founder}','founder@example.invalid','founder'),('${supervisor}','sup@example.invalid','supervisor'); INSERT INTO public.workers VALUES ('${worker}');
  GRANT USAGE ON SCHEMA public,auth TO authenticated,service_role; GRANT SELECT,INSERT,UPDATE,DELETE ON public.payroll,public.advances TO authenticated;`);
 await db.query('INSERT INTO public.payroll VALUES ($1,$2,$3,$4,500,$5,0,$6,$7,NULL,NULL,NULL)',[pay,worker,'2026-11-01','2026-11-07',deduction,net??(500-Number(deduction)).toFixed(2),'draft']);
 if(otherVoucher)await db.query('INSERT INTO public.payroll VALUES ($1,$2,$3,$4,500,0,0,500,$5,NULL,NULL,NULL)',[id(20),worker,'2026-11-01','2026-11-07','paid']);
 for(const a of advances){
  const date=a.date??'2026-11-04',amount=a.amount??'100.25';
  await db.query('INSERT INTO public.advances(id,worker_id,project_id,amount,amount_deducted,reason,date,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[a.id,worker,project,amount,a.deducted??'0','Fixture',date,a.status??'active']);
  if(a.linked)await db.query('INSERT INTO public.advance_requests VALUES($1,$2,$3,$4,$5,$6,$7)',[id(100+Number(a.id.slice(-2))),worker,project,amount,'issued',a.issuedAt??`${date}T04:00:00Z`,a.id]);
 }
 await db.exec(readFileSync('supabase/migrations/20261102000000_atomic_payroll_payments.sql','utf8'));
 await db.exec(readFileSync('supabase/drafts/guard_legacy_bale_payment.sql','utf8'));
 await db.exec(`SET test.uid='${founder}'; SET ROLE authenticated;`);
 const transition=(status:string)=>db.query<{data:{outcome:string}}>('SELECT public.set_payroll_status_atomic($1,$2) data',[pay,status]);
 return {db,transition};
}
const release=(n:number,overrides:Partial<Advance>={}):Advance=>({id:id(n),linked:true,...overrides});
describe('legacy paid-transition Bale safety gate (draft)',()=>{
 it('atomically consumes a complete same-week linked Wednesday release, and paid retry is harmless',async()=>{
  const {db,transition}=await fixture({advances:[release(10)],deduction:'100.25'});try{
   await transition('approved');expect((await transition('paid')).rows[0].data.outcome).toBe('updated');expect((await transition('paid')).rows[0].data.outcome).toBe('already_paid');
   expect((await db.query<{amount_deducted:string;status:string}>('SELECT amount_deducted,status FROM public.advances')).rows[0]).toEqual({amount_deducted:'100.25',status:'fully_deducted'});
   await db.exec('RESET ROLE');expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.audit_log')).rows[0].n).toBe(3);
  }finally{await db.close();}
 },30000);
 it('does not carry older outstanding Bale and rolls back the attempted payment',async()=>{
  const {db,transition}=await fixture({advances:[release(10),release(11,{date:'2026-10-28'})],deduction:'100.25'});try{
   await transition('approved');await expect(transition('paid')).rejects.toThrow(/outside this period/);
   expect((await db.query<{status:string}>('SELECT status FROM public.payroll WHERE id=$1',[pay])).rows[0].status).toBe('approved');expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.advances WHERE amount_deducted<>0')).rows[0].n).toBe(0);
  }finally{await db.close();}
 },30000);
 it('permits a zero-Bale voucher without carrying an older balance',async()=>{
  const {db,transition}=await fixture({advances:[release(11,{date:'2026-10-28'})]});try{await transition('approved');await transition('paid');expect((await db.query<{amount_deducted:string}>('SELECT amount_deducted FROM public.advances')).rows[0].amount_deducted).toBe('0.00');}finally{await db.close();}
 },30000);
 it.each([
  ['unlinked', [release(10,{linked:false})], '100.25', /release, date or previous deduction/],
  ['wrong release weekday', [release(10,{date:'2026-11-03'})], '100.25', /release, date or previous deduction/],
  ['already partially deducted', [release(10,{deducted:'1',status:'partially_deducted'})], '100.25', /release, date or previous deduction/],
  ['duplicate release', [release(10),release(11)], '200.50', /duplicate Bale/],
  ['partial voucher deduction', [release(10)], '50', /does not match all recorded releases/],
  ['zero deduction despite release', [release(10)], '0', /does not match all recorded releases/],
 ] as [string,Advance[],string,RegExp][] )('blocks %s without touching the ledger',async(_label,advances,deduction,error)=>{
  const {db,transition}=await fixture({advances,deduction});try{await transition('approved');await expect(transition('paid')).rejects.toThrow(error);expect((await db.query<{status:string}>('SELECT status FROM public.payroll WHERE id=$1',[pay])).rows[0].status).toBe('approved');}finally{await db.close();}
 },30000);
 it('blocks overlapping paid vouchers and inconsistent totals',async()=>{
  let setup=await fixture({otherVoucher:true});try{await setup.transition('approved');await expect(setup.transition('paid')).rejects.toThrow(/overlaps/);}finally{await setup.db.close();}
  setup=await fixture({net:'499.99'});try{await setup.transition('approved');await expect(setup.transition('paid')).rejects.toThrow(/totals need review/);}finally{await setup.db.close();}
 },30000);
 it('blocks later client advances for approved/paid payroll and hides the unchecked function',async()=>{
  const {db,transition}=await fixture();try{
   await transition('approved');await expect(db.query("INSERT INTO public.advances(worker_id,project_id,amount,amount_deducted,reason,date,status) VALUES($1,$2,10,0,'Late','2026-11-04','active')",[worker,project])).rejects.toThrow(/separate correction/);
   await expect(db.query("SELECT public.legacy_set_payroll_status_atomic_unchecked($1,'paid')",[pay])).rejects.toThrow(/permission denied/);
   await transition('paid');await expect(db.query("INSERT INTO public.advances(worker_id,project_id,amount,amount_deducted,reason,date,status) VALUES($1,$2,10,0,'Late','2026-11-04','active')",[worker,project])).rejects.toThrow(/separate correction/);
   await db.exec(`SET test.uid='${supervisor}'`);await expect(transition('paid')).rejects.toThrow(/Founder access/);
  }finally{await db.close();}
 },30000);
});
