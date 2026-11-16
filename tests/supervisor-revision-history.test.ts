import {describe,expect,it} from 'vitest';
import {parseSupervisorRevisionHistory} from '@/lib/payroll/supervisorLedger';
const id='10000000-0000-4000-8000-000000000001',actor='10000000-0000-4000-8000-000000000002';
const event=(revision:string)=>({request_id:`10000000-0000-4000-8000-${revision.padStart(12,'0')}`,actor_id:actor,action:'refresh',revision,occurred_at:'2026-11-14T00:00:00Z',reason:'Updated hours',before_status:'draft',after_status:'draft',before_rate:'600.00',after_rate:'600.00',before_gross:'600.00',after_gross:'900.00',paid_on:null});
describe('Supervisor revision history',()=>{
 it('checks scope, order, money and complete pages',()=>{
  const raw={payroll_id:id,items:[event('4'),event('3')],has_more:false};expect(parseSupervisorRevisionHistory(raw,id,null).items).toHaveLength(2);
  expect(()=>parseSupervisorRevisionHistory(raw,actor,null)).toThrow();expect(()=>parseSupervisorRevisionHistory(raw,id,'4')).toThrow();
  expect(()=>parseSupervisorRevisionHistory({...raw,items:[event('3'),event('4')]},id,null)).toThrow();
  expect(()=>parseSupervisorRevisionHistory({...raw,has_more:true},id,null)).toThrow();
  expect(()=>parseSupervisorRevisionHistory({...raw,items:[{...event('4'),after_gross:'NaN'}]},id,null)).toThrow();
 });
});
