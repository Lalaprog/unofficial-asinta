// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const mocks=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mocks.rpc})}));
vi.mock('next/link',()=>({default:({href,children}: {href:string;children:React.ReactNode})=>React.createElement('a',{href},children)}));
import {ProjectWorkforceLogs} from '@/components/projects/ProjectWorkforceLogs';
const row={id:'one',worker_id:'worker',project_id:'site',date:'2026-10-12',status:'present',hours_worked:8,notes:'Historic work',worker_name:'Past Worker',worker_position:'Mason',is_supervisor:false,is_founder_override:false};
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-12T06:00:00Z'));mocks.rpc.mockImplementation((name:string,args:{p_date?:string})=>Promise.resolve(name==='project_attendance_calendar'?{data:[{date:'2026-10-12',count:1}],error:null}:{data:{items:args.p_date==='2026-10-12'?[row]:[],has_more:false},error:null}));});
afterEach(()=>{cleanup();mocks.rpc.mockReset();vi.useRealTimers()});
describe('project attendance calendar',()=>{
 it('reads selected site and date from the server and never describes blank as absent',async()=>{
  render(React.createElement(ProjectWorkforceLogs,{projectId:'site',userId:'supervisor'}));
  expect(await screen.findByText('Past Worker')).toBeTruthy();
  expect(mocks.rpc).toHaveBeenCalledWith('project_attendance_calendar',{p_project_id:'site',p_month:'2026-10-01'});
  expect(mocks.rpc).toHaveBeenCalledWith('attendance_history_page',expect.objectContaining({p_project_id:'site',p_date:'2026-10-12'}));
  expect(screen.getByText('Historic work')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Choose attendance date'),{target:{value:'2026-10-13'}});
  expect(await screen.findByText('No records found for this date. Unmarked is not absent.')).toBeTruthy();
  expect(screen.queryByText('Past Worker')).toBeNull();
 });
 it('loads further day records on request without relying on the shared store',async()=>{
  const many=Array.from({length:20},(_,i)=>({...row,id:`${String(i).padStart(2,'0')}`,worker_name:`Worker ${i}`}));
  mocks.rpc.mockImplementation((name:string,args:{p_cursor_id?:string})=>Promise.resolve(name==='project_attendance_calendar'?{data:[{date:'2026-10-12',count:21}],error:null}:{data:args.p_cursor_id?{items:[{...row,id:'20',worker_name:'Older record'}],has_more:false}:{items:many,has_more:true},error:null}));
  render(React.createElement(ProjectWorkforceLogs,{projectId:'site',userId:'supervisor'}));
  expect(await screen.findByText('Worker 0')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Show more day records'}));
  expect(await screen.findByText('Older record')).toBeTruthy();
  expect(mocks.rpc).toHaveBeenCalledWith('attendance_history_page',expect.objectContaining({p_cursor_id:'19',p_project_id:'site',p_date:'2026-10-12'}));
 });
 it('does not misrepresent calendar errors as no records, and retries',async()=>{
  mocks.rpc.mockImplementation((name:string)=>Promise.resolve(name==='project_attendance_calendar'?{data:null,error:{message:'offline'}}:{data:{items:[],has_more:false},error:null}));
  render(React.createElement(ProjectWorkforceLogs,{projectId:'site',userId:'supervisor'}));
  expect(await screen.findByText(/Calendar could not be loaded/)).toBeTruthy();
  expect(screen.queryByLabelText(/October 12, 2026, no records/)).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Retry calendar'}));
  await waitFor(()=>expect(mocks.rpc.mock.calls.filter(x=>x[0]==='project_attendance_calendar')).toHaveLength(2));
 });
 it('discards a previous project calendar response',async()=>{
  let resolve!:(value:unknown)=>void;
  mocks.rpc.mockImplementation((name:string,args:{p_project_id:string})=>name==='project_attendance_calendar' && args.p_project_id==='old'?new Promise(r=>{resolve=r}):Promise.resolve(name==='project_attendance_calendar'?{data:[],error:null}:{data:{items:[],has_more:false},error:null}));
  const view=render(React.createElement(ProjectWorkforceLogs,{projectId:'old',userId:'supervisor'}));
  view.rerender(React.createElement(ProjectWorkforceLogs,{projectId:'new',userId:'supervisor'}));
  await waitFor(()=>expect(screen.getByText('No records found for this date. Unmarked is not absent.')).toBeTruthy());
  await act(async()=>resolve({data:[{date:'2026-10-12',count:9}],error:null}));
  expect(screen.queryByText('9 rec.')).toBeNull();
 });
});
