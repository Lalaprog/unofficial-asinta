// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {tool,siteA,siteB} from './helpers/owned-equipment-fixture';
const mock=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
vi.mock('@/components/ui/Modal',()=>({Modal:({isOpen,title,children}:{isOpen:boolean;title:string;children:React.ReactNode})=>isOpen?React.createElement('div',{role:'dialog','aria-label':title},children):null}));
import {OwnedEquipmentManager} from '@/components/tools/OwnedEquipmentManager';
import {OwnedEquipmentFoundation} from '@/components/tools/OwnedEquipmentFoundation';
const id='00000000-0000-0000-0000-000000000099';
const snapshot={items:[{id:tool,name:'Drill',stock:5,condition:'good',legacy_project_id:null,managed:true,sites:[{project_id:siteA,name:'Site A',quantity:3}]}],projects:[{id:siteA,name:'Site A'},{id:siteB,name:'Site B'}]};
const attempt={id,tool,action:'allocate',project:siteB,quantity:2,expectedStock:5,expectedSite:0};
const result={id,tool_id:tool,stock:5,allocated:5,depot:0,site_quantity:2,replayed:false};
beforeEach(()=>{mock.rpc.mockReset();sessionStorage.clear();vi.stubGlobal('crypto',{randomUUID:()=>id});});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.unstubAllEnvs();vi.restoreAllMocks();});
async function open(){render(React.createElement(OwnedEquipmentManager,{userId:'founder'}));fireEvent.click(screen.getByRole('button',{name:/Owned equipment allocation workspace/}));fireEvent.click(screen.getByRole('button',{name:'Load inventory'}));await screen.findByText(/Allocated to sites: 3/);}
describe('owned equipment workspace',()=>{
 it('asks for confirmation, persists an uncertain request and safely retries the same ID',async()=>{
  mock.rpc.mockResolvedValueOnce({data:snapshot,error:null}).mockResolvedValueOnce({data:null,error:{message:'lost connection'}}).mockResolvedValueOnce({data:{...result,replayed:true},error:null});
  await open();fireEvent.change(screen.getByLabelText('Project for Drill'),{target:{value:siteB}});fireEvent.change(screen.getByLabelText('Units at project for Drill'),{target:{value:'2'}});fireEvent.click(screen.getByRole('button',{name:'Review allocation'}));
  const dialog=screen.getByRole('dialog');expect(within(dialog).getByText(/Site B.*0 → 2 units/)).toBeTruthy();expect(mock.rpc).toHaveBeenCalledTimes(1);
  fireEvent.click(within(dialog).getByRole('button',{name:'Confirm operation'}));await screen.findByText(/Operation not confirmed/);expect(JSON.parse(sessionStorage.getItem('owned-equipment-attempt:founder')!)).toEqual(attempt);
  fireEvent.click(screen.getByRole('button',{name:'Retry same request'}));await screen.findByText(/original operation was confirmed/);
  const calls=mock.rpc.mock.calls.filter(c=>c[0]==='change_owned_equipment');expect(calls).toHaveLength(2);expect(calls[0][1]).toEqual(calls[1][1]);expect(calls[0][1]).toMatchObject({p_id:id,p_tool:tool,p_project:siteB,p_quantity:2,p_expected_site:0,p_expected_stock:5});expect(sessionStorage.getItem('owned-equipment-attempt:founder')).toBeNull();
 });
 it('recovers a stored request after remount and verifies its full details',async()=>{
  sessionStorage.setItem('owned-equipment-attempt:founder',JSON.stringify(attempt));mock.rpc.mockResolvedValueOnce({data:{found:false},error:null}).mockResolvedValueOnce({data:{found:true,attempt,result},error:null});
  render(React.createElement(OwnedEquipmentManager,{userId:'founder'}));fireEvent.click(screen.getByRole('button',{name:/Owned equipment allocation workspace/}));fireEvent.click(screen.getByRole('button',{name:'Check operation'}));await screen.findByText(/No completed event was found yet/);
  fireEvent.click(screen.getByRole('button',{name:'Check operation'}));await screen.findByText(/Operation recorded/);expect(sessionStorage.getItem('owned-equipment-attempt:founder')).toBeNull();
 });
 it('never sends when retry storage cannot be written',async()=>{
  mock.rpc.mockResolvedValueOnce({data:snapshot,error:null});await open();fireEvent.change(screen.getByLabelText('Project for Drill'),{target:{value:siteB}});fireEvent.change(screen.getByLabelText('Units at project for Drill'),{target:{value:'2'}});fireEvent.click(screen.getByRole('button',{name:'Review allocation'}));
  vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('Storage disabled');});fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Confirm operation'}));await screen.findByText(/Could not save the retry record/);expect(mock.rpc.mock.calls.map(c=>c[0])).toEqual(['owned_equipment_snapshot']);
 });
 it('requires an explicit physical-inventory confirmation to adopt unassigned stock',async()=>{
  mock.rpc.mockResolvedValueOnce({data:{...snapshot,items:[{...snapshot.items[0],managed:false,sites:[]}]},error:null}).mockResolvedValueOnce({data:{id,tool_id:tool,stock:5,allocated:0,depot:5,site_quantity:0,replayed:false},error:null});
  render(React.createElement(OwnedEquipmentManager,{userId:'founder'}));fireEvent.click(screen.getByRole('button',{name:/Owned equipment allocation workspace/}));fireEvent.click(screen.getByRole('button',{name:'Load inventory'}));await screen.findByText(/Legacy unassigned\/depot record/);
  fireEvent.click(screen.getByRole('button',{name:'Review adoption'}));expect(within(screen.getByRole('dialog')).getByText(/Confirm these are owned units physically at the depot/)).toBeTruthy();expect(mock.rpc).toHaveBeenCalledTimes(1);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Confirm operation'}));await screen.findByText(/Operation recorded/);expect(mock.rpc).toHaveBeenLastCalledWith('change_owned_equipment',{p_id:id,p_tool:tool,p_action:'adopt',p_project:null,p_quantity:null,p_expected_stock:5,p_expected_site:null});
 });
 it('does not offer adoption for legacy assigned stock',async()=>{
  mock.rpc.mockResolvedValueOnce({data:{...snapshot,items:[{...snapshot.items[0],managed:false,sites:[],legacy_project_id:siteA}]},error:null});
  render(React.createElement(OwnedEquipmentManager,{userId:'founder'}));fireEvent.click(screen.getByRole('button',{name:/Owned equipment allocation workspace/}));fireEvent.click(screen.getByRole('button',{name:'Load inventory'}));await screen.findByText(/Legacy site-assigned stock/);expect(screen.queryByRole('button',{name:'Review adoption'})).toBeNull();
 });
 it('is hidden unless the explicit preview flag and Founder assurance are ready',()=>{
  const props={userId:'founder',isFounder:true,assurance:'ready',authLoading:false};vi.stubEnv('NEXT_PUBLIC_OWNED_EQUIPMENT_PREVIEW','false');const view=render(React.createElement(OwnedEquipmentFoundation,props));expect(screen.queryByText(/Owned equipment allocation workspace/)).toBeNull();
  vi.stubEnv('NEXT_PUBLIC_OWNED_EQUIPMENT_PREVIEW','true');view.rerender(React.createElement(OwnedEquipmentFoundation,props));expect(screen.getByText(/Owned equipment allocation workspace/)).toBeTruthy();
  view.rerender(React.createElement(OwnedEquipmentFoundation,{...props,assurance:'checking'}));expect(screen.queryByText(/Owned equipment allocation workspace/)).toBeNull();
  view.rerender(React.createElement(OwnedEquipmentFoundation,{...props,isFounder:false}));expect(screen.queryByText(/Owned equipment allocation workspace/)).toBeNull();expect(mock.rpc).not.toHaveBeenCalled();
 });
});
