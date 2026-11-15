// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:m.rpc})}));
import {ProjectReviewedCostSummary} from '@/components/projects/ProjectReviewedCostSummary';
import {actor,inventory,request,result,saved,site} from './helpers/corrected-cost-ui-fixture';
import {crossFixture,key} from './helpers/cross-site-cost-review-fixture';
const other='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const covered=(review:unknown,project=site,counts:Record<string,number>={})=>({project_id:project,captured_at:'2024-12-15T00:00:00Z',unallocated_paid:0,attendance_matches:0,inconsistent_allocations:0,unattributed_history:0,...counts,review});
beforeEach(()=>m.rpc.mockReset());afterEach(()=>{cleanup();vi.unstubAllEnvs();});
const panel=(projectId=site,userId=actor,onReview=vi.fn())=>React.createElement(ProjectReviewedCostSummary,{projectId,userId,onReview});
describe('reviewed project cost overview',()=>{
 it('shows a recorded amount only when the current snapshot has no known review issues',async()=>{
  for(const flag of ['FINANCE_FOUNDATION_PREVIEW','PROJECT_COST_CORRECTION_PREVIEW','CORRECTED_PROJECT_COST_REVIEW_PREVIEW','SIMPLE_RECORDED_COST_PREVIEW'])vi.stubEnv(`NEXT_PUBLIC_${flag}`,'true');
  const empty={project_id:site,found:false,latest_revision:0},coverage={...covered(empty),captured_at:inventory.historical_review.base.captured_at},snapshot={project_id:site,coverage,inventory:structuredClone(inventory)},risk=structuredClone(snapshot);risk.inventory.historical_review.base.expenses[0].description='Bale';
  m.rpc.mockResolvedValueOnce({data:snapshot,error:null}).mockResolvedValueOnce({data:risk,error:null});render(panel());await screen.findByText('Recorded cost so far: ₱1,038.00');expect(screen.getByText(/not proof of payment or a complete accounting/)).toBeTruthy();expect(m.rpc).toHaveBeenCalledWith('project_recorded_cost_snapshot',{p_project:site});
  fireEvent.click(screen.getByRole('button',{name:'Refresh reviewed cost'}));await screen.findByText(/Recorded cost needs review/);expect(screen.getByText(/Some expenses may duplicate/)).toBeTruthy();expect(screen.queryByText(/Recorded cost so far/)).toBeNull();
 });
 it('keeps the simple amount with older-pay support enabled but hides it for an affected site',async()=>{
  for(const flag of ['FINANCE_FOUNDATION_PREVIEW','PROJECT_COST_CORRECTION_PREVIEW','CORRECTED_PROJECT_COST_REVIEW_PREVIEW','SIMPLE_RECORDED_COST_PREVIEW','LEGACY_VOUCHER_ATTRIBUTION_PREVIEW'])vi.stubEnv(`NEXT_PUBLIC_${flag}`,'true');
  const empty={project_id:site,found:false,latest_revision:0},coverage={...covered(empty),captured_at:inventory.historical_review.base.captured_at};
  const ordinary={project_id:site,coverage,inventory:structuredClone(inventory)},legacy={...coverage,legacy_site_attributions:0,changed_legacy_attributions:0,legacy_review:empty};
  m.rpc.mockResolvedValueOnce({data:{project_id:site,legacy,ordinary},error:null}).mockResolvedValueOnce({data:{project_id:site,legacy:{...legacy,legacy_site_attributions:1},ordinary},error:null});
  render(panel());await screen.findByText('Recorded cost so far: ₱1,038.00');expect(m.rpc).toHaveBeenCalledWith('project_cost_legacy_recorded_snapshot',{p_project:site});
  fireEvent.click(screen.getByRole('button',{name:'Refresh reviewed cost'}));await screen.findByText(/Older voucher attribution exists/);expect(screen.queryByText(/Recorded cost so far/)).toBeNull();
 });
 it('shows verified expenses, payroll and signed corrections without double adding them',async()=>{
  m.rpc.mockResolvedValue({data:covered(saved(request)),error:null});const open=vi.fn();render(panel(site,actor,open));
  await screen.findByText('Reviewed cost: ₱1,038.00');expect(screen.getByText(/Included expenses ₱50.25.*paid worker payroll ₱600.00.*included historical payroll ₱400.25.*corrections −₱12.50/)).toBeTruthy();
  expect(screen.getByText(/does not prove completeness or payment/)).toBeTruthy();expect(m.rpc).toHaveBeenCalledWith('project_cost_recorded_coverage',{p_project:site});fireEvent.click(screen.getByRole('button',{name:'Open cost review'}));expect(open).toHaveBeenCalledOnce();
 });
 it.each(['changed','unavailable'])('hides a %s review total on refresh',async status=>{
  m.rpc.mockResolvedValueOnce({data:covered(saved(request)),error:null}).mockResolvedValueOnce({data:covered({...saved(request),freshness:status}),error:null});render(panel());await screen.findByText('Reviewed cost: ₱1,038.00');fireEvent.click(screen.getByRole('button',{name:'Refresh reviewed cost'}));await screen.findByRole('alert');expect(screen.queryByText('Reviewed cost: ₱1,038.00')).toBeNull();
 });
 it('shows global attribution gaps and a site attendance clue, without claiming completeness',async()=>{
  m.rpc.mockResolvedValue({data:covered(saved(request),site,{unallocated_paid:3,attendance_matches:1,inconsistent_allocations:1,unattributed_history:2}),error:null});render(panel());
  await screen.findByText('Reviewed cost: ₱1,038.00');const box=screen.getByRole('generic',{name:'Recorded payroll coverage signals'});
  expect(box.textContent).toContain('3 positive paid voucher(s)');expect(box.textContent).toContain('1 unallocated voucher(s) have attendance');expect(box.textContent).toContain('2 historical worker payment record(s)');expect(box.textContent).toContain('even zero signals do not prove completeness');
 });
 it('withholds the total when coverage is unavailable or malformed',async()=>{
  m.rpc.mockResolvedValueOnce({data:covered(saved(request),site,{unallocated_paid:0,attendance_matches:1}),error:null}).mockResolvedValueOnce({data:null,error:Error('offline')});render(panel());
  await screen.findByRole('alert');expect(screen.queryByText(/Reviewed cost: ₱/)).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Refresh reviewed cost'}));await screen.findByRole('alert');expect(screen.queryByText(/Reviewed cost: ₱/)).toBeNull();
 });
 it('distinguishes no review from a malformed or inconsistent response',async()=>{
  m.rpc.mockResolvedValueOnce({data:covered({project_id:site,found:false,latest_revision:0}),error:null}).mockResolvedValueOnce({data:covered({...saved(request),result:{...result,incomplete_total:'1039.00'}}),error:null});render(panel());await screen.findByText(/No saved cost review yet/);fireEvent.click(screen.getByRole('button',{name:'Refresh reviewed cost'}));await screen.findByRole('alert');expect(screen.queryByText(/Reviewed cost: ₱/)).toBeNull();
 });
 it('withholds the destination total when an incoming correction was excluded',async()=>{
  const f=crossFixture();
  const review={project_id:f.ids.other,found:true,latest_revision:1,revision:1,request_id:f.ids.request,actor_id:f.ids.actor,recorded_at:'2024-12-15T00:00:00Z',note:'Reviewed destination',freshness:'matches',snapshot:f.destination,choices:{...f.destinationChoices,corrections:{[key]:{decision:'exclude',reason:'Needs cross-site review'}}},result:{...f.destinationResult,correction_gross:'0.00',excluded_cases:1,incomplete_total:'0.00'}};
  m.rpc.mockResolvedValue({data:covered(review,f.ids.other),error:null});render(panel(f.ids.other));
  await screen.findByText(/incoming correction from another project/);expect(screen.queryByText(/Reviewed cost: ₱/)).toBeNull();
 });
 it('substitutes a matching, independently verified cross-site review without adding the two totals',async()=>{
  for(const flag of ['FINANCE_FOUNDATION_PREVIEW','PROJECT_COST_CORRECTION_PREVIEW','CORRECTED_PROJECT_COST_REVIEW_PREVIEW','CROSS_SITE_SOURCE_REVIEW_PREVIEW','CROSS_SITE_LEDGER_PREVIEW','CROSS_SITE_ATOMIC_OVERVIEW'])vi.stubEnv(`NEXT_PUBLIC_${flag}`,'true');
  const f=crossFixture();
  const ordinary={project_id:f.ids.other,found:true,latest_revision:1,revision:1,request_id:f.ids.request,actor_id:f.ids.actor,recorded_at:'2024-12-15T00:00:00Z',note:'Reviewed destination',freshness:'matches',snapshot:f.destination,choices:{...f.destinationChoices,corrections:{[key]:{decision:'exclude',reason:'Cross-site review required'}}},result:{...f.destinationResult,correction_gross:'0.00',excluded_cases:1,incomplete_total:'0.00'}};
  const cross={...ordinary,request_id:f.ids.expense,choices:f.destinationChoices,cross_sites:f.contexts,result:f.destinationResult};
  m.rpc.mockImplementation(async(name:string)=>name==='project_cost_cross_site_overview'?{data:{project_id:f.ids.other,coverage:covered(ordinary,f.ids.other),cross,sources:f.sourceReviews},error:null}:{data:covered(ordinary,f.ids.other),error:null});
  render(panel(f.ids.other));await screen.findByText('Reviewed cross-site cost: ₱100.25');expect(screen.queryByText('Reviewed cost: ₱0.00')).toBeNull();expect(screen.getByText(/do not add them together/)).toBeTruthy();
  expect(m.rpc).toHaveBeenCalledWith('project_cost_cross_site_overview',{p_project:f.ids.other});expect(m.rpc).not.toHaveBeenCalledWith('project_cost_corrected_review',expect.anything());
 });
 it('shows a verified cross-site review when no ordinary destination review exists',async()=>{
  for(const flag of ['FINANCE_FOUNDATION_PREVIEW','PROJECT_COST_CORRECTION_PREVIEW','CORRECTED_PROJECT_COST_REVIEW_PREVIEW','CROSS_SITE_SOURCE_REVIEW_PREVIEW','CROSS_SITE_LEDGER_PREVIEW','CROSS_SITE_ATOMIC_OVERVIEW'])vi.stubEnv(`NEXT_PUBLIC_${flag}`,'true');
  const f=crossFixture();const cross={found:true,project_id:f.ids.other,latest_revision:1,revision:1,request_id:f.ids.request,actor_id:f.ids.actor,recorded_at:'2024-12-15T00:00:00Z',note:'Reviewed destination',freshness:'matches',snapshot:f.destination,choices:f.destinationChoices,cross_sites:f.contexts,result:f.destinationResult};
  const empty=covered({project_id:f.ids.other,found:false,latest_revision:0},f.ids.other);m.rpc.mockImplementation(async(name:string)=>name==='project_cost_cross_site_overview'?{data:{project_id:f.ids.other,coverage:empty,cross,sources:f.sourceReviews},error:null}:{data:empty,error:null});
  render(panel(f.ids.other));await screen.findByText('Reviewed cross-site cost: ₱100.25');expect(screen.queryByText(/No saved cost review yet/)).toBeNull();
 });
 it('prefers a verified cross-site review over an automatic amount that needs incoming-correction review',async()=>{
  for(const flag of ['FINANCE_FOUNDATION_PREVIEW','PROJECT_COST_CORRECTION_PREVIEW','CORRECTED_PROJECT_COST_REVIEW_PREVIEW','CROSS_SITE_SOURCE_REVIEW_PREVIEW','CROSS_SITE_LEDGER_PREVIEW','CROSS_SITE_ATOMIC_OVERVIEW','SIMPLE_RECORDED_COST_PREVIEW'])vi.stubEnv(`NEXT_PUBLIC_${flag}`,'true');
  const f=crossFixture(),empty={...covered({project_id:f.ids.other,found:false,latest_revision:0},f.ids.other),captured_at:f.destination.historical_review.base.captured_at};
  const cross={found:true,project_id:f.ids.other,latest_revision:1,revision:1,request_id:f.ids.request,actor_id:f.ids.actor,recorded_at:'2024-12-15T00:00:00Z',note:'Reviewed destination',freshness:'matches',snapshot:f.destination,choices:f.destinationChoices,cross_sites:f.contexts,result:f.destinationResult};
  m.rpc.mockImplementation(async(name:string)=>name==='project_recorded_cost_snapshot'?{data:{project_id:f.ids.other,coverage:empty,inventory:f.destination},error:null}:name==='project_cost_cross_site_overview'?{data:{project_id:f.ids.other,coverage:empty,cross,sources:f.sourceReviews},error:null}:{data:null,error:Error('Unexpected reader')});
  render(panel(f.ids.other));await screen.findByText('Reviewed cross-site cost: ₱100.25');expect(screen.queryByText(/Recorded cost needs review/)).toBeNull();
 });
 it.each([false,true])('checks legacy coverage and cross-site evidence in one snapshot (new older split: %s)',async newLegacy=>{
  for(const flag of ['FINANCE_FOUNDATION_PREVIEW','PROJECT_COST_CORRECTION_PREVIEW','CORRECTED_PROJECT_COST_REVIEW_PREVIEW','CROSS_SITE_SOURCE_REVIEW_PREVIEW','CROSS_SITE_LEDGER_PREVIEW','CROSS_SITE_ATOMIC_OVERVIEW','LEGACY_VOUCHER_ATTRIBUTION_PREVIEW'])vi.stubEnv(`NEXT_PUBLIC_${flag}`,'true');
  const f=crossFixture(),empty=covered({project_id:f.ids.other,found:false,latest_revision:0},f.ids.other),legacy=(count:number)=>({...empty,legacy_site_attributions:count,changed_legacy_attributions:0,legacy_review:{project_id:f.ids.other,found:false,latest_revision:0}});
  const cross={found:true,project_id:f.ids.other,latest_revision:1,revision:1,request_id:f.ids.request,actor_id:f.ids.actor,recorded_at:'2024-12-15T00:00:00Z',note:'Reviewed destination',freshness:'matches',snapshot:f.destination,choices:f.destinationChoices,cross_sites:f.contexts,result:f.destinationResult};
  m.rpc.mockImplementation(async(name:string)=>name==='project_cost_legacy_cross_site_overview'?{data:{project_id:f.ids.other,legacy:legacy(newLegacy?1:0),ordinary:{project_id:f.ids.other,coverage:empty,cross,sources:f.sourceReviews}},error:null}:{data:legacy(0),error:null});
  render(panel(f.ids.other));if(newLegacy){await screen.findByText(/Older voucher attribution exists/);expect(screen.queryByText(/Reviewed cross-site cost:/)).toBeNull();}else await screen.findByText('Reviewed cross-site cost: ₱100.25');
  expect(m.rpc).toHaveBeenCalledWith('project_cost_legacy_cross_site_overview',{p_project:f.ids.other});
 });
 it.each(['source stale','destination stale','different decisions','missing source','corrupt result'])('hides an unverifiable cross-site overview: %s',async change=>{
  for(const flag of ['FINANCE_FOUNDATION_PREVIEW','PROJECT_COST_CORRECTION_PREVIEW','CORRECTED_PROJECT_COST_REVIEW_PREVIEW','CROSS_SITE_SOURCE_REVIEW_PREVIEW','CROSS_SITE_LEDGER_PREVIEW','CROSS_SITE_ATOMIC_OVERVIEW'])vi.stubEnv(`NEXT_PUBLIC_${flag}`,'true');
  const f=crossFixture();
  const ordinary={project_id:f.ids.other,found:true,latest_revision:1,revision:1,request_id:f.ids.request,actor_id:f.ids.actor,recorded_at:'2024-12-15T00:00:00Z',note:'Reviewed destination',freshness:'matches',snapshot:f.destination,choices:{...f.destinationChoices,corrections:{[key]:{decision:'exclude',reason:'Cross-site review required'}}},result:{...f.destinationResult,correction_gross:'0.00',excluded_cases:1,incomplete_total:'0.00'}};
  const cross={...ordinary,request_id:f.ids.expense,choices:structuredClone(f.destinationChoices),cross_sites:f.contexts,result:{...f.destinationResult}};
  if(change==='source stale')f.sourceSaved.freshness='changed';if(change==='destination stale')cross.freshness='changed';if(change==='different decisions')(cross.choices.historical as Record<string,unknown>).extra={decision:'include',reason:null};if(change==='corrupt result')cross.result.incomplete_total='200.00';
  m.rpc.mockImplementation(async(name:string)=>name==='project_cost_cross_site_overview'?{data:{project_id:f.ids.other,coverage:covered(ordinary,f.ids.other),cross,sources:change==='missing source'?{}:f.sourceReviews},error:null}:{data:covered(ordinary,f.ids.other),error:null});
  render(panel(f.ids.other));await screen.findByText(/incoming correction from another project/);expect(screen.queryByText(/Reviewed cross-site cost:/)).toBeNull();
 });
 it('rejects a non-latest result',async()=>{
  m.rpc.mockResolvedValue({data:covered({...saved(request),latest_revision:2}),error:null});render(panel());await screen.findByRole('alert');expect(screen.queryByText(/Reviewed cost: ₱/)).toBeNull();
 });
 it('discards a late response for a different project or account',async()=>{
  let resolve!:(v:unknown)=>void;m.rpc.mockReturnValueOnce(new Promise(r=>{resolve=r})).mockResolvedValueOnce({data:covered({project_id:other,found:false,latest_revision:0},other),error:null});const view=render(panel());view.rerender(panel(other,actor));await screen.findByText(/No saved cost review yet/);await act(async()=>resolve({data:covered(saved(request)),error:null}));expect(screen.queryByText('Reviewed cost: ₱1,038.00')).toBeNull();
 });
});
