// @vitest-environment jsdom
// Synthetic, in-memory database only. This cannot send or prove cash payments.
import React from 'react';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
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
const founder='00000000-0000-0000-0000-000000000001',supervisor='00000000-0000-0000-0000-000000000002',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004';
const attendance='70000000-0000-4000-8000-000000000001',voucher='70000000-0000-4000-8000-000000000002';
const sql=(p:string)=>readFileSync(p,'utf8');
afterEach(()=>{cleanup();localStorage.clear();sessionStorage.clear();vi.restoreAllMocks();vi.unstubAllEnvs();});
async function fixture(){
 const db=new PGlite();await db.exec(baseFixture);
 await db.exec(`ALTER TABLE public.users ADD COLUMN email text;UPDATE public.users SET email='fixture@example.invalid';
  ALTER TABLE public.payroll ADD COLUMN notes text;ALTER TABLE public.advances ADD COLUMN reason text, ADD COLUMN created_at timestamptz DEFAULT now();ALTER TABLE public.advances ALTER COLUMN id SET DEFAULT gen_random_uuid();
  ALTER TABLE public.advance_requests ADD COLUMN approved_by uuid,ADD COLUMN approved_at timestamptz,ADD COLUMN rejected_by uuid,ADD COLUMN rejected_at timestamptz,ADD COLUMN issued_by uuid,ADD COLUMN updated_at timestamptz DEFAULT now();
  ALTER TABLE public.advance_requests ADD CONSTRAINT advance_request_rejection_fields CHECK(status<>'rejected' OR (rejected_by IS NOT NULL AND rejected_at IS NOT NULL));
  CREATE TABLE public.project_worker_assignments(project_id uuid,worker_id uuid,active boolean,primary key(project_id,worker_id));INSERT INTO public.project_worker_assignments VALUES('${site}','${worker}',true);
  DROP TABLE public.audit_log;CREATE TABLE public.audit_log(actor_id uuid,actor_email text,action text,table_name text,record_id uuid,before_row jsonb,after_row jsonb);
  CREATE POLICY test_founder_payroll_write ON public.payroll FOR ALL TO authenticated USING(public.is_founder()) WITH CHECK(public.is_founder());
  INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at) VALUES('${attendance}','${worker}','${site}','2024-11-03','present',8,'2024-11-03T08:00:00Z');`);
 const paths=['supabase/migrations/20261102000000_atomic_payroll_payments.sql','supabase/migrations/20261113000000_weekly_worker_preview.sql','supabase/migrations/20261113000001_attendance_time_detail.sql','supabase/migrations/20261113000002_worker_allowances.sql','supabase/migrations/20261113000003_weekly_payroll_context.sql','supabase/drafts/guard_legacy_bale_payment.sql','supabase/drafts/weekly_payment_date.sql','supabase/drafts/weekly_worker_generator.sql','supabase/drafts/weekly_worker_approval.sql','supabase/drafts/weekly_worker_paid_allocation.sql','supabase/drafts/weekly_worker_draft_details.sql','supabase/drafts/weekly_worker_draft_refresh.sql','supabase/drafts/weekly_worker_return_to_draft.sql','supabase/migrations/20261013000000_advance_requests.sql','supabase/migrations/20261013000001_advance_request_notifications.sql','supabase/migrations/20261113000004_bale_request_site_guard.sql','supabase/drafts/weekly_bale_schedule.sql','supabase/drafts/weekly_bale_expiration.sql','supabase/drafts/weekly_bale_release_list.sql'];
 for(const p of paths)await db.exec(sql(p));
 await db.exec(`CREATE OR REPLACE FUNCTION public.weekly_bale_clock() RETURNS timestamptz LANGUAGE sql VOLATILE SET search_path='' AS $$SELECT current_setting('test.clock')::timestamptz$$;
 SET test.assurance='yes';SET test.uid='${supervisor}';SET test.clock='2024-11-03T04:00:00Z';SET ROLE authenticated`);
 return db;
}

describe('weekly Bale through worker payroll: candidate UI and synthetic SQL',()=>{
 it('records one release and one external payment, recovering safely from lost responses',async()=>{
  for(const name of ['NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','NEXT_PUBLIC_WEEKLY_WORKER_ACTIONS_PREVIEW','NEXT_PUBLIC_WEEKLY_WORKER_REFRESH_PREVIEW','NEXT_PUBLIC_WEEKLY_WORKER_RETURN_PREVIEW'])vi.stubEnv(name,'true');
  mock.today='2024-11-06';mock.actor=supervisor;mock.supervisor=true;mock.founder=false;const db=await fixture();try{
   const req=(await db.query<{id:string}>('INSERT INTO public.advance_requests(worker_id,project_id,requested_amount,submitted_by) VALUES($1,$2,100.25,$3) RETURNING id',[worker,site,supervisor])).rows[0].id;
   await db.exec(`SET test.uid='${founder}';SET test.clock='2024-11-05T04:00:00Z'`);await db.query("SELECT public.review_advance_request($1,'approve')",[req]);
   await db.query("SELECT public.record_attendance_time_detail('70000000-0000-4000-8000-000000000003',$1,'2024-11-03T08:00:00Z',8,2,'Synthetic overtime')",[attendance]);
   await db.query("SELECT public.submit_worker_allowance('70000000-0000-4000-8000-000000000004',$1,'2024-11-03T08:00:00Z',50.25,'Synthetic allowance')",[attendance]);
   await db.exec(`SET test.uid='${supervisor}';SET test.clock='2024-11-06T04:00:00Z'`);
   let loseRelease=true,losePayment=true;mock.rpc.mockReset();mock.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>{
    try{
     const calls:Record<string,{query:string;params:unknown[]}>= {
      weekly_bale_release_list:{query:'SELECT public.weekly_bale_release_list($1) v',params:[args.p_start]},
      record_weekly_bale_release:{query:'SELECT public.record_weekly_bale_release($1) v',params:[args.p_request_id]},
      weekly_worker_preview_inputs:{query:'SELECT public.weekly_worker_preview_inputs($1) v',params:[args.p_start]},
      create_weekly_worker_draft:{query:'SELECT public.create_weekly_worker_draft($1,$2,$3) v',params:[args.p_id,args.p_worker,args.p_start]},
      weekly_worker_draft_details:{query:'SELECT public.weekly_worker_draft_details($1) v',params:[args.p_id]},
      approve_weekly_worker_draft:{query:'SELECT public.approve_weekly_worker_draft($1,$2) v',params:[args.p_id,args.p_expected_revision]},
      record_weekly_worker_payment:{query:'SELECT public.record_weekly_worker_payment($1,$2,$3) v',params:[args.p_id,args.p_payment_date,args.p_expected_revision]},
     };
     const call=calls[name];if(!call)throw Error(`Unexpected RPC ${name}`);const data=(await db.query<{v:unknown}>(call.query,call.params)).rows[0].v;
     if(name==='record_weekly_bale_release'&&loseRelease){loseRelease=false;return {data:null,error:Error('Synthetic lost response after commit')};}
     if(name==='record_weekly_worker_payment'&&losePayment){losePayment=false;return {data:null,error:Error('Synthetic lost response after commit')};}
     return {data,error:null};
    }catch(error){return {data:null,error};}
   });
   // Supervisor records a release only after acknowledging the simulated cash handover.
   render(React.createElement(WeeklyBaleReleasePanel));fireEvent.click(screen.getByRole('button',{name:'Experimental weekly Bale release'}));fireEvent.click(screen.getByRole('button',{name:'Load releases'}));
   await screen.findByText(/Test Worker.*Site One.*100.25/);fireEvent.click(screen.getByRole('button',{name:'Review external release'}));fireEvent.click(screen.getByRole('checkbox',{name:/verified this external release/}));fireEvent.click(screen.getByRole('button',{name:'Record release'}));
   await screen.findByText(/Release not confirmed/);fireEvent.click(screen.getByRole('button',{name:'Load releases'}));await screen.findByText('Release recorded · Wednesday 2024-11-06');expect(screen.queryByRole('button',{name:'Review external release'})).toBeNull();cleanup();
   // Founder uses the actual weekly preview and revision-aware voucher actions.
   mock.today='2024-11-09';mock.actor=founder;mock.founder=true;mock.supervisor=false;await db.exec(`SET test.uid='${founder}'`);vi.spyOn(crypto,'randomUUID').mockReturnValue(voucher);
   render(React.createElement(WeeklyWorkerPreview));expect(screen.getByText(/experimental voucher actions available/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:/Weekly worker planning preview/}));fireEvent.click(screen.getByRole('button',{name:'Load preview'}));await screen.findByText(/gross with allowances ₱800.25/);expect(screen.getByText(/Experimental voucher actions are available in the final column/)).toBeTruthy();
   fireEvent.click(screen.getByRole('button',{name:'Review new draft'}));fireEvent.click(screen.getByRole('button',{name:'Create draft'}));await screen.findByText(/Saved status: draft/);expect(screen.getByText(/gross ₱800.25 · Bale ₱100.25 · net ₱700.00/)).toBeTruthy();
   fireEvent.click(screen.getByRole('button',{name:'Review approval'}));fireEvent.click(screen.getByRole('button',{name:'Confirm approval'}));await screen.findByText(/Saved status: approved/);
   fireEvent.click(screen.getByRole('button',{name:'Review external payment'}));fireEvent.change(screen.getByLabelText('Actual external payment date'),{target:{value:'2024-11-09'}});fireEvent.click(screen.getByRole('checkbox',{name:/I verified the external payment/}));fireEvent.click(screen.getByRole('button',{name:'Record payment'}));await screen.findByText(/Outcome not confirmed/);expect(screen.queryByText(/Saved status: paid/)).toBeNull();
   cleanup();render(React.createElement(WeeklyWorkerPreview));fireEvent.click(screen.getByRole('button',{name:/Weekly worker planning preview/}));fireEvent.click(screen.getByRole('button',{name:'Load preview'}));await screen.findByRole('button',{name:'Load voucher details'});fireEvent.click(screen.getByRole('button',{name:'Load voucher details'}));await screen.findByText(/Saved status: paid/);expect(screen.getByText(/Recorded external payment date: 2024-11-09/)).toBeTruthy();expect(screen.getByText(/Site One: ₱800.25/)).toBeTruthy();
   await db.exec('RESET ROLE');expect((await db.query('SELECT status,gross_pay::text gross,bale_deduction::text bale,net_pay::text net FROM public.payroll WHERE id=$1',[voucher])).rows).toEqual([{status:'paid',gross:'800.25',bale:'100.25',net:'700.00'}]);
   expect((await db.query('SELECT amount::text amount,amount_deducted::text deducted,status FROM public.advances WHERE worker_id=$1',[worker])).rows).toEqual([{amount:'100.25',deducted:'100.25',status:'fully_deducted'}]);
   expect((await db.query('SELECT project_id,gross::text gross FROM public.weekly_worker_paid_allocations WHERE payroll_id=$1',[voucher])).rows).toEqual([{project_id:site,gross:'800.25'}]);
   expect(mock.rpc.mock.calls.filter(c=>c[0]==='record_weekly_bale_release')).toHaveLength(1);expect(mock.rpc.mock.calls.filter(c=>c[0]==='record_weekly_worker_payment')).toHaveLength(1);
  }finally{cleanup();await db.close();}
 },30000);
 it('blocks stale approval after a late Bale release, then refreshes and approves the revised amount',async()=>{
  for(const name of ['NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','NEXT_PUBLIC_WEEKLY_WORKER_ACTIONS_PREVIEW','NEXT_PUBLIC_WEEKLY_WORKER_REFRESH_PREVIEW','NEXT_PUBLIC_WEEKLY_WORKER_RETURN_PREVIEW'])vi.stubEnv(name,'true');
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
});
