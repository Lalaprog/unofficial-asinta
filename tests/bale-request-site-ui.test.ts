// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ mode:'ready', submit:vi.fn(), reload:vi.fn() }));
vi.mock('next/navigation', () => ({useRouter:()=>({replace:vi.fn()}),useSearchParams:()=>new URLSearchParams('tab=requests')}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:'sup'},isFounder:false,isSupervisor:true})}));
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:vi.fn()})}));
vi.mock('@/components/ui/Modal',()=>({Modal:({isOpen,title,children}:{isOpen:boolean;title:string;children:React.ReactNode})=>isOpen?React.createElement('div',{role:'dialog','aria-label':title},children):null}));
vi.mock('@/lib/attendance/useBaleProjectWorkers',()=>({useBaleProjectWorkers:(_user:string,project:string,enabled:boolean)=>({status:enabled&&project?mock.mode:'idle',workers:project==='a'?[{id:'w1',name:'Ada',position:'Mason'}]:[{id:'w2',name:'Ben',position:'Carpenter'}],someDetailsUnavailable:false,reload:mock.reload})}));
const projects=[{id:'a',name:'Site A'},{id:'b',name:'Site B'}];
vi.mock('@/lib/data/store',()=>({useDataStore:()=>({advanceRequests:[],projects,workers:[{id:'w1',name:'Ada',position:'Mason',active:true},{id:'w2',name:'Ben',position:'Carpenter',active:true}],users:[],getProjectsForSupervisor:()=>projects,createAdvanceRequest:mock.submit,reviewAdvanceRequest:vi.fn(),approveAdvanceRequests:vi.fn(),issueAdvanceRequest:vi.fn()})}));
import { AdvanceRequestsPanel } from '@/components/advances/AdvanceRequestsPanel';
beforeEach(()=>{mock.mode='ready';mock.submit.mockReset().mockResolvedValue({id:'new'});mock.reload.mockReset();});
afterEach(cleanup);

describe('site-scoped Bale request form',()=>{
  it('requires a site and clears a worker when the site changes',async()=>{
    render(React.createElement(AdvanceRequestsPanel));
    fireEvent.click(screen.getByRole('button',{name:'New Bale Request'}));
    const form=screen.getByRole('dialog',{name:'New Bale Request'});
    const site=within(form).getByLabelText('Project site');
    const worker=within(form).getByLabelText('Worker') as HTMLSelectElement;
    expect(worker.disabled).toBe(true);
    fireEvent.change(site,{target:{value:'a'}});
    expect(within(worker).getByRole('option',{name:'Ada · Mason'})).toBeTruthy();
    expect(within(worker).queryByRole('option',{name:'Ben · Carpenter'})).toBeNull();
    fireEvent.change(worker,{target:{value:'w1'}});
    fireEvent.change(site,{target:{value:'b'}});
    expect(worker.value).toBe('');
    expect(within(worker).queryByRole('option',{name:'Ada · Mason'})).toBeNull();
    fireEvent.change(worker,{target:{value:'w2'}});
    fireEvent.change(within(form).getByLabelText('Requested amount (₱)'),{target:{value:'125.50'}});
    fireEvent.click(within(form).getByRole('button',{name:'Send to Founder'}));
    await waitFor(()=>expect(mock.submit).toHaveBeenCalledWith({worker_id:'w2',project_id:'b',requested_amount:125.5}));
  });
  it('fails closed when a team read fails and offers retry',()=>{
    mock.mode='error';render(React.createElement(AdvanceRequestsPanel));
    fireEvent.click(screen.getByRole('button',{name:'New Bale Request'}));
    const form=screen.getByRole('dialog',{name:'New Bale Request'});
    fireEvent.change(within(form).getByLabelText('Project site'),{target:{value:'a'}});
    expect((within(form).getByLabelText('Worker') as HTMLSelectElement).disabled).toBe(true);
    expect((within(form).getByRole('button',{name:'Send to Founder'}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(form).getByRole('button',{name:'Try again'}));expect(mock.reload).toHaveBeenCalledTimes(1);
    expect(mock.submit).not.toHaveBeenCalled();
  });
});
