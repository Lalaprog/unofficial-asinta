'use client';
import React,{useEffect,useRef,useState} from 'react';
import {ChevronDown} from 'lucide-react';
import {Button} from '@/components/ui/Button';
import {Input} from '@/components/ui/Input';
import {Select} from '@/components/ui/Select';
import {Modal} from '@/components/ui/Modal';
import {useAuth} from '@/lib/auth/authContext';
import {createClient} from '@/lib/supabase/client';
import {parseSupervisorDayList,type SupervisorDay,type SupervisorDayList} from '@/lib/attendance/supervisorDay';
import {SUPERVISOR_DAY_CHANGED} from '@/lib/attendance/supervisorDayEvents';

export function SupervisorDayPanel(){
 const [open,setOpen]=useState(false);
 return <section className="overflow-hidden rounded-2xl border border-surface-border bg-white"><button type="button" aria-expanded={open} onClick={()=>setOpen(v=>!v)} className="flex min-h-11 w-full items-center justify-between gap-3 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand sm:p-5"><span><span className="block text-sm font-semibold text-navy">Supervisor daily attendance</span><span className="mt-1 block text-xs text-ink-secondary">One personal record per day · separate from site Roll Calls</span></span><ChevronDown aria-hidden="true" className={`h-4 w-4 shrink-0 ${open?'rotate-180':''}`}/></button>{open&&<Contents/>}</section>;
}
function Contents(){
 const {user,isFounder,isSupervisor,assurance}=useAuth();const key=JSON.stringify([user?.id,isFounder,isSupervisor,assurance]);
 const [state,setState]=useState<{key:string;list:SupervisorDayList|null;error:string;loading:boolean}>({key,list:null,error:'',loading:false});
 const [date,setDate]=useState(''),[work,setWork]=useState<'present'|'half_day'|'absent'>('present');
 const [message,setMessage]=useState(''),[saving,setSaving]=useState(false),[interrupted,setInterrupted]=useState(false),[decision,setDecision]=useState<{key:string;item:SupervisorDay;status:'approved'|'rejected'}|null>(null);
 const token=useRef(0),busy=useRef(false),active=useRef(key),request=useRef<{key:string;id:string}|null>(null);active.current=key;
 useEffect(()=>{const seq=token;seq.current++;if(busy.current)setInterrupted(true);busy.current=false;request.current=null;setDecision(null);setSaving(false);setMessage('');setDate('');setWork('present');setState({key,list:null,error:'',loading:false});return()=>{seq.current++;};},[key]);
 const current=state.key===key?state:{key,list:null,error:'',loading:false},currentDecision=decision?.key===key?decision:null;
 async function load(offset=0){
  if(!user?.id||(!isFounder&&!isSupervisor)||assurance!=='ready'||busy.current)return;
  const seq=++token.current;setState({key,list:null,error:'',loading:true});
  try{const {data,error}=await createClient().rpc('supervisor_day_list',{p_offset:offset});if(error)throw new Error(error.message);const list=parseSupervisorDayList(data,isFounder,offset);if(seq===token.current&&active.current===key)setState({key,list,error:'',loading:false});}
  catch(e){if(seq===token.current&&active.current===key)setState({key,list:null,error:e instanceof Error?e.message:'Attendance list unavailable',loading:false});}
 }
 async function submit(event:React.FormEvent){
  event.preventDefault();if(busy.current||assurance!=='ready'||!isSupervisor||!current.list||!date)return;
  const fingerprint=JSON.stringify([user?.id,date,work]);if(!request.current||request.current.key!==fingerprint)request.current={key:fingerprint,id:crypto.randomUUID()};
  const id=request.current.id;busy.current=true;setSaving(true);setMessage('');const seq=++token.current;window.dispatchEvent(new Event(SUPERVISOR_DAY_CHANGED));
  try{
   const {data,error}=await createClient().rpc('submit_supervisor_day',{p_id:id,p_date:date,p_work_status:work});
   if(error)throw new Error(error.message);
   if(!data||data.id!==id||!['pending','approved','rejected'].includes(data.status)||typeof data.replayed!=='boolean')throw new Error('Response could not be verified');
   if(seq!==token.current||active.current!==key)return;
   setMessage(`Daily record is ${data.status}. Refresh the list for its current status. No site attendance or payroll was changed.`);request.current=null;setDate('');setState({key,list:null,error:'',loading:false});
  }catch(e){if(seq===token.current&&active.current===key)setMessage(`Submission not confirmed: ${e instanceof Error?e.message:'Unknown error'}. Check the list before retrying; an unchanged retry uses the same request ID.`);}
  finally{window.dispatchEvent(new Event(SUPERVISOR_DAY_CHANGED));if(seq===token.current){busy.current=false;setSaving(false);}}
 }
 async function confirm(){
  if(!currentDecision||!isFounder||assurance!=='ready'||busy.current)return;busy.current=true;setSaving(true);setMessage('');const seq=++token.current;window.dispatchEvent(new Event(SUPERVISOR_DAY_CHANGED));
  try{
   const {data,error}=await createClient().rpc('review_supervisor_day',{p_id:currentDecision.item.id,p_decision:currentDecision.status});
   if(error)throw new Error(error.message);
   if(!data||data.id!==currentDecision.item.id||data.status!==currentDecision.status||typeof data.replayed!=='boolean')throw new Error('Response could not be verified');
   if(seq!==token.current||active.current!==key)return;
   setDecision(null);setMessage('Decision recorded. Refresh the list. Existing site attendance and payroll were not changed.');setState({key,list:null,error:'',loading:false});
  }catch(e){if(seq===token.current&&active.current===key){setDecision(null);setMessage(`Decision not confirmed: ${e instanceof Error?e.message:'Unknown error'}. Refresh the list and check before retrying.`);setState({key,list:null,error:'',loading:false});}}
  finally{window.dispatchEvent(new Event(SUPERVISOR_DAY_CHANGED));if(seq===token.current){busy.current=false;setSaving(false);}}
 }
 return <div className="space-y-4 border-t border-surface-border p-4 text-xs sm:p-5">
  <p className="rounded-lg border border-status-warning/25 bg-status-warning-bg p-3 leading-relaxed text-ink-secondary">The legacy payroll generator does not use these records. A separately enabled experimental ledger may use approved records; it is not live-ready. Existing site-based Supervisor attendance still operates; reconcile both sources to avoid counting a day twice. Approved or paid payroll requires separate review.</p>
  <p className="leading-relaxed text-ink-secondary">Supervisors submit one record per date, regardless of how many sites they handle. A Founder can decide without site entries. Indicators show currently assigned sites and whether any attendance entries exist for the day; they do not prove a complete Roll Call.</p>
  {interrupted&&<p role="status">A previous request may still complete. Reload and inspect the records before trying again; changing accounts or closing this panel does not cancel it.</p>}
  {assurance!=='ready'&&<p role="status">Session assurance must be ready before loading or changing records.</p>}
  <Button type="button" variant="secondary" size="sm" disabled={saving||current.loading||assurance!=='ready'} onClick={()=>load(current.list?.offset??0)} isLoading={current.loading}>{current.list?'Refresh daily records':'Load daily records'}</Button>
  {current.error&&<p role="alert" className="text-status-danger">Could not load daily attendance: {current.error}</p>}
  {message&&<p role="status" className="text-ink-secondary">{message}</p>}
  {current.list&&<div className="space-y-2"><p className="text-ink-secondary">Showing {current.list.items.length?current.list.offset+1:0}–{current.list.offset+current.list.items.length} of {current.list.total} records, pending first. Changes can shift pages; refresh before acting.</p>{current.list.items.length===0?<p>No daily records found.</p>:<ul className="space-y-2">{current.list.items.map(item=><li key={item.id} className="flex flex-col gap-3 rounded-xl border border-surface-border p-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0 space-y-1"><p className="font-semibold text-navy">{item.supervisor_name} · {item.work_date} · {item.work_status==='half_day'?'half day':item.work_status} · {item.status}</p><p className="break-words text-ink-secondary">Current sites: {item.sites.length?item.sites.map(site=>`${site.name}: ${site.has_entries?'entries found':'no entries found'}`).join(' · '):'none assigned'}</p>{item.pending_leave&&<p className="text-status-warning">A leave request for this day is pending; review both records.</p>}{item.approved_leave&&<p className="font-semibold text-status-warning">Approved leave covers this date; attendance approval is blocked.</p>}{isFounder&&Boolean(item.legacy_self_records)&&<p className="text-status-warning">Legacy self-attendance exists for this date; do not count both records.</p>}{isFounder&&item.possible_paid_overlap&&<p className="font-semibold text-status-warning">Possible paid payroll overlap. Review the original period separately; no payroll record was changed.</p>}{isFounder&&item.identity_needs_review&&<p className="text-status-warning">Supervisor identity may not match a unique worker profile; check records manually.</p>}</div>{isFounder&&item.status==='pending'&&<div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" size="sm" disabled={saving} onClick={()=>setDecision({key,item,status:'rejected'})}>Reject</Button><Button type="button" variant="primary" size="sm" disabled={saving||item.approved_leave} onClick={()=>setDecision({key,item,status:'approved'})}>Approve</Button></div>}</li>)}</ul>}<div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" size="sm" disabled={saving||current.list.offset===0} onClick={()=>load(Math.max(0,current.list!.offset-100))}>Previous daily records</Button><Button type="button" variant="secondary" size="sm" disabled={saving||current.list.offset+current.list.items.length>=current.list.total} onClick={()=>load(current.list!.offset+100)}>Next daily records</Button></div></div>}
  {isSupervisor&&current.list&&<form onSubmit={submit} className="space-y-3 border-t border-surface-border pt-4"><p className="font-semibold text-navy">Submit daily attendance</p><Input label="Work date" type="date" required value={date} onChange={e=>setDate(e.target.value)}/><Select label="Work status" value={work} onChange={e=>setWork(e.target.value as 'present'|'half_day'|'absent')}><option value="present">Present · full day</option><option value="half_day">Present · half day</option><option value="absent">Absent</option></Select><Button type="submit" variant="primary" disabled={saving} isLoading={saving}>Submit daily record</Button></form>}
  <Modal isOpen={!!currentDecision} onClose={()=>setDecision(null)} title={currentDecision?.status==='approved'?'Approve Supervisor attendance?':'Reject Supervisor attendance?'} description="This decision does not change site attendance or payroll." dismissOnBackdrop={!saving} dismissOnEscape={!saving} showCloseButton={!saving}>{currentDecision&&<div className="space-y-4 text-xs"><p>{currentDecision.item.supervisor_name} · {currentDecision.item.work_date} · {currentDecision.item.work_status==='half_day'?'half day':currentDecision.item.work_status}</p>{currentDecision.item.pending_leave&&<p className="text-status-warning">Leave is pending for this date; review both before deciding.</p>}{currentDecision.item.possible_paid_overlap&&<p className="font-semibold text-status-warning">Possible paid payroll overlap: review the original period separately.</p>}<p>Decisions cannot be changed here. Approval does not calculate or pay payroll; site Roll Calls can be missing.</p><div className="flex justify-end gap-2"><Button type="button" variant="secondary" disabled={saving} onClick={()=>setDecision(null)}>Cancel</Button><Button type="button" variant="primary" disabled={saving} isLoading={saving} onClick={confirm}>Confirm {currentDecision.status==='approved'?'approval':'rejection'}</Button></div></div>}</Modal>
 </div>;
}
