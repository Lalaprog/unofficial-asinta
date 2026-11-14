import {describe,expect,it} from 'vitest';
import {parseStoredCorrectedAttempt,savedMatchesCorrectedAttempt,serializeCorrectedAttempt} from '@/lib/projects/correctedReviewAttempt';
import {parseCorrectedSaved} from '@/lib/projects/correctedCostReview';
import {actor,choices,inventory,request,saved,site} from './helpers/corrected-cost-ui-fixture';
const marker={requestId:request,projectId:site,actorId:actor,expectedRevision:0};
const attempt={marker,raw:inventory,choices,note:'Reviewed records'};
describe('tab-local corrected review retry',()=>{
 it('validates and restores exact evidence and keeps identifier-only markers compatible',()=>{
  const encoded=serializeCorrectedAttempt(attempt,site,actor),restored=parseStoredCorrectedAttempt(encoded,site,actor);
  expect(restored.attempt).toEqual(attempt);expect(serializeCorrectedAttempt(restored.attempt!,site,actor)).toBe(encoded);
  expect(parseStoredCorrectedAttempt(JSON.stringify(marker),site,actor)).toEqual({marker,attempt:null});
 });
 it('confirms reviewed evidence and decisions, allowing only a server-assigned capture time to differ',()=>{
  const server=saved(request);server.snapshot=structuredClone(inventory);server.snapshot.historical_review.base.captured_at='2025-01-01T00:00:00Z';
  const parsed=parseCorrectedSaved(server,site);if(!parsed.found)throw Error('Missing review');
  expect(savedMatchesCorrectedAttempt(parsed,attempt)).toBe(true);
  expect(savedMatchesCorrectedAttempt(parsed,{...attempt,note:'Different note'})).toBe(false);
  const changed=structuredClone(inventory);changed.historical_review.historical[0].note='Different source evidence';
  expect(savedMatchesCorrectedAttempt(parsed,{...attempt,raw:changed})).toBe(false);
  const different=structuredClone(choices);different.corrections[`voucher:${inventory.corrections[0].case_id}`].reason='Changed reason';
  expect(savedMatchesCorrectedAttempt(parsed,{...attempt,choices:different})).toBe(false);
 });
 it('rejects invalid, oversized, differently scoped, or incomplete stored attempts',()=>{
  const v=JSON.parse(serializeCorrectedAttempt(attempt,site,actor));
  for(const changed of [{...v,version:2},{...v,extra:true},{...v,note:'  '},{...v,choices:{...choices,corrections:{}}},{...v,raw:{...inventory,project_id:request}},{...v,marker:{...marker,actorId:request}}])expect(()=>parseStoredCorrectedAttempt(JSON.stringify(changed),site,actor)).toThrow();
  expect(()=>parseStoredCorrectedAttempt(' '.repeat(3000001),site,actor)).toThrow(/large/);
  expect(()=>parseStoredCorrectedAttempt(JSON.stringify({...marker,extra:true}),site,actor)).toThrow();
 });
});
