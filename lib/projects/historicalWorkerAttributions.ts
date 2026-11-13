import {costCents} from './projectCostReconciliation';
export type HistoricalProjectAttribution={requestId:string;sourceId:string;workerId:string;workerName:string;start:string;end:string;paidOn:string;originalGross:string;siteGross:string;note:string;recordedBy:string;recordedAt:string;caseCount:number};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const date=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(`${v}T00:00:00Z`))&&new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)===v;
/** Separate incomplete human evidence, never a paid project-cost total. */
export function parseHistoricalProjectAttributions(raw:unknown,project:string):HistoricalProjectAttribution[]{
 if(!uuid(project)||!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid historical attribution response');
 const v=raw as Record<string,unknown>;if(v.project_id!==project||!Array.isArray(v.items)||v.items.length>200)throw Error('Invalid historical attribution project or count');
 const requests=new Set<string>(),sources=new Set<string>();let previous:{start:string;request:string}|undefined;
 return v.items.map((entry:unknown)=>{
  if(!entry||typeof entry!=='object'||Array.isArray(entry))throw Error('Invalid historical attribution');const x=entry as Record<string,unknown>;
  if(!uuid(x.request_id)||!uuid(x.source_id)||!uuid(x.worker_id)||!uuid(x.recorded_by)||requests.has(x.request_id.toLowerCase())||sources.has(x.source_id.toLowerCase())||typeof x.worker_name!=='string'||!x.worker_name.trim()||typeof x.note!=='string'||!x.note.trim()||x.note.length>500||typeof x.recorded_at!=='string'||!Number.isFinite(Date.parse(x.recorded_at))||!date(x.period_start)||!date(x.period_end)||!date(x.paid_on)||typeof x.case_count!=='number'||!Number.isSafeInteger(x.case_count)||x.case_count<0||x.case_count>100)throw Error('Invalid historical attribution identity or evidence');
  const start=new Date(`${x.period_start}T00:00:00Z`),end=new Date(`${x.period_end}T00:00:00Z`);
  if(start.getUTCDay()!==0||end.getTime()-start.getTime()!==6*86400000||x.paid_on<x.period_start||costCents(x.site_gross)<=0n||costCents(x.site_gross)>costCents(x.original_gross))throw Error('Invalid historical attribution period or gross');
  if(previous&&(x.period_start>previous.start||(x.period_start===previous.start&&x.request_id.toLowerCase()>=previous.request)))throw Error('Invalid historical attribution order');
  requests.add(x.request_id.toLowerCase());sources.add(x.source_id.toLowerCase());previous={start:x.period_start,request:x.request_id.toLowerCase()};
  return {requestId:x.request_id,sourceId:x.source_id,workerId:x.worker_id,workerName:x.worker_name,start:x.period_start,end:x.period_end,paidOn:x.paid_on,originalGross:x.original_gross as string,siteGross:x.site_gross as string,note:x.note,recordedBy:x.recorded_by,recordedAt:x.recorded_at,caseCount:x.case_count};
 });
}
