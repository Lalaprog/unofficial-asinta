// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
import {ProjectPaidPayrollSummary} from '@/components/projects/ProjectPaidPayrollSummary';
import {founder,other,payroll,site,worker} from './helpers/project-cost-reconciliation-fixture';
const paid={payroll_id:payroll,worker_id:worker,worker_name:'Worker A',period_start:'2024-11-03',period_end:'2024-11-09',payment_date:'2024-11-09',hours:'8.00',wage:'550.00',allowance:'50.00',gross:'600.00',voucher_gross:'750.00',voucher_bale:'100.00',voucher_other:'0.00',voucher_net:'650.00'};
const response={project_id:site,captured_at:'2024-11-10T00:00:00Z',expenses:[],rentals:[],paid_allocations:[paid],adjustment_cases:[]};
const panel=(projectId=site,userId=founder,onReview=vi.fn())=>React.createElement(ProjectPaidPayrollSummary,{projectId,userId,onReview});
beforeEach(()=>{mock.rpc.mockReset();});afterEach(()=>{cleanup();vi.restoreAllMocks();});
describe('project overview paid worker payroll summary',()=>{
 it('loads on demand, shows site gross separately, and opens reconciliation',async()=>{
  mock.rpc.mockResolvedValue({data:response,error:null});const onReview=vi.fn();render(panel(site,founder,onReview));expect(mock.rpc).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Load paid payroll summary'}));
  await screen.findByText(/Recorded site payroll gross: ₱600.00/);expect(screen.getByText(/1 paid allocation/)).toBeTruthy();expect(screen.getByText(/not proof of payment or a total project cost/)).toBeTruthy();expect(screen.getByText(/Do not add this to expenses/)).toBeTruthy();
  expect(mock.rpc).toHaveBeenCalledWith('project_cost_reconciliation_preview',{p_project:site});fireEvent.click(screen.getByRole('button',{name:'Review expense and payroll evidence'}));expect(onReview).toHaveBeenCalledOnce();
 });
 it('fails closed on malformed or unavailable snapshots, without retaining an old subtotal',async()=>{
  mock.rpc.mockResolvedValueOnce({data:response,error:null}).mockResolvedValueOnce({data:{...response,paid_allocations:[{...paid,gross:'601.00'}]},error:null});render(panel());fireEvent.click(screen.getByRole('button',{name:'Load paid payroll summary'}));await screen.findByText(/₱600.00/);
  fireEvent.click(screen.getByRole('button',{name:'Refresh paid payroll summary'}));await screen.findByRole('alert');expect(screen.queryByText(/₱600.00/)).toBeNull();expect(screen.getByText(/No payroll subtotal is assumed/)).toBeTruthy();
 });
 it('sums multiple paid allocations in exact centavos',async()=>{
  const large={...paid,payroll_id:'f0000000-0000-4000-8000-000000000001',wage:'9999999999.99',allowance:'0.00',gross:'9999999999.99',voucher_gross:'9999999999.99',voucher_bale:'0.00',voucher_net:'9999999999.99'};
  const penny={...paid,wage:'0.01',allowance:'0.00',gross:'0.01',voucher_gross:'0.01',voucher_bale:'0.00',voucher_net:'0.01'};
  mock.rpc.mockResolvedValue({data:{...response,paid_allocations:[large,penny]},error:null});render(panel());fireEvent.click(screen.getByRole('button',{name:'Load paid payroll summary'}));await screen.findByText(/Recorded site payroll gross: ₱10,000,000,000.00/);expect(screen.getByText(/2 paid allocation/)).toBeTruthy();
 });
 it('labels zero as no matching allocation, not proof of no payroll costs',async()=>{
  mock.rpc.mockResolvedValue({data:{...response,paid_allocations:[]},error:null});render(panel());fireEvent.click(screen.getByRole('button',{name:'Load paid payroll summary'}));await screen.findByText(/Recorded site payroll gross: ₱0.00/);expect(screen.getByText(/does not prove there was no payroll cost/)).toBeTruthy();
 });
 it('discards a late response when the project or actor changes',async()=>{
  let resolve!:(value:unknown)=>void;mock.rpc.mockReturnValueOnce(new Promise(r=>{resolve=r;}));const view=render(panel());fireEvent.click(screen.getByRole('button',{name:'Load paid payroll summary'}));view.rerender(panel(other,founder));
  await act(async()=>{resolve({data:response,error:null});await Promise.resolve();});expect(screen.queryByText(/₱600.00/)).toBeNull();expect(screen.getByRole('button',{name:'Load paid payroll summary'})).toBeTruthy();
 });
});
