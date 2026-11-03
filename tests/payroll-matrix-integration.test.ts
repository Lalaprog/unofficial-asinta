// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn(),create:vi.fn()}));
vi.mock('@/components/layout/AppShell',()=>({AppShell:({children}:{children:React.ReactNode})=>children}));
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:vi.fn()})}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:'f'},isFounder:true})}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
vi.mock('@/lib/data/store',()=>{const store={payroll:[],workers:[],projects:[{id:'s',name:'Site',location:'Batangas, PH'}],attendance:[],advances:[],createPayrollRun:mock.create,updatePayrollStatus:vi.fn()};return {useDataStore:()=>store}});
import PayrollPage from '@/app/payroll/page';
afterEach(()=>{cleanup();vi.useRealTimers();mock.create.mockReset()});
describe('matrix and payroll period controls',()=>{
  it('uses Manila defaults and shares selected period and site with the existing generation dialog',()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-02T16:30:00Z'));
    render(React.createElement(PayrollPage));fireEvent.click(screen.getByRole('button',{name:/Payroll-period attendance matrix/}));
    expect((screen.getByLabelText('Matrix period end') as HTMLInputElement).value).toBe('2026-11-03');expect((screen.getByLabelText('Matrix period start') as HTMLInputElement).value).toBe('2026-10-28');
    fireEvent.change(screen.getByLabelText('Matrix period start'),{target:{value:'2026-10-20'}});fireEvent.change(screen.getByLabelText('Matrix project site'),{target:{value:'s'}});
    fireEvent.click(screen.getByRole('button',{name:'New Payroll Run'}));expect((screen.getByLabelText('Period Start Date') as HTMLInputElement).value).toBe('2026-10-20');expect((screen.getByLabelText('Project Site Scope') as HTMLSelectElement).value).toBe('s');
    fireEvent.change(screen.getByLabelText('Period End Date'),{target:{value:'2026-11-02'}});expect((screen.getByLabelText('Matrix period end',{selector:'input'}) as HTMLInputElement).value).toBe('2026-11-02');expect(mock.create).not.toHaveBeenCalled();
  });
});
