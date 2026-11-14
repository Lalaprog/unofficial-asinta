'use client';

import {useEffect,useState} from 'react';
import {createClient} from '@/lib/supabase/client';

export const SUPERVISOR_LEAVE_CHANGED='asinta:supervisor-leave-changed';
export type PendingLeaveState={status:'idle'|'loading'|'ready'|'error';count:number|null};
const idle:PendingLeaveState={status:'idle',count:null};
export function parsePendingLeaveSummary(value:unknown):number {
 if(!value||typeof value!=='object'||!('pending_count' in value))throw new Error('Invalid leave summary');
 const count=value.pending_count;
 if(typeof count!=='number'||!Number.isSafeInteger(count)||count<0)throw new Error('Invalid leave summary');
 return count;
}

/** Poll only while eligible and visible. Errors are unknown, never zero. */
export function usePendingSupervisorLeave(enabled:boolean,userId:string|undefined):PendingLeaveState {
 const key=enabled&&userId?userId:null;
 const [state,setState]=useState<{key:string|null;value:PendingLeaveState}>({key:null,value:idle});
 useEffect(()=>{
  if(!key)return;
  let alive=true,inFlight=false,queued=false;
  setState({key,value:{status:'loading',count:null}});
  const refresh=async()=>{
   if(!alive||document.visibilityState==='hidden')return;
   if(inFlight){queued=true;return;}
   inFlight=true;
   let timeout:ReturnType<typeof setTimeout>|undefined;
   try{
    const timedOut=new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Leave summary timed out')),15_000);});
    const {data,error}=await Promise.race([createClient().rpc('supervisor_leave_pending_summary'),timedOut]);
    if(error)throw error;
    const count=parsePendingLeaveSummary(data);
    if(alive)setState({key,value:{status:'ready',count}});
   }catch{if(alive)setState({key,value:{status:'error',count:null}});}
   finally{if(timeout)clearTimeout(timeout);inFlight=false;if(alive&&queued){queued=false;void refresh();}}
  };
  void refresh();
  const timer=window.setInterval(()=>void refresh(),60_000);
  const onRefresh=()=>void refresh();
  window.addEventListener('focus',onRefresh);window.addEventListener(SUPERVISOR_LEAVE_CHANGED,onRefresh);document.addEventListener('visibilitychange',onRefresh);
  return()=>{alive=false;window.clearInterval(timer);window.removeEventListener('focus',onRefresh);window.removeEventListener(SUPERVISOR_LEAVE_CHANGED,onRefresh);document.removeEventListener('visibilitychange',onRefresh);};
 },[key]);
 return key&&state.key===key?state.value:idle;
}
