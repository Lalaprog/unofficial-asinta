// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  role: 'founder' as 'founder' | 'supervisor' | 'signedout',
  assurance: 'ready' as 'ready' | 'required' | 'checking' | 'unavailable',
  projects: [] as any[], calls: [] as Array<{kind:string;table?:string;selection?:string;payload?:any}>,
  reloadError: false, nextLoad: null as null | Promise<{data:any[] | null; error:{message:string} | null}>, toast: vi.fn(),
  tableFailure: null as null | {table:string; type:'error'|'throw'|'null'},
  founder: {id:'user', email:'founder@example.test', role:'founder'},
  supervisor: {id:'user', email:'founder@example.test', role:'supervisor'},
}));
vi.mock('@/lib/auth/authContext', () => ({useAuth: () => ({assurance:mock.assurance,user: mock.role === 'signedout' ? null : mock.role === 'founder' ? mock.founder : mock.supervisor, isLoading:false})}));
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
    select: (selection:string) => { mock.calls.push({kind:'select',table,selection});
      const result = async () => {
        if (mock.tableFailure?.table === table) {
          if (mock.tableFailure.type === 'throw') throw new Error('network down');
          if (mock.tableFailure.type === 'null') return {data:null,error:null};
          return {data:null,error:{message:'query failed'}};
        }
        return {data:[],error:null};
      };
      return {order:result,then:(resolve:(x:unknown)=>void, reject:(e:unknown)=>void)=>result().then(resolve,reject)};
    },
    insert: (payload:any) => ({select:(selection:string) => ({single:async()=>{mock.calls.push({kind:'insert',table,selection,payload});return {data:{id:'p'},error:null}}})}),
    update: (payload:any) => ({eq:()=>({select:(selection:string)=>({single:async()=>{mock.calls.push({kind:'update',table,selection,payload});return {data:{id:'p'},error:null}}})})}),
  }),
})}));
import { DataStoreProvider, useDataStore } from '@/lib/data/store';
let store:ReturnType<typeof useDataStore>;
function Probe(){store=useDataStore();return null;}
const project = {id:'p',name:'Site',client_id:'private-client',location:'Lipa',budget_estimate:'90000',status:'active' as const,start_date:'2026-01-01',target_completion_date:'2026-12-31',created_at:'2026-01-01T00:00:00Z'};
const setup = async () => {render(React.createElement(DataStoreProvider,null,React.createElement(Probe)));await waitFor(()=>expect(store.isLoaded).toBe(true));};
beforeEach(()=>{mock.role='founder';mock.assurance='ready';mock.projects=[project];mock.calls=[];mock.reloadError=false;mock.nextLoad=null;mock.tableFailure=null;mock.toast.mockReset();sessionStorage.clear();});
afterEach(()=>cleanup());

describe('project privacy in the shared store',()=>{
  it('does not hydrate, fetch or retain ledger data before assurance and loads after verification',async()=>{
    mock.assurance='required';
    sessionStorage.setItem('bale-ledger-cache:v2:user:founder',JSON.stringify({projects:[project]}));
    const view=render(React.createElement(DataStoreProvider,null,React.createElement(Probe)));
    await act(async()=>{});
    expect(store.projects).toHaveLength(0);
    expect(mock.calls).toHaveLength(0);
    expect(sessionStorage.getItem('bale-ledger-cache:v2:user:founder')).toBeNull();
    mock.assurance='ready';
    view.rerender(React.createElement(DataStoreProvider,null,React.createElement(Probe)));
    await waitFor(()=>expect(store.projects).toHaveLength(1));
    mock.assurance='checking';
    view.rerender(React.createElement(DataStoreProvider,null,React.createElement(Probe)));
    await waitFor(()=>expect(store.projects).toHaveLength(0));
  });
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
  it('ignores an overtaken failed read after a successful refresh',async()=>{
    let resolve!:(value:{data:null;error:{message:string}})=>void;
    mock.nextLoad=new Promise(r=>{resolve=r});
    render(React.createElement(DataStoreProvider,null,React.createElement(Probe)));
    await waitFor(()=>expect(mock.calls.some(c=>c.kind==='rpc' && c.table==='visible_projects')).toBe(true));
    await act(async()=>{await store.refresh()});
    expect(store.isLoaded).toBe(true);expect(store.loadError).toBeNull();
    await act(async()=>resolve({data:null,error:{message:'old failure'}}));
    expect(store.loadError).toBeNull();expect(store.projects[0].name).toBe('Site');
  });
  it('clears the cached ledger on sign-out in the same tab',async()=>{
    const view=render(React.createElement(DataStoreProvider,null,React.createElement(Probe)));
    await waitFor(()=>expect(store.projects).toHaveLength(1));
    expect(sessionStorage.getItem('bale-ledger-cache:v3:user:founder')).not.toBeNull();
    mock.role='signedout';
    view.rerender(React.createElement(DataStoreProvider,null,React.createElement(Probe)));
    await waitFor(()=>expect(store.projects).toHaveLength(0));
    expect(sessionStorage.getItem('bale-ledger-cache:v3:user:founder')).toBeNull();
  });
  it.each(['error','throw','null'] as const)('keeps the last complete batch and warns after a %s silent sync, then recovers',async(type)=>{
    await setup();
    const cacheKey='bale-ledger-cache:v3:user:founder';
    const before=sessionStorage.getItem(cacheKey);
    mock.projects=[{...project,name:'Changed'}];
    mock.tableFailure={table:'payroll',type};
    await act(async()=>{window.dispatchEvent(new Event('focus'));await new Promise(resolve=>setTimeout(resolve,600));});
    await waitFor(()=>expect(store.loadError).toMatch(/sync/));
    expect(store.projects[0].name).toBe('Site');
    expect(sessionStorage.getItem(cacheKey)).toBe(before);
    mock.tableFailure=null;
    await act(async()=>{await store.refresh()});
    expect(store.loadError).toBeNull();
    expect(store.projects[0].name).toBe('Changed');
    expect(sessionStorage.getItem(cacheKey)).not.toBe(before);
  });
  it('does not open the workspace or cache a partial initial batch',async()=>{
    mock.tableFailure={table:'advance_requests',type:'error'};
    render(React.createElement(DataStoreProvider,null,React.createElement(Probe)));
    await waitFor(()=>expect(store.loadError).toMatch(/sync failed/));
    expect(store.isLoaded).toBe(false);
    expect(store.projects).toHaveLength(0);
    expect(sessionStorage.getItem('bale-ledger-cache:v3:user:founder')).toBeNull();
    mock.tableFailure=null;
    await act(async()=>{await store.refresh()});
    expect(store.isLoaded).toBe(true);
    expect(store.projects[0].name).toBe('Site');
  });
  it('does not trust old partial or malformed tab caches',async()=>{
    mock.tableFailure={table:'payroll',type:'error'};
    sessionStorage.setItem('bale-ledger-cache:v2:user:founder',JSON.stringify({projects:[project]}));
    sessionStorage.setItem('bale-ledger-cache:v3:user:founder',JSON.stringify({projects:[project]}));
    render(React.createElement(DataStoreProvider,null,React.createElement(Probe)));
    await waitFor(()=>expect(store.loadError).toMatch(/sync failed/));
    expect(store.isLoaded).toBe(false);
    expect(store.projects).toHaveLength(0);
    expect(sessionStorage.getItem('bale-ledger-cache:v2:user:founder')).toBeNull();
  });
  it('marks a complete tab snapshot stale until the first live sync completes',async()=>{
    await setup();
    cleanup();
    let resolve!: (value:{data:any[];error:null})=>void;
    mock.nextLoad=new Promise(r=>{resolve=r});
    render(React.createElement(DataStoreProvider,null,React.createElement(Probe)));
    await waitFor(()=>expect(store.isLoaded).toBe(true));
    expect(store.projects[0].name).toBe('Site');
    expect(store.loadError).toMatch(/saved tab snapshot/);
    await act(async()=>resolve({data:[{...project,name:'Fresh'}],error:null}));
    await waitFor(()=>expect(store.loadError).toBeNull());
    expect(store.projects[0].name).toBe('Fresh');
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
