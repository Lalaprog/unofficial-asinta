import { describe,expect,it,vi,afterEach } from 'vitest';
import {categoryPreviewEnabled,parseCategoryAttempt,parseCategoryCatalog,parseCategoryHistory,parseCategoryResult,type CategoryAttempt} from '@/lib/workforce/categoryCatalog';
const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const category={id:id(1),label:'Mason',archived:false,revision:1};
const attempt:CategoryAttempt={requestId:id(2),categoryId:id(1),action:'rename',label:'Senior Mason',expectedRevision:1};
afterEach(()=>vi.unstubAllEnvs());
describe('worker category preview parsing',()=>{
 it('requires an exact opt-in',()=>{for(const v of [undefined,'','false','TRUE','1']){vi.stubEnv('NEXT_PUBLIC_WORKER_CATEGORY_PREVIEW',v);expect(categoryPreviewEnabled()).toBe(false);}vi.stubEnv('NEXT_PUBLIC_WORKER_CATEGORY_PREVIEW','true');expect(categoryPreviewEnabled()).toBe(true);});
 it('fails closed on malformed or duplicated categories',()=>{
  expect(parseCategoryCatalog([category])).toEqual([category]);
  for(const bad of [null,{},[category,category],[{...category,id:'bad'}],[{...category,revision:0}],[{...category,label:'  '}],[{...category,archived:'false'}]])expect(()=>parseCategoryCatalog(bad)).toThrow();
 });
 it('validates exact saved retry shape and response identity/version',()=>{
  expect(parseCategoryAttempt(attempt)).toEqual(attempt);
  for(const bad of [{...attempt,requestId:'bad'},{...attempt,label:null},{...attempt,expectedRevision:null},{...attempt,action:'delete'}])expect(()=>parseCategoryAttempt(bad)).toThrow();
  expect(parseCategoryResult({...category,label:'Senior Mason',revision:2,replayed:true},attempt).replayed).toBe(true);
  for(const bad of [{...category,id:id(3),revision:2,label:'Senior Mason',replayed:false},{...category,revision:1,label:'Senior Mason',replayed:false},{...category,revision:2,label:'Mason',replayed:false}])expect(()=>parseCategoryResult(bad,attempt)).toThrow();
 });
 it('rejects broken history and incomplete pagination cursors',()=>{
  const event={request_id:id(2),actor_id:id(3),action:'add',before_label:null,before_archived:null,after_label:'Mason',after_archived:false,after_revision:1,occurred_at:'2026-10-15T12:00:00+00:00'};
  expect(parseCategoryHistory({items:[event],has_more:false}).items).toHaveLength(1);
  for(const bad of [{items:[event],has_more:true},{items:[event,event],has_more:false},{items:[{...event,occurred_at:'bad'}],has_more:false},{items:[],has_more:'false'}])expect(()=>parseCategoryHistory(bad)).toThrow();
 });
});
