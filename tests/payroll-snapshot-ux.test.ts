// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({create:vi.fn(),toast:vi.fn()}));
vi.mock('@/components/layout/AppShell',()=>({AppShell:({children}:{children:React.ReactNode})=>children}));
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:mock.toast})}));
vi.mock('@/lib/data/store',()=>{const data={payroll:[],workers:[],projects:[],attendance:[],advances:[],createPayrollRun:mock.create,updatePayrollStatus:vi.fn()};return {useDataStore:()=>data}});
import PayrollPage from '@/app/payroll/page';
afterEach(()=>{cleanup();mock.create.mockReset()});
describe('payroll generation preview',()=>{
  it('allows a server check even with zero loaded attendance and warns about site scope',async()=>{
    mock.create.mockResolvedValue(null);render(React.createElement(PayrollPage));fireEvent.click(screen.getByRole('button',{name:'New Payroll Run'}));
    expect(screen.getByText('0 loaded logs in range')).toBeTruthy();expect(screen.getByText(/preview may omit records/)).toBeTruthy();expect(screen.getByText(/site-scoped run may recalculate/)).toBeTruthy();
    const button=screen.getByRole('button',{name:'Generate / Refresh Payroll Run'});expect(button.hasAttribute('disabled')).toBe(false);
    await act(async()=>{fireEvent.click(button)});expect(mock.create).toHaveBeenCalledTimes(1);expect(screen.getByRole('button',{name:'Generate / Refresh Payroll Run'})).toBeTruthy();
  });
});
