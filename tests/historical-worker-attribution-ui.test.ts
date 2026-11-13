// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({rpc:vi.fn()}));vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mocks.rpc})}));
import {HistoricalWorkerAttributions} from '@/components/projects/HistoricalWorkerAttributions';
import {historicalWorkerAttributionPreviewEnabled} from '@/lib/finance/featureAvailability';
import {parseHistoricalProjectAttributions} from '@/lib/projects/historicalWorkerAttributions';
const site='00000000-0000-0000-0000-000000000004',other='00000000-0000-0000-0000-000000000005',founder='00000000-0000-0000-0000-000000000001';
const row={request_id:'81000000-0000-4000-8000-000000000002',source_id:'81000000-0000-4000-8000-000000000001',worker_id:'00000000-0000-0000-0000-000000000003',worker_name:'Worker A',period_start:'2024-11-03',period_end:'2024-11-09',paid_on:'2024-11-09',original_gross:'600.00',site_gross:'400.25',note:'Ledger reviewed',recorded_by:founder,recorded_at:'2024-11-12T00:00:00Z',case_count:1};
const response={project_id:site,items:[row]};
beforeEach(()=>mocks.rpc.mockReset());afterEach(()=>{cleanup();vi.unstubAllEnvs();});
describe('historical worker attribution evidence (uninstalled, default-off)',()=>{
 it('requires the foundation, cost preview and separate attribution gate',()=>{
  vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_PROJECT_COST_RECONCILIATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_HISTORICAL_WORKER_ATTRIBUTION_PREVIEW','false');expect(historicalWorkerAttributionPreviewEnabled()).toBe(false);
  vi.stubEnv('NEXT_PUBLIC_HISTORICAL_WORKER_ATTRIBUTION_PREVIEW','true');expect(historicalWorkerAttributionPreviewEnabled()).toBe(true);vi.stubEnv('NEXT_PUBLIC_PROJECT_COST_RECONCILIATION_PREVIEW','false');expect(historicalWorkerAttributionPreviewEnabled()).toBe(false);vi.stubEnv('NEXT_PUBLIC_PROJECT_COST_RECONCILIATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','false');expect(historicalWorkerAttributionPreviewEnabled()).toBe(false);
 });
 it('loads separately and never presents the assertion as proof or part of the total',async()=>{
  mocks.rpc.mockResolvedValue({data:response,error:null});render(React.createElement(HistoricalWorkerAttributions,{projectId:site,userId:founder}));
  expect(mocks.rpc).not.toHaveBeenCalled();expect(screen.getByText(/not included/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Load historical evidence'}));
  expect(await screen.findByText(/Worker A.*this site ₱400.25/)).toBeTruthy();expect(screen.getByText(/Whole worker-week gross ₱600.00/)).toBeTruthy();expect(screen.getByText(/Original-period cases: 1/)).toBeTruthy();expect(screen.queryByText(/Temporary, incomplete estimate/)).toBeNull();expect(mocks.rpc).toHaveBeenCalledWith('project_historical_worker_attributions',{p_project:site});
 });
 it('fails closed for malformed, duplicated, out-of-order or cross-site results',()=>{
  expect(parseHistoricalProjectAttributions(response,site)).toHaveLength(1);
  for(const bad of [{...response,project_id:other},{...response,items:[row,row]},{...response,items:[{...row,site_gross:'601.00'}]},{...response,items:[{...row,period_end:'2024-11-10'}]},{...response,items:[{...row,case_count:-1}]},{...response,items:[{...row,original_gross:'NaN'}]}])expect(()=>parseHistoricalProjectAttributions(bad,site)).toThrow();
 });
 it('does not display a late response after project changes or treat errors as an empty list',async()=>{
  let resolve!:(value:unknown)=>void;mocks.rpc.mockReturnValueOnce(new Promise(r=>{resolve=r;})).mockResolvedValueOnce({data:null,error:Error('offline')});
  const view=render(React.createElement(HistoricalWorkerAttributions,{projectId:site,userId:founder}));fireEvent.click(screen.getByRole('button',{name:'Load historical evidence'}));view.rerender(React.createElement(HistoricalWorkerAttributions,{projectId:other,userId:founder}));resolve({data:response,error:null});fireEvent.click(screen.getByRole('button',{name:'Load historical evidence'}));
  expect(await screen.findByRole('alert')).toBeTruthy();expect(screen.queryByText(/Worker A/)).toBeNull();expect(screen.queryByText(/No attribution evidence returned/)).toBeNull();
 });
});
