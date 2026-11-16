// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn()}));vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
import {PaidWorkerEvidence} from '@/components/projects/PaidWorkerEvidence';
import {parsePaidWorkerPage} from '@/lib/projects/paidWorkerEvidence';
import {projectPaidWorkerEvidencePreviewEnabled} from '@/lib/finance/featureAvailability';
const row=(n:number)=>({payroll_id:String(n).padStart(3,'0'),worker_id:'worker',worker_name:'Ada',period_start:'2026-11-15',period_end:'2026-11-21',payment_date:'2026-11-21',hours:'8.00',wage:'88.89',allowance:'0.25',gross:'89.14'});
const page=(items:unknown[],more=false)=>({project_id:'site',items,has_more:more});
beforeEach(()=>mock.rpc.mockReset());afterEach(()=>{cleanup();vi.unstubAllEnvs();});
describe('experimental project paid payroll evidence',()=>{
 it('requires both default-off gates',()=>{vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_PROJECT_PAID_WORKER_EVIDENCE_PREVIEW','false');expect(projectPaidWorkerEvidencePreviewEnabled()).toBe(false);vi.stubEnv('NEXT_PUBLIC_PROJECT_PAID_WORKER_EVIDENCE_PREVIEW','true');expect(projectPaidWorkerEvidencePreviewEnabled()).toBe(true);vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','false');expect(projectPaidWorkerEvidencePreviewEnabled()).toBe(false);});
 it('shows only attributed gross evidence with warnings and keyset pagination',async()=>{
  mock.rpc.mockResolvedValueOnce({data:page(Array.from({length:25},(_,i)=>row(30-i)),true),error:null}).mockResolvedValueOnce({data:page([row(5)]),error:null});
  render(React.createElement(PaidWorkerEvidence,{projectId:'site',userId:'founder'}));await screen.findAllByText(/Ada · 2026-11-15/);expect(screen.getByText(/Do not add these figures/)).toBeTruthy();expect(screen.getByText(/not proof of transfer/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Show older payroll evidence'}));await screen.findByText('Voucher 005');expect(mock.rpc.mock.calls[1][1]).toMatchObject({p_cursor_week:'2026-11-15',p_cursor_payroll:'006'});
 });
 it('clears previously displayed rows if a later page fails and rejects stale responses',async()=>{
  mock.rpc.mockResolvedValueOnce({data:page(Array.from({length:25},(_,i)=>row(30-i)),true),error:null}).mockResolvedValueOnce({data:page([row(30)]),error:null});
  const view=render(React.createElement(PaidWorkerEvidence,{projectId:'site',userId:'one'}));await screen.findByRole('button',{name:'Show older payroll evidence'});fireEvent.click(screen.getByRole('button',{name:'Show older payroll evidence'}));await screen.findByRole('alert');expect(screen.queryByText('Voucher 030')).toBeNull();
  let resolve!:(v:unknown)=>void;mock.rpc.mockReturnValueOnce(new Promise(r=>{resolve=r;})).mockResolvedValueOnce({data:{project_id:'other',items:[],has_more:false},error:null});
  view.rerender(React.createElement(PaidWorkerEvidence,{projectId:'site2',userId:'two'}));view.rerender(React.createElement(PaidWorkerEvidence,{projectId:'other',userId:'three'}));resolve({data:page([row(1)]),error:null});await screen.findByText(/No matching paid allocations/);expect(screen.queryByText('Voucher 001')).toBeNull();
 });
 it('rejects wrong site, unbalanced amounts, duplicates, invalid week and invalid pagination',()=>{
  expect(parsePaidWorkerPage(page([row(2)]),'site').items).toHaveLength(1);
  for(const bad of [{...page([row(2)]),project_id:'other'},page([{...row(2),gross:'89.15'}]),page([row(2),row(2)]),page([{...row(2),period_start:'2026-11-16'}]),page([row(2)],true)])expect(()=>parsePaidWorkerPage(bad,'site')).toThrow();
 });
});
