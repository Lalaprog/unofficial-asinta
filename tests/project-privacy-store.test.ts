// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  role: 'founder' as 'founder' | 'supervisor' | 'signedout',
  projects: [] as any[], calls: [] as Array<{kind:string;table?:string;selection?:string;payload?:any}>,
  reloadError: false, nextLoad: null as null | Promise<{data:any[]; error:null}>, toast: vi.fn(),
  founder: {id:'user', email:'founder@example.test', role:'founder'},
  supervisor: {id:'user', email:'founder@example.test', role:'supervisor'},
}));
vi.mock('@/lib/auth/authContext', () => ({useAuth: () => ({user: mock.role === 'signedout' ? null : mock.role === 'founder' ? mock.founder : mock.supervisor, isLoading:false})}));
vi.mock('@/components/ui/Toast', () => ({useToast: () => ({showToast:mock.toast})}));
vi.mock('@/lib/supabase/client', () => ({createClient: () => ({
  rpc: (name:string) => {
    mock.calls.push({kind:'rpc', table:name});
    return {
      order: async () => { const pending=mock.nextLoad; mock.nextLoad=null; return pending ?? {data:mock.projects,error:null}; },
      eq: (_field:string,id:string) => ({maybeSingle:async () => mock.reloadError
        ? {data:null,error:{message:'reload failed'}}
        : {data:mock.projects.find(p=>p.id===id) ?? null,error:null}}),
    };
  },
  from: (table:string) => ({
    select: (selection:string) => { mock.calls.push({kind:'select',table,selection}); return {order:async()=>({data:[],error:null}),then:(resolve:(x:unknown)=>void)=>resolve({data:[],error:null})}; },
    insert: (payload:any) => ({select:(selection:string) => ({single:async()=>{mock.calls.push({kind:'insert',table,selection,payload});return {data:{id:'p'},error:null}}})}),
    update: (payload:any) => ({eq:()=>({select:(selection:string)=>({single:async()=>{mock.calls.push({kind:'update',table,selection,payload});return {data:{id:'p'},error:null}}})})}),
  }),
})}));
import { DataStoreProvider, useDataStore } from '@/lib/data/store';
let store:ReturnType<typeof useDataStore>;
function Probe(){store=useDataStore();return null;}
const project = {id:'p',name:'Site',client_id:'private-client',location:'Lipa',budget_estimate:'90000',status:'active' as const,start_date:'2026-01-01',target_completion_date:'2026-12-31',created_at:'2026-01-01T00:00:00Z'};
const setup = async () => {render(React.createElement(DataStoreProvider,null,React.createElement(Probe)));await waitFor(()=>expect(store.isLoaded).toBe(true));};
beforeEach(()=>{mock.role='founder';mock.projects=[project];mock.calls=[];mock.reloadError=false;mock.nextLoad=null;mock.toast.mockReset();sessionStorage.clear();});
afterEach(()=>cleanup());

describe('project privacy in the shared store',()=>{
  it('loads via the role-aware function and preserves Founder details',async()=>{
    await setup();
    expect(store.projects[0]).toMatchObject({client_id:'private-client',budget_estimate:90000});
    expect(mock.calls.some(c=>c.kind==='rpc' && c.table==='visible_projects')).toBe(true);
    expect(mock.calls.some(c=>c.kind==='select' && c.table==='projects')).toBe(false);
  });
  it('does not hydrate a previous role-agnostic Founder cache into a Supervisor session',async()=>{
    mock.role='supervisor';mock.projects=[{...project,client_id:null,budget_estimate:null}];
    sessionStorage.setItem('bale-ledger-cache:user',JSON.stringify({projects:[project]}));
    sessionStorage.setItem('bale-ledger-cache:v2:user:founder',JSON.stringify({projects:[project]}));
    sessionStorage.setItem('bale-ledger-cache:v2:other-user:founder',JSON.stringify({projects:[project]}));
    await setup();
    expect(store.projects).toHaveLength(1);
    expect(store.projects[0]).toMatchObject({client_id:null,budget_estimate:null});
    expect(sessionStorage.getItem('bale-ledger-cache:user')).toBeNull();
    expect(sessionStorage.getItem('bale-ledger-cache:v2:other-user:founder')).toBeNull();
  });
  it('ignores a late Founder load after the same account becomes a Supervisor',async()=>{
    let resolve!: (value:{data:any[];error:null})=>void;
    mock.nextLoad=new Promise(r=>{resolve=r});
    const view=render(React.createElement(DataStoreProvider,null,React.createElement(Probe)));
    await waitFor(()=>expect(mock.calls.some(c=>c.kind==='rpc' && c.table==='visible_projects')).toBe(true));
    mock.role='supervisor';mock.projects=[{...project,client_id:null,budget_estimate:null}];
    view.rerender(React.createElement(DataStoreProvider,null,React.createElement(Probe)));
    await waitFor(()=>expect(store.projects[0]).toMatchObject({client_id:null,budget_estimate:null}));
    await act(async()=>resolve({data:[project],error:null}));
    expect(store.projects[0]).toMatchObject({client_id:null,budget_estimate:null});
    expect(sessionStorage.getItem('bale-ledger-cache:v2:user:founder')).toBeNull();
  });
  it('clears the cached ledger on sign-out in the same tab',async()=>{
    const view=render(React.createElement(DataStoreProvider,null,React.createElement(Probe)));
    await waitFor(()=>expect(store.projects).toHaveLength(1));
    expect(sessionStorage.getItem('bale-ledger-cache:v2:user:founder')).not.toBeNull();
    mock.role='signedout';
    view.rerender(React.createElement(DataStoreProvider,null,React.createElement(Probe)));
    await waitFor(()=>expect(store.projects).toHaveLength(0));
    expect(sessionStorage.getItem('bale-ledger-cache:v2:user:founder')).toBeNull();
  });
  it('returns public columns from writes and rereads authoritative Founder details',async()=>{
    await setup();
    await act(async()=>{expect(await store.createProject({...project,budget_estimate:90000})).toMatchObject({client_id:'private-client',budget_estimate:90000})});
    await act(async()=>{expect(await store.updateProject('p',{name:'Site'})).toMatchObject({client_id:'private-client',budget_estimate:90000})});
    const writes=mock.calls.filter(c=>c.kind==='insert'||c.kind==='update');
    expect(writes).toHaveLength(2);
    expect(writes.every(c=>!c.selection?.includes('client_id') && !c.selection?.includes('budget_estimate'))).toBe(true);
  });
  it('warns not to blindly retry when the write succeeded but the subsequent reread fails',async()=>{
    await setup();mock.reloadError=true;
    await act(async()=>{expect(await store.updateProject('p',{name:'Edited'})).toBeNull()});
    expect(mock.calls.filter(c=>c.kind==='update')).toHaveLength(1);
    expect(mock.toast).toHaveBeenCalledWith('error',expect.stringContaining('may have been saved'));
  });
});
