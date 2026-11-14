'use client';
import React,{createContext,useContext,useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/Button';
import {useAuth} from '@/lib/auth/authContext';
import {attendanceTimeHistoryPreviewEnabled} from '@/lib/finance/featureAvailability';
import {createClient} from '@/lib/supabase/client';
import {parseHistoryTimeBatch,type HistoryTimeDetail} from '@/lib/attendance/historyTime';
import type {HistoryRecord} from '@/lib/attendance/history';

type State={key:string;items:Map<string,HistoryTimeDetail|null>|null;error:string;loading:boolean};
const Context=createContext<State|null>(null);
/** Opt-in UI only: backend RLS remains the security boundary. */
export function AttendanceTimeDetails({records,userId,revision,loading,children}:{records:HistoryRecord[];userId:string|undefined;revision:number;loading:boolean;children?:React.ReactNode}){
 if(!attendanceTimeHistoryPreviewEnabled())return <>{children}</>;
 return <ScopedTimeDetails records={records} userId={userId} revision={revision} loading={loading}>{children}</ScopedTimeDetails>;
}
function ScopedTimeDetails({records,userId,revision,loading,children}:{records:HistoryRecord[];userId:string|undefined;revision:number;loading:boolean;children?:React.ReactNode}){
 const {user,isFounder,isSupervisor,assurance}=useAuth();const [retry,setRetry]=useState(0);
 // Keep full snapshot fields in the key so changed attendance cannot reuse old summaries.
 const relevant=records.filter(r=>!r.is_supervisor).map(r=>({id:r.id,worker_id:r.worker_id,project_id:r.project_id,date:r.date,status:r.status,hours_worked:r.hours_worked,submitted_at:r.submitted_at})).sort((a,b)=>a.id.localeCompare(b.id));
 const eligible=Boolean(userId&&user?.id===userId&&(isFounder||isSupervisor)&&assurance==='ready'&&!loading);
 const key=JSON.stringify([eligible,userId,isFounder,isSupervisor,assurance,revision,retry,relevant]);
 const [state,setState]=useState<State>({key:'',items:null,error:'',loading:false});const current=useRef(key);current.current=key;
 useEffect(()=>{
  let live=true;const rows=JSON.parse(key)[7] as HistoryRecord[];
  setState({key,items:null,error:'',loading:eligible&&rows.length>0});
  if(!eligible||!rows.length)return()=>{live=false;};
  if(rows.length>500){setState({key,items:null,error:'Too many loaded records to verify together. Narrow the history before checking details.',loading:false});return()=>{live=false;};}
  void(async()=>{
   try{
    const chunks:HistoryRecord[][]=[];for(let i=0;i<rows.length;i+=100)chunks.push(rows.slice(i,i+100));
    const results=await Promise.all(chunks.map(async chunk=>{const {data,error}=await createClient().rpc('attendance_history_time_batch',{p_ids:chunk.map(r=>r.id)});if(error)throw new Error(error.message);return parseHistoryTimeBatch(data,chunk);}));
    const items=new Map<string,HistoryTimeDetail|null>();for(const result of results)for(const [id,detail] of result)items.set(id,detail);
    if(live&&current.current===key)setState({key,items,error:'',loading:false});
   }catch(e){if(live&&current.current===key)setState({key,items:null,error:e instanceof Error?e.message:'Time details unavailable',loading:false});}
  })();
  return()=>{live=false;};
 },[eligible,key]);
 const shown=state.key===key?state:{key,items:null,error:'',loading:eligible&&relevant.length>0};
 return <Context.Provider value={shown}>
  {relevant.length>0&&<div className="px-4 py-2 text-xs text-ink-secondary"><p>Regular/OT shows the latest visible saved details, not a payroll calculation. No visible detail is not proof that none exists; refresh after changes.</p>
   {!eligible&&!loading&&<p role="status">Sign in with an authorized, assured session to check time details.</p>}
   {shown.loading&&<p role="status">Loading regular/OT details…</p>}
   {shown.error&&<p role="alert">Could not verify regular/OT details: {shown.error} <Button type="button" size="sm" variant="secondary" onClick={()=>setRetry(n=>n+1)}>Retry time details</Button></p>}
  </div>}
  {children}
 </Context.Provider>;
}
export function AttendanceTimeLabel({id}:{id:string}){
 const state=useContext(Context);if(!state?.items?.has(id))return null;const detail=state.items.get(id);
 if(!detail)return <span className="text-ink-muted">No visible regular/OT details</span>;
 if(detail.stale)return <span className="font-semibold text-status-warning">Saved regular/OT details outdated; review required</span>;
 return <span className="text-ink-secondary">Regular {detail.regular_hours} h · OT {detail.overtime_hours} h</span>;
}
