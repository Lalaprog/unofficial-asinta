// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const {rpc}=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc})}));
import {ProjectWorkerMove} from '@/components/projects/ProjectWorkerMove';
import {parseWorkerMoveAttempt,workerMovePreviewEnabled} from '@/lib/workforce/atomicWorkerMove';
const actor='10000000-0000-4000-8000-000000000001',worker='10000000-0000-4000-8000-000000000002',site='10000000-0000-4000-8000-000000000003',dest='10000000-0000-4000-8000-000000000004';
const key=`worker-move:${actor}:${site}`;
const props={actorId:actor,projectId:site,workers:[{id:worker,name:'Ada · Mason'}],projects:[{id:site,name:'A'}, {id:dest,name:'B'}],onCompleted:vi.fn().mockResolvedValue(true)};
const view=()=>render(React.createElement(ProjectWorkerMove,props));
async function start(){fireEvent.click(screen.getByRole('button',{name:'Move a worker to another project'}));fireEvent.change(screen.getByLabelText('Worker on this project'),{target:{value:worker}});fireEvent.change(screen.getByLabelText('Destination project'),{target:{value:dest}});fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Confirm move'}));}
beforeEach(()=>{sessionStorage.clear();rpc.mockReset();props.onCompleted.mockClear();});
afterEach(()=>{cleanup();vi.unstubAllEnvs();vi.restoreAllMocks();});
describe('experimental atomic worker move UI',()=>{
 it('requires both build-time gates',()=>{vi.stubEnv('NEXT_PUBLIC_ATOMIC_WORKER_MOVE_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_ASSIGNMENT_HISTORY_PREVIEW','false');expect(workerMovePreviewEnabled()).toBe(false);vi.stubEnv('NEXT_PUBLIC_ASSIGNMENT_HISTORY_PREVIEW','true');expect(workerMovePreviewEnabled()).toBe(true);});
 it('requires confirmation and stores the exact retry before sending',async()=>{
  rpc.mockImplementation(async(_name:string,p:any)=>{expect(JSON.parse(sessionStorage.getItem(key)!)).toMatchObject({requestId:p.p_request,workerId:worker});return {data:{request_id:p.p_request,worker_id:p.p_worker,from_project:p.p_from,to_project:p.p_to,replayed:false},error:null};});
  view();fireEvent.click(screen.getByRole('button',{name:'Move a worker to another project'}));expect((screen.getByRole('button',{name:'Confirm move'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Worker on this project'),{target:{value:worker}});fireEvent.change(screen.getByLabelText('Destination project'),{target:{value:dest}});fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Confirm move'}));
  await screen.findByText(/Move recorded/);expect(sessionStorage.getItem(key)).toBeNull();expect(props.onCompleted).toHaveBeenCalled();
 });
 it('recovers an uncertain move after remount and retries the identical request',async()=>{
  rpc.mockResolvedValue({data:null,error:{message:'network'}});const first=view();await start();await screen.findByText(/outcome is not confirmed/);
  const initial=rpc.mock.calls[0][1],saved=sessionStorage.getItem(key);expect(saved).not.toBeNull();first.unmount();view();await screen.findByText('Unconfirmed move. The request may have been recorded.');
  rpc.mockImplementation(async(_name:string,p:any)=>({data:{request_id:p.p_request,worker_id:p.p_worker,from_project:p.p_from,to_project:p.p_to,replayed:true},error:null}));
  fireEvent.click(screen.getByRole('button',{name:'Retry same move'}));await screen.findByText(/original move was confirmed/);expect(rpc.mock.calls[1][1]).toEqual(initial);expect(sessionStorage.getItem(key)).toBeNull();
 });
 it('blocks writes when retry storage fails or holds a malformed record',async()=>{
  vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('blocked')});view();await start();await screen.findByText(/no move was sent/);expect(rpc).not.toHaveBeenCalled();cleanup();vi.restoreAllMocks();sessionStorage.setItem(key,'{}');view();await screen.findByText(/Cannot read the saved move retry/);expect(screen.queryByRole('button',{name:'Confirm move'})).toBeNull();expect(rpc).not.toHaveBeenCalled();
 });
 it('does not overwrite a newly appeared move before submitting',async()=>{
  view();fireEvent.click(screen.getByRole('button',{name:'Move a worker to another project'}));fireEvent.change(screen.getByLabelText('Worker on this project'),{target:{value:worker}});fireEvent.change(screen.getByLabelText('Destination project'),{target:{value:dest}});fireEvent.click(screen.getByRole('checkbox'));
  const other=JSON.stringify({requestId:'10000000-0000-4000-8000-000000000099',actorId:actor,workerId:worker,fromProject:site,toProject:dest});sessionStorage.setItem(key,other);fireEvent.click(screen.getByRole('button',{name:'Confirm move'}));await screen.findByText(/no move was sent/);expect(rpc).not.toHaveBeenCalled();expect(sessionStorage.getItem(key)).toBe(other);
 });
 it('preserves changed retry evidence and refuses a stale retry or clear',async()=>{
  rpc.mockResolvedValueOnce({data:null,error:{message:'network'}});view();await start();await screen.findByText(/outcome is not confirmed/);
  const attempt=JSON.parse(sessionStorage.getItem(key)!);const changed=JSON.stringify({...attempt,requestId:'10000000-0000-4000-8000-000000000099'});sessionStorage.setItem(key,changed);
  fireEvent.click(screen.getByRole('button',{name:'Retry same move'}));await screen.findByText(/no move was sent/);expect(rpc).toHaveBeenCalledTimes(1);expect(sessionStorage.getItem(key)).toBe(changed);
  fireEvent.click(screen.getByRole('button',{name:'Review before stopping retry'}));fireEvent.click(screen.getByRole('button',{name:'I checked; stop retrying'}));await screen.findByText(/Could not clear the saved retry/);expect(sessionStorage.getItem(key)).toBe(changed);
 });
 it('allows an explicitly reviewed stop when the retry record is unchanged',async()=>{
  rpc.mockResolvedValueOnce({data:null,error:{message:'network'}});view();await start();await screen.findByText(/outcome is not confirmed/);fireEvent.click(screen.getByRole('button',{name:'Review before stopping retry'}));fireEvent.click(screen.getByRole('button',{name:'I checked; stop retrying'}));await screen.findByText(/Retry stopped/);expect(sessionStorage.getItem(key)).toBeNull();
 });
 it('preserves changed evidence after a late success and verifies storage before sending',async()=>{
  let resolve!:(value:unknown)=>void;rpc.mockReturnValueOnce(new Promise(r=>{resolve=r;}));view();await start();const attempt=JSON.parse(sessionStorage.getItem(key)!);const changed=JSON.stringify({...attempt,requestId:'10000000-0000-4000-8000-000000000099'});sessionStorage.setItem(key,changed);
  resolve({data:{request_id:attempt.requestId,worker_id:worker,from_project:site,to_project:dest,replayed:false},error:null});await screen.findByText(/outcome is not confirmed/);expect(sessionStorage.getItem(key)).toBe(changed);expect(props.onCompleted).not.toHaveBeenCalled();
  cleanup();sessionStorage.clear();rpc.mockReset();vi.spyOn(Storage.prototype,'setItem').mockImplementationOnce(()=>{});view();await start();await screen.findByText(/no move was sent/);expect(rpc).not.toHaveBeenCalled();
 });
 it('does not accept a mismatched RPC result as confirmation',async()=>{
  rpc.mockResolvedValue({data:{request_id:'wrong',worker_id:worker,from_project:site,to_project:dest,replayed:false},error:null});view();await start();await screen.findByText(/outcome is not confirmed/);expect(sessionStorage.getItem(key)).not.toBeNull();expect(props.onCompleted).not.toHaveBeenCalled();
  expect(()=>parseWorkerMoveAttempt(JSON.parse(sessionStorage.getItem(key)!),dest,site)).toThrow(/scope/);
 });
});
