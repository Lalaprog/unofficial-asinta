'use client';
import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/Button';
import {useAuth} from '@/lib/auth/authContext';
import {createClient} from '@/lib/supabase/client';
import {parseHistoricalEvidence,type HistoricalEvidence} from '@/lib/payroll/historicalEvidence';
import type {PaidReviewVoucher} from '@/lib/payroll/paidReview';
import {historicalFinanceEntryPreviewEnabled} from '@/lib/finance/featureAvailability';
import {HistoricalFinanceEntry} from './HistoricalFinanceEntry';

type State={key:string;data:HistoricalEvidence|null;loading:boolean;error:string};
const empty=(key:string):State=>({key,data:null,loading:false,error:''});
/** Read-only historical assertions; neither the absence nor presence proves payment. */
export function HistoricalFinanceEvidence({voucher}:{voucher:PaidReviewVoucher}){
 const {user,isFounder,assurance}=useAuth();const key=JSON.stringify([user?.id,isFounder,assurance,voucher]);
 const [state,setState]=useState<State>(()=>empty(key));const [open,setOpen]=useState(false);
 const seq=useRef(0),active=useRef(key),busy=useRef(false);active.current=key;
 useEffect(()=>{const s=seq;s.current++;busy.current=false;setState(empty(key));setOpen(false);return()=>{s.current++;};},[key]);
 const current=state.key===key?state:empty(key);
 async function load(){
  if(!user?.id||!isFounder||assurance!=='ready'||busy.current)return;const token=++seq.current;busy.current=true;setState({...empty(key),loading:true});
  try{const {data,error}=await createClient().rpc('historical_finance_evidence_review',{p_payroll:voucher.id});if(error)throw new Error(error.message);const parsed=parseHistoricalEvidence(data,voucher);if(token===seq.current&&active.current===key)setState({key,data:parsed,loading:false,error:''});}
  catch(e){if(token===seq.current&&active.current===key)setState({...empty(key),error:e instanceof Error?e.message:'Evidence unavailable'});}
  finally{if(token===seq.current&&active.current===key)busy.current=false;}
 }
 const d=current.data;
 return <section className="mt-3 border-t border-surface-border pt-3"><button type="button" className="min-h-11 font-semibold text-brand underline" aria-expanded={open} onClick={()=>setOpen(v=>!v)}>Historical payment and Bale evidence</button>
  {open&&<div className="space-y-2"><p>This is read-only recorded evidence, not proof of release, payment, settlement or absence of other records. Check the original records; do not pay or deduct again based on this view. It excludes other Bale, payments and expense records. This evidence and the voucher above load separately and may become stale; refresh both before investigating.</p>
   <Button type="button" size="sm" variant="secondary" disabled={current.loading||!isFounder||!user?.id||assurance!=='ready'} isLoading={current.loading} onClick={()=>void load()}>{d?'Refresh historical evidence':'Load historical evidence'}</Button>
   {current.error&&<p role="alert">Could not load historical evidence: {current.error}</p>}
   {d&&<div className="space-y-2">{d.payment_conflict&&<p className="font-semibold text-status-warning">Conflicting payment-date sources exist. Investigate before relying on either.</p>}
    {d.recorded_payment_date&&<p>Payment date recorded by another workflow: {d.recorded_payment_date}. This is an assertion, not proof of transfer.</p>}
    {d.date_evidence?<div><p>Historical payment date assertion: {d.date_evidence.payment_date} · recorded by {d.date_evidence.recorded_by} at {d.date_evidence.recorded_at}.</p><p className="break-words">Evidence note: {d.date_evidence.note}</p>{!d.date_evidence.matches_voucher&&<p className="font-semibold text-status-warning">The voucher differs from the reviewed payment-date snapshot. Investigate.</p>}</div>:<p>No historical payment-date annotation was returned; this does not prove no payment occurred.</p>}
    {d.bale_evidence?<div><p>Historical settled Bale assertion: ₱{d.bale_evidence.amount} · release {d.bale_evidence.release_date} · project ID <span className="break-all">{d.bale_evidence.project_id}</span>.</p><p>Linked payment-date assertion: {d.bale_evidence.payment_date} ({d.bale_evidence.payment_date_source==='recorded_payment'?'recorded payment':'historical annotation'}). Recorded by {d.bale_evidence.recorded_by} at {d.bale_evidence.recorded_at}.</p><p className="break-words">Evidence note: {d.bale_evidence.note}</p>{(!d.bale_evidence.matches_voucher||d.bale_evidence.context_changed)&&<p className="font-semibold text-status-warning">The voucher or related records changed since this Bale evidence was saved. Investigate.</p>}</div>:<p>No historical settled Bale evidence was returned; this does not prove no Bale was released.</p>}
   </div>}
   {historicalFinanceEntryPreviewEnabled()&&user?.id&&isFounder&&assurance==='ready'&&<HistoricalFinanceEntry key={key} userId={user.id} voucher={voucher} evidence={d} onRecorded={()=>setState(empty(key))}/>}
  </div>}
 </section>;
}
