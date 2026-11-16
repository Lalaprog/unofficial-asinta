'use client';

import {useEffect,useState} from 'react';
import {workerPayrollPeriod} from '@/lib/payroll/periods';

export type BaleSubmissionAttempt={version:1;request:string;actor:string;worker:string;project:string;amount:string;period:string};
type GuardState = {key:string;status:'checking'|'ready'|'pending'|'unavailable';marker:string|null};
const initial=(key:string):GuardState=>({key,status:key?'checking':'ready',marker:null});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function parseAttempt(raw:string|null,actor:string|undefined):BaleSubmissionAttempt|null{
 try{
  if(!raw||raw.length>1000)return null;
  const v=JSON.parse(raw) as BaleSubmissionAttempt;
  if(!v||v.version!==1||typeof v.request!=='string'||!uuid.test(v.request)||v.actor!==actor||typeof v.worker!=='string'||!v.worker||v.worker.length>64||typeof v.project!=='string'||!v.project||v.project.length>64||typeof v.amount!=='string'||!/^(0|[1-9][0-9]{0,7})\.[0-9]{2}$/.test(v.amount)||Number(v.amount)<=0||typeof v.period!=='string'||workerPayrollPeriod(v.period).start!==v.period)return null;
  return {version:1,request:v.request,actor:v.actor,worker:v.worker,project:v.project,amount:v.amount,period:v.period};
 }catch{return null;}
}

/** Tab-local warning; when explicitly enabled, retains sensitive exact retry
 * details as well. Neither mode is a cross-tab lock or durable storage. */
export function useBaleRequestSubmissionGuard(userId:string|undefined, enabled:boolean){
 const key=enabled&&userId?`bale-request-unconfirmed-v1:${userId}`:'';
 const [state,setState]=useState<GuardState>(()=>initial(key));
 const current=state.key===key?state:initial(key);
 useEffect(()=>{
  if(!key){setState(initial(''));return;}
  try{const marker=sessionStorage.getItem(key);setState({key,status:marker===null?'ready':'pending',marker});}
  catch{setState({key,status:'unavailable',marker:null});}
 },[key]);
 function begin(details?:{worker:string;project:string;amount:string;period:string}):string|null{
  if(!key||!userId||current.status!=='ready')return null;
  try{
   const existing=sessionStorage.getItem(key);
   if(existing!==null){setState({key,status:'pending',marker:existing});return null;}
   const request=crypto.randomUUID();
   const marker=details?JSON.stringify({version:1,request,actor:userId,...details}):request;
   if(details&&!parseAttempt(marker,userId))throw Error('Invalid retry details');
   sessionStorage.setItem(key,marker);
   if(sessionStorage.getItem(key)!==marker)throw Error('Cannot preserve marker');
   setState({key,status:'pending',marker});return marker;
  }catch{setState({key,status:'unavailable',marker:null});return null;}
 }
 function retry():{marker:string;attempt:BaleSubmissionAttempt}|null{
  if(!key||current.status!=='pending'||current.marker===null)return null;
  const attempt=parseAttempt(current.marker,userId);if(!attempt)return null;
  try{
   if(sessionStorage.getItem(key)!==current.marker)throw Error('Marker changed');
   return {marker:current.marker,attempt};
  }catch{setState({key,status:'unavailable',marker:null});return null;}
 }
 function confirmed(marker:string):boolean{
  try{
   if(!key||sessionStorage.getItem(key)!==marker)throw Error('Marker changed');
   sessionStorage.removeItem(key);
   if(sessionStorage.getItem(key)!==null)throw Error('Marker was not removed');
   setState(previous=>previous.key===key?{key,status:'ready',marker:null}:previous);return true;
  }catch{setState(previous=>previous.key===key?{key,status:'unavailable',marker:null}:previous);return false;}
 }
 function clearAfterReview():boolean{
  if(!key||current.status!=='pending'||current.marker===null)return false;
  try{
   if(sessionStorage.getItem(key)!==current.marker)throw Error('Marker changed');
   sessionStorage.removeItem(key);
   if(sessionStorage.getItem(key)!==null)throw Error('Marker was not removed');
   setState({key,status:'ready',marker:null});return true;
  }catch{setState({key,status:'unavailable',marker:null});return false;}
 }
 return {status:current.status,pendingAttempt:parseAttempt(current.marker,userId),begin,retry,confirmed,clearAfterReview};
}
