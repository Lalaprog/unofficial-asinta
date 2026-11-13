'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {createClient} from '@/lib/supabase/client';
import {parseWeeklyBaleStatuses,type WeeklyBaleStatuses} from './weeklyBaleStatus';
import type {AdvanceRequest} from '@/types';
type State={key:string;data:WeeklyBaleStatuses|null;error:string;loading:boolean};
const empty=(key:string):State=>({key,data:null,error:'',loading:false});
/** Periodic read-only enrichment; old cached rows and in-flight responses never authorize actions. */
export function useWeeklyBaleStatuses(enabled:boolean,userId:string|undefined,roleScope:string,requests:AdvanceRequest[]){
 const scoped=requests.map(r=>[r.id,r.status,r.updated_at]).sort((a,b)=>a[0].localeCompare(b[0]));
 const key=JSON.stringify([enabled,userId,scoped,roleScope]);const [state,setState]=useState<State>(()=>empty(key));
 const seq=useRef(0),active=useRef(key);active.current=key;
 const refresh=useCallback(async()=>{
  const token=++seq.current;
  if(!enabled||!userId){setState(empty(key));return;}
  const ids=(JSON.parse(key)[2] as string[][]).map(row=>row[0]);
  if(ids.length>500){setState({...empty(key),error:'Too many requests to verify safely. Narrow or page the request list.'});return;}
  if(!ids.length){setState({key,data:{as_of:new Date().toISOString(),items:[]},error:'',loading:false});return;}
  setState({...empty(key),loading:true});
  try{const {data,error}=await createClient().rpc('weekly_bale_status_batch',{p_ids:ids});if(error)throw new Error(error.message);const parsed=parseWeeklyBaleStatuses(data,ids);if(token===seq.current&&active.current===key)setState({key,data:parsed,error:'',loading:false});}
  catch(e){if(token===seq.current&&active.current===key)setState({...empty(key),error:e instanceof Error?e.message:'Status unavailable'});}
 },[enabled,userId,key]);
 useEffect(()=>{const sequence=seq;void refresh();const timer=window.setInterval(()=>void refresh(),30000);const focus=()=>void refresh();window.addEventListener('focus',focus);return()=>{sequence.current++;window.clearInterval(timer);window.removeEventListener('focus',focus);};},[refresh]);
 const current=state.key===key?state:empty(key);
 return {...current,refresh};
}
