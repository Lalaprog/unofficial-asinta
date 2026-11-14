'use client';

import {useEffect,useState} from 'react';
import type {WeeklyBaleRelease} from '@/lib/payroll/weeklyBaleRelease';

type Marker={version:1;nonce:string;start:string;request:string;worker:string;project:string;amount:string;releaseDate:string};
type State={key:string;status:'checking'|'ready'|'pending'|'unavailable';raw:string|null};
const initial=(key:string):State=>({key,status:key?'checking':'unavailable',raw:null});
function parse(raw:string|null):Marker|null{
 try{
  if(raw===null||raw.length>2000)return null;
  const m=JSON.parse(raw) as Marker;
  if(!m||m.version!==1||typeof m.nonce!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(m.nonce)||
   [m.request,m.worker,m.project].some(x=>typeof x!=='string'||!x.trim()||x.length>128)||
   typeof m.start!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(m.start)||typeof m.releaseDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(m.releaseDate)||
   typeof m.amount!=='string'||!/^([1-9]\d{0,7}|0)\.\d{2}$/.test(m.amount)||m.amount==='0.00')return null;
  return m;
 }catch{return null;}
}

/** A tab-local warning only; not a lock, request cancellation, or payment proof. */
export function useWeeklyBaleReleaseGuard(actor:string){
 const key=actor?JSON.stringify(['weekly-bale-release-unconfirmed-v1',actor]):'';
 const [state,setState]=useState<State>(()=>initial(key));const current=state.key===key?state:initial(key);
 useEffect(()=>{
  if(!key){setState(initial(''));return;}
  try{const raw=sessionStorage.getItem(key);setState({key,status:raw===null?'ready':'pending',raw});}
  catch{setState({key,status:'unavailable',raw:null});}
 },[key]);
 function begin(start:string,item:WeeklyBaleRelease):string|null{
  if(!key||current.status!=='ready')return null;
  try{
   const old=sessionStorage.getItem(key);if(old!==null){setState({key,status:'pending',raw:old});return null;}
   const raw=JSON.stringify({version:1,nonce:crypto.randomUUID(),start,request:item.request_id,worker:item.worker_id,project:item.project_id,amount:item.amount,releaseDate:item.release_date});
   if(!parse(raw))throw Error('Invalid warning');sessionStorage.setItem(key,raw);if(sessionStorage.getItem(key)!==raw)throw Error('Warning not saved');
   setState({key,status:'pending',raw});return raw;
  }catch{setState({key,status:'unavailable',raw:null});return null;}
 }
 function clear(raw:string):boolean{
  try{
   if(!key||sessionStorage.getItem(key)!==raw)throw Error('Warning changed');sessionStorage.removeItem(key);if(sessionStorage.getItem(key)!==null)throw Error('Warning not removed');
   setState(previous=>previous.key===key?{key,status:'ready',raw:null}:previous);return true;
  }catch{setState(previous=>previous.key===key?{key,status:'unavailable',raw:null}:previous);return false;}
 }
 return {status:current.status,marker:parse(current.raw),begin,confirmed:clear,clearAfterReview:()=>current.status==='pending'&&current.raw!==null&&clear(current.raw)};
}
