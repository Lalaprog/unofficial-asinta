// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:m.rpc})}));
import {ProjectReviewedCostSummary} from '@/components/projects/ProjectReviewedCostSummary';
import {actor,request,result,saved,site} from './helpers/corrected-cost-ui-fixture';
import {crossFixture,key} from './helpers/cross-site-cost-review-fixture';
const other='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
beforeEach(()=>m.rpc.mockReset());afterEach(()=>{cleanup();vi.unstubAllEnvs();});
const panel=(projectId=site,userId=actor,onReview=vi.fn())=>React.createElement(ProjectReviewedCostSummary,{projectId,userId,onReview});
describe('reviewed project cost overview',()=>{
 it('shows verified expenses, payroll and signed corrections without double adding them',async()=>{
  m.rpc.mockResolvedValue({data:saved(request),error:null});const open=vi.fn();render(panel(site,actor,open));
  await screen.findByText('Reviewed cost: ₱1,038.00');expect(screen.getByText(/Included expenses ₱50.25.*paid worker payroll ₱600.00.*included historical payroll ₱400.25.*corrections −₱12.50/)).toBeTruthy();
  expect(screen.getByText(/does not prove completeness or payment/)).toBeTruthy();expect(m.rpc).toHaveBeenCalledWith('project_cost_corrected_review',{p_project:site,p_revision:null});fireEvent.click(screen.getByRole('button',{name:'Open cost review'}));expect(open).toHaveBeenCalledOnce();
 });
 it.each(['changed','unavailable'])('hides a %s review total on refresh',async status=>{
  m.rpc.mockResolvedValueOnce({data:saved(request),error:null}).mockResolvedValueOnce({data:{...saved(request),freshness:status},error:null});render(panel());await screen.findByText('Reviewed cost: ₱1,038.00');fireEvent.click(screen.getByRole('button',{name:'Refresh reviewed cost'}));await screen.findByRole('alert');expect(screen.queryByText('Reviewed cost: ₱1,038.00')).toBeNull();
 });
 it('distinguishes no review from a malformed or inconsistent response',async()=>{
  m.rpc.mockResolvedValueOnce({data:{project_id:site,found:false,latest_revision:0},error:null}).mockResolvedValueOnce({data:{...saved(request),result:{...result,incomplete_total:'1039.00'}},error:null});render(panel());await screen.findByText(/No saved cost review yet/);fireEvent.click(screen.getByRole('button',{name:'Refresh reviewed cost'}));await screen.findByRole('alert');expect(screen.queryByText(/Reviewed cost: ₱/)).toBeNull();
 });
 it('withholds the destination total when an incoming correction was excluded',async()=>{
  const f=crossFixture();
  const review={project_id:f.ids.other,found:true,latest_revision:1,revision:1,request_id:f.ids.request,actor_id:f.ids.actor,recorded_at:'2024-12-15T00:00:00Z',note:'Reviewed destination',freshness:'matches',snapshot:f.destination,choices:{...f.destinationChoices,corrections:{[key]:{decision:'exclude',reason:'Needs cross-site review'}}},result:{...f.destinationResult,correction_gross:'0.00',excluded_cases:1,incomplete_total:'0.00'}};
  m.rpc.mockResolvedValue({data:review,error:null});render(panel(f.ids.other));
  await screen.findByText(/incoming correction from another project/);expect(screen.queryByText(/Reviewed cost: ₱/)).toBeNull();
 });
 it('substitutes a matching, independently verified cross-site review without adding the two totals',async()=>{
  for(const flag of ['FINANCE_FOUNDATION_PREVIEW','PROJECT_COST_CORRECTION_PREVIEW','CORRECTED_PROJECT_COST_REVIEW_PREVIEW','CROSS_SITE_SOURCE_REVIEW_PREVIEW','CROSS_SITE_LEDGER_PREVIEW'])vi.stubEnv(`NEXT_PUBLIC_${flag}`,'true');
  const f=crossFixture();
  const ordinary={project_id:f.ids.other,found:true,latest_revision:1,revision:1,request_id:f.ids.request,actor_id:f.ids.actor,recorded_at:'2024-12-15T00:00:00Z',note:'Reviewed destination',freshness:'matches',snapshot:f.destination,choices:{...f.destinationChoices,corrections:{[key]:{decision:'exclude',reason:'Cross-site review required'}}},result:{...f.destinationResult,correction_gross:'0.00',excluded_cases:1,incomplete_total:'0.00'}};
  const cross={...ordinary,request_id:f.ids.expense,choices:f.destinationChoices,cross_sites:f.contexts,result:f.destinationResult};
  m.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>name==='project_cost_cross_site_review'?{data:cross,error:null}:name==='project_cost_corrected_review'&&args.p_project===f.ids.site?{data:f.sourceSaved,error:null}:{data:ordinary,error:null});
  render(panel(f.ids.other));await screen.findByText('Reviewed cross-site cost: ₱100.25');expect(screen.queryByText('Reviewed cost: ₱0.00')).toBeNull();expect(screen.getByText(/do not add them together/)).toBeTruthy();
  expect(m.rpc).toHaveBeenCalledWith('project_cost_corrected_review',{p_project:f.ids.site,p_revision:1});
 });
 it('shows a verified cross-site review when no ordinary destination review exists',async()=>{
  for(const flag of ['FINANCE_FOUNDATION_PREVIEW','PROJECT_COST_CORRECTION_PREVIEW','CORRECTED_PROJECT_COST_REVIEW_PREVIEW','CROSS_SITE_SOURCE_REVIEW_PREVIEW','CROSS_SITE_LEDGER_PREVIEW'])vi.stubEnv(`NEXT_PUBLIC_${flag}`,'true');
  const f=crossFixture();const cross={found:true,project_id:f.ids.other,latest_revision:1,revision:1,request_id:f.ids.request,actor_id:f.ids.actor,recorded_at:'2024-12-15T00:00:00Z',note:'Reviewed destination',freshness:'matches',snapshot:f.destination,choices:f.destinationChoices,cross_sites:f.contexts,result:f.destinationResult};
  m.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>name==='project_cost_cross_site_review'?{data:cross,error:null}:args?.p_project===f.ids.site?{data:f.sourceSaved,error:null}:{data:{project_id:f.ids.other,found:false,latest_revision:0},error:null});
  render(panel(f.ids.other));await screen.findByText('Reviewed cross-site cost: ₱100.25');expect(screen.queryByText(/No saved cost review yet/)).toBeNull();
 });
 it.each(['source stale','destination stale','different decisions','missing source','corrupt result'])('hides an unverifiable cross-site overview: %s',async change=>{
  for(const flag of ['FINANCE_FOUNDATION_PREVIEW','PROJECT_COST_CORRECTION_PREVIEW','CORRECTED_PROJECT_COST_REVIEW_PREVIEW','CROSS_SITE_SOURCE_REVIEW_PREVIEW','CROSS_SITE_LEDGER_PREVIEW'])vi.stubEnv(`NEXT_PUBLIC_${flag}`,'true');
  const f=crossFixture();
  const ordinary={project_id:f.ids.other,found:true,latest_revision:1,revision:1,request_id:f.ids.request,actor_id:f.ids.actor,recorded_at:'2024-12-15T00:00:00Z',note:'Reviewed destination',freshness:'matches',snapshot:f.destination,choices:{...f.destinationChoices,corrections:{[key]:{decision:'exclude',reason:'Cross-site review required'}}},result:{...f.destinationResult,correction_gross:'0.00',excluded_cases:1,incomplete_total:'0.00'}};
  const cross={...ordinary,request_id:f.ids.expense,choices:structuredClone(f.destinationChoices),cross_sites:f.contexts,result:{...f.destinationResult}};
  if(change==='source stale')f.sourceSaved.freshness='changed';if(change==='destination stale')cross.freshness='changed';if(change==='different decisions')(cross.choices.historical as Record<string,unknown>).extra={decision:'include',reason:null};if(change==='corrupt result')cross.result.incomplete_total='200.00';
  m.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>name==='project_cost_cross_site_review'?{data:cross,error:null}:name==='project_cost_corrected_review'&&args.p_project===f.ids.site?(change==='missing source'?{data:null,error:Error('Missing')}:{data:f.sourceSaved,error:null}):{data:ordinary,error:null});
  render(panel(f.ids.other));await screen.findByText(/incoming correction from another project/);expect(screen.queryByText(/Reviewed cross-site cost:/)).toBeNull();
 });
 it('rejects a non-latest result',async()=>{
  m.rpc.mockResolvedValue({data:{...saved(request),latest_revision:2},error:null});render(panel());await screen.findByRole('alert');expect(screen.queryByText(/Reviewed cost: ₱/)).toBeNull();
 });
 it('discards a late response for a different project or account',async()=>{
  let resolve!:(v:unknown)=>void;m.rpc.mockReturnValueOnce(new Promise(r=>{resolve=r})).mockResolvedValueOnce({data:{project_id:other,found:false,latest_revision:0},error:null});const view=render(panel());view.rerender(panel(other,actor));await screen.findByText(/No saved cost review yet/);await act(async()=>resolve({data:saved(request),error:null}));expect(screen.queryByText('Reviewed cost: ₱1,038.00')).toBeNull();
 });
});
