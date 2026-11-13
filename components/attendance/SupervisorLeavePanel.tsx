'use client';
import React,{useEffect,useRef,useState} from 'react';
import {ChevronDown} from 'lucide-react';
import {Button} from '@/components/ui/Button';
import {Input} from '@/components/ui/Input';
import {Select} from '@/components/ui/Select';
import {Modal} from '@/components/ui/Modal';
import {useAuth} from '@/lib/auth/authContext';
import {createClient} from '@/lib/supabase/client';
import {parseSupervisorLeaveList,type LeaveStatus,type SupervisorLeave,type SupervisorLeaveList} from '@/lib/attendance/supervisorLeave';
import {SUPERVISOR_LEAVE_CHANGED} from '@/lib/attendance/usePendingSupervisorLeave';

export function SupervisorLeavePanel(){
 const [open,setOpen]=useState(false);
 return <section className="overflow-hidden rounded-2xl border border-surface-border bg-white"><button type="button" aria-expanded={open} onClick={()=>setOpen(v=>!v)} className="flex min-h-11 w-full items-center justify-between gap-3 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand sm:p-5"><span><span className="block text-sm font-semibold text-navy">Supervisor leave requests</span><span className="mt-1 block text-xs text-ink-secondary">Request or review unpaid leave · payroll integration pending</span></span><ChevronDown aria-hidden="true" className={`h-4 w-4 shrink-0 ${open?'rotate-180':''}`}/></button>{open&&<Contents/>}</section>;
}
function Contents(){
 const {user,isFounder,isSupervisor,assurance}=useAuth();const key=JSON.stringify([user?.id,isFounder,isSupervisor,assurance]);
 const [state,setState]=useState<{key:string;list:SupervisorLeaveList|null;error:string;loading:boolean}>({key,list:null,error:'',loading:false});
 const [start,setStart]=useState(''),[end,setEnd]=useState(''),[kind,setKind]=useState<'normal'|'emergency'>('normal'),[reason,setReason]=useState('');
 const [message,setMessage]=useState(''),[saving,setSaving]=useState(false),[interrupted,setInterrupted]=useState(false),[decision,setDecision]=useState<{key:string;item:SupervisorLeave;status:Extract<LeaveStatus,'approved'|'rejected'>}|null>(null);
 const token=useRef(0),busy=useRef(false),active=useRef(key),request=useRef<{key:string;id:string}|null>(null);active.current=key;
 useEffect(()=>{const seq=token;seq.current++;if(busy.current)setInterrupted(true);busy.current=false;request.current=null;setDecision(null);setSaving(false);setMessage('');setStart('');setEnd('');setReason('');setKind('normal');setState({key,list:null,error:'',loading:false});return()=>{seq.current++;};},[key]);
 const current=state.key===key?state:{key,list:null,error:'',loading:false},currentDecision=decision?.key===key?decision:null;
 async function load(offset=0){
  if(!user?.id||(!isFounder&&!isSupervisor)||assurance!=='ready'||busy.current)return;
  const seq=++token.current;setState({key,list:null,error:'',loading:true});
  try{const {data,error}=await createClient().rpc('supervisor_leave_list',{p_offset:offset});if(error)throw new Error(error.message);const list=parseSupervisorLeaveList(data,isFounder,offset);if(seq===token.current&&active.current===key)setState({key,list,error:'',loading:false});}
  catch(e){if(seq===token.current&&active.current===key)setState({key,list:null,error:e instanceof Error?e.message:'Leave list unavailable',loading:false});}
 }
 async function submit(event:React.FormEvent){
  event.preventDefault();if(busy.current||assurance!=='ready'||!isSupervisor||!current.list||!start||!end)return;
  if(end<start){setMessage('The end date cannot be before the start date.');return;}
  const fingerprint=JSON.stringify([user?.id,start,end,kind,reason.trim()]);
  if(!request.current||request.current.key!==fingerprint)request.current={key:fingerprint,id:crypto.randomUUID()};
  const id=request.current.id;busy.current=true;setSaving(true);setMessage('');const seq=++token.current;window.dispatchEvent(new Event(SUPERVISOR_LEAVE_CHANGED));
  try{
   const {data,error}=await createClient().rpc('submit_supervisor_leave',{p_id:id,p_start:start,p_end:end,p_kind:kind,p_reason:reason.trim()});
   if(error)throw new Error(error.message);
   if(!data||data.id!==id||!['pending','approved','rejected'].includes(data.status)||typeof data.replayed!=='boolean')throw new Error('Response could not be verified');
   if(seq!==token.current||active.current!==key)return;
   setMessage(`Request recorded as ${data.status}. Refresh the list to check its current status. No attendance or payroll was changed.`);
   request.current=null;setStart('');setEnd('');setReason('');setState({key,list:null,error:'',loading:false});
  }catch(e){if(seq===token.current&&active.current===key)setMessage(`Submission not confirmed: ${e instanceof Error?e.message:'Unknown error'}. Check the list before retrying; an unchanged retry uses the same request ID.`);}
  finally{window.dispatchEvent(new Event(SUPERVISOR_LEAVE_CHANGED));if(seq===token.current){busy.current=false;setSaving(false);}}
 }
 async function confirm(){
  if(!currentDecision||!isFounder||assurance!=='ready'||busy.current)return;
  busy.current=true;setSaving(true);setMessage('');const seq=++token.current;window.dispatchEvent(new Event(SUPERVISOR_LEAVE_CHANGED));
  try{
   const {data,error}=await createClient().rpc('review_supervisor_leave',{p_id:currentDecision.item.id,p_decision:currentDecision.status});
   if(error)throw new Error(error.message);
   if(!data||data.id!==currentDecision.item.id||data.status!==currentDecision.status||typeof data.replayed!=='boolean')throw new Error('Response could not be verified');
   if(seq!==token.current||active.current!==key)return;
   setDecision(null);setMessage('Decision recorded. Refresh the list. Existing attendance and payroll were not changed.');setState({key,list:null,error:'',loading:false});
  }catch(e){if(seq===token.current&&active.current===key){setDecision(null);setMessage(`Decision not confirmed: ${e instanceof Error?e.message:'Unknown error'}. Refresh the list and check before retrying.`);setState({key,list:null,error:'',loading:false});}}
  finally{window.dispatchEvent(new Event(SUPERVISOR_LEAVE_CHANGED));if(seq===token.current){busy.current=false;setSaving(false);}}
 }
 return <div className="space-y-4 border-t border-surface-border p-4 text-xs sm:p-5">
  <p className="rounded-lg border border-status-warning/25 bg-status-warning-bg p-3 leading-relaxed text-ink-secondary">Approved leave is unpaid in the experimental ledger, but a decision does not change attendance or a finalized payroll record. The legacy payroll generator does not consume it. Review affected approved or paid periods separately; no payment, correction or message is sent.</p>
  <p className="leading-relaxed text-ink-secondary">Normal leave requires at least two calendar days before the first day in Philippine time. Emergency leave can be filed for past dates. A Founder decides each request.</p>
  {interrupted&&<p role="status">A previous request may still complete. Reload and inspect the records before trying again; changing accounts or closing this panel does not cancel it.</p>}
  {assurance!=='ready'&&<p role="status">Session assurance must be ready before loading or changing records.</p>}
  <Button type="button" variant="secondary" size="sm" disabled={saving||current.loading||assurance!=='ready'} onClick={()=>load(current.list?.offset??0)} isLoading={current.loading}>{current.list?'Refresh leave list':'Load leave list'}</Button>
  {current.error&&<p role="alert" className="text-status-danger">Could not load leave requests: {current.error}</p>}
  {message&&<p role="status" className="text-ink-secondary">{message}</p>}
  {current.list&&<div className="space-y-2"><p className="text-ink-secondary">Showing {current.list.items.length ? current.list.offset+1 : 0}–{current.list.offset+current.list.items.length} of {current.list.total} requests, pending first. Changes can shift pages; refresh to check current decisions.</p>{current.list.items.length===0?<p>No leave requests found.</p>:<ul className="space-y-2">{current.list.items.map(item=><li key={item.id} className="flex flex-col gap-3 rounded-xl border border-surface-border p-3 sm:flex-row sm:items-center sm:justify-between"><div className="space-y-1"><p className="font-semibold text-navy">{item.supervisor_name} · {item.kind} · {item.status}</p><p>{item.start_date} to {item.end_date}</p>{item.reason&&<p className="break-words">{item.reason}</p>}{isFounder&&item.possible_paid_overlap&&<p className="font-semibold text-status-warning">Possible paid payroll overlap: review the original payroll record and any separate correction. No payroll record was changed.</p>}{isFounder&&item.identity_needs_review&&<p className="text-status-warning">Supervisor identity may not match a unique worker profile; check records manually.</p>}</div>{isFounder&&item.status==='pending'&&<div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" size="sm" disabled={saving} onClick={()=>setDecision({key,item,status:'rejected'})}>Reject</Button><Button type="button" variant="primary" size="sm" disabled={saving} onClick={()=>setDecision({key,item,status:'approved'})}>Approve</Button></div>}</li>)}</ul>}<div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" size="sm" disabled={saving||current.list.offset===0} onClick={()=>load(Math.max(0,current.list!.offset-100))}>Previous requests</Button><Button type="button" variant="secondary" size="sm" disabled={saving||current.list.offset+current.list.items.length>=current.list.total} onClick={()=>load(current.list!.offset+100)}>Next requests</Button></div></div>}
  {isSupervisor&&current.list&&<form onSubmit={submit} className="space-y-3 border-t border-surface-border pt-4"><p className="font-semibold text-navy">New leave request</p><div className="grid gap-3 sm:grid-cols-2"><Input label="First day" type="date" required value={start} onChange={e=>setStart(e.target.value)}/><Input label="Last day" type="date" required value={end} onChange={e=>setEnd(e.target.value)}/></div><Select label="Leave type" value={kind} onChange={e=>setKind(e.target.value as 'normal'|'emergency')}><option value="normal">Normal</option><option value="emergency">Emergency</option></Select><Input label="Reason (optional)" maxLength={500} value={reason} onChange={e=>setReason(e.target.value)}/><Button type="submit" variant="primary" disabled={saving} isLoading={saving}>Submit leave request</Button></form>}
  <Modal isOpen={!!currentDecision} onClose={()=>setDecision(null)} title={currentDecision?.status==='approved'?'Approve Supervisor leave?':'Reject Supervisor leave?'} description="The decision does not change attendance or payroll." dismissOnBackdrop={!saving} dismissOnEscape={!saving} showCloseButton={!saving}>{currentDecision&&<div className="space-y-4 text-xs"><p>{currentDecision.item.supervisor_name} · {currentDecision.item.start_date} to {currentDecision.item.end_date} · {currentDecision.item.kind}</p>{currentDecision.item.possible_paid_overlap&&<p className="font-semibold text-status-warning">Possible paid payroll overlap. Review the original period separately; it will not be changed here.</p>}<p>Decisions cannot be changed here. Approved leave is unpaid in the experimental ledger; legacy payroll does not use it. No existing payroll is changed.</p><div className="flex justify-end gap-2"><Button type="button" variant="secondary" disabled={saving} onClick={()=>setDecision(null)}>Cancel</Button><Button type="button" variant="primary" disabled={saving} isLoading={saving} onClick={confirm}>Confirm {currentDecision.status==='approved'?'approval':'rejection'}</Button></div></div>}</Modal>
 </div>;
}
