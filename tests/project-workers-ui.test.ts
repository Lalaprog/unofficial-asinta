// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ workers: [
  {id:'20000000-0000-0000-0000-000000000001',name:'Mara Cruz',position:'Mason',contact_number:'091234',active:true,pay_rate:500,pay_rate_type:'daily',created_at:''},
  {id:'20000000-0000-0000-0000-000000000002',name:'Juan Cruz',position:'Carpenter',contact_number:'—',active:true,pay_rate:500,pay_rate_type:'daily',created_at:''},
], founder:true, refresh: vi.fn(async()=>{}) }));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({isFounder:state.founder})}));
vi.mock('@/lib/data/store',()=>({useDataStore:()=>({workers:state.workers,refresh:state.refresh,isLoaded:true,loadError:null})}));
import { ProjectWorkers } from '@/components/projects/ProjectWorkers';
let ids:string[];
let unavailable:string[];
let extraAvailable:Array<{id:string;name:string;position:string;contact_number:string}>;
beforeEach(()=>{
  ids=[]; unavailable=[]; extraAvailable=[]; state.founder=true;
  vi.stubGlobal('fetch',vi.fn(async(_url:string,opts?:RequestInit)=>{
    if(opts?.method==='POST') {const body=JSON.parse(String(opts.body));if(body.action==='assign') ids.push(body.workerId);if(body.action==='remove') ids=ids.filter(id=>id!==body.workerId);return {ok:true,json:async()=>({ok:true})};}
    return {ok:true,json:async()=>({workerIds:ids,availableWorkers:[...state.workers.filter(w=>!ids.includes(w.id) && !unavailable.includes(w.id)).map(({id,name,position,contact_number})=>({id,name,position,contact_number})),...extraAvailable]})};
  }));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.clearAllMocks();});
describe('project team UI',()=>{
  it('starts empty, searches existing workers and adds a selected profile to this project',async()=>{
    render(React.createElement(ProjectWorkers,{projectId:'10000000-0000-0000-0000-000000000001'}));
    await screen.findByText(/No workers have been assigned/);
    expect(screen.getByText(/past attendance does not automatically assign/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Add worker'}));
    await screen.findByRole('button',{name:'Add Mara Cruz'});
    fireEvent.change(screen.getByLabelText('Search existing workers'),{target:{value:'Mara'}});
    expect(screen.queryByText('Juan Cruz')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Add Mara Cruz'}));
    await screen.findByText('Mara Cruz added to this project.');
    expect(ids).toEqual([state.workers[0].id]);
    const post=vi.mocked(fetch).mock.calls.find(([,opts])=>opts?.method==='POST');
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({action:'assign',workerId:state.workers[0].id});
    expect(screen.getByText(/does not mark attendance or change payroll/)).toBeTruthy();
  });
  it('fetches candidates only after opening the add-worker flow', async()=>{
    render(React.createElement(ProjectWorkers,{projectId:'10000000-0000-0000-0000-000000000001'}));
    await screen.findByText(/No workers have been assigned/);
    expect(vi.mocked(fetch).mock.calls.filter(([url])=>String(url).includes('view=available'))).toHaveLength(0);
    fireEvent.click(screen.getByRole('button',{name:'Add worker'}));
    await screen.findByRole('button',{name:'Add Mara Cruz'});
    expect(vi.mocked(fetch).mock.calls.filter(([url])=>String(url).includes('view=available'))).toHaveLength(1);
  });
  it('shows only the server-verified unassigned workers as add candidates', async()=>{
    unavailable=[state.workers[0].id];
    render(React.createElement(ProjectWorkers,{projectId:'10000000-0000-0000-0000-000000000001'}));
    await screen.findByText(/No workers have been assigned/);
    fireEvent.click(screen.getByRole('button',{name:'Add worker'}));
    expect(await screen.findByRole('button',{name:'Add Juan Cruz'})).toBeTruthy();
    expect(screen.queryByRole('button',{name:'Add Mara Cruz'})).toBeNull();
  });
  it('shows server-verified candidates even if absent from the shared worker store', async()=>{
    extraAvailable=[{id:'20000000-0000-0000-0000-000000000003',name:'Extra Worker',position:'Mason',contact_number:'—'}];
    render(React.createElement(ProjectWorkers,{projectId:'10000000-0000-0000-0000-000000000001'}));
    await screen.findByText(/No workers have been assigned/);
    fireEvent.click(screen.getByRole('button',{name:'Add worker'}));
    expect(await screen.findByRole('button',{name:'Add Extra Worker'})).toBeTruthy();
  });
  it('groups assigned workers by craft in collapsible sections', async()=>{
    ids=state.workers.map(worker=>worker.id);
    render(React.createElement(ProjectWorkers,{projectId:'10000000-0000-0000-0000-000000000001'}));
    const mason=(await screen.findByText('Mason')).closest('details')!;
    const carpenter=screen.getByText('Carpenter').closest('details')!;
    expect(mason.open).toBe(true);
    expect(carpenter.open).toBe(true);
    expect(mason.textContent).toContain('Mara Cruz');
    expect(carpenter.textContent).toContain('Juan Cruz');
    fireEvent.click(mason.querySelector('summary')!);
    expect(mason.open).toBe(false);
  });
  it('requires confirmation before removal and explains the existing records are preserved',async()=>{
    ids=[state.workers[0].id];
    render(React.createElement(ProjectWorkers,{projectId:'10000000-0000-0000-0000-000000000001'}));
    fireEvent.click(await screen.findByRole('button',{name:'Remove Mara Cruz from project'}));
    expect(screen.getByText(/attendance, payroll and Bale records will not be deleted/)).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.filter(([,o])=>o?.method==='POST')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button',{name:'Remove from project',hidden:false}));
    await waitFor(()=>expect(ids).toHaveLength(0));
  });
  it('does not show names assigned elsewhere in Supervisor duplicate hints',async()=>{
    state.founder=false; unavailable=[state.workers[0].id];
    render(React.createElement(ProjectWorkers,{projectId:'10000000-0000-0000-0000-000000000001'}));
    await screen.findByText(/No workers have been assigned/);
    fireEvent.click(screen.getByRole('button',{name:'Add worker'}));
    await screen.findByRole('button',{name:'Add Juan Cruz'});
    fireEvent.click(screen.getByRole('button',{name:'Register a new worker'}));
    fireEvent.change(screen.getByLabelText('Full name'),{target:{value:'Mara'}});
    expect(screen.getByText(/A similar profile may already exist/)).toBeTruthy();
    expect(screen.queryByText(/Similar existing names: Mara Cruz/)).toBeNull();
  });
  it('shows a matching-name warning before registering a duplicate',async()=>{
    render(React.createElement(ProjectWorkers,{projectId:'10000000-0000-0000-0000-000000000001'}));
    await screen.findByText(/No workers have been assigned/);fireEvent.click(screen.getByRole('button',{name:'Add worker'}));
    await screen.findByRole('button',{name:'Add Mara Cruz'});
    fireEvent.click(screen.getByRole('button',{name:'Register a new worker'}));
    fireEvent.change(screen.getByLabelText('Full name'),{target:{value:'Mara'}});
    expect(screen.getByText(/Similar existing names: Mara Cruz/)).toBeTruthy();
  });
});
