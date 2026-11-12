export type WorkerCategory = {id:string;label:string;archived:boolean;revision:number};
export type CategoryAction = 'add'|'rename'|'archive'|'restore';
export type CategoryAttempt = {requestId:string;categoryId:string;action:CategoryAction;label:string|null;expectedRevision:number|null};
export type CategoryEvent = {request_id:string;actor_id:string;action:CategoryAction;before_label:string|null;before_archived:boolean|null;after_label:string;after_archived:boolean;after_revision:number;occurred_at:string};
export type CategoryHistoryPage = {items:CategoryEvent[];has_more:boolean};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const actions:CategoryAction[]=['add','rename','archive','restore'];
const isObject=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const validLabel=(v:unknown):v is string=>typeof v==='string'&&v.trim()===v&&v.length>0&&v.length<=80&&!/[\x00-\x1f\x7f]/.test(v);
const validRevision=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=1&&v<=2147483647;
export function categoryPreviewEnabled():boolean {return process.env.NEXT_PUBLIC_WORKER_CATEGORY_PREVIEW==='true';}
export function parseCategory(raw:unknown):WorkerCategory {
 if(!isObject(raw)||typeof raw.id!=='string'||!uuid.test(raw.id)||!validLabel(raw.label)||typeof raw.archived!=='boolean'||!validRevision(raw.revision))throw new Error('Invalid category response');
 return {id:raw.id,label:raw.label,archived:raw.archived,revision:raw.revision};
}
export function parseCategoryCatalog(raw:unknown):WorkerCategory[] {
 if(!Array.isArray(raw)||raw.length>500)throw new Error('Invalid category catalog');
 const items=raw.map(parseCategory),ids=new Set(items.map(v=>v.id.toLowerCase()));
 if(ids.size!==items.length)throw new Error('Duplicate category IDs');
 return items;
}
export function parseCategoryResult(raw:unknown,attempt:CategoryAttempt):WorkerCategory & {replayed:boolean} {
 const category=parseCategory(raw);
 if(!isObject(raw)||typeof raw.replayed!=='boolean'||category.id.toLowerCase()!==attempt.categoryId.toLowerCase())throw new Error('Invalid category result');
 if(attempt.action==='add'&&(category.label!==attempt.label||category.archived||category.revision!==1))throw new Error('Unexpected category result');
 if(attempt.action==='rename'&&(category.label!==attempt.label||category.archived||category.revision!==attempt.expectedRevision!+1))throw new Error('Unexpected category result');
 if(attempt.action==='archive'&&(!category.archived||category.revision!==attempt.expectedRevision!+1))throw new Error('Unexpected category result');
 if(attempt.action==='restore'&&(category.archived||category.revision!==attempt.expectedRevision!+1))throw new Error('Unexpected category result');
 return {...category,replayed:raw.replayed};
}
export function parseCategoryHistory(raw:unknown):CategoryHistoryPage {
 if(!isObject(raw)||!Array.isArray(raw.items)||raw.items.length>100||typeof raw.has_more!=='boolean'||(raw.has_more&&raw.items.length!==100))throw new Error('Invalid category history');
 const seen=new Set<string>();
 const items=raw.items.map((event:unknown):CategoryEvent=>{
  if(!isObject(event)||typeof event.request_id!=='string'||!uuid.test(event.request_id)||seen.has(event.request_id.toLowerCase())||typeof event.actor_id!=='string'||!uuid.test(event.actor_id)||typeof event.action!=='string'||!actions.includes(event.action as CategoryAction)||!(event.before_label===null||validLabel(event.before_label))||!(event.before_archived===null||typeof event.before_archived==='boolean')||!validLabel(event.after_label)||typeof event.after_archived!=='boolean'||!validRevision(event.after_revision)||typeof event.occurred_at!=='string'||!Number.isFinite(Date.parse(event.occurred_at)))throw new Error('Invalid category history event');
  seen.add(event.request_id.toLowerCase());return event as CategoryEvent;
 });
 return {items,has_more:raw.has_more};
}
export function prepareCategoryAttempt(action:CategoryAction, category:WorkerCategory|null, name:string):CategoryAttempt {
 const label=action==='add'||action==='rename'?name.trim():null;
 if(label!==null&&!validLabel(label))throw new Error('Enter a category name of 1–80 characters without control characters.');
 if(action!=='add'&&!category)throw new Error('Choose a category first.');
 if(typeof crypto.randomUUID!=='function')throw new Error('A secure request ID is unavailable in this browser.');
 return {requestId:crypto.randomUUID(),categoryId:category?.id??crypto.randomUUID(),action,label,expectedRevision:category?.revision??null};
}
/** Persisted retry payload is untrusted browser state: validate before use. */
export function parseCategoryAttempt(raw:unknown):CategoryAttempt {
 if(!isObject(raw)||typeof raw.requestId!=='string'||!uuid.test(raw.requestId)||typeof raw.categoryId!=='string'||!uuid.test(raw.categoryId)||typeof raw.action!=='string'||!actions.includes(raw.action as CategoryAction))throw new Error('Invalid recovery record');
 const action=raw.action as CategoryAction;
 if((action==='add'||action==='rename')?!validLabel(raw.label):raw.label!==null)throw new Error('Invalid recovery label');
 if(action==='add'?raw.expectedRevision!==null:!validRevision(raw.expectedRevision))throw new Error('Invalid recovery revision');
 return {requestId:raw.requestId,categoryId:raw.categoryId,action,label:raw.label as string|null,expectedRevision:raw.expectedRevision as number|null};
}
