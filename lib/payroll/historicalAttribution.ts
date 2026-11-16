import {parseExternalList,type ExternalRow} from './historicalExternalWorker';
export type AttributionProject={id:string;name:string};
export type AttributionSplit={project_id:string;gross:string};
export type AttributionAttempt={id:string;actor:string;source:ExternalRow;split:AttributionSplit[];note:string};
export type AttributionStatus={found:false}|{found:true;request_id:string;source_id:string;source:ExternalRow;source_changed:boolean;split:AttributionSplit[];note:string;actor_id:string;recorded_at:string;case_count:number};
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const note=(x:unknown):x is string=>typeof x==='string'&&x===x.trim()&&x.length>0&&x.length<=500&&!/[\x00-\x1f\x7f]/.test(x);
const canonical=(x:unknown):string=>{if(Array.isArray(x))return `[${x.map(canonical).join(',')}]`;if(object(x))return `{${Object.keys(x).sort().map(k=>`${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`;return JSON.stringify(x);};
export const sameAttributionEvidence=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
export function attributionMoney(x:unknown):{cents:bigint;formatted:string}{
 if(typeof x!=='string'||!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(x))throw Error('Invalid amount');
 const [a,b='']=x.split('.'),formatted=`${a}.${b.padEnd(2,'0')}`;return {cents:BigInt(a)*100n+BigInt(b.padEnd(2,'0')),formatted};
}
export function parseAttributionProjects(raw:unknown):AttributionProject[]{
 if(!object(raw)||Object.keys(raw).join(',')!=='projects'||!Array.isArray(raw.projects)||raw.projects.length>2000)throw Error('Invalid project catalog');const ids=new Set<string>();
 return raw.projects.map((x:unknown)=>{if(!object(x)||Object.keys(x).sort().join(',')!=='id,name'||!uuid(x.id)||typeof x.name!=='string'||!x.name.trim()||ids.has(x.id.toLowerCase()))throw Error('Invalid project');ids.add(x.id.toLowerCase());return {id:x.id,name:x.name};});
}
export function parseAttributionSource(raw:unknown,worker:string,source:string):ExternalRow{
 if(!object(raw)||Object.keys(raw).sort().join(',')!=='bale,evidence_note,gross,net,other_deductions,paid_on,period_end,period_start,recorded_at,recorded_by,request_id,worker_id,worker_snapshot')throw Error('Invalid assertion shape');
 const row=parseExternalList({total:1,offset:0,items:[raw]},worker).items[0];if(row.request_id!==source)throw Error('Wrong historical assertion');return row;
}
export function parseAttributionSplit(raw:unknown,gross:string):AttributionSplit[]{
 if(!Array.isArray(raw)||raw.length<1||raw.length>50)throw Error('Select between one and fifty projects');const seen=new Set<string>();let total=0n;
 const split=raw.map((x:unknown)=>{if(!object(x)||Object.keys(x).sort().join(',')!=='gross,project_id'||!uuid(x.project_id)||seen.has(x.project_id.toLowerCase()))throw Error('Invalid or duplicate project');
  seen.add(x.project_id.toLowerCase());const amount=attributionMoney(x.gross);if(amount.cents<=0n)throw Error('Site amount must be positive');total+=amount.cents;return {project_id:x.project_id.toLowerCase(),gross:amount.formatted};});
 if(total!==attributionMoney(gross).cents||total<=0n)throw Error('Site amounts must equal full gross');return split.sort((a,b)=>a.project_id.localeCompare(b.project_id));
}
export function parseAttributionAttempt(raw:unknown,actor:string,worker:string,sourceId:string):AttributionAttempt{
 if(!object(raw)||Object.keys(raw).sort().join(',')!=='actor,id,note,source,split'||!uuid(raw.id)||!uuid(raw.actor)||raw.actor!==actor||!note(raw.note))throw Error('Invalid saved attribution');
 const source=parseAttributionSource(raw.source,worker,sourceId),split=parseAttributionSplit(raw.split,source.gross);
 return {id:raw.id,actor:raw.actor,source,split,note:raw.note};
}
export function parseAttributionStatus(raw:unknown,worker:string,sourceId:string):AttributionStatus{
 if(!object(raw)||typeof raw.found!=='boolean')throw Error('Invalid attribution status');if(!raw.found){if(Object.keys(raw).join(',')!=='found')throw Error('Invalid attribution status');return {found:false};}
 if(Object.keys(raw).sort().join(',')!=='actor_id,case_count,found,note,recorded_at,request_id,source,source_changed,source_id,split')throw Error('Invalid attribution status');
 if(!uuid(raw.request_id)||raw.source_id!==sourceId||!uuid(raw.actor_id)||!note(raw.note)||typeof raw.source_changed!=='boolean'||typeof raw.recorded_at!=='string'||!Number.isFinite(Date.parse(raw.recorded_at))||typeof raw.case_count!=='number'||!Number.isSafeInteger(raw.case_count)||raw.case_count<0||raw.case_count>100)throw Error('Invalid attribution status');
 const source=parseAttributionSource(raw.source,worker,sourceId),split=parseAttributionSplit(raw.split,source.gross);
 return {found:true,request_id:raw.request_id,source_id:sourceId,source,source_changed:raw.source_changed,split,note:raw.note,actor_id:raw.actor_id,recorded_at:raw.recorded_at,case_count:raw.case_count};
}
export function attributionStatusMatches(status:AttributionStatus,a:AttributionAttempt):boolean{
 return status.found&&!status.source_changed&&status.request_id===a.id&&status.actor_id===a.actor&&status.source_id===a.source.request_id&&status.note===a.note&&sameAttributionEvidence(status.source,a.source)&&sameAttributionEvidence(status.split,a.split);
}
export function attributionArguments(a:AttributionAttempt){return {p_request:a.id,p_source:a.source.request_id,p_expected:a.source,p_split:a.split,p_note:a.note,p_ack:true};}
