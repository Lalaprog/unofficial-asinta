'use client';

import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/Button';
import {Input} from '@/components/ui/Input';
import {Select} from '@/components/ui/Select';
import {Modal} from '@/components/ui/Modal';
import {useAuth} from '@/lib/auth/authContext';
import {createClient} from '@/lib/supabase/client';
import {getManilaClock} from '@/lib/reminders/scheduler';
import {parseAdjustmentList,sameSnapshot,snapshotFromReview,validDifference,type AdjustmentList,type PaidAdjustment} from '@/lib/payroll/paidAdjustments';
import type {PaidReviewVoucher} from '@/lib/payroll/paidReview';

type State={key:string;list:AdjustmentList|null;loading:boolean;error:string};
type Confirm={kind:'open'}|{kind:'resolve';item:PaidAdjustment};
const empty=(key:string):State=>({key,list:null,loading:false,error:''});

/** Founder-entered case history; no transfer, deduction, voucher edit or future carryover. */
export function PaidAdjustmentPanel({voucher}:{voucher:PaidReviewVoucher}){
 const {user,isFounder}=useAuth();
 const snapshot=snapshotFromReview(voucher),key=JSON.stringify([user?.id,isFounder,snapshot]);
 const [expanded,setExpanded]=useState(false),[state,setState]=useState<State>(()=>empty(key));
 const [difference,setDifference]=useState(''),[reason,setReason]=useState(''),[message,setMessage]=useState('');
 const [resolution,setResolution]=useState<'settled_external'|'no_transfer'>('settled_external'),[settledOn,setSettledOn]=useState(''),[note,setNote]=useState('');
 const [confirm,setConfirm]=useState<Confirm|null>(null),[saving,setSaving]=useState(false);
 const seq=useRef(0),busy=useRef(false),active=useRef(key),request=useRef<{key:string;id:string}|null>(null);active.current=key;
 useEffect(()=>{const sequence=seq;sequence.current++;busy.current=false;request.current=null;setExpanded(false);setState(empty(key));setDifference('');setReason('');setMessage('');setConfirm(null);setSaving(false);setResolution('settled_external');setSettledOn('');setNote('');return()=>{sequence.current++;};},[key]);
 const current=state.key===key?state:empty(key);
 async function load(offset=0){
  if(!isFounder||!user?.id||busy.current)return;
  busy.current=true;const token=++seq.current;setState({...empty(key),loading:true});
  try{
   const {data,error}=await createClient().rpc('paid_payroll_adjustment_list',{p_payroll_id:voucher.id,p_offset:offset});
   if(error)throw new Error(error.message);
   const list=parseAdjustmentList(data,voucher.id,offset);
   if(token===seq.current&&active.current===key)setState({key,list,loading:false,error:''});
  }catch(e){if(token===seq.current&&active.current===key)setState({...empty(key),error:e instanceof Error?e.message:'History unavailable'});}
  finally{if(token===seq.current&&active.current===key)busy.current=false;}
 }
 function prepareOpen(event:React.FormEvent){
  event.preventDefault();if(!current.list||busy.current||!isFounder)return;
  if(!validDifference(difference)||!reason.trim()||reason.trim().length>500){setMessage('Enter a nonzero difference with at most two decimals and an explanation.');return;}
  setMessage('');setConfirm({kind:'open'});
 }
 function prepareResolution(item:PaidAdjustment){
  if(busy.current||item.status!=='pending')return;
  setResolution('settled_external');setSettledOn('');setNote('');setMessage('');setConfirm({kind:'resolve',item});
 }
 async function save(){
  if(!confirm||busy.current||!user?.id||!isFounder||!current.list)return;
  if(confirm.kind==='open'&&(!validDifference(difference)||!reason.trim()||reason.trim().length>500)){setMessage('Enter a nonzero difference with at most two decimals and an explanation.');return;}
  if(confirm.kind==='resolve'&&(!note.trim()||note.trim().length>500||(resolution==='settled_external'&&(!settledOn||settledOn<voucher.period_start||settledOn>getManilaClock().dateIso)))){
   setMessage('Enter an explanation and a settlement date within or after the original period and no later than today in Philippine time.');return;
  }
  busy.current=true;setSaving(true);setMessage('');const token=++seq.current;
  try{
   let result:{id?:unknown;status?:unknown;replayed?:unknown}|null=null;
   if(confirm.kind==='open'){
    const fingerprint=JSON.stringify([user.id,voucher.id,snapshot,difference,reason.trim()]);
    if(!request.current||request.current.key!==fingerprint)request.current={key:fingerprint,id:crypto.randomUUID()};
    const id=request.current.id;
    const {data,error}=await createClient().rpc('open_paid_payroll_adjustment',{p_id:id,p_payroll_id:voucher.id,p_expected:snapshot,p_difference:difference,p_reason:reason.trim()});
    if(error)throw new Error(error.message);result=data;
    if(!result||result.id!==id||!['pending','settled_external','no_transfer'].includes(String(result.status))||typeof result.replayed!=='boolean')throw new Error('Response could not be verified');
    if(token!==seq.current||active.current!==key)return;
    request.current=null;setDifference('');setReason('');
   }else{
    const {data,error}=await createClient().rpc('resolve_paid_payroll_adjustment',{p_id:confirm.item.id,p_resolution:resolution,p_settled_on:resolution==='settled_external'?settledOn:null,p_note:note.trim()});
    if(error)throw new Error(error.message);result=data;
    if(!result||result.id!==confirm.item.id||result.status!==resolution||typeof result.replayed!=='boolean')throw new Error('Response could not be verified');
    if(token!==seq.current||active.current!==key)return;
   }
   setConfirm(null);setState(empty(key));setMessage('Recorded. Reload case history to verify the current state. No voucher, payment or Bale was changed.');
  }catch(e){if(token===seq.current&&active.current===key){setConfirm(null);setState(empty(key));setMessage(`Not confirmed: ${e instanceof Error?e.message:'Unknown error'}. Reload case history before retrying; an unchanged new-case retry uses the same ID.`);}}
  finally{if(token===seq.current&&active.current===key){busy.current=false;setSaving(false);}}
 }
 return <div className="mt-3 border-t border-surface-border pt-3">
  <button type="button" className="min-h-11 font-semibold text-brand underline" aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}>Adjustment cases for this voucher</button>
  {expanded&&<div className="space-y-3 pt-2">
   <p>Review this original paid period only. Positive means a possible amount owed to the worker; negative means a possible overpayment. Verify evidence first. This does not change a voucher or move money.</p>
   <Button type="button" variant="secondary" size="sm" onClick={()=>load(current.list?.offset??0)} disabled={saving||current.loading} isLoading={current.loading}>{current.list?'Refresh case history':'Load case history'}</Button>
   {current.error&&<p role="alert">Unable to load case history: {current.error}</p>}{message&&<p role="status">{message}</p>}
   {current.list&&<>
    <p>Showing {current.list.items.length?current.list.offset+1:0}–{current.list.offset+current.list.items.length} of {current.list.total} cases. Check past cases before creating another; duplicates cannot always be detected.</p>
    {current.list.items.length===0?<p>No cases recorded for this voucher.</p>:<ul className="space-y-2">{current.list.items.map(item=><li key={item.id} className="rounded-lg border border-surface-border bg-white p-3">
     <p className="font-semibold text-navy">{item.status.replace('_',' ')} · difference ₱{item.difference}</p><p className="break-words">Reason: {item.reason}</p>
     {!sameSnapshot(item.original_voucher,snapshot)&&<p className="font-semibold text-status-warning">The original voucher differs from the version currently displayed. Investigate before resolving.</p>}
     {item.status!=='pending'&&<p className="break-words">{item.status==='settled_external'?`External settlement recorded for ${item.settled_on}.`:'No transfer recorded.'} {item.resolution_note}</p>}
     {item.status==='pending'&&<Button type="button" variant="secondary" size="sm" disabled={saving} onClick={()=>prepareResolution(item)}>Resolve this case</Button>}
    </li>)}</ul>}
    <div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" size="sm" disabled={saving||current.list.offset===0} onClick={()=>load(Math.max(0,current.list!.offset-100))}>Previous cases</Button><Button type="button" variant="secondary" size="sm" disabled={saving||current.list.offset+current.list.items.length>=current.list.total} onClick={()=>load(current.list!.offset+100)}>Next cases</Button></div>
    <form onSubmit={prepareOpen} className="space-y-3 border-t border-surface-border pt-3"><p className="font-semibold text-navy">Open a separate case</p><Input label="Signed difference in pesos" inputMode="decimal" value={difference} onChange={e=>setDifference(e.target.value)} hint="Example: 50.25 or -50.25; no automatic payment or deduction."/><Input label="Reason for review" maxLength={500} value={reason} onChange={e=>setReason(e.target.value)}/><Button type="submit" variant="secondary" size="sm" disabled={saving}>Review new case</Button></form>
   </>}
  </div>}
  <Modal isOpen={!!confirm} onClose={()=>setConfirm(null)} title={confirm?.kind==='open'?'Open adjustment review?':'Record case resolution?'} description="This records a review decision only. No money is sent or deducted." dismissOnBackdrop={!saving} dismissOnEscape={!saving} showCloseButton={!saving}>
   {confirm&&<div className="space-y-3 text-xs text-ink-secondary">
    {confirm.kind==='open'?<><p>{voucher.worker_name||'Worker unavailable'} · original period {voucher.period_start} to {voucher.period_end}</p><p>Signed difference ₱{difference} · {reason.trim()}</p><p>Check the original records and prior cases. This amount is an entered review figure, not proof of a payment or debt.</p></>:<><p>Case difference ₱{confirm.item.difference} · {confirm.item.reason}</p><Select label="Resolution" value={resolution} onChange={e=>setResolution(e.target.value as typeof resolution)}><option value="settled_external">Full amount settled outside the system</option><option value="no_transfer">No transfer required</option></Select>{resolution==='settled_external'&&<Input label="Actual settlement date" type="date" min={voucher.period_start} max={getManilaClock().dateIso} value={settledOn} onChange={e=>setSettledOn(e.target.value)}/>}<Input label="Resolution explanation" maxLength={500} value={note} onChange={e=>setNote(e.target.value)}/><p>Partial settlements are not supported here. Never record a settlement unless it actually happened.</p></>}
    {message&&<p role="status">{message}</p>}<div className="flex justify-end gap-2"><Button type="button" variant="secondary" disabled={saving} onClick={()=>setConfirm(null)}>Cancel</Button><Button type="button" variant="primary" disabled={saving} isLoading={saving} onClick={save}>{confirm.kind==='open'?'Open case':'Record resolution'}</Button></div>
   </div>}
  </Modal>
 </div>;
}
