// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({create:vi.fn(),update:vi.fn()}));
vi.mock('@/components/layout/AppShell',()=>({AppShell:({children}:{children:React.ReactNode})=>children}));
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:vi.fn()})}));
vi.mock('@/components/payroll/PayrollFoundationPanels',()=>({PayrollFoundationPanels:()=>React.createElement('div',null,'Candidate panels')}));
vi.mock('@/components/payroll/AttendanceMatrix',()=>({AttendanceMatrix:()=>null}));
vi.mock('@/lib/data/store',()=>({useDataStore:()=>({
 payroll:[{id:'draft',worker_id:'w',status:'draft',period_start:'2024-11-03',period_end:'2024-11-09',gross_pay:600,bale_deduction:0,net_pay:600,days_worked:1,hours_worked:8},{id:'approved',worker_id:'w',status:'approved',period_start:'2024-11-10',period_end:'2024-11-16',gross_pay:600,bale_deduction:0,net_pay:600,days_worked:1,hours_worked:8}],
 workers:[{id:'w',name:'Test Worker',position:'Mason'}],projects:[],attendance:[],advances:[],createPayrollRun:mock.create,updatePayrollStatus:mock.update
})}));
import PayrollPage from '@/app/payroll/page';
afterEach(()=>{cleanup();vi.unstubAllEnvs();mock.create.mockReset();mock.update.mockReset();});
describe('experimental weekly cutover: legacy UI hold',()=>{
 it('keeps legacy actions unchanged when the separate hold is off',()=>{
  render(React.createElement(PayrollPage));expect(screen.getByRole('button',{name:'New Payroll Run'})).toBeTruthy();expect(screen.getByRole('button',{name:'Approve'})).toBeTruthy();expect(screen.getByRole('button',{name:'Mark as Paid'})).toBeTruthy();expect(screen.getAllByRole('button',{name:'Print Payslip'})).toHaveLength(2);
 });
 it('hides legacy writers even if the other weekly gates are missing',()=>{
  vi.stubEnv('NEXT_PUBLIC_WEEKLY_WORKER_CUTOVER_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','false');
  render(React.createElement(PayrollPage));expect(screen.queryByRole('button',{name:'New Payroll Run'})).toBeNull();expect(screen.queryByRole('button',{name:'Approve'})).toBeNull();expect(screen.queryByRole('button',{name:'Mark as Paid'})).toBeNull();expect(screen.getAllByRole('button',{name:'Print Payslip'})).toHaveLength(2);expect(screen.getByText(/complete weekly voucher controls are not enabled/)).toBeTruthy();expect(mock.create).not.toHaveBeenCalled();expect(mock.update).not.toHaveBeenCalled();
 });
 it('closes an open legacy confirmation when cutover mode becomes active',()=>{
  const view=render(React.createElement(PayrollPage));fireEvent.click(screen.getByRole('button',{name:'Approve'}));expect(screen.getByRole('button',{name:'Approve voucher'})).toBeTruthy();
  vi.stubEnv('NEXT_PUBLIC_WEEKLY_WORKER_CUTOVER_PREVIEW','true');view.rerender(React.createElement(PayrollPage));expect(screen.queryByRole('button',{name:'Approve voucher'})).toBeNull();expect(mock.update).not.toHaveBeenCalled();
 });
});
