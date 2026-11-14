'use client';
import {useEffect,useState} from 'react';

type Marker={version:1;nonce:string;decision:'approve'|'reject';ids:string[]};
type State={key:string;status:'checking'|'ready'|'pending'|'unavailable';raw:string|null};
const initial=(key:string):State=>({key,status:key?'checking':'unavailable',raw:null});
function parse(raw:string|null):Marker|null {
 try {
  if(raw===null || raw.length>8000)return null;
  const m=JSON.parse(raw) as Marker;
  if(!m || m.version!==1 || typeof m.nonce!=='string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(m.nonce) ||
    !['approve','reject'].includes(m.decision) || !Array.isArray(m.ids) || !m.ids.length || m.ids.length>50 ||
    m.ids.some(id=>typeof id!=='string'||!id.trim()||id.length>128) || new Set(m.ids).size!==m.ids.length) return null;
  return m;
 } catch {return null;}
}
/** Account-scoped tab warning, not an idempotency key, lock or audit record. */
export function useBaleReviewGuard(actor:string|undefined,enabled:boolean) {
 const key=actor&&enabled?JSON.stringify(['weekly-bale-review-unconfirmed-v1',actor]):'';
 const [state,setState]=useState<State>(()=>initial(key));
 const current=state.key===key?state:initial(key);
 useEffect(()=>{
  if(!key){setState(initial(''));return;}
  try{const raw=sessionStorage.getItem(key);setState({key,status:raw===null?'ready':'pending',raw});}
  catch{setState({key,status:'unavailable',raw:null});}
 },[key]);
 function begin(decision:'approve'|'reject',ids:string[]):string|null {
  if(!key||current.status!=='ready')return null;
  try{
   const existing=sessionStorage.getItem(key);
   if(existing!==null){setState({key,status:'pending',raw:existing});return null;}
   const raw=JSON.stringify({version:1,nonce:crypto.randomUUID(),decision,ids});
   if(!parse(raw))throw Error('Invalid warning');
   sessionStorage.setItem(key,raw);if(sessionStorage.getItem(key)!==raw)throw Error('Warning not saved');
   setState({key,status:'pending',raw});return raw;
  }catch{setState({key,status:'unavailable',raw:null});return null;}
 }
 function clear(raw:string):boolean {
  try{
   if(!key||sessionStorage.getItem(key)!==raw)throw Error('Warning changed');
   sessionStorage.removeItem(key);if(sessionStorage.getItem(key)!==null)throw Error('Warning not removed');
   setState(prev=>prev.key===key?{key,status:'ready',raw:null}:prev);return true;
  }catch{setState(prev=>prev.key===key?{key,status:'unavailable',raw:null}:prev);return false;}
 }
 return {status:current.status,raw:current.raw,marker:parse(current.raw),begin,confirmed:clear,clearAfterReview:()=>current.status==='pending'&&current.raw!==null&&clear(current.raw)};
}
