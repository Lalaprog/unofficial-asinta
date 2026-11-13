// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const {rpc,prepare}=vi.hoisted(()=>({rpc:vi.fn(),prepare:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc})}));
vi.mock('@/lib/users/supervisorPortrait',()=>({prepareSupervisorPortrait:prepare}));
import {SupervisorPortrait} from '@/components/users/SupervisorPortrait';
const id='10000000-0000-4000-8000-000000000002';
const absent={supervisor_id:id,version:null,has_photo:false,mime:null,data:null};
beforeEach(()=>{rpc.mockReset();prepare.mockReset();rpc.mockResolvedValue({data:absent,error:null});prepare.mockResolvedValue({mime:'image/png',data:'image'});});
afterEach(()=>cleanup());
describe('experimental Supervisor portrait UI',()=>{
 it('shows fallback and sends only resized content with a version and operation id',async()=>{
  render(React.createElement(SupervisorPortrait,{id,name:'Test'}));const input=await screen.findByLabelText('Choose photo');
  expect(screen.getByText(/Default icon/)).toBeTruthy();
  const file=new File(['original'],'image.png',{type:'image/png'});fireEvent.change(input,{target:{files:[file]}});
  await waitFor(()=>expect(rpc).toHaveBeenCalledWith('set_supervisor_profile_photo',expect.objectContaining({p_supervisor:id,p_expected_version:null,p_mime:'image/png',p_data:'image',p_operation:expect.any(String)})));
  expect(prepare).toHaveBeenCalledWith(file);
 });
 it('retries the same operation after ambiguous upload failure',async()=>{
  rpc.mockImplementation(async(name:string)=>name==='set_supervisor_profile_photo'?{data:null,error:{code:'NETWORK'}}:{data:absent,error:null});
  render(React.createElement(SupervisorPortrait,{id,name:'Test'}));fireEvent.change(await screen.findByLabelText('Choose photo'),{target:{files:[new File(['x'],'a.png',{type:'image/png'})]}});
  fireEvent.click(await screen.findByRole('button',{name:'Retry same change'}));
  await waitFor(()=>expect(rpc.mock.calls.filter(c=>c[0]==='set_supervisor_profile_photo')).toHaveLength(2));
  const writes=rpc.mock.calls.filter(c=>c[0]==='set_supervisor_profile_photo');expect(writes[0][1]).toEqual(writes[1][1]);
 });
 it('does not upload if preparation fails and displays an error',async()=>{
  prepare.mockRejectedValue(new Error('Bad photo'));
  render(React.createElement(SupervisorPortrait,{id,name:'Test'}));fireEvent.change(await screen.findByLabelText('Choose photo'),{target:{files:[new File(['x'],'a.png',{type:'image/png'})]}});
  await screen.findByText('Bad photo');expect(rpc.mock.calls.every(c=>c[0]!=='set_supervisor_profile_photo')).toBe(true);
 });
 it('shows the private image and removal sends its version',async()=>{
  rpc.mockResolvedValue({data:{supervisor_id:id,version:'old',has_photo:true,mime:'image/png',data:'abc'},error:null});
  render(React.createElement(SupervisorPortrait,{id,name:'Test'}));await screen.findByAltText('Test profile photo');fireEvent.click(screen.getByRole('button',{name:'Remove photo'}));
  await waitFor(()=>expect(rpc).toHaveBeenCalledWith('set_supervisor_profile_photo',expect.objectContaining({p_expected_version:'old',p_mime:null,p_data:null})));
 });
});
