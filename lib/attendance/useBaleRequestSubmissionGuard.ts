'use client';

import {useEffect,useState} from 'react';

type GuardState = {key:string;status:'checking'|'ready'|'pending'|'unavailable';marker:string|null};
const initial=(key:string):GuardState=>({key,status:key?'checking':'ready',marker:null});

/**
 * A tab-local uncertainty warning, not an idempotency key or a database lock.
 * Only the random marker is stored: no worker, amount or project details.
 * Loss of storage, another device/tab and an in-flight request remain possible.
 */
export function useBaleRequestSubmissionGuard(userId:string|undefined, enabled:boolean){
 const key=enabled&&userId?`bale-request-unconfirmed-v1:${userId}`:'';
 const [state,setState]=useState<GuardState>(()=>initial(key));
 const current=state.key===key?state:initial(key);
 useEffect(()=>{
  if(!key){setState(initial(''));return;}
  try{const marker=sessionStorage.getItem(key);setState({key,status:marker===null?'ready':'pending',marker});}
  catch{setState({key,status:'unavailable',marker:null});}
 },[key]);
 function begin():string|null{
  if(!key||current.status!=='ready')return null;
  try{
   const existing=sessionStorage.getItem(key);
   if(existing!==null){setState({key,status:'pending',marker:existing});return null;}
   const marker=crypto.randomUUID();
   sessionStorage.setItem(key,marker);
   if(sessionStorage.getItem(key)!==marker)throw Error('Cannot preserve marker');
   setState({key,status:'pending',marker});return marker;
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
 return {status:current.status,begin,confirmed,clearAfterReview};
}
