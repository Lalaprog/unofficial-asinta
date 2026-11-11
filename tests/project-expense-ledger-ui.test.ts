// @vitest-environment jsdom
import React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,renderHook,screen,waitFor} from '@testing-library/react';
const mocks=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mocks.rpc})}));
vi.mock('next/link',()=>({default:({href,children}:{href:string;children:React.ReactNode})=>React.createElement('a',{href},children)}));
import {ProjectExpenseLedger} from '@/components/projects/ProjectExpenseLedger';
import {useExpenseTotals} from '@/lib/projects/useExpenseTotals';
const row={id:'bb',project_id:'site',description:'Newest',category:'materials',amount:'12.35',expense_date:'2026-10-01',notes:null};
const page=(items:unknown[],has_more:boolean)=>({data:{items,has_more},error:null});
const deferred=()=>{let resolve!:(value:unknown)=>void;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
beforeEach(()=>mocks.rpc.mockReset());afterEach(()=>cleanup());
describe('project expense display',()=>{
 it('shows server records in centavos and loads older pages',async()=>{
  mocks.rpc.mockResolvedValueOnce(page([row],true)).mockResolvedValueOnce(page([{...row,id:'aa',description:'Old invoice',amount:'99.99',expense_date:'2020-01-01'}],false));
  render(React.createElement(ProjectExpenseLedger,{projectId:'site',userId:'founder',onRefreshTotals:vi.fn()}));
  expect(await screen.findByText('₱12.35')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Show older expenses'}));
  expect(await screen.findByText('Old invoice')).toBeTruthy();expect(screen.getByText('₱99.99')).toBeTruthy();
  expect(mocks.rpc).toHaveBeenLastCalledWith('project_expense_page',expect.objectContaining({p_project_id:'site',p_cursor_id:'bb',p_cursor_date:'2026-10-01'}));
 });
 it('shows an error rather than a false empty ledger and offers retry',async()=>{
  mocks.rpc.mockResolvedValueOnce({data:null,error:{message:'offline'}}).mockResolvedValueOnce(page([],false));
  render(React.createElement(ProjectExpenseLedger,{projectId:'site',userId:'founder',onRefreshTotals:vi.fn()}));
  expect(await screen.findByRole('alert')).toBeTruthy();expect(screen.queryByText(/No recorded expenses/)).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Reload ledger'}));expect(await screen.findByText(/No recorded expenses/)).toBeTruthy();
 });
 it('drops old totals on scope change and late response',async()=>{
  const old=deferred(),newer=deferred();mocks.rpc.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise);
  const hook=renderHook(({site})=>useExpenseTotals('f',true,[site]),{initialProps:{site:'old'}});
  hook.rerender({site:'new'});
  await act(async()=>newer.resolve({data:[{project_id:'new',expense_count:1,total:'1.25'}],error:null}));
  await waitFor(()=>expect(hook.result.current.totals.get('new')?.total).toBe(1.25));
  await act(async()=>old.resolve({data:[{project_id:'old',expense_count:1,total:'3.00'}],error:null}));
  expect(hook.result.current.totals.has('old')).toBe(false);
 });
 it('does not call the expense totals function for a Supervisor',()=>{
  const hook=renderHook(()=>useExpenseTotals('s',false,['site']));
  expect(hook.result.current.status).toBe('idle');expect(mocks.rpc).not.toHaveBeenCalled();
 });
});
