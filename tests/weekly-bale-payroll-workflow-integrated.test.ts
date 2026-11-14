// @vitest-environment jsdom
// Synthetic, in-memory database only. This cannot send or prove cash payments.
import React from 'react';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const mock=vi.hoisted(()=>({rpc:vi.fn(),today:'2024-11-06',actor:'',founder:false,supervisor:true}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
vi.mock('@/lib/reminders/scheduler',()=>({getManilaClock:()=>({dateIso:mock.today})}));
vi.mock('@/lib/dates/useManilaToday',()=>({useManilaToday:()=>mock.today}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:mock.actor},isFounder:mock.founder,isSupervisor:mock.supervisor,assurance:'ready'})}));
vi.mock('@/lib/data/store',()=>({useDataStore:()=>({projects:[{id:'00000000-0000-0000-0000-000000000004',name:'Site One'}]})}));
import {WeeklyBaleReleasePanel} from '@/components/advances/WeeklyBaleReleasePanel';
import {WeeklyWorkerPreview} from '@/components/payroll/WeeklyWorkerPreview';
import {TimeDetailDialog} from '@/components/attendance/TimeDetailDialog';
import {AllowanceDialog} from '@/components/attendance/AllowanceDialog';
import {WorkerAllowanceQueue} from '@/components/payroll/WorkerAllowanceQueue';
import {PaidAttendanceReview} from '@/components/payroll/PaidAttendanceReview';
import {PaidAdjustmentPanel} from '@/components/payroll/PaidAdjustmentPanel';
import type {PaidReviewVoucher} from '@/lib/payroll/paidReview';
import type {HistoryRecord} from '@/lib/attendance/history';
const founder='00000000-0000-0000-0000-000000000001',supervisor='00000000-0000-0000-0000-000000000002',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004';
const attendance='70000000-0000-4000-8000-000000000001',voucher='70000000-0000-4000-8000-000000000002';
const sql=(p:string)=>readFileSync(p,'utf8');
afterEach(()=>{cleanup();localStorage.clear();sessionStorage.clear();vi.restoreAllMocks();vi.unstubAllEnvs();});
async function fixture(cutover=true){
 const db=new PGlite();await db.exec(baseFixture);
 await db.exec(`ALTER TABLE public.users ADD COLUMN email text;UPDATE public.users SET email='fixture@example.invalid';
  ALTER TABLE public.payroll ADD COLUMN notes text;ALTER TABLE public.advances ADD COLUMN reason text, ADD COLUMN created_at timestamptz DEFAULT now();ALTER TABLE public.advances ALTER COLUMN id SET DEFAULT gen_random_uuid();
  ALTER TABLE public.advance_requests ADD COLUMN approved_by uuid,ADD COLUMN approved_at timestamptz,ADD COLUMN rejected_by uuid,ADD COLUMN rejected_at timestamptz,ADD COLUMN issued_by uuid,ADD COLUMN updated_at timestamptz DEFAULT now();
  ALTER TABLE public.advance_requests ADD CONSTRAINT advance_request_rejection_fields CHECK(status<>'rejected' OR (rejected_by IS NOT NULL AND rejected_at IS NOT NULL));
  CREATE TABLE public.project_worker_assignments(project_id uuid,worker_id uuid,active boolean,primary key(project_id,worker_id));INSERT INTO public.project_worker_assignments VALUES('${site}','${worker}',true);
  DROP TABLE public.audit_log;CREATE TABLE public.audit_log(actor_id uuid,actor_email text,action text,table_name text,record_id uuid,before_row jsonb,after_row jsonb);
  CREATE POLICY test_founder_payroll_write ON public.payroll FOR ALL TO authenticated USING(public.is_founder()) WITH CHECK(public.is_founder());
  INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at) VALUES('${attendance}','${worker}','${site}','2024-11-03','present',8,'2024-11-03T08:00:00Z');`);
 const paths=['supabase/migrations/20261102000000_atomic_payroll_payments.sql','supabase/migrations/20261113000000_weekly_worker_preview.sql','supabase/migrations/20261113000001_attendance_time_detail.sql','supabase/migrations/20261113000002_worker_allowances.sql','supabase/migrations/20261113000003_weekly_payroll_context.sql','supabase/drafts/guard_legacy_bale_payment.sql','supabase/drafts/weekly_payment_date.sql','supabase/drafts/weekly_worker_generator.sql','supabase/drafts/weekly_worker_approval.sql','supabase/drafts/weekly_worker_paid_allocation.sql','supabase/drafts/weekly_worker_draft_details.sql','supabase/drafts/weekly_paid_attendance_change_review.sql','supabase/drafts/paid_payroll_adjustments.sql','supabase/drafts/weekly_worker_draft_refresh.sql','supabase/drafts/weekly_worker_return_to_draft.sql','supabase/migrations/20261013000000_advance_requests.sql','supabase/migrations/20261013000001_advance_request_notifications.sql','supabase/migrations/20261113000004_bale_request_site_guard.sql','supabase/drafts/weekly_bale_schedule.sql','supabase/drafts/weekly_bale_expiration.sql','supabase/drafts/weekly_bale_release_list.sql'];
 for(const p of paths)await db.exec(sql(p));
 if(cutover){
  await db.exec(`BEGIN; ${sql('supabase/drafts/weekly_bale_legacy_cutover_guard.sql')} ${sql('supabase/drafts/weekly_worker_legacy_cutover_guard.sql')} COMMIT;`);
  // Model the hosted follow-up ACL change as well as the original guards.
  // The UI still uses Founder review, but release and payment must use the
  // replacements even when the obsolete functions are no longer executable.
  await db.exec('REVOKE ALL ON FUNCTION public.issue_advance_request(uuid),public.record_advance_deduction_atomic(uuid,numeric) FROM PUBLIC,anon,authenticated,service_role');
 }
 if(cutover){
  for(const p of ['supabase/migrations/20261103000001_attendance_history.sql','supabase/migrations/20261112000001_payslip_batch_snapshot.sql','supabase/drafts/worker_category_catalog.sql','supabase/drafts/worker_category_workforce_cutover.sql','supabase/drafts/recorded_craft_observations.sql'])await db.exec(`BEGIN; ${sql(p)} COMMIT;`);
 }
 await db.exec(`CREATE OR REPLACE FUNCTION public.weekly_bale_clock() RETURNS timestamptz LANGUAGE sql VOLATILE SET search_path='' AS $$SELECT current_setting('test.clock')::timestamptz$$;
 SET test.assurance='yes';SET test.uid='${supervisor}';SET test.clock='2024-11-03T04:00:00Z';SET ROLE authenticated`);
 return db;
}

describe('weekly Bale through worker payroll: candidate UI and synthetic SQL',()=>{
 it('records one release and one external payment, recovering safely from lost responses',async()=>{
  for(const name of ['NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','NEXT_PUBLIC_WEEKLY_WORKER_ACTIONS_PREVIEW','NEXT_PUBLIC_WEEKLY_WORKER_CUTOVER_PREVIEW','NEXT_PUBLIC_WEEKLY_BALE_RELEASE_PREVIEW','NEXT_PUBLIC_WEEKLY_WORKER_REFRESH_PREVIEW','NEXT_PUBLIC_WEEKLY_WORKER_RETURN_PREVIEW'])vi.stubEnv(name,'true');
  mock.today='2024-11-06';mock.actor=supervisor;mock.supervisor=true;mock.founder=false;const db=await fixture();try{
   await expect(db.query('SELECT public.issue_advance_request(NULL::uuid)')).rejects.toThrow(/permission denied/);
   await expect(db.query('SELECT public.record_advance_deduction_atomic(NULL::uuid,1::numeric)')).rejects.toThrow(/permission denied/);
   const req=(await db.query<{id:string}>('INSERT INTO public.advance_requests(worker_id,project_id,requested_amount,submitted_by) VALUES($1,$2,100.25,$3) RETURNING id',[worker,site,supervisor])).rows[0].id;
   let loseTime=true,loseAllowance=true,loseRelease=true,losePayment=true,loseCase=true;mock.rpc.mockReset();mock.rpc.mockImplementation(async(name:string,args:Record<string,unknown>={})=>{
    try{
     const calls:Record<string,{query:string;params:unknown[]}>= {
      attendance_time_detail_latest:{query:'SELECT public.attendance_time_detail_latest($1) v',params:[args.p_attendance]},
      record_attendance_time_detail:{query:'SELECT public.record_attendance_time_detail($1,$2,$3,$4,$5,$6) v',params:[args.p_request,args.p_attendance,args.p_expected_submitted_at,args.p_regular,args.p_overtime,args.p_note]},
      worker_allowances_for_attendance:{query:'SELECT public.worker_allowances_for_attendance($1) v',params:[args.p_attendance]},
      submit_worker_allowance:{query:'SELECT public.submit_worker_allowance($1,$2,$3,$4,$5) v',params:[args.p_id,args.p_attendance,args.p_expected_submitted_at,args.p_amount,args.p_description]},
      worker_allowance_pending_queue:{query:'SELECT public.worker_allowance_pending_queue() v',params:[]},
      review_worker_allowance:{query:'SELECT public.review_worker_allowance($1,$2) v',params:[args.p_id,args.p_decision]},
      weekly_bale_release_list:{query:'SELECT public.weekly_bale_release_list($1) v',params:[args.p_start]},
      record_weekly_bale_release:{query:'SELECT public.record_weekly_bale_release($1) v',params:[args.p_request_id]},
      weekly_worker_preview_inputs:{query:'SELECT public.weekly_worker_preview_inputs($1) v',params:[args.p_start]},
      create_weekly_worker_draft:{query:'SELECT public.create_weekly_worker_draft($1,$2,$3) v',params:[args.p_id,args.p_worker,args.p_start]},
      weekly_worker_draft_details:{query:'SELECT public.weekly_worker_draft_details($1) v',params:[args.p_id]},
      approve_weekly_worker_draft:{query:'SELECT public.approve_weekly_worker_draft($1,$2) v',params:[args.p_id,args.p_expected_revision]},
      record_weekly_worker_payment:{query:'SELECT public.record_weekly_worker_payment($1,$2,$3) v',params:[args.p_id,args.p_payment_date,args.p_expected_revision]},
      weekly_paid_attendance_change_review:{query:'SELECT public.weekly_paid_attendance_change_review($1) v',params:[args.p_id]},
      paid_payroll_adjustment_list:{query:'SELECT public.paid_payroll_adjustment_list($1,$2) v',params:[args.p_payroll_id,args.p_offset]},
      open_paid_payroll_adjustment:{query:'SELECT public.open_paid_payroll_adjustment($1,$2,$3::jsonb,$4,$5) v',params:[args.p_id,args.p_payroll_id,JSON.stringify(args.p_expected),args.p_difference,args.p_reason]},
      resolve_paid_payroll_adjustment:{query:'SELECT public.resolve_paid_payroll_adjustment($1,$2,$3,$4) v',params:[args.p_id,args.p_resolution,args.p_settled_on,args.p_note]},
     };
     const call=calls[name];if(!call)throw Error(`Unexpected RPC ${name}`);const data=(await db.query<{v:unknown}>(call.query,call.params)).rows[0].v;
     if(name==='record_attendance_time_detail'&&loseTime){loseTime=false;return {data:null,error:Error('Synthetic lost response after commit')};}
     if(name==='submit_worker_allowance'&&loseAllowance){loseAllowance=false;return {data:null,error:Error('Synthetic lost response after commit')};}
     if(name==='record_weekly_bale_release'&&loseRelease){loseRelease=false;return {data:null,error:Error('Synthetic lost response after commit')};}
     if(name==='record_weekly_worker_payment'&&losePayment){losePayment=false;return {data:null,error:Error('Synthetic lost response after commit')};}
     if(name==='open_paid_payroll_adjustment'&&loseCase){loseCase=false;return {data:null,error:Error('Synthetic lost response after commit')};}
     return {data,error:null};
    }catch(error){return {data:null,error};}
   });
   // Actual attendance dialogs write the source records through their candidate RPCs.
   const record:HistoryRecord={id:attendance,worker_id:worker,project_id:site,date:'2024-11-03',status:'present',hours_worked:8,notes:null,recorded_by:supervisor,is_founder_override:false,submitted_at:'2024-11-03T08:00:00Z',created_at:'2024-11-03T08:00:00Z',worker_name:'Test Worker',worker_position:'Mason',project_name:'Site One',is_supervisor:false};
   render(React.createElement(TimeDetailDialog,{record,onClose:vi.fn()}));await screen.findByText(/No supplemental time details/);
   fireEvent.change(screen.getByLabelText('Regular hours (maximum 8)'),{target:{value:'8'}});fireEvent.change(screen.getByLabelText('Overtime hours'),{target:{value:'2'}});fireEvent.change(screen.getByLabelText('Reason / source of hours'),{target:{value:'Synthetic overtime'}});fireEvent.click(screen.getByRole('button',{name:'Save time details'}));await screen.findByText(/Save not confirmed/);cleanup();
   render(React.createElement(TimeDetailDialog,{record,onClose:vi.fn()}));await screen.findByText(/Latest saved: 8.00 regular \+ 2.00 OT/);fireEvent.click(screen.getByRole('button',{name:'Retry exact time details'}));await screen.findByText(/Time details saved/);cleanup();
   render(React.createElement(AllowanceDialog,{record,isFounder:false,onClose:vi.fn()}));await screen.findByText('No allowances recorded.');fireEvent.change(screen.getByLabelText('Allowance amount (₱)'),{target:{value:'50.25'}});fireEvent.change(screen.getByLabelText('Allowance purpose'),{target:{value:'Synthetic allowance'}});fireEvent.click(screen.getByRole('button',{name:'Submit for approval'}));await screen.findByText(/Result not fully confirmed/);cleanup();
   render(React.createElement(AllowanceDialog,{record,isFounder:false,onClose:vi.fn()}));await screen.findByText(/Request .*50.25/);await screen.findByText(/₱50.25 · pending/);fireEvent.click(screen.getByRole('button',{name:'Retry exact allowance'}));await screen.findByText(/Submitted for Founder approval/);cleanup();
   // Founder decides the allowance and Bale; a pending allowance cannot silently become pay.
   mock.actor=founder;mock.founder=true;mock.supervisor=false;mock.today='2024-11-05';await db.exec(`SET test.uid='${founder}';SET test.clock='2024-11-05T04:00:00Z'`);await db.query("SELECT public.review_advance_request($1,'approve')",[req]);
   render(React.createElement(WeeklyWorkerPreview));fireEvent.click(screen.getByRole('button',{name:/Weekly worker planning preview/}));fireEvent.click(screen.getByRole('button',{name:'Load preview'}));await screen.findByText(/Allowance awaiting Founder decision/);expect(screen.queryByRole('button',{name:'Review new draft'})).toBeNull();cleanup();
   render(React.createElement(WorkerAllowanceQueue));fireEvent.click(screen.getByRole('button',{name:/Worker allowance approvals/}));fireEvent.click(screen.getByRole('button',{name:'Load requests'}));await screen.findByText(/Test Worker ·/);fireEvent.click(screen.getByRole('button',{name:'Approve'}));fireEvent.click(screen.getByRole('button',{name:'Confirm approval'}));await screen.findByText(/Decision recorded/);cleanup();
   mock.actor=supervisor;mock.founder=false;mock.supervisor=true;mock.today='2024-11-06';await db.exec(`SET test.uid='${supervisor}';SET test.clock='2024-11-06T04:00:00Z'`);
   // Supervisor records a release only after acknowledging the simulated cash handover.
   render(React.createElement(WeeklyBaleReleasePanel));fireEvent.click(screen.getByRole('button',{name:'Experimental weekly Bale release'}));fireEvent.click(screen.getByRole('button',{name:'Load releases'}));
   await screen.findByText(/Test Worker.*Site One.*100.25/);fireEvent.click(screen.getByRole('button',{name:'Review external release'}));fireEvent.click(screen.getByRole('checkbox',{name:/verified this external release/}));fireEvent.click(screen.getByRole('button',{name:'Record release'}));
   await screen.findByText(/Release not confirmed/);fireEvent.click(screen.getByRole('button',{name:'Load releases'}));await screen.findByText('Release recorded · Wednesday 2024-11-06');expect(screen.queryByRole('button',{name:'Review external release'})).toBeNull();cleanup();
   // Manual deductions are blocked; the weekly payment records the full amount once.
   await db.exec('RESET ROLE');await expect(db.query("UPDATE public.advances SET amount_deducted=10,status='partially_deducted' WHERE worker_id=$1",[worker])).rejects.toThrow(/Weekly Bale is immutable/);await db.exec('SET ROLE authenticated');
   // Founder uses the actual weekly preview and revision-aware voucher actions.
   mock.today='2024-11-09';mock.actor=founder;mock.founder=true;mock.supervisor=false;await db.exec(`SET test.uid='${founder}'`);vi.spyOn(crypto,'randomUUID').mockReturnValue(voucher);
   render(React.createElement(WeeklyWorkerPreview));expect(screen.getByText(/experimental voucher actions available/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:/Weekly worker planning preview/}));fireEvent.click(screen.getByRole('button',{name:'Load preview'}));await screen.findByText(/gross with allowances ₱800.25/);expect(screen.getByText(/Experimental voucher actions are available in the final column/)).toBeTruthy();
   fireEvent.click(screen.getByRole('button',{name:'Review new draft'}));fireEvent.click(screen.getByRole('button',{name:'Create draft'}));await screen.findByText(/Saved status: draft/);expect(screen.getByText(/gross ₱800.25 · Bale ₱100.25 · net ₱700.00/)).toBeTruthy();
   fireEvent.click(screen.getByRole('button',{name:'Review approval'}));fireEvent.click(screen.getByRole('button',{name:'Confirm approval'}));await screen.findByText(/Saved status: approved/);
   fireEvent.click(screen.getByRole('button',{name:'Review external payment'}));fireEvent.change(screen.getByLabelText('Actual external payment date'),{target:{value:'2024-11-09'}});fireEvent.click(screen.getByRole('checkbox',{name:/I verified the external payment/}));fireEvent.click(screen.getByRole('button',{name:'Record payment'}));await screen.findByText(/Outcome not confirmed/);expect(screen.queryByText(/Saved status: paid/)).toBeNull();
   cleanup();render(React.createElement(WeeklyWorkerPreview));fireEvent.click(screen.getByRole('button',{name:/Weekly worker planning preview/}));fireEvent.click(screen.getByRole('button',{name:'Load preview'}));await screen.findByRole('button',{name:'Load voucher details'});fireEvent.click(screen.getByRole('button',{name:'Load voucher details'}));await screen.findByText(/Saved status: paid/);expect(screen.getByText(/Recorded external payment date: 2024-11-09/)).toBeTruthy();expect(screen.getByText(/Site One: ₱800.25/)).toBeTruthy();
   cleanup();const money=(await db.query<{gross_pay:string;bale_deduction:string;other_deductions:string;net_pay:string}>('SELECT gross_pay::text,bale_deduction::text,other_deductions::text,net_pay::text FROM public.payroll WHERE id=$1',[voucher])).rows[0];
   const paidVoucher:PaidReviewVoucher={id:voucher,worker_id:worker,worker_name:'Test Worker',period_start:'2024-11-03',period_end:'2024-11-09',...money,overlapping_paid:false,period_bale_total:'100.25',period_bale_count:1,unlinked_period_bale_count:0};
   render(React.createElement(PaidAttendanceReview,{voucher:paidVoucher}));fireEvent.click(screen.getByRole('button',{name:'Check attendance changes'}));await screen.findByText(/selected attendance and time details matched/);
   // A later backfill changes the current record without rewriting the paid voucher.
   await db.exec('RESET ROLE');await db.query("UPDATE public.attendance SET hours_worked=4, status='half_day' WHERE id=$1",[attendance]);await db.exec('SET ROLE authenticated');
   fireEvent.click(screen.getByRole('button',{name:'Recheck attendance'}));await screen.findByText(/Attendance or time details differ/);expect(screen.getByText(/review a separate correction/)).toBeTruthy();cleanup();
   // The Founder reviews a separate original-period case; this records no transfer.
   const caseId='70000000-0000-4000-8000-000000000040';vi.mocked(crypto.randomUUID).mockReturnValue(caseId);
   render(React.createElement(PaidAdjustmentPanel,{voucher:paidVoucher}));fireEvent.click(screen.getByRole('button',{name:'Adjustment cases for this voucher'}));fireEvent.click(screen.getByRole('button',{name:'Load case history'}));await screen.findByText('No cases recorded for this voucher.');
   fireEvent.change(screen.getByLabelText('Signed difference in pesos'),{target:{value:'-300.00'}});fireEvent.change(screen.getByLabelText('Reason for review'),{target:{value:'Synthetic attendance correction'}});fireEvent.click(screen.getByRole('button',{name:'Review new case'}));fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Open case'}));await screen.findByText(/Outcome not confirmed/);cleanup();
   render(React.createElement(PaidAdjustmentPanel,{voucher:paidVoucher}));fireEvent.click(screen.getByRole('button',{name:'Adjustment cases for this voucher'}));fireEvent.click(screen.getByRole('button',{name:'Retry exact case action'}));await screen.findByText(/Recorded. Reload case history/);fireEvent.click(screen.getByRole('button',{name:'Load case history'}));await screen.findByText(/pending · difference/);fireEvent.click(screen.getByRole('button',{name:'Resolve this case'}));
   const dialog=screen.getByRole('dialog');fireEvent.change(within(dialog).getByLabelText('Resolution'),{target:{value:'no_transfer'}});fireEvent.change(within(dialog).getByLabelText('Resolution explanation'),{target:{value:'Synthetic review: no transfer required'}});fireEvent.click(within(dialog).getByRole('checkbox',{name:/confirmed no transfer is required/}));fireEvent.click(within(dialog).getByRole('button',{name:'Record resolution'}));await screen.findByText(/Recorded. Reload case history/);cleanup();
   await db.exec('RESET ROLE');expect((await db.query('SELECT status,gross_pay::text gross,bale_deduction::text bale,net_pay::text net FROM public.payroll WHERE id=$1',[voucher])).rows).toEqual([{status:'paid',gross:'800.25',bale:'100.25',net:'700.00'}]);expect((await db.query('SELECT craft FROM public.payroll_craft_observations WHERE payroll_id=$1',[voucher])).rows).toEqual([{craft:'Mason'}]);
   expect((await db.query('SELECT amount::text amount,amount_deducted::text deducted,status FROM public.advances WHERE worker_id=$1',[worker])).rows).toEqual([{amount:'100.25',deducted:'100.25',status:'fully_deducted'}]);
   expect((await db.query('SELECT project_id,gross::text gross FROM public.weekly_worker_paid_allocations WHERE payroll_id=$1',[voucher])).rows).toEqual([{project_id:site,gross:'800.25'}]);
   expect((await db.query('SELECT amount::text amount,status FROM public.worker_allowances WHERE worker_id=$1',[worker])).rows).toEqual([{amount:'50.25',status:'approved'}]);
   expect((await db.query('SELECT regular_hours::text regular,overtime_hours::text ot FROM public.attendance_time_details WHERE attendance_id=$1',[attendance])).rows).toEqual([{regular:'8.00',ot:'2.00'}]);
   expect((await db.query('SELECT payroll_id,difference::text difference,status FROM public.paid_payroll_adjustment_cases WHERE id=$1',[caseId])).rows).toEqual([{payroll_id:voucher,difference:'-300.00',status:'no_transfer'}]);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.paid_payroll_adjustment_events WHERE case_id=$1',[caseId])).rows[0].n).toBe(2);
   await db.query("INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at) VALUES('70000000-0000-4000-8000-000000000041',$1,$2,'2024-11-10','present',8,'2024-11-10T08:00:00Z')",[worker,site]);await db.exec('SET ROLE authenticated');
   expect((await db.query<{v:{calculation:unknown}}>("SELECT public.create_weekly_worker_draft('70000000-0000-4000-8000-000000000042',$1,'2024-11-10') v",[worker])).rows[0].v.calculation).toMatchObject({gross:'600.00',bale:'0.00',net:'600.00'});
   const cases=mock.rpc.mock.calls.filter(c=>c[0]==='open_paid_payroll_adjustment');expect(cases).toHaveLength(2);expect(cases[1][1]).toEqual(cases[0][1]);
   const timeWrites=mock.rpc.mock.calls.filter(c=>c[0]==='record_attendance_time_detail');expect(timeWrites).toHaveLength(2);expect(timeWrites[1][1]).toEqual(timeWrites[0][1]);
   const submissions=mock.rpc.mock.calls.filter(c=>c[0]==='submit_worker_allowance');expect(submissions).toHaveLength(2);expect(submissions[1][1]).toEqual(submissions[0][1]);
   expect(mock.rpc.mock.calls.filter(c=>c[0]==='record_weekly_bale_release')).toHaveLength(1);expect(mock.rpc.mock.calls.filter(c=>c[0]==='record_weekly_worker_payment')).toHaveLength(1);
  }finally{cleanup();await db.close();}
 },30000);
 it('blocks stale approval after a late Bale release, then refreshes and approves the revised amount',async()=>{
  for(const name of ['NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','NEXT_PUBLIC_WEEKLY_WORKER_ACTIONS_PREVIEW','NEXT_PUBLIC_WEEKLY_WORKER_CUTOVER_PREVIEW','NEXT_PUBLIC_WEEKLY_BALE_RELEASE_PREVIEW','NEXT_PUBLIC_WEEKLY_WORKER_REFRESH_PREVIEW','NEXT_PUBLIC_WEEKLY_WORKER_RETURN_PREVIEW'])vi.stubEnv(name,'true');
  mock.today='2024-11-06';mock.actor=founder;mock.supervisor=false;mock.founder=true;const db=await fixture();try{
   const req=(await db.query<{id:string}>('INSERT INTO public.advance_requests(worker_id,project_id,requested_amount,submitted_by) VALUES($1,$2,100.25,$3) RETURNING id',[worker,site,supervisor])).rows[0].id;
   await db.exec(`SET test.uid='${founder}';SET test.clock='2024-11-05T04:00:00Z'`);await db.query("SELECT public.review_advance_request($1,'approve')",[req]);
   mock.rpc.mockReset();mock.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>{
    try{
     const calls:Record<string,{query:string;params:unknown[]}>= {
      weekly_worker_preview_inputs:{query:'SELECT public.weekly_worker_preview_inputs($1) v',params:[args.p_start]},
      create_weekly_worker_draft:{query:'SELECT public.create_weekly_worker_draft($1,$2,$3) v',params:[args.p_id,args.p_worker,args.p_start]},
      weekly_worker_draft_details:{query:'SELECT public.weekly_worker_draft_details($1) v',params:[args.p_id]},
      approve_weekly_worker_draft:{query:'SELECT public.approve_weekly_worker_draft($1,$2) v',params:[args.p_id,args.p_expected_revision]},
      refresh_weekly_worker_draft:{query:'SELECT public.refresh_weekly_worker_draft($1,$2,$3) v',params:[args.p_request,args.p_id,args.p_expected_revision]},
     };
     const call=calls[name];if(!call)throw Error(`Unexpected RPC ${name}`);return {data:(await db.query<{v:unknown}>(call.query,call.params)).rows[0].v,error:null};
    }catch(error){return {data:null,error};}
   });
   const refreshId='70000000-0000-4000-8000-000000000005';vi.spyOn(crypto,'randomUUID').mockReturnValueOnce(voucher).mockReturnValueOnce(refreshId);
   render(React.createElement(WeeklyWorkerPreview));fireEvent.click(screen.getByRole('button',{name:/Weekly worker planning preview/}));fireEvent.click(screen.getByRole('button',{name:'Load preview'}));await screen.findByRole('button',{name:'Review new draft'});
   fireEvent.click(screen.getByRole('button',{name:'Review new draft'}));fireEvent.click(screen.getByRole('button',{name:'Create draft'}));await screen.findByText(/Saved status: draft/);expect(screen.getByText(/gross ₱600.00 · Bale ₱0.00 · net ₱600.00/)).toBeTruthy();
   // A separate authorized Supervisor records the Wednesday cash handover after the draft.
   await db.exec(`SET test.uid='${supervisor}';SET test.clock='2024-11-06T04:00:00Z'`);await db.query('SELECT public.record_weekly_bale_release($1)',[req]);await db.exec(`SET test.uid='${founder}'`);
   fireEvent.click(screen.getByRole('button',{name:'Review approval'}));fireEvent.click(screen.getByRole('button',{name:'Confirm approval'}));await screen.findByText(/Outcome not confirmed/);
   await db.exec('RESET ROLE');expect((await db.query('SELECT status,bale_deduction::text bale FROM public.payroll WHERE id=$1',[voucher])).rows).toEqual([{status:'draft',bale:'0.00'}]);await db.exec('SET ROLE authenticated');
   fireEvent.click(screen.getByRole('button',{name:'Refresh preview'}));await screen.findByRole('button',{name:'Load voucher details'});fireEvent.click(screen.getByRole('button',{name:'Load voucher details'}));await screen.findByText(/Saved status: draft/);
   fireEvent.click(screen.getByRole('button',{name:'Review draft refresh'}));fireEvent.click(screen.getByRole('button',{name:'Refresh draft'}));await screen.findByText(/revision 1/);expect(screen.getByText(/gross ₱600.00 · Bale ₱100.25 · net ₱499.75/)).toBeTruthy();
   fireEvent.click(screen.getByRole('button',{name:'Review approval'}));fireEvent.click(screen.getByRole('button',{name:'Confirm approval'}));await screen.findByText(/Saved status: approved/);
   await db.exec('RESET ROLE');expect((await db.query('SELECT status,bale_deduction::text bale,net_pay::text net FROM public.payroll WHERE id=$1',[voucher])).rows).toEqual([{status:'approved',bale:'100.25',net:'499.75'}]);expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.weekly_worker_paid_allocations WHERE payroll_id=$1',[voucher])).rows[0].n).toBe(0);
  }finally{cleanup();await db.close();}
 },30000);
 it('rejects old-client payroll insertion and preserves already-paid history',async()=>{
  const db=await fixture();try{
   await db.exec(`SET test.uid='${founder}'`);
   const legacy='70000000-0000-4000-8000-000000000010';
   const insert="INSERT INTO public.payroll(id,worker_id,period_start,period_end,status,days_worked,hours_worked,gross_pay,bale_deduction,other_deductions,net_pay) VALUES($1,$2,'2024-11-03','2024-11-09',$3,1,8,600,0,0,600)";
   await expect(db.query(insert,[legacy,worker,'paid'])).rejects.toThrow(/must start as (drafts|a source-bound weekly draft)/);
   await expect(db.query(insert,[legacy,worker,'draft'])).rejects.toThrow(/Legacy payroll insertion blocked/);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.payroll WHERE id=$1',[legacy])).rows[0].n).toBe(0);
   await db.exec('RESET ROLE');await expect(db.query("UPDATE public.payroll SET status='draft' WHERE id=$1",[worker])).rejects.toThrow(/Legacy paid payroll status is preserved/);expect((await db.query('SELECT status FROM public.payroll WHERE id=$1',[worker])).rows).toEqual([{status:'paid'}]);
   await expect(db.query("INSERT INTO public.advances(id,worker_id,project_id,date,amount,amount_deducted,status,reason) VALUES($1,$2,$3,'2024-11-06',100,0,'active','Legacy manual')",['70000000-0000-4000-8000-000000000012',worker,site])).rejects.toThrow(/Legacy Bale insertion blocked/);
   expect((await db.query('SELECT count(*)::int n FROM public.advances WHERE worker_id=$1',[worker])).rows).toEqual([{n:0}]);
   expect((await db.query("SELECT has_table_privilege('service_role','public.weekly_worker_draft_sources','INSERT') AS service_write,has_table_privilege('authenticated','public.weekly_worker_draft_sources','INSERT') AS client_write")).rows).toEqual([{service_write:false,client_write:false}]);
  }finally{await db.close();}
 },30000);
 it('blocks legacy cancellation and privileged direct changes to a released weekly Bale',async()=>{
  const db=await fixture();try{
   const req=(await db.query<{id:string}>('INSERT INTO public.advance_requests(worker_id,project_id,requested_amount,submitted_by) VALUES($1,$2,100.25,$3) RETURNING id',[worker,site,supervisor])).rows[0].id;
   await db.exec(`SET test.uid='${founder}';SET test.clock='2024-11-05T04:00:00Z'`);await db.query("SELECT public.review_advance_request($1,'approve')",[req]);
   await db.exec(`SET test.uid='${supervisor}';SET test.clock='2024-11-06T04:00:00Z'`);await db.query('SELECT public.record_weekly_bale_release($1)',[req]);
   await db.exec(`SET test.uid='${founder}'`);const advance=(await db.query<{id:string}>('SELECT issued_advance_id id FROM public.advance_requests WHERE id=$1',[req])).rows[0].id;
   await expect(db.query("SELECT public.set_advance_status_atomic($1,'cancelled')",[advance])).rejects.toThrow(/Weekly Bale is immutable/);
   await db.exec('RESET ROLE');await expect(db.query("UPDATE public.advances SET status='cancelled' WHERE id=$1",[advance])).rejects.toThrow(/Weekly Bale is immutable/);
   await expect(db.query('DELETE FROM public.advances WHERE id=$1',[advance])).rejects.toThrow(/Weekly Bale is immutable/);
   expect((await db.query('SELECT status,amount_deducted::text FROM public.advances WHERE id=$1',[advance])).rows).toEqual([{status:'active',amount_deducted:'0.00'}]);
   await db.exec(`SET ROLE service_role;SET test.uid=''`);
   await expect(db.query('SELECT public.issue_advance_request($1)',[req])).rejects.toThrow(/permission denied/);
   await expect(db.query('SELECT public.record_advance_deduction_atomic($1,1)',[advance])).rejects.toThrow(/permission denied/);
  }finally{await db.close();}
 },30000);
 it('refuses Bale cutover while an old outstanding advance remains',async()=>{
  const db=await fixture(false);try{
   await db.exec("RESET ROLE; SET test.uid=''");await db.query("INSERT INTO public.advances(id,worker_id,project_id,date,amount,amount_deducted,status,reason) VALUES($1,$2,$3,'2024-10-30',100,0,'active','Legacy')",['70000000-0000-4000-8000-000000000013',worker,site]);
   await expect(db.exec(`BEGIN; ${sql('supabase/drafts/weekly_bale_legacy_cutover_guard.sql')} COMMIT;`)).rejects.toThrow(/Unresolved legacy open requests or outstanding Bale/);
   await db.exec('ROLLBACK');expect((await db.query("SELECT to_regprocedure('public.require_weekly_bale_source_on_insert()') IS NULL absent")).rows).toEqual([{absent:true}]);
   expect((await db.query('SELECT status,amount_deducted::text FROM public.advances WHERE id=$1',['70000000-0000-4000-8000-000000000013'])).rows).toEqual([{status:'active',amount_deducted:'0.00'}]);
   // Model a legacy pre-schedule request in this disposable fixture only.
   await db.query('DELETE FROM public.advances WHERE id=$1',['70000000-0000-4000-8000-000000000013']);await db.exec('ALTER TABLE public.advance_requests DISABLE TRIGGER register_weekly_bale_submission');
   await db.exec(`SET test.uid='${supervisor}';SET ROLE authenticated`);const old=(await db.query<{id:string}>('INSERT INTO public.advance_requests(worker_id,project_id,requested_amount,submitted_by) VALUES($1,$2,100,$3) RETURNING id',[worker,site,supervisor])).rows[0].id;
   await db.exec('RESET ROLE; ALTER TABLE public.advance_requests ENABLE TRIGGER register_weekly_bale_submission');
   await expect(db.exec(`BEGIN; ${sql('supabase/drafts/weekly_bale_legacy_cutover_guard.sql')} COMMIT;`)).rejects.toThrow(/Unresolved legacy open requests or outstanding Bale/);await db.exec('ROLLBACK');
   expect((await db.query('SELECT status FROM public.advance_requests WHERE id=$1',[old])).rows).toEqual([{status:'pending_approval'}]);
  }finally{await db.close();}
 },30000);
 it('requires unresolved old vouchers to be reconciled before the guard can be installed',async()=>{
  const db=await fixture(false);try{
   await db.exec('RESET ROLE');await db.query("INSERT INTO public.payroll(id,worker_id,period_start,period_end,status,days_worked,hours_worked,gross_pay,bale_deduction,other_deductions,net_pay) VALUES($1,$2,'2024-11-03','2024-11-09','draft',1,8,600,0,0,600)",['70000000-0000-4000-8000-000000000011',worker]);
   for(const status of ['draft','reviewed','approved']){
    await db.query('UPDATE public.payroll SET status=$1 WHERE id=$2',[status,'70000000-0000-4000-8000-000000000011']);
    await expect(db.exec(`BEGIN; ${sql('supabase/drafts/weekly_worker_legacy_cutover_guard.sql')} COMMIT;`)).rejects.toThrow(/Unresolved legacy unpaid or unrecognized payroll/);
    await db.exec('ROLLBACK');expect((await db.query("SELECT to_regprocedure('public.require_weekly_worker_source_on_insert()') IS NULL absent")).rows).toEqual([{absent:true}]);
    expect((await db.query('SELECT status FROM public.payroll WHERE id=$1',['70000000-0000-4000-8000-000000000011'])).rows).toEqual([{status}]);
   }
  }finally{await db.close();}
 },30000);
});
