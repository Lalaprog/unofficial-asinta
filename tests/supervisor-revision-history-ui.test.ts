// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:m.rpc})}));
import {SupervisorRevisionHistory} from '@/components/payroll/SupervisorRevisionHistory';
const payroll='10000000-0000-4000-8000-000000000001',actor='10000000-0000-4000-8000-000000000002';
afterEach(()=>{cleanup();m.rpc.mockReset();});
it('loads validated review evidence and explains its limits',async()=>{
 m.rpc.mockResolvedValue({data:{payroll_id:payroll,items:[{request_id:actor,actor_id:actor,action:'return_to_draft',revision:'0',occurred_at:'2026-11-14T00:00:00Z',reason:'No payment',before_status:'approved',after_status:'draft',before_rate:'600.00',after_rate:'600.00',before_gross:'600.00',after_gross:'600.00',paid_on:null}],has_more:false},error:null});
 render(React.createElement(SupervisorRevisionHistory,{payroll}));fireEvent.click(screen.getByRole('button',{name:'Load revision history'}));await screen.findByText('Reason: No payment');expect(screen.getByText(/not proof of external payment/)).toBeTruthy();expect(m.rpc).toHaveBeenCalledWith('supervisor_payroll_revision_history',{p_payroll:payroll,p_before:null});
});
it('fails closed on malformed or unavailable evidence',async()=>{m.rpc.mockResolvedValue({data:{payroll_id:payroll,items:[],has_more:true},error:null});render(React.createElement(SupervisorRevisionHistory,{payroll}));fireEvent.click(screen.getByRole('button',{name:'Load revision history'}));expect((await screen.findByRole('alert')).textContent).toMatch(/Could not verify/);});
