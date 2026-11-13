import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
import {buildWeeklyPreview,parseWeeklyInput} from '@/lib/payroll/weeklyPreview';
import {parseWeeklyDraftDetails} from '@/lib/payroll/weeklyDraftDetails';
const id=(n:number)=>`10000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const founder='00000000-0000-0000-0000-000000000001',supervisor='00000000-0000-0000-0000-000000000002',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004',other='00000000-0000-0000-0000-000000000005';
const [att1,att2,detail,allowance,advance,request,voucher]=[1,2,3,4,5,6,7].map(id);
const start='2024-11-03';
const sql=(path:string)=>readFileSync(path,'utf8');
async function fixture(withApproval=false,withPayment=false){
 const db=new PGlite();
 await db.exec(baseFixture);
 await db.exec(`ALTER TABLE public.users ADD COLUMN email text;
  UPDATE public.users SET email='fixture@example.invalid';
  ALTER TABLE public.payroll ADD COLUMN notes text;
  ALTER TABLE public.advances ADD COLUMN reason text;
  ALTER TABLE public.advances ADD COLUMN created_at timestamptz DEFAULT now();
  UPDATE public.workers SET pay_rate=655.55 WHERE id='${worker}';
  INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at) VALUES
   ('${att1}','${worker}','${site}','2024-11-03','present',8,'2024-11-03T08:00:00Z'),
   ('${att2}','${worker}','${site}','2024-11-04','half_day',4,'2024-11-04T08:00:00Z');`);
 for(const name of ['20261102000000_atomic_payroll_payments.sql','20261113000000_weekly_worker_preview.sql','20261113000001_attendance_time_detail.sql','20261113000002_worker_allowances.sql','20261113000003_weekly_payroll_context.sql'])
  await db.exec(sql(`supabase/migrations/${name}`));
 await db.exec(`INSERT INTO public.attendance_time_details(request_id,attendance_id,worker_id,project_id,attendance_date,attendance_status,attendance_hours,attendance_submitted_at,regular_hours,overtime_hours,note,recorded_by)
  VALUES ('${detail}','${att1}','${worker}','${site}','2024-11-03','present',8,'2024-11-03T08:00:00Z',8,2,'OT','${founder}');
  INSERT INTO public.worker_allowances(id,attendance_id,worker_id,project_id,attendance_date,attendance_status,attendance_hours,attendance_submitted_at,amount,description,status,submitted_by,reviewed_by,reviewed_at)
  VALUES ('${allowance}','${att1}','${worker}','${site}','2024-11-03','present',8,'2024-11-03T08:00:00Z',50.25,'Meals','approved','${founder}','${founder}',now());
  INSERT INTO public.advances(id,worker_id,project_id,date,amount,amount_deducted,status,reason) VALUES ('${advance}','${worker}','${site}','2024-11-06',500.50,0,'active','Bale');
  INSERT INTO public.advance_requests(id,worker_id,project_id,requested_amount,status,issued_at,issued_advance_id,submitted_by) VALUES ('${request}','${worker}','${site}',500.50,'issued','2024-11-06T04:00:00Z','${advance}','${supervisor}');`);
 // This synthetic fixture models the relevant audit columns, not a hosted clone.
 await db.exec('DROP TABLE public.audit_log; CREATE TABLE public.audit_log(actor_id uuid,actor_email text,action text,table_name text,record_id uuid,before_row jsonb,after_row jsonb); CREATE POLICY test_founder_payroll_write ON public.payroll FOR ALL TO authenticated USING (public.is_founder()) WITH CHECK (public.is_founder());');
 if(withPayment){
  await db.exec(sql('supabase/drafts/guard_legacy_bale_payment.sql'));
  await db.exec(sql('supabase/drafts/weekly_payment_date.sql'));
 }
 await db.exec(sql('supabase/drafts/weekly_worker_generator.sql'));
 if(withApproval||withPayment) await db.exec(sql('supabase/drafts/weekly_worker_approval.sql'));
 if(withPayment){await db.exec(sql('supabase/drafts/weekly_worker_paid_allocation.sql'));await db.exec(sql('supabase/drafts/weekly_worker_draft_details.sql'));}
 await db.exec(`SET test.uid='${founder}'; SET test.assurance='yes'; SET ROLE authenticated;`);
 return db;
}
const generate=(db:PGlite,key=voucher)=>db.query<{result:{payroll_id:string;replayed:boolean;calculation:Record<string,unknown>}}>('SELECT public.create_weekly_worker_draft($1,$2,$3) result',[key,worker,start]);

describe('server-calculated weekly source-bound draft (not payable)',()=>{
 it('creates a centavo-exact Sun–Sat draft from real preview migrations and matches the client preview',async()=>{
  const db=await fixture();try{
   const raw=(await db.query<{data:unknown}>('SELECT public.weekly_worker_preview_inputs($1) data',[start])).rows[0].data;
   const preview=buildWeeklyPreview(parseWeeklyInput(raw,start),'2024-11-05').rows.find(r=>r.worker.id===worker)!;
   const result=(await generate(db)).rows[0].result;expect(result).toMatchObject({payroll_id:voucher,replayed:false,calculation:{wage:'1147.21',allowance:'50.25',gross:'1197.46',bale:'500.50',net:'696.96',unmarked_dates:['2024-11-05','2024-11-06','2024-11-07','2024-11-08','2024-11-09']}});
   expect(result.calculation).toMatchObject({wage:preview.wage,allowance:preview.allowance,gross:preview.gross,bale:preview.bale,net:preview.net});
   expect((await db.query('SELECT gross_pay::text,bale_deduction::text,net_pay::text,status,days_worked::text,hours_worked::text FROM public.payroll WHERE id=$1',[voucher])).rows).toEqual([{gross_pay:'1197.46',bale_deduction:'500.50',net_pay:'696.96',status:'draft',days_worked:'1.50',hours_worked:'14.00'}]);
   expect((await generate(db)).rows[0].result.replayed).toBe(true);
   await expect(generate(db,id(8))).rejects.toThrow(/existing overlapping voucher|existing voucher or weekly draft/);
   await db.exec('RESET ROLE');expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.audit_log WHERE table_name=\'payroll\'')).rows[0].n).toBe(1);
   const source=(await db.query<{source_snapshot:{attendance:unknown[];allowances:unknown[];advances:unknown[]}}>('SELECT source_snapshot FROM public.weekly_worker_draft_sources WHERE payroll_id=$1',[voucher])).rows[0].source_snapshot;
   expect(source.attendance).toHaveLength(2);expect(source.allowances).toHaveLength(1);expect(source.advances).toHaveLength(1);
  }finally{await db.close();}
 },30000);
 it('freezes the draft against old client edits, approval, payment and deletion',async()=>{
  const db=await fixture();try{await generate(db);
   await expect(db.query('UPDATE public.payroll SET gross_pay=1 WHERE id=$1',[voucher])).rejects.toThrow(/frozen/);
   await expect(db.query("SELECT public.set_payroll_status_atomic($1,'approved')",[voucher])).rejects.toThrow(/frozen/);
   await expect(db.query('DELETE FROM public.payroll WHERE id=$1',[voucher])).rejects.toThrow(/frozen/);
   expect((await db.query('SELECT status FROM public.payroll WHERE id=$1',[voucher])).rows).toEqual([{status:'draft'}]);
  }finally{await db.close();}
 },30000);
 it('refuses stale or pending allowance without writing a voucher',async()=>{
  const db=await fixture();try{
   await db.exec('RESET ROLE');await db.query("UPDATE public.worker_allowances SET status='pending',reviewed_by=NULL,reviewed_at=NULL WHERE id=$1",[allowance]);await db.exec('SET ROLE authenticated');
   await expect(generate(db)).rejects.toThrow(/Pending or stale allowance/);
   await db.exec('RESET ROLE');await db.query("UPDATE public.worker_allowances SET status='approved',reviewed_by=$2,reviewed_at=now() WHERE id=$1",[allowance,founder]);
   await db.query('UPDATE public.attendance SET submitted_at=now() WHERE id=$1',[att1]);await db.exec('SET ROLE authenticated');
   await expect(generate(db)).rejects.toThrow(/Stale time details|Pending or stale allowance/);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.payroll WHERE id=$1',[voucher])).rows[0].n).toBe(0);
  }finally{await db.close();}
 },30000);
 it('refuses excess, old or unlinked Bale instead of carrying it into another week',async()=>{
  const db=await fixture();try{
   await db.exec('RESET ROLE');await db.query('UPDATE public.advances SET amount=2000 WHERE id=$1',[advance]);await db.query('UPDATE public.advance_requests SET requested_amount=2000 WHERE id=$1',[request]);await db.exec('SET ROLE authenticated');
   await expect(generate(db)).rejects.toThrow(/Bale exceeds earnings/);
   await db.exec('RESET ROLE');await db.query("UPDATE public.advances SET date='2024-10-30',amount=500.50 WHERE id=$1",[advance]);await db.exec('SET ROLE authenticated');
   await expect(generate(db)).rejects.toThrow(/Older outstanding Bale/);
   await db.exec('RESET ROLE');await db.query("UPDATE public.advances SET date='2024-11-06' WHERE id=$1",[advance]);await db.exec('SET ROLE authenticated');
   await expect(generate(db)).rejects.toThrow(/Bale release/);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.payroll WHERE id=$1',[voucher])).rows[0].n).toBe(0);
  }finally{await db.close();}
 },30000);
 it('blocks duplicate-day attendance, overlapping historical payroll, non-Founders and lost assurance',async()=>{
  const db=await fixture();try{
   await db.exec('RESET ROLE');await db.query("INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at) VALUES($1,$2,$3,'2024-11-03','present',8,now())",[id(8),worker,site]);await db.exec('SET ROLE authenticated');
   await expect(generate(db)).rejects.toThrow(/Conflicting attendance/);
   await db.exec('RESET ROLE');await db.query('DELETE FROM public.attendance WHERE id=$1',[id(8)]);
   await db.exec("SET test.uid=''");
   await db.query("INSERT INTO public.payroll(id,worker_id,period_start,period_end,status,gross_pay,bale_deduction,other_deductions,net_pay) VALUES($1,$2,'2024-11-01','2024-11-04','paid',1,0,0,1)",[id(9),worker]);await db.exec(`SET test.uid='${founder}'; SET ROLE authenticated`);
   await expect(generate(db)).rejects.toThrow(/overlapping voucher/);
   await db.exec(`SET test.uid='${supervisor}'`);await expect(generate(db)).rejects.toThrow(/Founder access/);
   await db.exec(`SET test.uid='${founder}'; SET test.assurance='no'`);await expect(generate(db)).rejects.toThrow(/Founder access/);
  }finally{await db.close();}
 },30000);
 it('calculates hourly rates with centavos and permits explicitly marked zero-work weeks',async()=>{
  let db=await fixture();try{
   await db.exec('RESET ROLE');await db.query("UPDATE public.workers SET pay_rate=100.05,pay_rate_type='hourly' WHERE id=$1",[worker]);await db.exec('SET ROLE authenticated');
   const result=(await generate(db)).rows[0].result;
   expect(result.calculation).toMatchObject({wage:'1400.70',allowance:'50.25',gross:'1450.95',bale:'500.50',net:'950.45'});
  }finally{await db.close();}
  db=await fixture();try{
   await db.exec('RESET ROLE');await db.exec(`DELETE FROM public.attendance_time_details; DELETE FROM public.worker_allowances; DELETE FROM public.advance_requests WHERE id='${request}'; DELETE FROM public.advances WHERE id='${advance}'; UPDATE public.attendance SET status='absent',hours_worked=0 WHERE id IN ('${att1}','${att2}'); SET ROLE authenticated;`);
   const result=(await generate(db)).rows[0].result;
   expect(result.calculation).toMatchObject({wage:'0.00',gross:'0.00',net:'0.00'});
   expect((result.calculation.unmarked_dates as string[])).toHaveLength(5);
  }finally{await db.close();}
 },30000);
 it('will not turn an entirely unmarked week into a zero voucher',async()=>{
  const db=await fixture();try{await db.exec('RESET ROLE');await db.exec(`DELETE FROM public.attendance_time_details; DELETE FROM public.worker_allowances; DELETE FROM public.attendance WHERE id IN ('${att1}','${att2}'); SET ROLE authenticated;`);await expect(generate(db)).rejects.toThrow(/unmarked does not mean absent/);}finally{await db.close();}
 },30000);
 it('does not silently merge possible duplicate allowances or Bale records',async()=>{
  const db=await fixture();try{
   await db.exec('RESET ROLE');await db.query("INSERT INTO public.worker_allowances(id,attendance_id,worker_id,project_id,attendance_date,attendance_status,attendance_hours,attendance_submitted_at,amount,description,status,submitted_by,reviewed_by,reviewed_at) SELECT $1,attendance_id,worker_id,project_id,attendance_date,attendance_status,attendance_hours,attendance_submitted_at,amount,' meals ',status,submitted_by,reviewed_by,reviewed_at FROM public.worker_allowances WHERE id=$2",[id(8),allowance]);await db.exec('SET ROLE authenticated');
   await expect(generate(db)).rejects.toThrow(/duplicate allowance/);
   await db.exec('RESET ROLE');await db.query('DELETE FROM public.worker_allowances WHERE id=$1',[id(8)]);
   await db.query("INSERT INTO public.advances(id,worker_id,project_id,date,amount,amount_deducted,status,reason) SELECT $1,worker_id,project_id,date,amount,amount_deducted,status,reason FROM public.advances WHERE id=$2",[id(8),advance]);
   await db.query("INSERT INTO public.advance_requests(id,worker_id,project_id,requested_amount,status,issued_at,issued_advance_id,submitted_by) SELECT $1,worker_id,project_id,requested_amount,status,issued_at,$2,submitted_by FROM public.advance_requests WHERE id=$3",[id(9),id(8),request]);await db.exec('SET ROLE authenticated');
   await expect(generate(db)).rejects.toThrow(/duplicate Bale/);
  }finally{await db.close();}
 },30000);
 it('approves an unchanged source-bound draft only through the new guarded action, without paying',async()=>{
  const db=await fixture(true);try{
   await generate(db);await expect(db.query("SELECT public.set_payroll_status_atomic($1,'approved')",[voucher])).rejects.toThrow(/frozen/);
   const result=await db.query<{result:{outcome:string}}>('SELECT public.approve_weekly_worker_draft($1) result',[voucher]);expect(result.rows[0].result.outcome).toBe('updated');
   expect((await db.query<{result:{outcome:string}}>('SELECT public.approve_weekly_worker_draft($1) result',[voucher])).rows[0].result.outcome).toBe('already_approved');
   await expect(db.query("SELECT public.set_payroll_status_atomic($1,'paid')",[voucher])).rejects.toThrow(/frozen/);
   expect((await db.query('SELECT status FROM public.payroll WHERE id=$1',[voucher])).rows).toEqual([{status:'approved'}]);
   await db.exec('RESET ROLE');expect((await db.query('SELECT approved_by,approval_xid FROM public.weekly_worker_draft_sources WHERE payroll_id=$1',[voucher])).rows).toEqual([{approved_by:founder,approval_xid:null}]);
   expect((await db.query('SELECT status,amount_deducted::text FROM public.advances WHERE id=$1',[advance])).rows).toEqual([{status:'active',amount_deducted:'0.00'}]);
  }finally{await db.close();}
 },30000);
 it('refuses approval when legacy attendance or the worker rate changes after generation',async()=>{
  let db=await fixture(true);try{
   await generate(db);await db.exec('RESET ROLE');await db.query('UPDATE public.attendance SET hours_worked=7 WHERE id=$1',[att1]);await db.exec('SET ROLE authenticated');
   await expect(db.query('SELECT public.approve_weekly_worker_draft($1)',[voucher])).rejects.toThrow(/source data changed/);
   expect((await db.query('SELECT status FROM public.payroll WHERE id=$1',[voucher])).rows).toEqual([{status:'draft'}]);
  }finally{await db.close();}
  db=await fixture(true);try{
   await generate(db);await db.exec('RESET ROLE');await db.query('UPDATE public.workers SET pay_rate=700 WHERE id=$1',[worker]);await db.exec('SET ROLE authenticated');
   await expect(db.query('SELECT public.approve_weekly_worker_draft($1)',[voucher])).rejects.toThrow(/source data changed/);
  }finally{await db.close();}
 },30000);
 it('refuses approval after a newly marked day or an altered allowance',async()=>{
  let db=await fixture(true);try{
   await generate(db);await db.exec('RESET ROLE');await db.query("INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at) VALUES($1,$2,$3,'2024-11-05','present',8,now())",[id(9),worker,site]);await db.exec('SET ROLE authenticated');
   await expect(db.query('SELECT public.approve_weekly_worker_draft($1)',[voucher])).rejects.toThrow(/source data changed/);
  }finally{await db.close();}
  db=await fixture(true);try{
   await generate(db);await db.exec('RESET ROLE');await db.query('UPDATE public.worker_allowances SET amount=51 WHERE id=$1',[allowance]);await db.exec('SET ROLE authenticated');
   await expect(db.query('SELECT public.approve_weekly_worker_draft($1)',[voucher])).rejects.toThrow(/source data changed/);
  }finally{await db.close();}
 },30000);
 it('denies approval to Supervisors and sessions without assurance',async()=>{
  const db=await fixture(true);try{
   await generate(db);await db.exec(`SET test.uid='${supervisor}'`);await expect(db.query('SELECT public.approve_weekly_worker_draft($1)',[voucher])).rejects.toThrow(/Founder access/);
   await db.exec(`SET test.uid='${founder}'; SET test.assurance='no'`);await expect(db.query('SELECT public.approve_weekly_worker_draft($1)',[voucher])).rejects.toThrow(/Founder access/);
  }finally{await db.close();}
 },30000);
 it('blocks overlapping vouchers and new out-of-period Bale before approval',async()=>{
  let db=await fixture(true);try{
   await generate(db);await db.exec('RESET ROLE');await db.exec("SET test.uid=''");
   await db.query("INSERT INTO public.payroll(id,worker_id,period_start,period_end,status,gross_pay,bale_deduction,other_deductions,net_pay) VALUES($1,$2,'2024-11-01','2024-11-04','paid',1,0,0,1)",[id(9),worker]);await db.exec(`SET test.uid='${founder}'; SET ROLE authenticated`);
   await expect(db.query('SELECT public.approve_weekly_worker_draft($1)',[voucher])).rejects.toThrow(/overlapping voucher/);
  }finally{await db.close();}
  db=await fixture(true);try{
   await generate(db);await db.exec('RESET ROLE');await db.query("INSERT INTO public.advances(id,worker_id,project_id,date,amount,amount_deducted,status,reason) VALUES($1,$2,$3,'2024-10-30',10,0,'active','Old')",[id(9),worker,site]);await db.exec('SET ROLE authenticated');
   await expect(db.query('SELECT public.approve_weekly_worker_draft($1)',[voucher])).rejects.toThrow(/outside the period/);
  }finally{await db.close();}
 },30000);
 it('does not allow clients to forge approval markers or leave them behind when approval audit fails',async()=>{
  const db=await fixture(true);try{
   await generate(db);
   await expect(db.query('UPDATE public.weekly_worker_draft_sources SET approval_xid=txid_current(),approved_by=$1,approved_at=now() WHERE payroll_id=$2',[founder,voucher])).rejects.toThrow(/permission denied/);
   await db.exec('RESET ROLE');await db.exec("CREATE FUNCTION public.reject_approval_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'approval audit failed'; END$$; CREATE TRIGGER reject_approval_audit BEFORE INSERT ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.reject_approval_audit(); SET ROLE authenticated;");
   await expect(db.query('SELECT public.approve_weekly_worker_draft($1)',[voucher])).rejects.toThrow(/approval audit failed/);
   expect((await db.query('SELECT status FROM public.payroll WHERE id=$1',[voucher])).rows).toEqual([{status:'draft'}]);
   await db.exec('RESET ROLE');expect((await db.query('SELECT approved_by,approval_xid FROM public.weekly_worker_draft_sources WHERE payroll_id=$1',[voucher])).rows).toEqual([{approved_by:null,approval_xid:null}]);
  }finally{await db.close();}
 },30000);
 it('rolls back both the draft and source evidence if audit storage fails',async()=>{
  const db=await fixture();try{
   await db.exec("RESET ROLE; CREATE FUNCTION public.reject_generator_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'audit failed'; END$$; CREATE TRIGGER reject_generator_audit BEFORE INSERT ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.reject_generator_audit(); SET ROLE authenticated;");
   await expect(generate(db)).rejects.toThrow(/audit failed/);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.payroll WHERE id=$1',[voucher])).rows[0].n).toBe(0);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.weekly_worker_draft_sources WHERE payroll_id=$1',[voucher])).rows[0].n).toBe(0);
  }finally{await db.close();}
 },30000);
});

const approve=(db:PGlite)=>db.query('SELECT public.approve_weekly_worker_draft($1)',[voucher]);
const pay=(db:PGlite,date='2024-11-09')=>db.query<{result:{outcome:string;payment_date:string}}>('SELECT public.record_weekly_worker_payment($1,$2) result',[voucher,date]);
describe('integrated weekly payment and gross site allocations (draft)',()=>{
 it('atomically records one external payment, same-week Bale and centavo-exact moved-worker allocations',async()=>{
  const db=await fixture(true,true);try{
   await db.exec('RESET ROLE');await db.query('UPDATE public.attendance SET project_id=$2 WHERE id=$1',[att2,other]);await db.exec('SET ROLE authenticated');
   const expensesBefore=(await db.query('SELECT * FROM public.expenses ORDER BY id')).rows;
   const raw=(await db.query<{data:unknown}>('SELECT public.weekly_worker_preview_inputs($1) data',[start])).rows[0].data;
   const expected=buildWeeklyPreview(parseWeeklyInput(raw,start),'2024-11-05').rows.find(r=>r.worker.id===worker)!.projectEstimates;
   await generate(db);
   const getDetails=async()=>parseWeeklyDraftDetails((await db.query<{result:unknown}>('SELECT public.weekly_worker_draft_details($1) result',[voucher])).rows[0].result,{id:voucher,worker,start});
   expect((await getDetails()).status).toBe('draft');await approve(db);expect((await getDetails()).status).toBe('approved');
   expect((await pay(db)).rows[0].result).toMatchObject({outcome:'updated',payment_date:'2024-11-09'});
   expect(await getDetails()).toMatchObject({status:'paid',payment_date:'2024-11-09',allocations:[{project_id:site,gross:'869.69'},{project_id:other,gross:'327.77'}]});
   expect((await db.query('SELECT project_id,hours::text,wage::text,allowance::text,gross::text FROM public.weekly_worker_paid_allocations ORDER BY project_id')).rows).toEqual([
    {project_id:site,hours:'10.00',wage:'819.44',allowance:'50.25',gross:'869.69'},
    {project_id:other,hours:'4.00',wage:'327.77',allowance:'0.00',gross:'327.77'}]);
   const costs=(await db.query<{project_id:string;wage:string;allowance:string;gross:string}>('SELECT project_id,wage::text,allowance::text,gross::text FROM public.weekly_worker_paid_allocations ORDER BY project_id')).rows;
   expect(costs.map(c=>({projectId:c.project_id,wage:c.wage,allowance:c.allowance,gross:c.gross}))).toEqual(expected);
   expect((await db.query('SELECT status,amount_deducted::text FROM public.advances WHERE id=$1',[advance])).rows).toEqual([{status:'fully_deducted',amount_deducted:'500.50'}]);
   expect((await db.query('SELECT payment_date::text,recorded_by FROM public.payroll_payment_dates WHERE payroll_id=$1',[voucher])).rows).toEqual([{payment_date:'2024-11-09',recorded_by:founder}]);
   expect((await pay(db)).rows[0].result.outcome).toBe('already_recorded');await expect(pay(db,'2024-11-08')).rejects.toThrow(/differs/);
   expect((await db.query('SELECT * FROM public.expenses ORDER BY id')).rows).toEqual(expensesBefore);
   await db.exec(`SET test.uid='${supervisor}'`);expect((await db.query('SELECT * FROM public.weekly_worker_paid_allocations')).rows).toEqual([]);
   await expect(db.query('SELECT public.weekly_worker_draft_details($1)',[voucher])).rejects.toThrow(/Founder access/);
   await db.exec(`SET test.uid='${founder}'; SET test.assurance='no'`);expect((await db.query('SELECT * FROM public.weekly_worker_paid_allocations')).rows).toEqual([]);
   await expect(db.query('SELECT public.weekly_worker_draft_details($1)',[voucher])).rejects.toThrow(/Founder access/);
   await db.exec('RESET ROLE');expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.weekly_worker_paid_allocations WHERE payroll_id=$1',[voucher])).rows[0].n).toBe(2);
   expect((await db.query('SELECT payment_actor,payment_xid FROM public.weekly_worker_draft_sources WHERE payroll_id=$1',[voucher])).rows).toEqual([{payment_actor:founder,payment_xid:null}]);
   await expect(db.query('UPDATE public.weekly_worker_paid_allocations SET gross=0 WHERE payroll_id=$1',[voucher])).rejects.toThrow(/immutable/);
  }finally{await db.close();}
 },30000);
 it('refuses old-client payment, direct allocation writes, future dates and unauthorized payment',async()=>{
  const db=await fixture(true,true);try{
   await generate(db);await approve(db);
   await expect(db.query("SELECT public.set_payroll_status_atomic($1,'paid')",[voucher])).rejects.toThrow(/actual date/);
   await expect(db.query('SELECT public.weekly_payment_date_internal($1,$2)',[voucher,'2024-11-09'])).rejects.toThrow(/permission denied/);
   await expect(db.query('INSERT INTO public.weekly_worker_paid_allocations(payroll_id,project_id,hours,wage,allowance,gross) VALUES($1,$2,1,1,0,1)',[voucher,site])).rejects.toThrow(/permission denied/);
   await expect(pay(db,'9998-12-31')).rejects.toThrow(/future date/);
   await expect(pay(db,'2024-11-05')).rejects.toThrow(/precedes a recorded Bale/);
   await db.exec(`SET test.uid='${supervisor}'`);await expect(pay(db)).rejects.toThrow(/Founder access/);
   await db.exec(`SET test.uid='${founder}'; SET test.assurance='no'`);await expect(pay(db)).rejects.toThrow(/Founder access/);
   await db.exec(`SET test.assurance='yes'`);expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.weekly_worker_paid_allocations WHERE payroll_id=$1',[voucher])).rows[0].n).toBe(0);
  }finally{await db.close();}
 },30000);
 it('blocks payment if source data changed after approval without mutating Bale or costs',async()=>{
  const db=await fixture(true,true);try{
   await generate(db);await approve(db);await db.exec('RESET ROLE');await db.query('UPDATE public.attendance SET hours_worked=7 WHERE id=$1',[att1]);await db.exec('SET ROLE authenticated');
   await expect(pay(db)).rejects.toThrow(/source data changed since approval/);
   expect((await db.query('SELECT status FROM public.payroll WHERE id=$1',[voucher])).rows).toEqual([{status:'approved'}]);
   expect((await db.query('SELECT status,amount_deducted::text FROM public.advances WHERE id=$1',[advance])).rows).toEqual([{status:'active',amount_deducted:'0.00'}]);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.weekly_worker_paid_allocations WHERE payroll_id=$1',[voucher])).rows[0].n).toBe(0);
  }finally{await db.close();}
 },30000);
 it('rolls back allocations, payment and Bale when the date insert fails',async()=>{
  const db=await fixture(true,true);try{
   await generate(db);await approve(db);
   await db.exec("RESET ROLE; CREATE FUNCTION public.reject_date() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'date storage failure'; END$$; CREATE TRIGGER reject_date BEFORE INSERT ON public.payroll_payment_dates FOR EACH ROW EXECUTE FUNCTION public.reject_date(); SET ROLE authenticated;");
   await expect(pay(db)).rejects.toThrow(/date storage failure/);
   expect((await db.query('SELECT status FROM public.payroll WHERE id=$1',[voucher])).rows).toEqual([{status:'approved'}]);
   expect((await db.query('SELECT status,amount_deducted::text FROM public.advances WHERE id=$1',[advance])).rows).toEqual([{status:'active',amount_deducted:'0.00'}]);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.weekly_worker_paid_allocations WHERE payroll_id=$1',[voucher])).rows[0].n).toBe(0);
   await db.exec('RESET ROLE');expect((await db.query('SELECT payment_actor,payment_xid FROM public.weekly_worker_draft_sources WHERE payroll_id=$1',[voucher])).rows).toEqual([{payment_actor:null,payment_xid:null}]);
  }finally{await db.close();}
 },30000);
 it('allocates an indivisible centavo deterministically to the lower site ID',async()=>{
  const db=await fixture(true,true);try{
   await db.exec('RESET ROLE');await db.exec(`DELETE FROM public.attendance_time_details; DELETE FROM public.worker_allowances; DELETE FROM public.advance_requests WHERE id='${request}'; DELETE FROM public.advances WHERE id='${advance}'; UPDATE public.workers SET pay_rate=0.04 WHERE id='${worker}'; UPDATE public.attendance SET hours_worked=1 WHERE id IN ('${att1}','${att2}'); UPDATE public.attendance SET project_id='${other}' WHERE id='${att2}'; SET ROLE authenticated;`);
   await generate(db);await approve(db);await pay(db);
   expect((await db.query('SELECT project_id,wage::text,gross::text FROM public.weekly_worker_paid_allocations WHERE payroll_id=$1 ORDER BY project_id',[voucher])).rows).toEqual([
    {project_id:site,wage:'0.01',gross:'0.01'},{project_id:other,wage:'0.00',gross:'0.00'}]);
  }finally{await db.close();}
 },30000);
 it('records a zero-work zero-pay week without inventing a project allocation',async()=>{
  const db=await fixture(true,true);try{
   await db.exec('RESET ROLE');await db.exec(`DELETE FROM public.attendance_time_details; DELETE FROM public.worker_allowances; DELETE FROM public.advance_requests WHERE id='${request}'; DELETE FROM public.advances WHERE id='${advance}'; UPDATE public.attendance SET status='absent',hours_worked=0 WHERE id IN ('${att1}','${att2}'); SET ROLE authenticated;`);
   await generate(db);await approve(db);expect((await pay(db)).rows[0].result.outcome).toBe('updated');
   const details=parseWeeklyDraftDetails((await db.query<{result:unknown}>('SELECT public.weekly_worker_draft_details($1) result',[voucher])).rows[0].result,{id:voucher,worker,start});expect(details).toMatchObject({status:'paid',gross:'0.00',allocations:[]});
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.weekly_worker_paid_allocations WHERE payroll_id=$1',[voucher])).rows[0].n).toBe(0);
   expect((await pay(db)).rows[0].result.outcome).toBe('already_recorded');
  }finally{await db.close();}
 },30000);
});
