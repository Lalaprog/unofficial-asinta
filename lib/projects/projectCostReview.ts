import {costCents,estimateProjectCost,parseCostSnapshot,type CostChoice,type CostSnapshot} from './projectCostReconciliation';

const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const record=(x:unknown):Record<string,unknown>=>{if(!x||typeof x!=='object'||Array.isArray(x))throw Error('Invalid review');return x as Record<string,unknown>;};
const revision=(x:unknown):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0&&x<=2147483647;
const totalCents=(x:unknown):bigint=>{if(typeof x!=='string'||!/^(?:0|[1-9]\d{0,13})\.\d{2}$/.test(x))throw Error('Invalid review total');const [a,b]=x.split('.');return BigInt(a)*100n+BigInt(b);};
const text=(x:unknown,max:number):x is string=>typeof x==='string'&&x===x.trim()&&x.length>0&&x.length<=max&&!/[\u0000-\u001f\u007f-\u009f]/.test(x);
export type ReviewMarker={requestId:string;projectId:string;actorId:string;expectedRevision:number};
export type ReviewDecision={decision:CostChoice;reason:string|null};
export type SavedReview={found:true;projectId:string;revision:number;latestRevision:number;requestId:string;actorId:string;recordedAt:string;note:string;freshness:'matches'|'changed'|'unavailable';snapshot:CostSnapshot;decisions:Record<string,ReviewDecision>;included:bigint;excluded:bigint;paid:bigint;total:bigint};
export function parseReviewMarker(value:unknown,projectId:string,actorId:string):ReviewMarker{
 const v=record(value);if(!uuid(v.requestId)||v.projectId!==projectId||v.actorId!==actorId||!uuid(projectId)||!uuid(actorId)||!revision(v.expectedRevision)||v.expectedRevision>=2147483647)throw Error('Invalid saved retry marker');
 return {requestId:v.requestId,projectId,actorId,expectedRevision:v.expectedRevision};
}
export function buildReviewDecisions(snapshot:CostSnapshot,choices:Record<string,CostChoice>,reasons:Record<string,string>):Record<string,ReviewDecision>{
 const decisions:Record<string,ReviewDecision>={};for(const e of snapshot.expenses){const choice=choices[e.id];if(choice==='include')decisions[e.id]={decision:choice,reason:null};else if(choice==='exclude'&&text(reasons[e.id],300))decisions[e.id]={decision:choice,reason:reasons[e.id]};else throw Error('Review each expense and explain exclusions');}return decisions;
}
/** Validate server response, exact cents and decisions before displaying saved evidence. */
export function parseSavedReview(value:unknown,projectId:string):{found:false;latestRevision:0}|SavedReview{
 const v=record(value);if(v.project_id!==projectId||!uuid(projectId)||typeof v.found!=='boolean'||!revision(v.latest_revision))throw Error('Invalid review response');
 if(v.found===false){if(v.latest_revision!==0)throw Error('Invalid empty review');return {found:false,latestRevision:0};}
 if(!revision(v.revision)||v.revision<1||v.revision>v.latest_revision||!uuid(v.request_id)||!uuid(v.actor_id)||typeof v.recorded_at!=='string'||!Number.isFinite(Date.parse(v.recorded_at))||!text(v.note,500)||!['matches','changed','unavailable'].includes(v.freshness as string))throw Error('Invalid review metadata');
 const snapshot=parseCostSnapshot(v.snapshot,projectId),raw=record(v.choices),choices:Record<string,CostChoice>={},reasons:Record<string,string>={};
 if(Object.keys(raw).length!==snapshot.expenses.length)throw Error('Invalid saved decisions');
 for(const e of snapshot.expenses){const d=record(raw[e.id]);if(Object.keys(d).length!==2||!('reason' in d)||!(d.decision==='include'||d.decision==='exclude'))throw Error('Invalid saved decision');if(d.decision==='include'&&d.reason!==null)throw Error('Invalid saved reason');if(d.decision==='exclude'&&!text(d.reason,300))throw Error('Invalid saved reason');choices[e.id]=d.decision;if(typeof d.reason==='string')reasons[e.id]=d.reason;}
 const decisions=buildReviewDecisions(snapshot,choices,reasons),sum=estimateProjectCost(snapshot,choices),included=totalCents(v.included_expenses),excluded=totalCents(v.excluded_expenses),paid=totalCents(v.paid_gross),total=totalCents(v.incomplete_total);
 if(included!==sum.expenses||excluded!==sum.excluded||paid!==sum.payroll||total!==sum.total)throw Error('Saved total differs from evidence');
 // Underlying per-row parser accepts only precise monetary strings.
 for(const e of snapshot.expenses)costCents(e.amount);
 return {found:true,projectId,revision:v.revision,latestRevision:v.latest_revision,requestId:v.request_id,actorId:v.actor_id,recordedAt:v.recorded_at,note:v.note,freshness:v.freshness as SavedReview['freshness'],snapshot,decisions,included,excluded,paid,total};
}
export function verifyReviewWrite(value:unknown,marker:ReviewMarker):void{const v=record(value);if(v.request_id!==marker.requestId||v.project_id!==marker.projectId||v.revision!==marker.expectedRevision+1||typeof v.replayed!=='boolean')throw Error('Review not confirmed');}
export function validReviewNote(note:string):boolean{return text(note,500);}
