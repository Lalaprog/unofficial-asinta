// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {parseProjectEquipment} from '@/lib/tools/projectEquipment';
import {siteA,siteB,tool} from './helpers/owned-equipment-fixture';
const mock=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
import {ProjectSiteEquipment} from '@/components/projects/ProjectSiteEquipment';
const props={projectId:siteA,userId:'user',isFounder:false,isSupervisor:true,assurance:'ready'};
const data={project_id:siteA,items:[{id:tool,name:'Drill',condition:'good',quantity:2,source:'allocated'}]};
const deferred=()=>{let resolve!:(v:unknown)=>void;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
beforeEach(()=>mock.rpc.mockReset());afterEach(cleanup);
describe('site equipment preview',()=>{
 it('loads an authorized site snapshot without displaying other-site or total stock',async()=>{
  mock.rpc.mockResolvedValue({data,error:null});render(React.createElement(ProjectSiteEquipment,props));await screen.findByText('Drill');
  expect(mock.rpc).toHaveBeenCalledWith('project_equipment_snapshot',{p_project:siteA});expect(screen.getByText(/Quantity at this site: 2/)).toBeTruthy();expect(screen.getByText(/Neither confirms physical location or condition/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Refresh site equipment'}));await screen.findByText('Drill');expect(mock.rpc).toHaveBeenCalledTimes(2);
 });
 it('reports errors rather than saying there are no tools',async()=>{
  mock.rpc.mockResolvedValue({data:null,error:{message:'Not installed'}});render(React.createElement(ProjectSiteEquipment,props));await screen.findByRole('alert');expect(screen.queryByText(/No equipment records returned/)).toBeNull();
 });
 it('hides old site results immediately and ignores late responses after site or identity changes',async()=>{
  const old=deferred();mock.rpc.mockReturnValueOnce(old.promise).mockResolvedValue({data:{project_id:siteB,items:[]},error:null});const view=render(React.createElement(ProjectSiteEquipment,props));view.rerender(React.createElement(ProjectSiteEquipment,{...props,projectId:siteB}));await screen.findByText(/No equipment records returned/);
  await act(async()=>old.resolve({data,error:null}));expect(screen.queryByText('Drill')).toBeNull();view.rerender(React.createElement(ProjectSiteEquipment,{...props,projectId:siteB,userId:'other',assurance:'checking'}));expect(screen.getByText(/until your authorized session is ready/)).toBeTruthy();expect(screen.queryByText(/No equipment records returned/)).toBeNull();
 });
 it('validates duplicates, identity, source, and bounds rather than returning partial data',()=>{
  expect(parseProjectEquipment(data,siteA).items).toHaveLength(1);
  for(const bad of [{project_id:siteB,items:data.items},{...data,items:[data.items[0],data.items[0]]},{...data,items:[{...data.items[0],quantity:-1}]},{...data,items:[{...data.items[0],quantity:0}]},{...data,items:[{...data.items[0],source:'unknown'}]}])expect(()=>parseProjectEquipment(bad,siteA)).toThrow();
 });
});
