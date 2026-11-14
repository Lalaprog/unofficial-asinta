import {developmentFinanceCutoverEnabled} from '@/lib/finance/featureAvailability';
export function assignmentHistoryPreviewEnabled():boolean{return (process.env.NEXT_PUBLIC_ASSIGNMENT_HISTORY_PREVIEW==='true') || developmentFinanceCutoverEnabled();}
export type AssignmentEvent={id:string;projectId:string;projectName:string;type:'baseline_active'|'baseline_inactive'|'assigned'|'unassigned';occurredAt:string;actorId:string|null};
export function parseAssignmentHistory(raw:unknown,worker:string,cursor?:AssignmentEvent):{items:AssignmentEvent[];hasMore:boolean}{
 if(!raw||typeof raw!=='object')throw new Error('Invalid history');const page=raw as {worker_id?:unknown;has_more?:unknown;items?:unknown};
 if(page.worker_id!==worker||typeof page.has_more!=='boolean'||!Array.isArray(page.items)||page.items.length>25||(page.has_more&&page.items.length!==25))throw new Error('Invalid history');
 const ids=new Set<string>();let previous=cursor;
 const items=page.items.map((raw:unknown):AssignmentEvent=>{
  if(!raw||typeof raw!=='object')throw new Error('Invalid event');const r=raw as Record<string,unknown>;
  if(typeof r.id!=='string'||!r.id||ids.has(r.id)||typeof r.project_id!=='string'||!r.project_id||typeof r.project_name!=='string'||!r.project_name||typeof r.event_type!=='string'||!['baseline_active','baseline_inactive','assigned','unassigned'].includes(r.event_type)||typeof r.occurred_at!=='string'||!Number.isFinite(Date.parse(r.occurred_at))||!(r.actor_id===null||typeof r.actor_id==='string')||(r.event_type.startsWith('baseline_')&&r.actor_id!==null))throw new Error('Invalid event');
  if(previous&&(Date.parse(r.occurred_at)>Date.parse(previous.occurredAt)||(r.occurred_at===previous.occurredAt&&r.id>=previous.id)))throw new Error('Invalid event order');
  ids.add(r.id);const result={id:r.id,projectId:r.project_id,projectName:r.project_name,type:r.event_type as AssignmentEvent['type'],occurredAt:r.occurred_at,actorId:r.actor_id as string|null};previous=result;return result;
 });return {items,hasMore:page.has_more};
}
