// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn(),today:'2026-11-21'}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
vi.mock('@/lib/reminders/scheduler',()=>({getManilaClock:()=>({dateIso:mock.today})}));
import {WeeklyWorkerActions} from '@/components/payroll/WeeklyWorkerActions';
import {buildWeeklyPreview,parseWeeklyInput} from '@/lib/payroll/weeklyPreview';
const start='2026-11-15',end='2026-11-21',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004',id='10000000-0000-4000-8000-000000000007';
const input={start,end,workers:[{id:worker,name:'Ada',position:'Mason',active:true,pay_rate:'600.00',pay_rate_type:'daily',linked_supervisor:false,possible_supervisor:false}],attendance:[{id:'a',worker_id:worker,project_id:site,date:start,status:'present',hours_worked:'8.00',time_detail:null}],vouchers:[],allowances:[],advances:[],older_advances:[]};
const row=buildWeeklyPreview(parseWeeklyInput(input,start),'2026-11-21').rows[0];
const details=(status:'draft'|'approved'|'paid')=>({payroll_id:id,worker_id:worker,period_start:start,period_end:end,status,calculation:{regular_hours:'8.00',overtime_hours:'0.00',wage:'600.00',allowance:'0.00',gross:'600.00',bale:'0.00',net:'600.00',unmarked_dates:['2026-11-16','2026-11-17','2026-11-18','2026-11-19','2026-11-20','2026-11-21']},gross:'600.00',bale:'0.00',other:'0.00',net:'600.00',payment_date:status==='paid'?end:null,approved:status!=='draft',allocations:status==='paid'?[{project_id:site,hours:'8.00',wage:'600.00',allowance:'0.00',gross:'600.00'}]:[]});
const props={row,start,end,previewDate:'2026-11-21',userId:'founder',projects:[{id:site,name:'Site One'}]};
beforeEach(()=>{mock.rpc.mockReset();mock.today='2026-11-21';localStorage.clear();sessionStorage.clear();vi.spyOn(crypto,'randomUUID').mockReturnValue(id);});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllEnvs();});

describe('experimental source-bound weekly action UI',()=>{
 it('requires separate confirmations and explicit externally-paid date, then displays saved attribution',async()=>{
  let status:'draft'|'approved'|'paid'='draft';
  mock.rpc.mockImplementation(async(name:string)=>{
   if(name==='create_weekly_worker_draft')return {data:{payroll_id:id,replayed:false},error:null};
   if(name==='approve_weekly_worker_draft'){status='approved';return {data:{outcome:'updated',payroll:{id,status}},error:null};}
   if(name==='record_weekly_worker_payment'){status='paid';return {data:{outcome:'updated',payroll:{id,status},payment_date:end},error:null};}
   if(name==='weekly_worker_draft_details')return {data:details(status),error:null};
   throw new Error(`Unexpected RPC ${name}`);
  });
  render(React.createElement(WeeklyWorkerActions,props));expect(mock.rpc).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Review new draft'}));expect(mock.rpc).not.toHaveBeenCalled();
  expect(within(screen.getByRole('dialog')).getByText(/Unmarked dates are not absences/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Create draft'}));
  await screen.findByText(/Saved status: draft/);expect(mock.rpc).toHaveBeenCalledWith('create_weekly_worker_draft',{p_id:id,p_worker:worker,p_start:start});
  fireEvent.click(screen.getByRole('button',{name:'Review approval'}));expect(mock.rpc).not.toHaveBeenCalledWith('approve_weekly_worker_draft',expect.anything());fireEvent.click(screen.getByRole('button',{name:'Confirm approval'}));
  await screen.findByText(/Saved status: approved/);fireEvent.click(screen.getByRole('button',{name:'Review external payment'}));
  const record=screen.getByRole('button',{name:'Record payment'}) as HTMLButtonElement;expect(record.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Actual external payment date'),{target:{value:end}});expect(record.disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox',{name:/I verified the external payment/}));expect(record.disabled).toBe(false);fireEvent.click(record);
  await screen.findByText(/Saved status: paid/);expect(mock.rpc).toHaveBeenCalledWith('record_weekly_worker_payment',{p_id:id,p_payment_date:end});
  expect(screen.getByText(/Site One: ₱600.00/)).toBeTruthy();expect(screen.getByText(/No money was transferred/)).toBeTruthy();expect(screen.getByText(/without reconciling Bale/)).toBeTruthy();
 });
 it('distinguishes saved past, today and future unmarked days without changing the saved voucher',async()=>{
  mock.today='2026-11-18';const existing={...row,vouchers:[{id,worker_id:worker,status:'draft' as const,period_start:start,period_end:end}]};mock.rpc.mockResolvedValue({data:details('draft'),error:null});
  render(React.createElement(WeeklyWorkerActions,{...props,previewDate:mock.today,row:existing}));fireEvent.click(screen.getByRole('button',{name:'Load voucher details'}));await screen.findByText(/Saved status: draft/);
  expect(screen.getByText('Past unmarked: 2026-11-16, 2026-11-17.')).toBeTruthy();expect(screen.getByText('Today unmarked: 2026-11-18.')).toBeTruthy();expect(screen.getByText('Upcoming: 2026-11-19, 2026-11-20, 2026-11-21.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Review approval'}));expect(within(screen.getByRole('dialog')).getByText(/upcoming: 2026-11-19/)).toBeTruthy();
 });
 it('refuses an action if the Philippine day changed before the view refreshed',async()=>{
  render(React.createElement(WeeklyWorkerActions,props));fireEvent.click(screen.getByRole('button',{name:'Review new draft'}));mock.today='2026-11-22';fireEvent.click(screen.getByRole('button',{name:'Create draft'}));
  expect(await screen.findByText(/Philippine date changed/)).toBeTruthy();expect(mock.rpc).not.toHaveBeenCalled();
 });
 it('locks on an unknown outcome and preserves the request ID across reloads',async()=>{
  mock.rpc.mockRejectedValue(new Error('Network lost'));
  const first=render(React.createElement(WeeklyWorkerActions,props));fireEvent.click(screen.getByRole('button',{name:'Review new draft'}));fireEvent.click(screen.getByRole('button',{name:'Create draft'}));
  await screen.findByText(/Outcome not confirmed/);expect((screen.getByRole('button',{name:'Review new draft'}) as HTMLButtonElement).disabled).toBe(true);
  expect(mock.rpc.mock.calls[0][1].p_id).toBe(id);first.unmount();
  vi.spyOn(crypto,'randomUUID').mockReturnValue('20000000-0000-4000-8000-000000000008');
  render(React.createElement(WeeklyWorkerActions,props));fireEvent.click(screen.getByRole('button',{name:'Review new draft'}));fireEvent.click(screen.getByRole('button',{name:'Create draft'}));
  await screen.findByText(/Outcome not confirmed/);expect(mock.rpc.mock.calls[1][1].p_id).toBe(id);
 });
 it('fails closed before generation when browser storage cannot preserve the retry ID',async()=>{
  vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('Storage unavailable');});
  render(React.createElement(WeeklyWorkerActions,props));fireEvent.click(screen.getByRole('button',{name:'Review new draft'}));fireEvent.click(screen.getByRole('button',{name:'Create draft'}));
  await screen.findByText(/Storage unavailable/);expect(mock.rpc).not.toHaveBeenCalled();
 });
 it('never allows future or pre-period dates in the external payment confirmation',async()=>{
  const existing={...row,vouchers:[{id,worker_id:worker,status:'approved' as const,period_start:start,period_end:end}]};
  mock.rpc.mockResolvedValue({data:details('approved'),error:null});render(React.createElement(WeeklyWorkerActions,{...props,row:existing}));
  fireEvent.click(screen.getByRole('button',{name:'Load voucher details'}));await screen.findByText(/Saved status: approved/);fireEvent.click(screen.getByRole('button',{name:'Review external payment'}));
  fireEvent.click(screen.getByRole('checkbox',{name:/I verified/}));const button=screen.getByRole('button',{name:'Record payment'}) as HTMLButtonElement;
  fireEvent.change(screen.getByLabelText('Actual external payment date'),{target:{value:'2026-11-22'}});expect(button.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Actual external payment date'),{target:{value:'2026-11-14'}});expect(button.disabled).toBe(true);expect(mock.rpc).toHaveBeenCalledTimes(1);
 });
 it('refuses malformed saved details and cannot approve them',async()=>{
  const existing={...row,vouchers:[{id,worker_id:worker,status:'draft' as const,period_start:start,period_end:end}]};
  mock.rpc.mockResolvedValue({data:{...details('draft'),net:'999.00'},error:null});render(React.createElement(WeeklyWorkerActions,{...props,row:existing}));
  fireEvent.click(screen.getByRole('button',{name:'Load voucher details'}));await screen.findByText(/Outcome not confirmed/);expect(screen.queryByRole('button',{name:'Review approval'})).toBeNull();
 });
 it('does not offer generation for an overlap or an unmarked-only week',()=>{
  const overlap={...row,vouchers:[{id,worker_id:worker,status:'paid' as const,period_start:'2026-11-14',period_end:end}]};
  const view=render(React.createElement(WeeklyWorkerActions,{...props,row:overlap}));expect(screen.queryByRole('button',{name:'Review new draft'})).toBeNull();
  view.rerender(React.createElement(WeeklyWorkerActions,{...props,row:{...row,days:row.days.map(d=>({...d,entries:[]}))}}));expect(screen.queryByRole('button',{name:'Review new draft'})).toBeNull();
 });
});


describe('revision-aware draft refresh UI (independent gate)',()=>{
 const existing={...row,vouchers:[{id,worker_id:worker,status:'draft' as const,period_start:start,period_end:end}]};
 const request='20000000-0000-4000-8000-000000000008';
 const version=(n:number)=>({...details('draft'),draft_revision:n});
 function enable(){vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_WEEKLY_WORKER_ACTIONS_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_WEEKLY_WORKER_REFRESH_PREVIEW','true');}
 it('requires all three gates and a valid server revision',async()=>{
  const {weeklyWorkerRefreshPreviewEnabled}=await import('@/lib/finance/featureAvailability');enable();expect(weeklyWorkerRefreshPreviewEnabled()).toBe(true);
  vi.stubEnv('NEXT_PUBLIC_WEEKLY_WORKER_ACTIONS_PREVIEW','false');expect(weeklyWorkerRefreshPreviewEnabled()).toBe(false);vi.stubEnv('NEXT_PUBLIC_WEEKLY_WORKER_ACTIONS_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','false');expect(weeklyWorkerRefreshPreviewEnabled()).toBe(false);
  enable();mock.rpc.mockResolvedValue({data:details('draft'),error:null});render(React.createElement(WeeklyWorkerActions,{...props,row:existing}));fireEvent.click(screen.getByRole('button',{name:'Load voucher details'}));await screen.findByText(/Invalid weekly draft revision/);expect(screen.queryByRole('button',{name:'Review approval'})).toBeNull();
 });
 it('refreshes only after confirmation, checks the saved revision, and approves precisely that revision',async()=>{
  enable();vi.spyOn(crypto,'randomUUID').mockReturnValue(request);let revision=0,status:'draft'|'approved'='draft';
  const refreshed=()=>({...details(status),draft_revision:revision,gross:'1200.00',net:'1200.00',calculation:{...details(status).calculation,regular_hours:'16.00',wage:'1200.00',gross:'1200.00',net:'1200.00'}});
  mock.rpc.mockImplementation(async(name:string)=>{
   if(name==='weekly_worker_draft_details')return {data:revision?refreshed():{...details(status),draft_revision:revision},error:null};
   if(name==='refresh_weekly_worker_draft'){revision=1;return {data:{payroll_id:id,replayed:false,revision,calculation:refreshed().calculation},error:null};}
   if(name==='approve_weekly_worker_draft'){status='approved';return {data:{outcome:'updated',payroll:{id,status}},error:null};}throw Error(name);
  });
  render(React.createElement(WeeklyWorkerActions,{...props,row:existing}));fireEvent.click(screen.getByRole('button',{name:'Load voucher details'}));await screen.findByText(/revision 0/);
  fireEvent.click(screen.getByRole('button',{name:'Review draft refresh'}));expect(mock.rpc).toHaveBeenCalledTimes(1);expect(screen.getByText(/previous snapshot is retained/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Refresh draft'}));
  await screen.findByText(/revision 1/);expect(screen.getByText(/gross ₱1200.00/)).toBeTruthy();expect(mock.rpc).toHaveBeenCalledWith('refresh_weekly_worker_draft',{p_request:request,p_id:id,p_expected_revision:0});expect(sessionStorage.length).toBe(0);
  fireEvent.click(screen.getByRole('button',{name:'Review approval'}));expect(screen.getByText(/approving revision 1/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Confirm approval'}));await screen.findByText(/Saved status: approved/);
  expect(mock.rpc).toHaveBeenCalledWith('approve_weekly_worker_draft',{p_id:id,p_expected_revision:1});expect(screen.queryByRole('button',{name:'Review draft refresh'})).toBeNull();
 });
 it('preserves and retries the exact uncertain request across reloads before enabling approval',async()=>{
  enable();vi.spyOn(crypto,'randomUUID').mockReturnValue(request);let first=true;
  mock.rpc.mockImplementation(async(name:string)=>{
   if(name==='weekly_worker_draft_details')return {data:version(first?0:1),error:null};
   if(name==='refresh_weekly_worker_draft'){if(first){first=false;throw Error('connection lost');}return {data:{payroll_id:id,replayed:true,revision:1,calculation:details('draft').calculation},error:null};}throw Error(name);
  });
  const view=render(React.createElement(WeeklyWorkerActions,{...props,row:existing}));fireEvent.click(screen.getByRole('button',{name:'Load voucher details'}));await screen.findByText(/revision 0/);fireEvent.click(screen.getByRole('button',{name:'Review draft refresh'}));fireEvent.click(screen.getByRole('button',{name:'Refresh draft'}));
  await screen.findByText(/Refresh outcome not confirmed/);expect(screen.queryByRole('button',{name:'Review approval'})).toBeNull();expect(sessionStorage.length).toBe(1);view.unmount();
  render(React.createElement(WeeklyWorkerActions,{...props,row:existing}));expect(screen.getByRole('button',{name:'Retry exact refresh'})).toBeTruthy();expect(screen.queryByRole('button',{name:'Load voucher details'})).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Retry exact refresh'}));
  await screen.findByText(/revision 1/);expect(mock.rpc.mock.calls.filter(c=>c[0]==='refresh_weekly_worker_draft').map(c=>c[1])).toEqual(Array(2).fill({p_request:request,p_id:id,p_expected_revision:0}));expect(sessionStorage.length).toBe(0);
 });
 it('blocks approval if a concurrent revision wins after refresh and preserves the retry record',async()=>{
  enable();vi.spyOn(crypto,'randomUUID').mockReturnValue(request);let count=0;
  mock.rpc.mockImplementation(async(name:string)=>name==='weekly_worker_draft_details'?{data:version(count++<2?0:2),error:null}:{data:{payroll_id:id,replayed:false,revision:1,calculation:details('draft').calculation},error:null});
  render(React.createElement(WeeklyWorkerActions,{...props,row:existing}));fireEvent.click(screen.getByRole('button',{name:'Load voucher details'}));await screen.findByText(/revision 0/);fireEvent.click(screen.getByRole('button',{name:'Review draft refresh'}));fireEvent.click(screen.getByRole('button',{name:'Refresh draft'}));
  await screen.findByText(/Refresh outcome not confirmed/);expect(screen.queryByRole('button',{name:'Review approval'})).toBeNull();expect(sessionStorage.length).toBe(1);
 });
 it('fails closed if retry storage cannot be written, before sending',async()=>{
  enable();vi.spyOn(crypto,'randomUUID').mockReturnValue(request);mock.rpc.mockResolvedValue({data:version(0),error:null});
  render(React.createElement(WeeklyWorkerActions,{...props,row:existing}));fireEvent.click(screen.getByRole('button',{name:'Load voucher details'}));await screen.findByText(/revision 0/);fireEvent.click(screen.getByRole('button',{name:'Review draft refresh'}));
  vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('unavailable');});fireEvent.click(screen.getByRole('button',{name:'Refresh draft'}));await screen.findByText(/Retry storage could not be verified/);
  expect(mock.rpc.mock.calls.filter(c=>c[0]==='refresh_weekly_worker_draft')).toHaveLength(0);expect(screen.queryByRole('button',{name:'Review approval'})).toBeNull();
 });
 it('checks the worker and period before replaying a stored request',async()=>{
  enable();sessionStorage.setItem(JSON.stringify(['weekly-worker-refresh-v1','founder',worker,start]),JSON.stringify({request,payroll:id,revision:0}));mock.rpc.mockResolvedValue({data:{...version(0),worker_id:'another'},error:null});
  render(React.createElement(WeeklyWorkerActions,{...props,row:existing}));fireEvent.click(screen.getByRole('button',{name:'Retry exact refresh'}));await screen.findByText(/Refresh outcome not confirmed/);
  expect(mock.rpc.mock.calls.filter(c=>c[0]==='refresh_weekly_worker_draft')).toHaveLength(0);expect(sessionStorage.length).toBe(1);
 });
 it('fails closed on corrupt or unavailable retry storage without sending a refresh',async()=>{
  enable();sessionStorage.setItem(JSON.stringify(['weekly-worker-refresh-v1','founder',worker,start]),'broken');
  render(React.createElement(WeeklyWorkerActions,{...props,row:existing}));expect(await screen.findByText(/refresh or return may have been sent/)).toBeTruthy();expect(screen.queryByRole('button',{name:'Load voucher details'})).toBeNull();expect(mock.rpc).not.toHaveBeenCalled();
 });
});


describe('approved voucher return and revision-bound payment UI',()=>{
 const existing={...row,vouchers:[{id,worker_id:worker,status:'approved' as const,period_start:start,period_end:end}]};
 const request='20000000-0000-4000-8000-000000000008';
 function enable(){vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_WEEKLY_WORKER_ACTIONS_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_WEEKLY_WORKER_REFRESH_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_WEEKLY_WORKER_RETURN_PREVIEW','true');}
 it('requires all gates and confirmation of no external payment with a reason',async()=>{
  const {weeklyWorkerReturnPreviewEnabled}=await import('@/lib/finance/featureAvailability');enable();expect(weeklyWorkerReturnPreviewEnabled()).toBe(true);vi.stubEnv('NEXT_PUBLIC_WEEKLY_WORKER_REFRESH_PREVIEW','false');expect(weeklyWorkerReturnPreviewEnabled()).toBe(false);enable();
  vi.spyOn(crypto,'randomUUID').mockReturnValue(request);let status:'approved'|'draft'='approved',revision=0;
  mock.rpc.mockImplementation(async(name:string)=>{
   if(name==='weekly_worker_draft_details')return {data:{...details(status),draft_revision:revision},error:null};
   if(name==='return_weekly_worker_to_draft'){status='draft';revision=1;return {data:{payroll_id:id,replayed:false,revision},error:null};}throw Error(name);
  });
  render(React.createElement(WeeklyWorkerActions,{...props,row:existing}));fireEvent.click(screen.getByRole('button',{name:'Load voucher details'}));await screen.findByText(/Saved status: approved/);
  fireEvent.click(screen.getByRole('button',{name:'Review return to draft'}));expect(screen.getByText(/If payment may have happened/)).toBeTruthy();
  const button=screen.getByRole('button',{name:'Return to draft'}) as HTMLButtonElement;expect(button.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Reason for returning to draft'),{target:{value:'  Saturday attendance  '}});expect(button.disabled).toBe(true);fireEvent.click(screen.getByRole('checkbox',{name:/I verified no external payment/}));expect(button.disabled).toBe(false);fireEvent.click(button);
  await screen.findByText(/Saved status: draft/);expect(screen.getByText(/saved amount is unchanged/)).toBeTruthy();expect(mock.rpc).toHaveBeenCalledWith('return_weekly_worker_to_draft',{p_request:request,p_id:id,p_expected_revision:0,p_reason:'Saturday attendance'});expect(sessionStorage.length).toBe(0);
 });
 it('records payment only for the reviewed revision and never offers return for paid vouchers',async()=>{
  enable();let status:'approved'|'paid'='approved';mock.rpc.mockImplementation(async(name:string)=>name==='weekly_worker_draft_details'?{data:{...details(status),draft_revision:2},error:null}:(status='paid',{data:{outcome:'updated',payroll:{id,status},payment_date:end},error:null}));
  render(React.createElement(WeeklyWorkerActions,{...props,row:existing}));fireEvent.click(screen.getByRole('button',{name:'Load voucher details'}));await screen.findByText(/Saved status: approved/);fireEvent.click(screen.getByRole('button',{name:'Review external payment'}));fireEvent.change(screen.getByLabelText('Actual external payment date'),{target:{value:end}});fireEvent.click(screen.getByRole('checkbox',{name:/I verified the external payment/}));fireEvent.click(screen.getByRole('button',{name:'Record payment'}));
  await screen.findByText(/Saved status: paid/);expect(mock.rpc).toHaveBeenCalledWith('record_weekly_worker_payment',{p_id:id,p_payment_date:end,p_expected_revision:2});expect(screen.queryByRole('button',{name:'Review return to draft'})).toBeNull();
 });
 it('retries an uncertain return with the same exact ID, reason and revision across reload',async()=>{
  enable();vi.spyOn(crypto,'randomUUID').mockReturnValue(request);let first=true;mock.rpc.mockImplementation(async(name:string)=>{
   if(name==='weekly_worker_draft_details')return {data:{...details(first?'approved':'draft'),draft_revision:first?0:1},error:null};
   if(name==='return_weekly_worker_to_draft'){if(first){first=false;throw Error('lost');}return {data:{payroll_id:id,replayed:true,revision:1},error:null};}throw Error(name);
  });
  const view=render(React.createElement(WeeklyWorkerActions,{...props,row:existing}));fireEvent.click(screen.getByRole('button',{name:'Load voucher details'}));await screen.findByText(/Saved status: approved/);fireEvent.click(screen.getByRole('button',{name:'Review return to draft'}));fireEvent.change(screen.getByLabelText('Reason for returning to draft'),{target:{value:'Attendance changed'}});fireEvent.click(screen.getByRole('checkbox',{name:/I verified no external payment/}));fireEvent.click(screen.getByRole('button',{name:'Return to draft'}));await screen.findByText(/Return outcome not confirmed/);view.unmount();
  render(React.createElement(WeeklyWorkerActions,{...props,row:existing}));expect(screen.queryByRole('button',{name:'Load voucher details'})).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Retry exact return'}));await screen.findByText(/Saved status: draft/);
  expect(mock.rpc.mock.calls.filter(c=>c[0]==='return_weekly_worker_to_draft').map(c=>c[1])).toEqual(Array(2).fill({p_request:request,p_id:id,p_expected_revision:0,p_reason:'Attendance changed'}));expect(sessionStorage.length).toBe(0);
 });
 it('refuses to send a return if retry storage cannot be preserved',async()=>{
  enable();vi.spyOn(crypto,'randomUUID').mockReturnValue(request);mock.rpc.mockResolvedValue({data:{...details('approved'),draft_revision:0},error:null});
  render(React.createElement(WeeklyWorkerActions,{...props,row:existing}));fireEvent.click(screen.getByRole('button',{name:'Load voucher details'}));await screen.findByText(/Saved status: approved/);fireEvent.click(screen.getByRole('button',{name:'Review return to draft'}));fireEvent.change(screen.getByLabelText('Reason for returning to draft'),{target:{value:'Correction'}});fireEvent.click(screen.getByRole('checkbox',{name:/I verified no external payment/}));vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('unavailable');});fireEvent.click(screen.getByRole('button',{name:'Return to draft'}));
  await screen.findByText(/Retry storage could not be verified/);expect(mock.rpc.mock.calls.filter(c=>c[0]==='return_weekly_worker_to_draft')).toHaveLength(0);expect(screen.queryByRole('button',{name:'Review external payment'})).toBeNull();
 });
 it('rejects a replay for a mismatched worker and blocks a stale payment response',async()=>{
  enable();sessionStorage.setItem(JSON.stringify(['weekly-worker-return-v1','founder',worker,start]),JSON.stringify({request,payroll:id,revision:0,reason:'Attendance'}));mock.rpc.mockResolvedValue({data:{...details('approved'),worker_id:'other',draft_revision:0},error:null});
  const view=render(React.createElement(WeeklyWorkerActions,{...props,row:existing}));fireEvent.click(screen.getByRole('button',{name:'Retry exact return'}));await screen.findByText(/Return outcome not confirmed/);expect(mock.rpc.mock.calls.filter(c=>c[0]==='return_weekly_worker_to_draft')).toHaveLength(0);view.unmount();sessionStorage.clear();mock.rpc.mockReset();
  mock.rpc.mockImplementation(async(name:string)=>name==='weekly_worker_draft_details'?{data:{...details('approved'),draft_revision:2},error:null}:{data:null,error:{message:'Voucher revision changed'}});
  render(React.createElement(WeeklyWorkerActions,{...props,row:existing}));fireEvent.click(screen.getByRole('button',{name:'Load voucher details'}));await screen.findByText(/Saved status: approved/);fireEvent.click(screen.getByRole('button',{name:'Review external payment'}));fireEvent.change(screen.getByLabelText('Actual external payment date'),{target:{value:end}});fireEvent.click(screen.getByRole('checkbox',{name:/I verified the external payment/}));fireEvent.click(screen.getByRole('button',{name:'Record payment'}));await screen.findByText(/Voucher revision changed/);expect(screen.queryByText(/Saved status: paid/)).toBeNull();
 });
 it('fails closed when result is stale or retry storage is corrupted',async()=>{
  enable();vi.spyOn(crypto,'randomUUID').mockReturnValue(request);let count=0;mock.rpc.mockImplementation(async(name:string)=>name==='weekly_worker_draft_details'?{data:{...details(count++<2?'approved':'draft'),draft_revision:count<=2?0:2},error:null}:{data:{payroll_id:id,replayed:false,revision:1},error:null});
  const view=render(React.createElement(WeeklyWorkerActions,{...props,row:existing}));fireEvent.click(screen.getByRole('button',{name:'Load voucher details'}));await screen.findByText(/Saved status: approved/);fireEvent.click(screen.getByRole('button',{name:'Review return to draft'}));fireEvent.change(screen.getByLabelText('Reason for returning to draft'),{target:{value:'Correction'}});fireEvent.click(screen.getByRole('checkbox',{name:/I verified no external payment/}));fireEvent.click(screen.getByRole('button',{name:'Return to draft'}));await screen.findByText(/Return outcome not confirmed/);expect(screen.queryByRole('button',{name:'Review approval'})).toBeNull();expect(sessionStorage.length).toBe(1);view.unmount();
  sessionStorage.clear();sessionStorage.setItem(JSON.stringify(['weekly-worker-return-v1','founder',worker,start]),'{bad');render(React.createElement(WeeklyWorkerActions,{...props,row:existing}));expect(await screen.findByText(/refresh or return may have been sent/)).toBeTruthy();expect(screen.queryByRole('button',{name:'Load voucher details'})).toBeNull();
 });
});
