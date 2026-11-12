'use client';
import React,{useEffect,useRef,useState} from 'react';
import {ChevronDown} from 'lucide-react';
import {Button} from '@/components/ui/Button';
import {Modal} from '@/components/ui/Modal';
import {useAuth} from '@/lib/auth/authContext';
import {createClient} from '@/lib/supabase/client';
import {parsePendingAllowances,type AllowancePending} from '@/lib/payroll/workerAllowances';

type State={key:string;loading:boolean;error:string;items:AllowancePending[]|null};
const empty=(key:string):State=>({key,loading:false,error:'',items:null});
export function WorkerAllowanceQueue(){
 const [open,setOpen]=useState(false);
 return <section className="overflow-hidden rounded-2xl border border-surface-border bg-white"><button type="button" aria-expanded={open} onClick={()=>setOpen(x=>!x)} className="flex min-h-11 w-full items-center justify-between gap-3 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand sm:p-5"><span><span className="block text-sm font-semibold text-navy">Worker allowance approvals</span><span className="mt-1 block text-xs text-ink-secondary">Review Supervisor submissions; does not change payroll</span></span><ChevronDown aria-hidden="true" className={`h-4 w-4 shrink-0 ${open?'rotate-180':''}`}/></button>{open&&<Contents/>}</section>;
}
function Contents(){
 const {user,isFounder}=useAuth();const key=JSON.stringify([user?.id,isFounder]);
 const [state,setState]=useState<State>(()=>empty(key));const [decision,setDecision]=useState<{item:AllowancePending;status:'approved'|'rejected'}|null>(null);const [saving,setSaving]=useState(false);
 const seq=useRef(0),lock=useRef(false),currentKey=useRef(key);currentKey.current=key;
 useEffect(()=>{const s=seq;const l=lock;s.current++;l.current=false;setSaving(false);setState(empty(key));setDecision(null);return()=>{s.current++;l.current=false;};},[key]);
 const current=state.key===key?state:empty(key);
 async function load(){
  if(!user?.id||!isFounder||lock.current)return;
  const token=++seq.current;setState({...empty(key),loading:true});
  try{const {data,error}=await createClient().rpc('worker_allowance_pending_queue');if(error)throw new Error(error.message);const items=parsePendingAllowances(data);if(token===seq.current&&currentKey.current===key)setState({key,loading:false,error:'',items});}
  catch(e){if(token===seq.current&&currentKey.current===key)setState({...empty(key),error:e instanceof Error?e.message:'Queue unavailable'});}
 }
 async function confirm(){
  if(!decision||lock.current)return;
  lock.current=true;setSaving(true);const token=++seq.current;
  try{
   const {data,error}=await createClient().rpc('review_worker_allowance',{p_id:decision.item.id,p_decision:decision.status});
   if(error)throw new Error(error.message);
   if(!data||data.id!==decision.item.id||data.status!==decision.status||typeof data.replayed!=='boolean')throw new Error('Response could not be verified');
   if(token!==seq.current||currentKey.current!==key)return;
   setDecision(null);setState({...empty(key),error:'Decision recorded. Refresh the queue to see current requests.'});
  }catch(e){if(token===seq.current&&currentKey.current===key){setDecision(null);setState({...empty(key),error:`Decision not confirmed: ${e instanceof Error?e.message:'Unknown error'}. Refresh the queue and check before retrying.`});}}
  finally{if(token===seq.current){lock.current=false;setSaving(false);}}
 }
 return <div className="space-y-4 border-t border-surface-border p-4 sm:p-5">
  <p className="text-xs leading-relaxed text-ink-secondary">Load pending worker allowances across sites. Approval does not pay a worker or update any payroll voucher. Existing payroll cannot use these entries yet; dates covered by an approved/paid voucher or changed attendance must be reviewed separately.</p>
  <Button type="button" variant="secondary" size="sm" onClick={load} disabled={!isFounder||!user?.id||saving} isLoading={current.loading}>{current.items?'Refresh requests':'Load requests'}</Button>
  {current.error&&<p role="status" className="text-sm text-ink-secondary">{current.error}</p>}{current.loading&&<p role="status" className="text-sm text-ink-secondary">Loading requests…</p>}
  {current.items&&(!current.items.length?<p className="text-xs text-ink-secondary">No pending allowances at the last check.</p>:<ul className="space-y-2">{current.items.map(item=><li key={item.id} className="flex flex-col gap-3 rounded-xl border border-surface-border p-3 text-xs sm:flex-row sm:items-center sm:justify-between"><div className="space-y-1"><p className="font-semibold text-navy">{item.worker_name} · {item.worker_position}</p><p>{item.project_name} · {item.date} · ₱{item.amount}</p><p className="break-words text-ink-secondary">{item.description}</p>{(item.stale||item.finalized)&&<p className="font-semibold text-status-warning">{item.stale?'Attendance changed. ':''}{item.finalized?'Approved/paid payroll covers this date. ':''}Approval requires separate review.</p>}</div><div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" size="sm" disabled={saving} onClick={()=>setDecision({item,status:'rejected'})}>Reject</Button><Button type="button" variant="primary" size="sm" disabled={saving||item.stale||item.finalized} onClick={()=>setDecision({item,status:'approved'})}>Approve</Button></div></li>)}</ul>)}
  <Modal isOpen={!!decision} onClose={()=>setDecision(null)} title={decision?.status==='approved'?'Approve worker allowance?':'Reject worker allowance?'} description="This decision does not pay the worker or update payroll." dismissOnBackdrop={!saving} dismissOnEscape={!saving} showCloseButton={!saving}>
   {decision&&<div className="space-y-4 text-xs"><p>{decision.item.worker_name} · {decision.item.project_name} · {decision.item.date} · ₱{decision.item.amount}</p><p className="break-words">{decision.item.description}</p><p className="text-ink-secondary">This decision cannot be edited here. Review the details before continuing.</p><div className="flex justify-end gap-2"><Button type="button" variant="secondary" disabled={saving} onClick={()=>setDecision(null)}>Cancel</Button><Button type="button" variant="primary" isLoading={saving} disabled={saving} onClick={confirm}>Confirm {decision.status==='approved'?'approval':'rejection'}</Button></div></div>}
  </Modal>
 </div>;
}
