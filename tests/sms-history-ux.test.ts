// @vitest-environment jsdom
vi.mock('@/lib/sms/loadTemplate', () => ({ loadSMSTemplate: async () => 'Dear {{client_contact_name}}, invoice {{invoice_number}}.' }));
import React from 'react';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn(),send:vi.fn()}));
vi.mock('@/components/layout/AppShell',()=>({AppShell:({children}:{children:React.ReactNode})=>React.createElement('main',null,children)}));
vi.mock('@/components/ui/Modal',()=>({Modal:({children,isOpen,title}:{children:React.ReactNode;isOpen:boolean;title:string})=>isOpen?React.createElement('div',{role:'dialog','aria-label':title},children):null}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:'founder'},isFounder:true})}));
vi.mock('@/lib/data/store',()=>{const store={invoices:[{id:'i',invoice_number:'INV-1',client_id:'c',project_id:'p',status:'sent',amount:100,amount_paid:0,due_date:'2026-12-01'}],clients:[{id:'c',name:'Ada',phone:'09123456789'}],projects:[{id:'p',name:'Site'}],sendSMS:mock.send};return {useDataStore:()=>store}});
vi.mock('@/lib/supabase/client',()=>{
  const chain = {select:()=>chain,eq:()=>chain,in:()=>chain,order:()=>chain,limit:()=>chain,maybeSingle:async()=>({data:null,error:null})};
  return {createClient:()=>({rpc:mock.rpc,from:()=>chain})};
});
import SMSPage from '@/app/sms/page';
const row={id:'a',invoice_id:'i',invoice_number:'INV-1',sent_at:'2026-11-03T00:00:00+00:00',recipient:'Ada',phone:'0912',message:'A complete message',status:'failed',simulated:true,error_message:'Simulation log'};
beforeEach(()=>{mock.send.mockReset();mock.rpc.mockReset().mockImplementation((name:string)=>Promise.resolve({data:name==='sms_history_summary'?{total:1,delivered:0}:{items:[row],has_more:false},error:null}));vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({philsmsConfigured:false})}));});
afterEach(()=>{cleanup();vi.unstubAllGlobals()});
describe('SMS history page',()=>{
  it('shows compact expandable details and forwards filters without depending on the shared store',async()=>{
    render(React.createElement(SMSPage));await screen.findByText('Ada');expect(screen.getByText('A complete message').closest('details')?.open).toBe(false);
    const details=screen.getByText('Ada').closest('details')!;fireEvent.click(details.querySelector('summary')!);expect(details.open).toBe(true);expect(within(details).getByText('Simulation log')).toBeTruthy();
    expect(screen.getByText('1 Messages')).toBeTruthy();expect(screen.getByText('0 Delivered')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Status'),{target:{value:'simulated'}});await waitFor(()=>expect(mock.rpc).toHaveBeenCalledWith('sms_history_page',expect.objectContaining({p_status:'simulated'})));
    fireEvent.change(screen.getByLabelText('Search messages'),{target:{value:'INV-1'}});await waitFor(()=>expect(mock.rpc).toHaveBeenCalledWith('sms_history_page',expect.objectContaining({p_search:'INV-1'})));
    fireEvent.change(screen.getByLabelText('From date (Manila)'),{target:{value:'2026-11-03'}});fireEvent.change(screen.getByLabelText('To date (Manila)'),{target:{value:'2026-11-01'}});expect(screen.getByRole('alert').textContent).toMatch(/end date/i);
    fireEvent.click(screen.getByRole('button',{name:'Clear filters'}));await waitFor(()=>expect(mock.rpc).toHaveBeenCalledWith('sms_history_page',expect.objectContaining({p_status:null,p_from:null,p_to:null})));
  });
  it('refreshes history after failed and successful send attempts without issuing an extra send',async()=>{
    mock.send.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(React.createElement(SMSPage));await screen.findByText('Ada');fireEvent.click(screen.getByRole('button',{name:'Compose SMS'}));
    const dialog=screen.getByRole('dialog');fireEvent.change(within(dialog).getByLabelText(/Invoice \(recipient/),{target:{value:'i'}});await within(dialog).findByText('None on record');
    fireEvent.click(within(dialog).getByRole('checkbox'));const before=mock.rpc.mock.calls.filter(([name])=>name==='sms_history_page').length;
    fireEvent.click(within(dialog).getByRole('button',{name:'Confirm & Send SMS'}));await waitFor(()=>expect(mock.send).toHaveBeenCalledTimes(1));await waitFor(()=>expect(mock.rpc.mock.calls.filter(([name])=>name==='sms_history_page').length).toBeGreaterThan(before));
    expect((within(dialog).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    const after=mock.rpc.mock.calls.filter(([name])=>name==='sms_history_page').length;fireEvent.click(within(dialog).getByRole('checkbox'));fireEvent.click(within(dialog).getByRole('button',{name:'Confirm & Send SMS'}));await within(dialog).findByText(/SMS handed to the gateway/);await waitFor(()=>expect(mock.rpc.mock.calls.filter(([name])=>name==='sms_history_page').length).toBeGreaterThan(after));expect(mock.send).toHaveBeenCalledTimes(2);
  });
  it('shows an error rather than an empty result and retries',async()=>{
    mock.rpc.mockImplementation((name:string)=>Promise.resolve(name==='sms_history_page'?{error:{message:'offline'}}:{data:{total:1,delivered:0},error:null}));render(React.createElement(SMSPage));await screen.findByText(/Could not load SMS history/);expect(screen.queryByText(/No SMS dispatch logs match/)).toBeNull();
    mock.rpc.mockResolvedValue({data:{items:[row],has_more:false},error:null});fireEvent.click(screen.getByRole('button',{name:'Try again'}));await screen.findByText('Ada');
  });
});
