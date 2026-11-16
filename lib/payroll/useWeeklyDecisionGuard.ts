'use client';

import {useEffect,useState} from 'react';

type Decision = {version:1;nonce:string;action:'approve'|'pay';payroll:string;paymentDate:string|null;revision:number|null};
type GuardState = {key:string;status:'checking'|'ready'|'pending'|'unavailable';marker:string|null};
const initial=(key:string):GuardState=>({key,status:key?'checking':'unavailable',marker:null});
function parse(raw:string|null):Decision|null {
 try {
  if(!raw || raw.length>1000)return null;
  const value=JSON.parse(raw) as Decision;
  if(!value || value.version!==1 || typeof value.nonce!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.nonce) || !['approve','pay'].includes(value.action) || typeof value.payroll!=='string' || !value.payroll || value.payroll.length>64 ||
   (value.revision!==null&&(!Number.isSafeInteger(value.revision)||value.revision<0)) ||
   (value.action==='approve' ? value.paymentDate!==null : typeof value.paymentDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value.paymentDate)))return null;
  return {version:1,nonce:value.nonce,action:value.action,payroll:value.payroll,paymentDate:value.paymentDate,revision:value.revision};
 }catch{return null;}
}

/** Tab-local uncertainty warning, not a cross-tab lock or payment proof. */
export function useWeeklyDecisionGuard(userId:string,workerId:string,start:string){
 const key=userId&&workerId&&start?JSON.stringify(['weekly-worker-decision-unconfirmed-v1',userId,workerId,start]):'';
 const [state,setState]=useState<GuardState>(()=>initial(key));
 const current=state.key===key?state:initial(key);
 useEffect(()=>{
  if(!key){setState(initial(''));return;}
  try{const marker=sessionStorage.getItem(key);setState({key,status:marker===null?'ready':'pending',marker});}
  catch{setState({key,status:'unavailable',marker:null});}
 },[key]);
 function stillReady():boolean {
  if(!key||current.status!=='ready')return false;
  try{
   const marker=sessionStorage.getItem(key);
   if(marker===null)return true;
   setState({key,status:'pending',marker});return false;
  }catch{setState({key,status:'unavailable',marker:null});return false;}
 }
 function begin(action:'approve'|'pay',payroll:string,paymentDate:string|null,revision:number|null):string|null {
  if(!key||current.status!=='ready')return null;
  try{
   const existing=sessionStorage.getItem(key);
   if(existing!==null){setState({key,status:'pending',marker:existing});return null;}
   const marker=JSON.stringify({version:1,nonce:crypto.randomUUID(),action,payroll,paymentDate,revision});
   if(!parse(marker))throw Error('Invalid decision');
   sessionStorage.setItem(key,marker);
   if(sessionStorage.getItem(key)!==marker)throw Error('Marker not preserved');
   setState({key,status:'pending',marker});return marker;
  }catch{setState({key,status:'unavailable',marker:null});return null;}
 }
 function clear(marker:string):boolean{
  try{
   if(!key||sessionStorage.getItem(key)!==marker)throw Error('Marker changed');
   sessionStorage.removeItem(key);
   if(sessionStorage.getItem(key)!==null)throw Error('Marker not removed');
   setState(previous=>previous.key===key?{key,status:'ready',marker:null}:previous);return true;
  }catch{setState(previous=>previous.key===key?{key,status:'unavailable',marker:null}:previous);return false;}
 }
 function clearAfterReview():boolean{
  if(current.status!=='pending'||current.marker===null)return false;
  return clear(current.marker);
 }
 return {status:current.status,decision:parse(current.marker),stillReady,begin,confirmed:clear,clearAfterReview};
}
