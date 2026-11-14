'use client';
import React,{useEffect,useRef,useState} from 'react';
import {createClient} from '@/lib/supabase/client';
import {Button} from '@/components/ui/Button';
import {parseWeeklyBaleHealth,type WeeklyBaleHealth} from '@/lib/attendance/weeklyBaleHealth';

/** A fresh Founder-only operational observation, not an alerting service. */
export function WeeklyBaleExpiryHealth({userId}:{userId:string}){
 const [state,setState]=useState<{key:string;data:WeeklyBaleHealth|null;error:string;loading:boolean}>({key:userId,data:null,error:'',loading:false});
 const seq=useRef(0),active=useRef(userId);active.current=userId;
 useEffect(()=>{const sequence=seq;sequence.current++;setState({key:userId,data:null,error:'',loading:false});return()=>{sequence.current++;};},[userId]);
 const current=state.key===userId?state:{key:userId,data:null,error:'',loading:false};
 async function load(){
  if(current.loading)return;const token=++seq.current;setState({key:userId,data:null,error:'',loading:true});
  try{const {data,error}=await createClient().rpc('weekly_bale_expiry_health_status');if(error)throw new Error(error.message);const health=parseWeeklyBaleHealth(data);if(token===seq.current&&active.current===userId)setState({key:userId,data:health,error:'',loading:false});}
  catch(e){if(token===seq.current&&active.current===userId)setState({key:userId,data:null,error:e instanceof Error?e.message:'Status unavailable',loading:false});}
 }
 return <div className="rounded-xl border border-surface-border bg-surface-inset p-3 text-xs text-ink-secondary">
  <p className="font-semibold text-navy">Expiry worker check</p><p>Check this after deployment and after outages. It does not prove that alerts were received; this observation can become stale.</p>
  <Button type="button" size="sm" variant="secondary" onClick={load} isLoading={current.loading}>Check expiry worker</Button>
  {current.error&&<p role="alert">Worker health unavailable: {current.error}. Do not assume rejection is running.</p>}
  {current.data&&<p role="status">{current.data.healthy?'Recent successful run with no overdue requests at this check.':'Attention: no recent successful run or overdue requests remain.'} Checked {current.data.checked_at}; last success {current.data.last_success||'never'}; overdue requests {current.data.current_remaining_due}. Refresh to check again.</p>}
 </div>;
}
