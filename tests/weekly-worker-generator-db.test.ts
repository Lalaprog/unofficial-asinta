import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
import {buildWeeklyPreview,parseWeeklyInput} from '@/lib/payroll/weeklyPreview';
import {parseWeeklyDraftDetails} from '@/lib/payroll/weeklyDraftDetails';
import {historicalArguments,parseHistoricalAttempt,verifyHistoricalResult} from '@/lib/payroll/historicalEntry';
const id=(n:number)=>`10000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const founder='00000000-0000-0000-0000-000000000001',supervisor='00000000-0000-0000-0000-000000000002',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004',other='00000000-0000-0000-0000-000000000005';
const [att1,att2,detail,allowance,advance,request,voucher]=[1,2,3,4,5,6,7].map(id);
const start='2024-11-03';
const sql=(path:string)=>readFileSync(path,'utf8');
async function fixture(withApproval=false,withPayment=false,withRefresh=false,withReturn=false,withHistorical=false,withHistoricalBale=false,withHistoricalReview=false){
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
 if(withPayment){await db.exec(sql('supabase/drafts/weekly_worker_paid_allocation.sql'));await db.exec(sql('supabase/drafts/weekly_worker_draft_details.sql'));await db.exec(sql('supabase/drafts/project_paid_payroll_evidence.sql'));}
 if(withRefresh) await db.exec(sql('supabase/drafts/weekly_worker_draft_refresh.sql'));
 if(withReturn) await db.exec(sql('supabase/drafts/weekly_worker_return_to_draft.sql'));
 if(withHistorical) await db.exec(sql('supabase/drafts/historical_paid_date_annotation.sql'));
 if(withHistoricalBale) await db.exec(sql('supabase/drafts/historical_settled_bale_evidence.sql'));
 if(withHistoricalReview) await db.exec(sql('supabase/drafts/historical_finance_evidence_review.sql'));
 await db.exec(`SET test.uid='${founder}'; SET test.assurance='yes'; SET ROLE authenticated;`);
 return db;
}
const generate=(db:PGlite,key=voucher)=>db.query<{result:{payroll_id:string;replayed:boolean;calculation:Record<string,unknown>}}>('SELECT public.create_weekly_worker_draft($1,$2,$3) result',[key,worker,start]);

describe('server-calculated weekly source-bound draft (not payable)',()=>{
 it('creates a centavo-exact Sun–Sat draft from real preview migrations and matches the client preview',async()=>{
  const db=await fixture();try{
   const raw=(await db.query<{data:unknown}>('SELECT public.weekly_worker_preview_inputs($1) data',[start])).rows[0].data;
   const preview=buildWeeklyPreview(parseWeeklyInput(raw,start),'2024-11-09').rows.find(r=>r.worker.id===worker)!;
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
 it('blocks future-dated inputs using Philippine server date while allowing incomplete current weeks',async()=>{
  const db=await fixture(true,true);try{
   await db.exec(`RESET ROLE; DELETE FROM public.attendance_time_details; DELETE FROM public.worker_allowances; DELETE FROM public.advance_requests WHERE id='${request}'; DELETE FROM public.advances WHERE id='${advance}'; DELETE FROM public.attendance WHERE id='${att2}';`);
   const future=(await db.query<{start:string}>("SELECT ((statement_timestamp() AT TIME ZONE 'Asia/Manila')::date + (7-extract(dow FROM (statement_timestamp() AT TIME ZONE 'Asia/Manila')::date))::int)::text start")).rows[0].start;
   await db.query('UPDATE public.attendance SET date=$1 WHERE id=$2',[future,att1]);await db.exec('SET ROLE authenticated');
   await expect(db.query('SELECT public.create_weekly_worker_draft($1,$2,$3)',[voucher,worker,future])).rejects.toThrow(/Future-dated/);
   await db.exec('RESET ROLE');expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.payroll WHERE id=$1',[voucher])).rows[0].n).toBe(0);
   const today=(await db.query<{today_date:string}>("SELECT (statement_timestamp() AT TIME ZONE 'Asia/Manila')::date::text today_date")).rows[0].today_date;
   const current=(await db.query<{start:string}>("SELECT ((statement_timestamp() AT TIME ZONE 'Asia/Manila')::date - extract(dow FROM (statement_timestamp() AT TIME ZONE 'Asia/Manila')::date)::int)::text start")).rows[0].start;
   await db.query('UPDATE public.attendance SET date=$1 WHERE id=$2',[today,att1]);await db.exec('SET ROLE authenticated');
   const result=await db.query<{result:{calculation:{unmarked_dates:string[]}}}>('SELECT public.create_weekly_worker_draft($1,$2,$3) result',[voucher,worker,current]);expect(result.rows[0].result.calculation.unmarked_dates).toHaveLength(6);
  }finally{await db.close();}
 },30000);
 it('blocks future evidence in previously saved drafts at approval and payment without changing voucher state',async()=>{
  const db=await fixture(true,true);try{
   await generate(db);await db.exec('RESET ROLE');await db.query("UPDATE public.weekly_worker_draft_sources SET source_snapshot=jsonb_set(source_snapshot,'{attendance,0,record,date}',to_jsonb(((statement_timestamp() AT TIME ZONE 'Asia/Manila')::date+1)::text)) WHERE payroll_id=$1",[voucher]);await db.exec('SET ROLE authenticated');
   await expect(db.query('SELECT public.approve_weekly_worker_draft($1)',[voucher])).rejects.toThrow(/Future-dated/);
   await db.exec('RESET ROLE');await db.query("UPDATE public.weekly_worker_draft_sources SET source_snapshot=jsonb_set(source_snapshot,'{attendance,0,record,date}',to_jsonb('2024-11-03'::text)) WHERE payroll_id=$1",[voucher]);await db.exec('SET ROLE authenticated');await db.query('SELECT public.approve_weekly_worker_draft($1)',[voucher]);
   await db.exec('RESET ROLE');await db.query("UPDATE public.weekly_worker_draft_sources SET source_snapshot=jsonb_set(source_snapshot,'{attendance,0,record,date}',to_jsonb(((statement_timestamp() AT TIME ZONE 'Asia/Manila')::date+1)::text)) WHERE payroll_id=$1",[voucher]);await db.exec('SET ROLE authenticated');
   await expect(db.query('SELECT public.record_weekly_worker_payment($1,$2)',[voucher,'2024-11-09'])).rejects.toThrow(/Future-dated/);
   expect((await db.query('SELECT status FROM public.payroll WHERE id=$1',[voucher])).rows[0]).toEqual({status:'approved'});
  }finally{await db.close();}
 },30000);
 it('recognizes future source records without treating today or rejected/cancelled items as future payable work',async()=>{
  const db=await fixture();try{
   await expect(db.query('SELECT public.weekly_worker_source_has_future($1,$2)',[{},'2026-11-18'])).rejects.toThrow(/permission denied/);await db.exec('RESET ROLE');
   const check=(source:object)=>db.query<{v:boolean}>('SELECT public.weekly_worker_source_has_future($1,$2) v',[source,'2026-11-18']);
   const base={attendance:[{record:{date:'2026-11-18'}}],allowances:[{status:'rejected',attendance_date:'2026-11-20'}],advances:[{advance:{status:'cancelled',date:'2026-11-20'}}]};
   expect((await check(base)).rows[0].v).toBe(false);
   expect((await check({...base,attendance:[{record:{date:'2026-11-19'}}]})).rows[0].v).toBe(true);
   expect((await check({...base,allowances:[{status:'approved',attendance_date:'2026-11-19'}]})).rows[0].v).toBe(true);
   expect((await check({...base,advances:[{advance:{status:'active',date:'2026-11-19'}}]})).rows[0].v).toBe(true);
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
 it('fails a paid retry when allocation hours or approval markers are inconsistent',async()=>{
  const db=await fixture(true,true);try{
   await generate(db);await approve(db);await pay(db);
   await db.exec('RESET ROLE; ALTER TABLE public.weekly_worker_paid_allocations DISABLE TRIGGER guard_weekly_paid_allocation_immutable');
   await db.query('UPDATE public.weekly_worker_paid_allocations SET hours=hours+1 WHERE payroll_id=$1',[voucher]);
   await db.exec('ALTER TABLE public.weekly_worker_paid_allocations ENABLE TRIGGER guard_weekly_paid_allocation_immutable; SET ROLE authenticated');
   await expect(pay(db)).rejects.toThrow(/allocation is incomplete/);
   await db.exec('RESET ROLE; ALTER TABLE public.weekly_worker_paid_allocations DISABLE TRIGGER guard_weekly_paid_allocation_immutable');
   await db.query('UPDATE public.weekly_worker_paid_allocations SET hours=hours-1 WHERE payroll_id=$1',[voucher]);
   await db.exec('ALTER TABLE public.weekly_worker_paid_allocations ENABLE TRIGGER guard_weekly_paid_allocation_immutable');
   await db.query('UPDATE public.weekly_worker_draft_sources SET approval_xid=123 WHERE payroll_id=$1',[voucher]);
   await db.exec('SET ROLE authenticated');await expect(pay(db)).rejects.toThrow(/allocation is incomplete/);
   await db.exec('RESET ROLE');await db.query('UPDATE public.weekly_worker_draft_sources SET approval_xid=NULL WHERE payroll_id=$1',[voucher]);await db.exec('SET ROLE authenticated');
   expect((await pay(db)).rows[0].result.outcome).toBe('already_recorded');
  }finally{await db.close();}
 },30000);
 it('atomically records one external payment, same-week Bale and centavo-exact moved-worker allocations',async()=>{
  const db=await fixture(true,true);try{
   await db.exec('RESET ROLE');await db.query('UPDATE public.attendance SET project_id=$2 WHERE id=$1',[att2,other]);await db.exec('SET ROLE authenticated');
   const expensesBefore=(await db.query('SELECT * FROM public.expenses ORDER BY id')).rows;
   const raw=(await db.query<{data:unknown}>('SELECT public.weekly_worker_preview_inputs($1) data',[start])).rows[0].data;
   const expected=buildWeeklyPreview(parseWeeklyInput(raw,start),'2024-11-09').rows.find(r=>r.worker.id===worker)!.projectEstimates;
   await generate(db);
   const getDetails=async()=>parseWeeklyDraftDetails((await db.query<{result:unknown}>('SELECT public.weekly_worker_draft_details($1) result',[voucher])).rows[0].result,{id:voucher,worker,start});
   expect((await getDetails()).status).toBe('draft');await approve(db);expect((await getDetails()).status).toBe('approved');
   expect((await db.query<{data:{items:unknown[]}}>('SELECT public.project_paid_worker_evidence($1) data',[site])).rows[0].data.items).toEqual([]);
   expect((await pay(db)).rows[0].result).toMatchObject({outcome:'updated',payment_date:'2024-11-09'});
   expect((await db.query<{data:{items:unknown[]}}>('SELECT public.project_paid_worker_evidence($1) data',[site])).rows[0].data.items).toEqual([expect.objectContaining({payroll_id:voucher,gross:'869.69',payment_date:'2024-11-09'})]);
   expect((await db.query<{data:{items:unknown[]}}>('SELECT public.project_paid_worker_evidence($1) data',[other])).rows[0].data.items).toEqual([expect.objectContaining({payroll_id:voucher,gross:'327.77'})]);
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
 it('connects a controlled Wednesday Bale release to full same-week payroll deduction',async()=>{
  const db=await fixture(true,true);try{
   await db.exec(`RESET ROLE; DELETE FROM public.advance_requests WHERE id='${request}'; DELETE FROM public.advances WHERE id='${advance}';
    ALTER TABLE public.advances ALTER COLUMN id SET DEFAULT gen_random_uuid();
    ALTER TABLE public.advance_requests ADD COLUMN approved_by uuid, ADD COLUMN approved_at timestamptz, ADD COLUMN rejected_by uuid, ADD COLUMN rejected_at timestamptz, ADD COLUMN issued_by uuid, ADD COLUMN updated_at timestamptz DEFAULT now();
    CREATE TABLE public.project_worker_assignments(project_id uuid,worker_id uuid,active boolean,primary key(project_id,worker_id)); INSERT INTO public.project_worker_assignments VALUES('${site}','${worker}',true);`);
   await db.exec(sql('supabase/migrations/20261013000000_advance_requests.sql'));
   await db.exec(sql('supabase/migrations/20261013000001_advance_request_notifications.sql'));
   await db.exec(sql('supabase/migrations/20261113000004_bale_request_site_guard.sql'));
   await db.exec(sql('supabase/drafts/weekly_bale_schedule.sql'));
   await db.exec(`CREATE OR REPLACE FUNCTION public.weekly_bale_clock() RETURNS timestamptz LANGUAGE sql VOLATILE SET search_path='' AS $$SELECT current_setting('test.clock')::timestamptz$$;
    SET test.clock='2024-11-03T04:00:00Z'; SET test.uid='${supervisor}'; SET ROLE authenticated;`);
   const req=(await db.query<{id:string}>('INSERT INTO public.advance_requests(worker_id,project_id,requested_amount,submitted_by) VALUES($1,$2,500.50,$3) RETURNING id',[worker,site,supervisor])).rows[0].id;
   await db.exec(`SET test.uid='${founder}'; SET test.clock='2024-11-05T04:00:00Z'`);await db.query("SELECT public.review_advance_request($1,'approve')",[req]);
   await db.exec(`SET test.uid='${supervisor}'; SET test.clock='2024-11-06T04:00:00Z'`);
   const release=(await db.query<{result:{advance_id:string}}>('SELECT public.record_weekly_bale_release($1) result',[req])).rows[0].result;
   await db.exec(`SET test.uid='${founder}'`);const calculation=(await generate(db)).rows[0].result.calculation;expect(calculation).toMatchObject({bale:'500.50',gross:'1197.46',net:'696.96'});
   await approve(db);await pay(db);expect((await db.query('SELECT status,amount_deducted::text FROM public.advances WHERE id=$1',[release.advance_id])).rows).toEqual([{status:'fully_deducted',amount_deducted:'500.50'}]);
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


describe('uninstalled revision-bound weekly draft refresh',()=>{
 const refresh=(db:PGlite,requestId=id(30),revision=0)=>db.query<{result:{replayed:boolean;revision:number;calculation:{gross:string}}}>('SELECT public.refresh_weekly_worker_draft($1,$2,$3) result',[requestId,voucher,revision]);
 const approve=(db:PGlite,revision:number)=>db.query('SELECT public.approve_weekly_worker_draft($1,$2)',[voucher,revision]);
 it('recalculates a late Saturday record, saves both snapshots and requires review of the new revision',async()=>{
  const db=await fixture(true,true,true);try{
   await generate(db);
   expect((await db.query<{d:{draft_revision:number}}>('SELECT public.weekly_worker_draft_details($1) d',[voucher])).rows[0].d.draft_revision).toBe(0);
   await db.exec('RESET ROLE');await db.query("INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at) VALUES($1,$2,$3,'2024-11-09','present',8,now())",[id(31),worker,site]);await db.exec('SET ROLE authenticated');
   await expect(approve(db,0)).rejects.toThrow(/source data changed/);
   const result=(await refresh(db)).rows[0].result;expect(result).toMatchObject({replayed:false,revision:1,calculation:{gross:'1853.01'}});
   expect((await refresh(db)).rows[0].result).toMatchObject({replayed:true,revision:1,calculation:{gross:'1853.01'}});
   await expect(refresh(db,id(32),0)).rejects.toThrow(/revision changed/);
   await expect(refresh(db,id(30),1)).rejects.toThrow(/request ID/);
   await expect(db.query('SELECT public.approve_weekly_worker_draft($1)',[voucher])).rejects.toThrow();
   await expect(db.query('SELECT public.weekly_worker_approval_internal($1)',[voucher])).rejects.toThrow(/permission denied/);
   await expect(approve(db,0)).rejects.toThrow(/revision changed/);
   expect((await db.query<{d:{draft_revision:number;gross:string}}>('SELECT public.weekly_worker_draft_details($1) d',[voucher])).rows[0].d).toMatchObject({draft_revision:1,gross:'1853.01'});
   expect((await db.query<{before_calculation:{gross:string};after_calculation:{gross:string};before_sources:{attendance:unknown[]};after_sources:{attendance:unknown[]}}>('SELECT before_calculation,after_calculation,before_sources,after_sources FROM public.weekly_worker_draft_refreshes WHERE request_id=$1',[id(30)])).rows[0]).toMatchObject({before_calculation:{gross:'1197.46'},after_calculation:{gross:'1853.01'},before_sources:{attendance:[expect.anything(),expect.anything()]},after_sources:{attendance:[expect.anything(),expect.anything(),expect.anything()]}});
   expect((await refresh(db,id(33),1)).rows[0].result).toMatchObject({replayed:false,revision:2});
   expect((await refresh(db)).rows[0].result).toMatchObject({replayed:true,revision:1});
   await expect(approve(db,1)).rejects.toThrow(/revision changed/);await approve(db,2);await expect(refresh(db,id(34),2)).rejects.toThrow(/unapproved, unpaid/);expect((await refresh(db)).rows[0].result.replayed).toBe(true);
   await db.query('SELECT public.record_weekly_worker_payment($1,$2)',[voucher,'2024-11-09']);await expect(refresh(db,id(35),2)).rejects.toThrow(/unapproved, unpaid/);
   await expect(db.query('UPDATE public.weekly_worker_draft_refreshes SET expected_revision=9 WHERE request_id=$1',[id(30)])).rejects.toThrow(/permission denied/);
   await db.exec('RESET ROLE');await expect(db.query('DELETE FROM public.weekly_worker_draft_refreshes WHERE request_id=$1',[id(30)])).rejects.toThrow(/immutable/);
  }finally{await db.close();}
 },30000);
 it('rolls back the refresh, history and revision when audit fails and rejects unsafe inputs and roles',async()=>{
  const db=await fixture(true,true,true);try{
   await generate(db);await db.exec('RESET ROLE');await db.query("UPDATE public.worker_allowances SET status='pending',reviewed_by=NULL,reviewed_at=NULL WHERE id=$1",[allowance]);await db.exec('SET ROLE authenticated');
   await expect(refresh(db)).rejects.toThrow(/Pending or stale allowance/);
   await db.exec('RESET ROLE');await db.query("UPDATE public.worker_allowances SET status='approved',reviewed_by=$2,reviewed_at=now() WHERE id=$1",[allowance,founder]);await db.exec(`SET test.uid='${supervisor}'; SET ROLE authenticated`);
   await expect(refresh(db)).rejects.toThrow(/Founder access/);await db.exec(`SET test.uid='${founder}'; SET test.assurance='no'`);await expect(refresh(db)).rejects.toThrow(/Founder access/);
   await db.exec("SET test.assurance='yes'; RESET ROLE; ALTER TABLE public.audit_log ADD CONSTRAINT deny_update CHECK (action <> 'update'); SET ROLE authenticated");
   await expect(refresh(db)).rejects.toThrow(/deny_update/);await db.exec('RESET ROLE');
   expect((await db.query('SELECT draft_revision,refresh_xid,refresh_actor FROM public.weekly_worker_draft_sources WHERE payroll_id=$1',[voucher])).rows).toEqual([{draft_revision:0,refresh_xid:null,refresh_actor:null}]);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.weekly_worker_draft_refreshes')).rows[0].n).toBe(0);
   expect((await db.query<{gross:string}>('SELECT gross_pay::text gross FROM public.payroll WHERE id=$1',[voucher])).rows[0].gross).toBe('1197.46');
  }finally{await db.close();}
 },30000);
});


describe('approved but not paid return candidate',()=>{
 const back=(db:PGlite,requestId=id(40),rev=0,reason='Attendance changed')=>db.query<{result:{replayed:boolean;revision:number}}>('SELECT public.return_weekly_worker_to_draft($1,$2,$3,$4) result',[requestId,voucher,rev,reason]);
 const approve=(db:PGlite,rev:number)=>db.query('SELECT public.approve_weekly_worker_draft($1,$2)',[voucher,rev]);
 const pay=(db:PGlite,rev:number)=>db.query('SELECT public.record_weekly_worker_payment($1,$2,$3)',[voucher,'2024-11-09',rev]);
 it('keeps approval evidence, returns to draft, refreshes and requires fresh approval and payment revision',async()=>{
  const db=await fixture(true,true,true,true);try{
   await generate(db);await approve(db,0);await db.exec('RESET ROLE');await db.query("INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at) VALUES($1,$2,$3,'2024-11-09','present',8,now())",[id(41),worker,site]);await db.exec('SET ROLE authenticated');
   await expect(pay(db,0)).rejects.toThrow(/source data changed/);expect((await back(db)).rows[0].result).toEqual({replayed:false,payroll_id:voucher,revision:1});
   expect((await back(db)).rows[0].result.replayed).toBe(true);await expect(back(db,id(40),0,'Another reason')).rejects.toThrow(/different action/);
   expect((await db.query('SELECT status FROM public.payroll WHERE id=$1',[voucher])).rows).toEqual([{status:'draft'}]);
   expect((await db.query("SELECT previous_approved_by,reason,approved_payroll->>'status' status FROM public.weekly_worker_approval_returns WHERE request_id=$1",[id(40)])).rows).toEqual([{previous_approved_by:founder,reason:'Attendance changed',status:'approved'}]);
   await expect(approve(db,0)).rejects.toThrow(/revision changed/);
   await db.query('SELECT public.refresh_weekly_worker_draft($1,$2,$3)',[id(42),voucher,1]);await approve(db,2);
   await expect(pay(db,0)).rejects.toThrow(/revision changed/);await expect(pay(db,1)).rejects.toThrow(/revision changed/);
   await expect(db.query('SELECT public.record_weekly_worker_payment($1,$2)',[voucher,'2024-11-09'])).rejects.toThrow();await expect(db.query('SELECT public.weekly_worker_payment_internal($1,$2)',[voucher,'2024-11-09'])).rejects.toThrow(/permission denied/);
   await pay(db,2);await expect(back(db,id(43),2)).rejects.toThrow(/without recorded payment/);expect((await back(db)).rows[0].result.replayed).toBe(true);
   await db.exec('RESET ROLE');await expect(db.query('DELETE FROM public.weekly_worker_approval_returns WHERE request_id=$1',[id(40)])).rejects.toThrow(/immutable/);
  }finally{await db.close();}
 },30000);
 it('blocks unauthorized, stale, missing reason and rolled-back return without changing state',async()=>{
  const db=await fixture(true,true,true,true);try{
   await generate(db);await approve(db,0);await expect(back(db,id(40),0,' ')).rejects.toThrow(/reason/);await expect(back(db,id(40),1)).rejects.toThrow(/revision changed/);
   await db.exec(`SET test.uid='${supervisor}'`);await expect(back(db)).rejects.toThrow(/Founder access/);await db.exec(`SET test.uid='${founder}'; SET test.assurance='no'`);await expect(back(db)).rejects.toThrow(/Founder access/);
   await db.exec("SET test.assurance='yes'; RESET ROLE; ALTER TABLE public.audit_log ADD CONSTRAINT deny_update_return CHECK (action <> 'update') NOT VALID; SET ROLE authenticated");await expect(back(db)).rejects.toThrow(/deny_update_return/);await db.exec('RESET ROLE');
   expect((await db.query('SELECT status FROM public.payroll WHERE id=$1',[voucher])).rows).toEqual([{status:'approved'}]);
   expect((await db.query('SELECT draft_revision,approved_by,return_xid,return_actor FROM public.weekly_worker_draft_sources WHERE payroll_id=$1',[voucher])).rows).toEqual([{draft_revision:0,approved_by:founder,return_xid:null,return_actor:null}]);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.weekly_worker_approval_returns')).rows[0].n).toBe(0);
  }finally{await db.close();}
 },30000);
});


describe('historical externally paid date annotation candidate',()=>{
 const historical=id(50),requestId=id(51);
 async function seed(db:PGlite){
  await db.exec("RESET ROLE; SET test.uid=''");await db.query("INSERT INTO public.payroll(id,worker_id,period_start,period_end,status,gross_pay,bale_deduction,other_deductions,net_pay) VALUES($1,$2,'2024-10-20','2024-10-26','paid',1000,200,0,800)",[historical,worker]);
  const expected=(await db.query<{v:unknown}>('SELECT public.historical_paid_voucher_snapshot(p) v FROM public.payroll p WHERE id=$1',[historical])).rows[0].v;await db.exec(`SET test.uid='${founder}'; SET ROLE authenticated`);return expected;
 }
 const annotate=(db:PGlite,expected:unknown,request=requestId,date='2024-10-26',note='Manual payroll ledger reviewed')=>db.query<{r:{replayed:boolean;payment_date:string}}>('SELECT public.annotate_historical_paid_date($1,$2,$3,$4,$5) r',[request,historical,expected,date,note]);
 it('records an explicit historical date against an existing paid voucher without paying or changing Bale',async()=>{
  const db=await fixture(true,true,true,true,true);try{
   const expected=await seed(db);const before=(await db.query('SELECT status,amount_deducted::text FROM public.advances WHERE id=$1',[advance])).rows;
   expect((await annotate(db,expected)).rows[0].r).toMatchObject({replayed:false,payment_date:'2024-10-26'});expect((await annotate(db,expected)).rows[0].r.replayed).toBe(true);
   await expect(annotate(db,expected,requestId,'2024-10-25')).rejects.toThrow(/different evidence/);await expect(annotate(db,expected,id(52))).rejects.toThrow(/Existing payment-date evidence/);
   expect((await db.query('SELECT status,amount_deducted::text FROM public.advances WHERE id=$1',[advance])).rows).toEqual(before);
   expect((await db.query('SELECT status,gross_pay::text,bale_deduction::text,net_pay::text FROM public.payroll WHERE id=$1',[historical])).rows).toEqual([{status:'paid',gross_pay:'1000',bale_deduction:'200',net_pay:'800'}]);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.payroll_payment_dates WHERE payroll_id=$1',[historical])).rows[0].n).toBe(0);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.weekly_worker_paid_allocations WHERE payroll_id=$1',[historical])).rows[0].n).toBe(0);
   await db.exec('RESET ROLE');expect((await db.query<{n:number}>("SELECT count(*)::int n FROM public.audit_log WHERE table_name='historical_paid_date_annotations'")).rows[0].n).toBe(1);await expect(db.query('DELETE FROM public.historical_paid_date_annotations WHERE request_id=$1',[requestId])).rejects.toThrow(/immutable/);
  }finally{await db.close();}
 },30000);
 it('refuses stale, duplicate, wrong role, future or unsupported records and rolls back failed audit',async()=>{
  const db=await fixture(true,true,true,true,true);try{
   const expected=await seed(db);await generate(db);await expect(db.query('SELECT public.annotate_historical_paid_date($1,$2,$3,$4,$5)',[id(53),voucher,{},'2024-11-09','ledger'])).rejects.toThrow(/Only an existing paid voucher/);
   await expect(annotate(db,{...expected as object,net_pay:'999'})).rejects.toThrow(/changed since review/);
   await expect(annotate(db,expected,requestId,'2024-10-19')).rejects.toThrow(/precede/);await expect(annotate(db,expected,requestId,'9998-01-01')).rejects.toThrow(/valid actual date/);await expect(annotate(db,expected,requestId,'2024-10-26',' ')).rejects.toThrow(/evidence note/);
   await db.exec(`SET test.uid='${supervisor}'`);await expect(annotate(db,expected)).rejects.toThrow(/Founder access/);await db.exec(`SET test.uid='${founder}'; SET test.assurance='no'`);await expect(annotate(db,expected)).rejects.toThrow(/Founder access/);
   await db.exec("SET test.assurance='yes'; RESET ROLE");await db.query('INSERT INTO public.payroll_payment_dates(payroll_id,payment_date,recorded_by) VALUES($1,$2,$3)',[historical,'2024-10-26',founder]);await db.exec('SET ROLE authenticated');await expect(annotate(db,expected)).rejects.toThrow(/Existing payment-date evidence/);
   await db.exec('RESET ROLE');await db.query('DELETE FROM public.payroll_payment_dates WHERE payroll_id=$1',[historical]);await db.exec("ALTER TABLE public.audit_log ADD CONSTRAINT deny_history CHECK (table_name <> 'historical_paid_date_annotations') NOT VALID; SET ROLE authenticated");await expect(annotate(db,expected)).rejects.toThrow(/deny_history/);await db.exec('RESET ROLE');
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.historical_paid_date_annotations')).rows[0].n).toBe(0);
  }finally{await db.close();}
 },30000);
});


describe('historical settled Bale evidence candidate',()=>{
 const historical=id(60),dateRequest=id(61),baleRequest=id(62);
 async function seed(db:PGlite,withDate=true){
  await db.exec("RESET ROLE; SET test.uid=''");await db.query("INSERT INTO public.payroll(id,worker_id,period_start,period_end,status,gross_pay,bale_deduction,other_deductions,net_pay) VALUES($1,$2,'2024-10-20','2024-10-26','paid',1000,200,0,800)",[historical,worker]);
  const expected=(await db.query<{v:unknown}>('SELECT public.historical_paid_voucher_snapshot(p) v FROM public.payroll p WHERE id=$1',[historical])).rows[0].v;await db.exec(`SET test.uid='${founder}'; SET ROLE authenticated`);
  if(withDate)await db.query("SELECT public.annotate_historical_paid_date($1,$2,$3,'2024-10-26','Original payroll ledger')",[dateRequest,historical,expected]);return expected;
 }
 const record=(db:PGlite,expected:unknown,req=baleRequest,amount='200',date='2024-10-23',project=site,note='Original release and deduction verified')=>db.query<{r:{replayed:boolean}}>('SELECT public.record_historical_settled_bale($1,$2,$3,$4,$5,$6,$7) r',[req,historical,expected,project,date,amount,note]);
 it('records one fully settled historical release as evidence only and retries exactly once',async()=>{
  const db=await fixture(true,true,true,true,true,true);try{
   const expected=await seed(db);const before=(await db.query('SELECT id,status,amount_deducted::text FROM public.advances ORDER BY id')).rows;
   expect((await record(db,expected)).rows[0].r.replayed).toBe(false);expect((await record(db,expected)).rows[0].r.replayed).toBe(true);
   await expect(record(db,expected,baleRequest,'200','2024-10-24')).rejects.toThrow(/different Bale evidence/);await expect(record(db,expected,id(63))).rejects.toThrow(/requires separate reconciliation/);
   expect((await db.query('SELECT id,status,amount_deducted::text FROM public.advances ORDER BY id')).rows).toEqual(before);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.advance_requests WHERE issued_advance_id=$1',[baleRequest])).rows[0].n).toBe(0);
   expect((await db.query('SELECT release_date::text,payment_date::text,payment_date_source,amount::text FROM public.historical_settled_bale_evidence WHERE request_id=$1',[baleRequest])).rows).toEqual([{release_date:'2024-10-23',payment_date:'2024-10-26',payment_date_source:'historical_annotation',amount:'200.00'}]);
   await db.exec('RESET ROLE');await expect(db.query('DELETE FROM public.historical_settled_bale_evidence WHERE request_id=$1',[baleRequest])).rejects.toThrow(/immutable/);
  }finally{await db.close();}
 },30000);
 it('round-trips client date and Bale evidence requests through the real candidates without finance mutations',async()=>{
  const db=await fixture(true,true,true,true,true,true,true);try{
   await seed(db,false);const before=(await db.query('SELECT id,status,amount_deducted::text FROM public.advances ORDER BY id')).rows;
   const r=async()=>(await db.query<{v:{voucher_snapshot:unknown;date_evidence:unknown;bale_evidence:unknown}}>('SELECT public.historical_finance_evidence_review($1) v',[historical])).rows[0].v;
   const first=await r();const paid={id:historical,worker_id:worker,worker_name:'Worker',period_start:'2024-10-20',period_end:'2024-10-26',gross_pay:'1000.00',bale_deduction:'200.00',other_deductions:'0.00',net_pay:'800.00',overlapping_paid:false,period_bale_total:'0.00',period_bale_count:0,unlinked_period_bale_count:0};
   const date=parseHistoricalAttempt({kind:'date',request:dateRequest,snapshot:first.voucher_snapshot,date:'2024-10-26',note:'Payroll ledger',project:null},paid);const da=historicalArguments(date);
   const dateResult=(await db.query<{v:unknown}>('SELECT public.annotate_historical_paid_date($1,$2,$3,$4,$5) v',[da.p_request,da.p_payroll,da.p_expected,'p_date' in da?da.p_date:null,da.p_note])).rows[0].v;verifyHistoricalResult(dateResult,date);expect((await r()).date_evidence).toMatchObject({payment_date:'2024-10-26',matches_voucher:true});
   const bale=parseHistoricalAttempt({kind:'bale',request:baleRequest,snapshot:first.voucher_snapshot,date:'2024-10-23',note:'Release ledger',project:site},paid);const ba=historicalArguments(bale);
   const baleResult=(await db.query<{v:unknown}>('SELECT public.record_historical_settled_bale($1,$2,$3,$4,$5,$6,$7) v',[ba.p_request,ba.p_payroll,ba.p_expected,'p_project' in ba?ba.p_project:null,'p_release_date' in ba?ba.p_release_date:null,'p_amount' in ba?ba.p_amount:null,ba.p_note])).rows[0].v;verifyHistoricalResult(baleResult,bale);expect((await r()).bale_evidence).toMatchObject({amount:'200.00',context_changed:false});
   expect((await db.query('SELECT id,status,amount_deducted::text FROM public.advances ORDER BY id')).rows).toEqual(before);expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.payroll_payment_dates WHERE payroll_id=$1',[historical])).rows[0].n).toBe(0);
  }finally{await db.close();}
 },30000);
 it('reads saved historical assertions and flags later conflicting records without changing them',async()=>{
  const db=await fixture(true,true,true,true,true,true,true);try{
   const expected=await seed(db);const empty=(await db.query<{v:{voucher_snapshot:unknown;date_evidence:object;bale_evidence:unknown}}>('SELECT public.historical_finance_evidence_review($1) v',[historical])).rows[0].v;expect(empty.voucher_snapshot).toEqual(expected);expect(empty.date_evidence).toMatchObject({payment_date:'2024-10-26',matches_voucher:true});expect(empty.bale_evidence).toBeNull();
   await record(db,expected);let v=(await db.query<{v:{payment_conflict:boolean;bale_evidence:{context_changed:boolean;matches_voucher:boolean;amount:string}}}>('SELECT public.historical_finance_evidence_review($1) v',[historical])).rows[0].v;expect(v.payment_conflict).toBe(false);expect(v.bale_evidence).toMatchObject({context_changed:false,matches_voucher:true,amount:'200.00'});
   await db.exec('RESET ROLE');await db.query('INSERT INTO public.payroll_payment_dates(payroll_id,payment_date,recorded_by) VALUES($1,$2,$3)',[historical,'2024-10-25',founder]);await db.exec('SET ROLE authenticated');
   v=(await db.query<{v:typeof v}>('SELECT public.historical_finance_evidence_review($1) v',[historical])).rows[0].v;expect(v.payment_conflict).toBe(true);expect(v.bale_evidence.context_changed).toBe(true);
   await db.exec('RESET ROLE; ALTER TABLE public.payroll_payment_dates DROP CONSTRAINT payroll_payment_dates_pkey');await db.query('INSERT INTO public.payroll_payment_dates(payroll_id,payment_date,recorded_by) VALUES($1,$2,$3)',[historical,'2024-10-25',founder]);await db.exec('SET ROLE authenticated');await expect(db.query('SELECT public.historical_finance_evidence_review($1)',[historical])).rejects.toThrow(/Ambiguous recorded payment-date/);
   await db.exec('RESET ROLE; DELETE FROM public.payroll_payment_dates; SET ROLE authenticated');await expect(db.query('SELECT public.historical_finance_evidence_review($1)',[id(999)])).rejects.toThrow(/Paid voucher unavailable/);
   await db.exec(`SET test.uid='${supervisor}'`);await expect(db.query('SELECT public.historical_finance_evidence_review($1)',[historical])).rejects.toThrow(/Founder access/);await db.exec(`SET test.uid='${founder}'; SET test.assurance='no'`);await expect(db.query('SELECT public.historical_finance_evidence_review($1)',[historical])).rejects.toThrow(/Founder access/);
  }finally{await db.close();}
 },30000);
 it('flags changed voucher, period advances and overlaps without modifying them',async()=>{
  const db=await fixture(true,true,true,true,true,true,true);try{
   const expected=await seed(db);await record(db,expected);
   const review=async()=>(await db.query<{v:{date_evidence:{matches_voucher:boolean};bale_evidence:{matches_voucher:boolean;context_changed:boolean}}}>('SELECT public.historical_finance_evidence_review($1) v',[historical])).rows[0].v;
   await db.exec("RESET ROLE; SET test.uid=''");await db.query("INSERT INTO public.advances(id,worker_id,project_id,date,amount,amount_deducted,status) VALUES($1,$2,$3,'2024-10-23',200,200,'fully_deducted')",[id(65),worker,site]);await db.exec(`SET test.uid='${founder}'; SET ROLE authenticated`);expect((await review()).bale_evidence.context_changed).toBe(true);
   await db.exec("RESET ROLE; SET test.uid=''");await db.query('DELETE FROM public.advances WHERE id=$1',[id(65)]);await db.query("INSERT INTO public.payroll(id,worker_id,period_start,period_end,status,gross_pay,bale_deduction,other_deductions,net_pay) VALUES($1,$2,'2024-10-24','2024-10-30','paid',100,0,0,100)",[id(66),worker]);await db.exec(`SET test.uid='${founder}'; SET ROLE authenticated`);expect((await review()).bale_evidence.context_changed).toBe(true);
   await db.exec("RESET ROLE; SET test.uid=''; ALTER TABLE public.payroll DISABLE TRIGGER USER");await db.query('UPDATE public.payroll SET bale_deduction=NULL WHERE id=$1',[historical]);await db.exec(`ALTER TABLE public.payroll ENABLE TRIGGER USER; SET test.uid='${founder}'; SET ROLE authenticated`);const changed=await review();expect(changed.date_evidence.matches_voucher).toBe(false);expect(changed.bale_evidence).toMatchObject({matches_voucher:false,context_changed:true});
  }finally{await db.close();}
 },30000);
 it('fails closed on missing date, duplicate advances, mismatch, access and audit failure',async()=>{
  const db=await fixture(true,true,true,true,true,true);try{
   const expected=await seed(db,false);await expect(record(db,expected)).rejects.toThrow(/payment-date assertion/);await expect(record(db,expected,baleRequest,'199')).rejects.toThrow(/full Bale deduction/);
   await expect(record(db,{...expected as object,net_pay:'999'})).rejects.toThrow(/changed since review/);await expect(record(db,expected,baleRequest,'200','2024-10-19')).rejects.toThrow(/outside original week/);
   await db.exec(`SET test.uid='${supervisor}'`);await expect(record(db,expected)).rejects.toThrow(/Founder access/);await db.exec(`SET test.uid='${founder}'; SET test.assurance='no'`);await expect(record(db,expected)).rejects.toThrow(/Founder access/);await db.exec("SET test.assurance='yes'; RESET ROLE");
   await db.exec("SET test.uid=''");await db.query("INSERT INTO public.advances(id,worker_id,project_id,date,amount,amount_deducted,status) VALUES($1,$2,$3,'2024-10-23',200,200,'fully_deducted')",[id(65),worker,site]);await db.exec(`SET test.uid='${founder}'; SET ROLE authenticated`);await expect(record(db,expected)).rejects.toThrow(/requires separate reconciliation/);
   await db.exec('RESET ROLE');await db.query('DELETE FROM public.advances WHERE id=$1',[id(65)]);await db.exec('SET ROLE authenticated');await db.query("SELECT public.annotate_historical_paid_date($1,$2,$3,'2024-10-26','Ledger')",[dateRequest,historical,expected]);
   await expect(record(db,expected,baleRequest,'200','2024-10-23',id(99))).rejects.toThrow(/Project unavailable/);
   await db.exec('RESET ROLE');await db.query('INSERT INTO public.payroll_payment_dates(payroll_id,payment_date,recorded_by) VALUES($1,$2,$3)',[historical,'2024-10-26',founder]);await db.exec('SET ROLE authenticated');await expect(record(db,expected)).rejects.toThrow(/payment-date assertion/);
   await db.exec('RESET ROLE');await db.query('DELETE FROM public.payroll_payment_dates WHERE payroll_id=$1',[historical]);
   await db.exec("ALTER TABLE public.audit_log ADD CONSTRAINT deny_bale_history CHECK (table_name <> 'historical_settled_bale_evidence') NOT VALID; SET ROLE authenticated");await expect(record(db,expected)).rejects.toThrow(/deny_bale_history/);await db.exec('RESET ROLE');expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.historical_settled_bale_evidence')).rows[0].n).toBe(0);
  }finally{await db.close();}
 },30000);
});
