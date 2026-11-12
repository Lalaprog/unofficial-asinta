// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({create:vi.fn(),toast:vi.fn()}));
vi.mock('@/components/layout/AppShell',()=>({AppShell:({children}:{children:React.ReactNode})=>children}));
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:mock.toast})}));
vi.mock('@/lib/data/store',()=>{const data={payroll:[],workers:[],projects:[],attendance:[],advances:[],createPayrollRun:mock.create,updatePayrollStatus:vi.fn()};return {useDataStore:()=>data}});
import PayrollPage from '@/app/payroll/page';
afterEach(()=>{cleanup();vi.useRealTimers();mock.create.mockReset()});
describe('payroll generation preview',()=>{
  it('defaults to the Manila Sunday–Saturday worker week and warns while it is incomplete',()=>{
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-24T16:01:00Z'));
    render(React.createElement(PayrollPage));fireEvent.click(screen.getByRole('button',{name:'New Payroll Run'}));
    expect((screen.getByLabelText('Period Start Date') as HTMLInputElement).value).toBe('2026-10-25');
    expect((screen.getByLabelText('Period End Date') as HTMLInputElement).value).toBe('2026-10-31');
    expect(screen.getByText(/period is still in progress/i)).toBeTruthy();
    expect(screen.getByText(/legacy generator, not the requested weekly payroll workflow/i)).toBeTruthy();
    expect(mock.create).not.toHaveBeenCalled();
  });
  it('allows a server check even with zero loaded attendance and warns about site scope',async()=>{
    mock.create.mockResolvedValue(null);render(React.createElement(PayrollPage));fireEvent.click(screen.getByRole('button',{name:'New Payroll Run'}));
    expect(screen.getByText('0 loaded logs in range')).toBeTruthy();expect(screen.getByText(/preview may omit records/)).toBeTruthy();expect(screen.getByText(/site-scoped run may recalculate/)).toBeTruthy();
    const button=screen.getByRole('button',{name:'Generate / Refresh Payroll Run'});expect(button.hasAttribute('disabled')).toBe(false);
    await act(async()=>{fireEvent.click(button)});expect(mock.create).toHaveBeenCalledTimes(1);expect(screen.getByRole('button',{name:'Generate / Refresh Payroll Run'})).toBeTruthy();
  });
});
