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
beforeEach(()=>m.rpc.mockReset());afterEach(()=>cleanup());
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
 it('rejects a non-latest result',async()=>{
  m.rpc.mockResolvedValue({data:{...saved(request),latest_revision:2},error:null});render(panel());await screen.findByRole('alert');expect(screen.queryByText(/Reviewed cost: ₱/)).toBeNull();
 });
 it('discards a late response for a different project or account',async()=>{
  let resolve!:(v:unknown)=>void;m.rpc.mockReturnValueOnce(new Promise(r=>{resolve=r})).mockResolvedValueOnce({data:{project_id:other,found:false,latest_revision:0},error:null});const view=render(panel());view.rerender(panel(other,actor));await screen.findByText(/No saved cost review yet/);await act(async()=>resolve({data:saved(request),error:null}));expect(screen.queryByText('Reviewed cost: ₱1,038.00')).toBeNull();
 });
});
