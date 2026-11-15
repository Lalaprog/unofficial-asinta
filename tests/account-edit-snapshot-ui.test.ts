// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen,within,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({load:vi.fn(),toast:vi.fn(),refresh:vi.fn()}));
vi.mock('@/lib/users/accountEditSnapshot',()=>({loadAccountEditSnapshot:m.load}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({})}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:'founder'}})}));
vi.mock('@/components/layout/AppShell',()=>({AppShell:({children}:{children:React.ReactNode})=>React.createElement('main',null,children)}));
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:m.toast})}));
vi.mock('@/lib/data/store',()=>({useDataStore:()=>({users:[{id:'sup',name:'Old Name',email:'test@example.invalid',role:'supervisor',created_at:'2026-01-01T00:00:00Z'}],workers:[],projects:[{id:'a',name:'Site A',location:'Lipa'}],projectSupervisors:[],refresh:m.refresh})}));
import UsersPage from '@/app/users/page';
const user={id:'sup',name:'Current Name',email:'test@example.invalid',role:'supervisor',created_at:'2026-01-01T00:00:00Z'};
beforeEach(()=>{m.load.mockReset();m.toast.mockReset();m.refresh.mockReset();});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('team account edit snapshot',()=>{
 it('uses the targeted read rather than an incomplete shared worker or assignment list',async()=>{
  m.load.mockResolvedValue({user,assignedProjectIds:['a','b'],worker:{id:'sup',active:true,pay_rate:600,pay_rate_type:'daily',contact_number:'—',removed_at:null}});
  const fetchMock=vi.fn().mockResolvedValue({ok:true,json:async()=>({ok:true,user})});vi.stubGlobal('fetch',fetchMock);
  render(React.createElement(UsersPage));fireEvent.click(screen.getByRole('button',{name:'Manage'}));const dialog=await screen.findByRole('dialog');
  expect((within(dialog).getByLabelText('Full Name') as HTMLInputElement).value).toBe('Current Name');
  expect((within(dialog).getByRole('checkbox',{name:/Link Supervisor to a workforce profile/}) as HTMLInputElement).checked).toBe(true);
  expect(within(dialog).getByRole('alert').textContent).toMatch(/Some assigned sites/);
  fireEvent.click(within(dialog).getByRole('button',{name:'Save Changes'}));await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(1));
  const body=JSON.parse(fetchMock.mock.calls[0][1].body);expect(body).toMatchObject({userId:'sup',name:'Current Name',includeInPayroll:true,payRate:600,assignedProjectIds:['a','b']});
 });
 it('does not open or submit an edit when the targeted read fails',async()=>{
  m.load.mockRejectedValue(Error('incomplete'));const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
  render(React.createElement(UsersPage));fireEvent.click(screen.getByRole('button',{name:'Manage'}));await waitFor(()=>expect(m.toast).toHaveBeenCalledWith('error',expect.stringMatching(/No changes were made/)));
  expect(screen.queryByRole('dialog')).toBeNull();expect(fetchMock).not.toHaveBeenCalled();
 });
});
