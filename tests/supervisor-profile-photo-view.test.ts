// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const {rpc}=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc})}));
import {useSupervisorPortrait} from '@/lib/users/useSupervisorPortrait';
import {parseSupervisorPortrait} from '@/lib/users/supervisorPortrait';
const a='10000000-0000-4000-8000-000000000001',b='10000000-0000-4000-8000-000000000002',version='20000000-0000-4000-8000-000000000001';
const photo=(id:string)=>({supervisor_id:id,version,has_photo:true,mime:'image/png',data:'YWJj'});
function View({id,enabled}:{id:string|undefined;enabled:boolean}){const src=useSupervisorPortrait(id,enabled);return React.createElement('span',{'data-testid':'image'},src??'icon');}
beforeEach(()=>{vi.stubEnv('NEXT_PUBLIC_SUPERVISOR_PORTRAIT_PREVIEW','true');rpc.mockReset();});
afterEach(()=>{cleanup();vi.unstubAllEnvs();});
describe('Supervisor private portrait display',()=>{
 it('is default-off and does not issue an RPC',async()=>{
  vi.stubEnv('NEXT_PUBLIC_SUPERVISOR_PORTRAIT_PREVIEW','false');render(React.createElement(View,{id:a,enabled:true}));await act(async()=>{});
  expect(screen.getByTestId('image').textContent).toBe('icon');expect(rpc).not.toHaveBeenCalled();
 });
 it('hides an old image immediately on account/assurance changes and ignores late replies',async()=>{
  let resolveA!:(v:unknown)=>void,resolveB!:(v:unknown)=>void;
  rpc.mockImplementation((_name:string,{p_supervisor}: {p_supervisor:string})=>new Promise(resolve=>{if(p_supervisor===a)resolveA=resolve;else resolveB=resolve;}));
  const view=render(React.createElement(View,{id:a,enabled:true}));
  await act(async()=>resolveA({data:photo(a),error:null}));expect(screen.getByTestId('image').textContent).toContain('data:image/png');
  view.rerender(React.createElement(View,{id:b,enabled:true}));expect(screen.getByTestId('image').textContent).toBe('icon');
  view.rerender(React.createElement(View,{id:b,enabled:false}));await act(async()=>resolveB({data:photo(b),error:null}));expect(screen.getByTestId('image').textContent).toBe('icon');
  expect(rpc).toHaveBeenCalledTimes(2);
 });
 it('falls back for a wrong identity or malformed response',async()=>{
  rpc.mockResolvedValue({data:photo(b),error:null});render(React.createElement(View,{id:a,enabled:true}));
  await waitFor(()=>expect(rpc).toHaveBeenCalled());await act(async()=>{});expect(screen.getByTestId('image').textContent).toBe('icon');
  for(const bad of [{...photo(a),mime:'image/svg+xml'},{...photo(a),data:'!!!!'},{...photo(a),data:'A'.repeat(349532)},{...photo(a),version:null},{...photo(a),has_photo:false}])expect(()=>parseSupervisorPortrait(bad,a)).toThrow(/Invalid portrait/);
 });
});
