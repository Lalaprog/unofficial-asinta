import {describe,expect,it,vi} from 'vitest';
import {loadWeeklyBaleStatusBatches,MAX_LOADED_STATUS_IDS} from '@/lib/attendance/weeklyBaleStatus';

const ids=(count:number)=>Array.from({length:count},(_,i)=>`request-${i}`);
const item=(id:string)=>({id,kind:'weekly',period_start:'2026-11-15',stored_status:'pending_approval',effective_status:'pending_approval',auto_expired:false,can_review:true});
const result=(chunk:string[],as_of='2026-11-17T10:00:00Z')=>({data:{as_of,items:chunk.map(item)},error:null});

describe('bounded weekly Bale status batches',()=>{
 it('checks 501 loaded IDs in separate bounded calls without losing the older request',async()=>{
  const fetch=vi.fn(async(chunk:string[])=>result(chunk));
  const all=ids(501),status=await loadWeeklyBaleStatusBatches(all,fetch);
  expect(fetch.mock.calls.map(([chunk])=>chunk.length)).toEqual([500,1]);
  expect(status.items.map(row=>row.id)).toEqual(all);
  expect(status.as_of).toBe('2026-11-17T10:00:00.000Z');
 });
 it('accepts the bound and prevents too many or duplicate IDs before any call',async()=>{
  const fetch=vi.fn(async(chunk:string[])=>result(chunk));
  expect((await loadWeeklyBaleStatusBatches(ids(MAX_LOADED_STATUS_IDS),fetch)).items).toHaveLength(MAX_LOADED_STATUS_IDS);
  expect(fetch).toHaveBeenCalledTimes(4);fetch.mockClear();
  await expect(loadWeeklyBaleStatusBatches(ids(MAX_LOADED_STATUS_IDS+1),fetch)).rejects.toThrow(/Too many/);
  await expect(loadWeeklyBaleStatusBatches(['same','same'],fetch)).rejects.toThrow(/duplicate/);
  expect(fetch).not.toHaveBeenCalled();
 });
 it('holds all results when any chunk fails, is missing or is malformed',async()=>{
  for(const failure of [{data:null,error:{message:'offline'}},{data:{as_of:'2026-11-17T10:00:00Z',items:[]},error:null},{data:{as_of:'bad',items:[]},error:null}]) {
   const fetch=vi.fn(async(chunk:string[])=>chunk.length===500?result(chunk):failure);
   await expect(loadWeeklyBaleStatusBatches(ids(501),fetch)).rejects.toThrow();
  }
 });
 it('refuses batches crossing Philippine midnight or with widely separated server timestamps',async()=>{
  const crossing=vi.fn(async(chunk:string[])=>result(chunk,chunk.length===500?'2026-11-17T15:59:59Z':'2026-11-17T16:00:00Z'));
  await expect(loadWeeklyBaleStatusBatches(ids(501),crossing)).rejects.toThrow(/time boundary/);
  const delayed=vi.fn(async(chunk:string[])=>result(chunk,chunk.length===500?'2026-11-17T10:00:00Z':'2026-11-17T10:01:01Z'));
  await expect(loadWeeklyBaleStatusBatches(ids(501),delayed)).rejects.toThrow(/took too long/);
 });
 it('uses the earliest server time for a successful set, not the device clock',async()=>{
  const fetch=vi.fn(async(chunk:string[])=>result(chunk,chunk.length===500?'2026-11-17T10:00:01Z':'2026-11-17T10:00:00Z'));
  const data=await loadWeeklyBaleStatusBatches(ids(501),fetch);
  expect(data.as_of).toBe('2026-11-17T10:00:00.000Z');
 });
});
