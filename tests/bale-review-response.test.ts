import {describe,expect,it} from 'vitest';
import type {AdvanceRequest} from '@/types';
import {verifyBaleReviewRows} from '@/lib/attendance/baleReview';
const request=(id:string):AdvanceRequest=>({id,worker_id:'worker',project_id:'site',submitted_by:'supervisor',requested_amount:125.5,status:'pending_approval',approved_by:null,approved_at:null,rejected_by:null,rejected_at:null,issued_by:null,issued_at:null,issued_advance_id:null,created_at:'2026-11-15T00:00:00Z',updated_at:'2026-11-15T00:00:00Z'});
const approved=(id:string)=>({...request(id),status:'approved_pending_payment',requested_amount:'125.50',approved_by:'founder',approved_at:'2026-11-17T01:00:00Z'});
describe('Bale review response verification',()=>{
 it('accepts exactly the selected requests in any order',()=>{
  const rows=verifyBaleReviewRows([approved('b'),approved('a')],[request('a'),request('b')],'approve','founder');
  expect(rows.map(row=>row.id)).toEqual(['b','a']);expect(rows[0].requested_amount).toBe(125.5);
 });
 it('requires the recorded rejection actor and time',()=>{
  const rejected={...request('a'),status:'rejected',rejected_by:'founder',rejected_at:'2026-11-17T01:00:00Z'};
  expect(verifyBaleReviewRows([rejected],[request('a')],'reject','founder')).toHaveLength(1);
  expect(()=>verifyBaleReviewRows([{...rejected,rejected_by:'other'}],[request('a')],'reject','founder')).toThrow();
 });
 it.each([
  {rows:[]},{rows:[approved('a'),approved('a')]},{rows:[approved('a'),approved('other')]},
  {rows:[approved('a'),{...approved('b'),status:'pending_approval'}]},
  {rows:[approved('a'),{...approved('b'),approved_by:'other'}]},
  {rows:[approved('a'),{...approved('b'),approved_at:'invalid'}]},
  {rows:[approved('a'),{...approved('b'),requested_amount:999}]},
  {rows:[approved('a'),{...approved('b'),worker_id:'other'}]},
  {rows:[approved('a'),{...approved('b'),project_id:'other'}]},
  {rows:[approved('a'),{...approved('b'),submitted_by:'other'}]},
 ])('rejects incomplete, duplicated or mismatched responses %#',({rows})=>{
  expect(()=>verifyBaleReviewRows(rows,[request('a'),request('b')],'approve','founder')).toThrow();
 });
});
