// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn()}));vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
import {ProjectCostReconciliation} from '@/components/projects/ProjectCostReconciliation';
import {projectCostReviewLedgerPreviewEnabled} from '@/lib/finance/featureAvailability';
import {parseSavedReview} from '@/lib/projects/projectCostReview';
import {baleExpense,founder,materialExpense,other,payroll,rentalExpense,rentalId,site,worker} from './helpers/project-cost-reconciliation-fixture';
const expenses=[{id:materialExpense,project_id:site,description:'Sand',category:'materials',amount:'50.00',expense_date:'2024-11-04',ai_bale_detection:false},{id:baleExpense,project_id:site,description:'Bale given',category:'other',amount:'100.00',expense_date:'2024-11-03',ai_bale_detection:true},{id:rentalExpense,project_id:site,description:'Excavator hire',category:'equipment',amount:'1000.00',expense_date:'2024-11-02',ai_bale_detection:false}];
const rentals=[{id:rentalId,expense_id:rentalExpense,project_id:site,expense_amount:'1000.00',expense_date:'2024-11-02',expense_description:'Excavator hire',item_name:'Excavator',supplier:'Supplier',quantity:1,rental_start:'2024-11-01',rental_end:'2024-11-02',confirmed_at:'2024-11-02T00:00:00Z'}];
const paid=[{payroll_id:payroll,worker_id:worker,worker_name:'Worker A',period_start:'2024-11-03',period_end:'2024-11-09',payment_date:'2024-11-09',hours:'8.00',wage:'550.00',allowance:'50.00',gross:'600.00',voucher_gross:'750.00',voucher_bale:'100.00',voucher_other:'0.00',voucher_net:'650.00'}];
const snapshot={project_id:site,captured_at:'2024-11-10T00:00:00Z',expenses,rentals,paid_allocations:paid,adjustment_cases:[]};
const decisions={[materialExpense]:{decision:'include',reason:null},[baleExpense]:{decision:'exclude',reason:'Already represented in payroll gross'},[rentalExpense]:{decision:'include',reason:null}};
const empty={project_id:site,found:false,latest_revision:0};
const saved=(id:string)=>({project_id:site,found:true,latest_revision:1,revision:1,request_id:id,actor_id:founder,recorded_at:'2024-11-10T00:00:00Z',note:'Reviewed source records',freshness:'matches',snapshot,choices:decisions,included_expenses:'1050.00',excluded_expenses:'100.00',paid_gross:'600.00',incomplete_total:'1650.00'});
const panel=()=>React.createElement(ProjectCostReconciliation,{projectId:site,userId:founder});
const key=`project-cost-review:${founder}:${site}`;
function choose(id:string,choice:string){fireEvent.click(within(screen.getByRole('group',{name:`Expense ${id}`})).getByLabelText(choice));}
async function prepare(){render(panel());fireEvent.click(screen.getByRole('button',{name:'Load review snapshot'}));await screen.findByText(/Snapshot captured/);choose(materialExpense,'Include expense');choose(baleExpense,'Exclude from this preview');choose(rentalExpense,'Include expense');fireEvent.change(screen.getByLabelText('Reason for excluding Bale given'),{target:{value:'Already represented in payroll gross'}});fireEvent.click(screen.getByRole('button',{name:'Load saved review'}));await screen.findByText(/No saved review was returned/);fireEvent.change(screen.getByLabelText(/Review note/),{target:{value:'Reviewed source records'}});}
const checkbox=()=>screen.getByRole('checkbox',{name:/I reviewed these decisions/}) as HTMLInputElement;
beforeEach(()=>{sessionStorage.clear();mock.rpc.mockReset();vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_PROJECT_COST_RECONCILIATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_PROJECT_COST_REVIEW_LEDGER_PREVIEW','true');});
afterEach(()=>{cleanup();sessionStorage.clear();vi.restoreAllMocks();vi.unstubAllEnvs();});
describe('experimental saved project cost review',()=>{
 it('is independently default-off and gated by the scratchpad',()=>{vi.stubEnv('NEXT_PUBLIC_PROJECT_COST_REVIEW_LEDGER_PREVIEW','false');expect(projectCostReviewLedgerPreviewEnabled()).toBe(false);vi.stubEnv('NEXT_PUBLIC_PROJECT_COST_REVIEW_LEDGER_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_PROJECT_COST_RECONCILIATION_PREVIEW','false');expect(projectCostReviewLedgerPreviewEnabled()).toBe(false);render(panel());expect(screen.queryByRole('region',{name:'Experimental saved cost review'})).toBeNull();});
 it('requires reasons and a renewed acknowledgement; stores only a marker and verifies the saved review',async()=>{
  let storedMarker:Record<string,unknown>|null=null;
  mock.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>{
   if(name==='project_cost_reconciliation_preview')return {data:snapshot,error:null};
   if(name==='project_cost_review')return {data:args.p_revision===null?empty:saved(storedMarker!.requestId as string),error:null};
   if(name==='record_project_cost_review'){storedMarker=JSON.parse(sessionStorage.getItem(key)!);expect(Object.keys(storedMarker!).sort()).toEqual(['actorId','expectedRevision','projectId','requestId']);expect(args.p_snapshot).toEqual(snapshot);expect(args.p_choices).toEqual(decisions);return {data:{request_id:storedMarker!.requestId,project_id:site,revision:1,replayed:false},error:null};}
   throw Error('unexpected RPC');
  });
  await prepare();expect(checkbox().disabled).toBe(false);fireEvent.click(checkbox());expect((screen.getByRole('button',{name:'Save incomplete review'}) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(screen.getByLabelText('Reason for excluding Bale given'),{target:{value:' '}});expect(checkbox().checked).toBe(false);expect(checkbox().disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Reason for excluding Bale given'),{target:{value:'Already represented in payroll gross'}});fireEvent.click(checkbox());fireEvent.click(screen.getByRole('button',{name:'Save incomplete review'}));
  await screen.findByText(/Review recorded and verified/);expect(screen.getByText(/Incomplete reviewed estimate: ₱1,650.00/)).toBeTruthy();expect(sessionStorage.getItem(key)).toBeNull();expect(mock.rpc.mock.calls.filter(c=>c[0]==='record_project_cost_review')).toHaveLength(1);
 });
 it('keeps only identifiers after a lost response and verifies the original revision after navigation',async()=>{
  let requestId='';mock.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>{
   if(name==='project_cost_reconciliation_preview')return {data:snapshot,error:null};
   if(name==='record_project_cost_review'){requestId=args.p_request as string;return {data:null,error:Error('lost response')};}
   if(name==='project_cost_review')return {data:args.p_revision===null?empty:saved(requestId),error:null};throw Error('unexpected RPC');
  });
  await prepare();fireEvent.click(checkbox());fireEvent.click(screen.getByRole('button',{name:'Save incomplete review'}));await screen.findByText(/outcome is unconfirmed/i);expect(screen.getByRole('button',{name:'Retry same review'})).toBeTruthy();const stored=sessionStorage.getItem(key)!;expect(stored).not.toContain('Worker A');expect(stored).not.toContain('1650');
  cleanup();render(panel());expect(await screen.findByText(/Unconfirmed review request/)).toBeTruthy();expect(screen.queryByRole('button',{name:'Retry same review'})).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Check saved revision'}));await screen.findByText(/Review recorded and verified/);expect(sessionStorage.getItem(key)).toBeNull();expect(mock.rpc.mock.calls.filter(c=>c[0]==='record_project_cost_review')).toHaveLength(1);
 });
 it('does not send if browser marker storage fails, and keeps unknown results unresolved',async()=>{
  mock.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>name==='project_cost_reconciliation_preview'?{data:snapshot,error:null}:name==='project_cost_review'?{data:args.p_revision===null?empty:saved('20000000-0000-0000-0000-000000000099'),error:null}:{data:null,error:Error('offline')});
  await prepare();fireEvent.click(checkbox());const spy=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('quota');});fireEvent.click(screen.getByRole('button',{name:'Save incomplete review'}));await screen.findByText(/no request was sent/i);expect(mock.rpc.mock.calls.filter(c=>c[0]==='record_project_cost_review')).toHaveLength(0);spy.mockRestore();
  fireEvent.click(screen.getByRole('button',{name:'Save incomplete review'}));await screen.findByText(/outcome is unconfirmed/i);fireEvent.click(screen.getByRole('button',{name:'Check saved revision'}));await screen.findByText(/does not prove it failed/i);expect(sessionStorage.getItem(key)).toBeTruthy();expect(screen.queryByRole('button',{name:'Save incomplete review'})).toBeNull();
  fireEvent.click(screen.getByText('Resolve an unconfirmed request'));const clear=screen.getByRole('button',{name:'Clear marker after investigation'}) as HTMLButtonElement;expect(clear.disabled).toBe(true);fireEvent.click(screen.getByRole('checkbox',{name:/request may still complete/}));fireEvent.click(clear);expect(sessionStorage.getItem(key)).toBeNull();expect(screen.getByText(/Marker cleared, not the review/)).toBeTruthy();expect(screen.getByRole('button',{name:'Load saved review'})).toBeTruthy();
 });
 it('blocks malformed markers and never assumes an empty review on read errors',async()=>{
  sessionStorage.setItem(key,JSON.stringify({requestId:'invalid',projectId:site,actorId:founder,expectedRevision:0}));render(panel());expect(await screen.findByText(/Cannot read the saved review marker/)).toBeTruthy();expect(screen.queryByRole('button',{name:'Load saved review'})).toBeNull();cleanup();sessionStorage.clear();
  mock.rpc.mockResolvedValue({data:null,error:Error('offline')});render(panel());fireEvent.click(screen.getByRole('button',{name:'Load saved review'}));await screen.findByText(/Could not verify the requested review/);expect(screen.queryByText(/No saved review was returned/)).toBeNull();expect(screen.queryByRole('button',{name:'Save incomplete review'})).toBeNull();
 });
 it('discards a late saved-review response after a project change',async()=>{
  let resolve!:(v:unknown)=>void;mock.rpc.mockReturnValue(new Promise(r=>{resolve=r;}));const view=render(panel());fireEvent.click(screen.getByRole('button',{name:'Load saved review'}));view.rerender(React.createElement(ProjectCostReconciliation,{projectId:other,userId:founder}));resolve({data:saved('20000000-0000-0000-0000-000000000001'),error:null});await new Promise(r=>setTimeout(r,0));expect(screen.queryByText(/Incomplete reviewed estimate/)).toBeNull();expect(screen.queryByText(/Reviewed source records/)).toBeNull();
 });
 it('loads saved historical revisions without treating them as the latest',async()=>{
  const id='20000000-0000-0000-0000-000000000001';mock.rpc.mockImplementation(async(_name:string,args:Record<string,unknown>)=>({data:args.p_revision===1?{...saved(id),latest_revision:2,note:'First review',freshness:'changed'}:{...saved(id),revision:2,latest_revision:2,note:'Second review'},error:null}));
  render(panel());fireEvent.click(screen.getByRole('button',{name:'Load saved review'}));await screen.findByText(/Saved revision 2/);fireEvent.click(screen.getByRole('button',{name:'Previous revision'}));await screen.findByText(/Saved revision 1/);expect(screen.getByText(/First review/)).toBeTruthy();expect(screen.getByText(/Included-source status: changed/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Next revision'}));await screen.findByText(/Saved revision 2/);expect(screen.getByText(/Second review/)).toBeTruthy();
 });
 it('shows cases captured in a saved revision as unallocated voucher evidence',async()=>{
  const correction={case_id:'20000000-0000-0000-0000-000000000010',payroll_id:payroll,worker_id:worker,difference:'25.50',reason:'Missed overtime',status:'pending',created_by:founder,created_at:'2024-11-10T01:00:00Z',resolved_by:null,resolved_at:null,settled_on:null,resolution_note:null};
  const result=saved('20000000-0000-0000-0000-000000000001');mock.rpc.mockResolvedValue({data:{...result,snapshot:{...snapshot,adjustment_cases:[correction]}},error:null});render(panel());fireEvent.click(screen.getByRole('button',{name:'Load saved review'}));await screen.findByText(/Saved revision 1/);fireEvent.click(screen.getByText('View saved adjustment signals'));expect(screen.getByText(/whole-voucher difference ₱25.50/)).toBeTruthy();expect(screen.getByText(/A case can appear at multiple sites/)).toBeTruthy();expect(screen.getByText(/Incomplete reviewed estimate: ₱1,650.00/)).toBeTruthy();
 });
 it('rejects incorrect totals, project, decisions and metadata before display',()=>{const v=saved('20000000-0000-0000-0000-000000000001');expect(parseSavedReview(v,site)).toMatchObject({found:true,total:165000n});for(const bad of [{...v,project_id:other},{...v,incomplete_total:'1650.01'},{...v,choices:{...decisions,[baleExpense]:{decision:'exclude',reason:''}}},{...v,revision:2},{...v,freshness:'complete'}])expect(()=>parseSavedReview(bad,site)).toThrow();});
});
