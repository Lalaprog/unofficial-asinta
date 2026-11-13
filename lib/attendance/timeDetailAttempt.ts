// A tab-local exact retry record; this is neither authorization nor proof of a write.
export type TimeDetailAttempt={version:1;actor:string;attendance:string;worker:string;project:string;date:string;submittedAt:string;id:string;regular:string;overtime:string;note:string};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function timeDetailAttemptKey(actor:string,attendance:string):string{return JSON.stringify(['attendance-time-attempt-v1',actor,attendance]);}
export function parseTimeDetailAttempt(value:unknown):TimeDetailAttempt{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid time detail retry record');
 const a=value as TimeDetailAttempt;
 if(a.version!==1||[a.actor,a.attendance,a.worker,a.project,a.date,a.submittedAt].some(v=>typeof v!=='string'||!v||v.length>200)||typeof a.id!=='string'||!uuid.test(a.id)
  ||typeof a.regular!=='string'||typeof a.overtime!=='string'||!/^\d{1,2}(?:\.\d{1,2})?$/.test(a.regular)||!/^\d{1,2}(?:\.\d{1,2})?$/.test(a.overtime)
  ||Number(a.regular)>8||Number(a.regular)+Number(a.overtime)>24||Number(a.regular)+Number(a.overtime)<=0
  ||typeof a.note!=='string'||!a.note||a.note!==a.note.trim()||a.note.length>500)throw new Error('Invalid time detail retry record');
 return {version:1,actor:a.actor,attendance:a.attendance,worker:a.worker,project:a.project,date:a.date,submittedAt:a.submittedAt,id:a.id,regular:a.regular,overtime:a.overtime,note:a.note};
}
