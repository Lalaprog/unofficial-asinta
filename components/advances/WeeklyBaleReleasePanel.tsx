'use client';
import React,{useEffect,useRef,useState} from 'react';
import {useAuth} from '@/lib/auth/authContext';
import {createClient} from '@/lib/supabase/client';
import {getManilaClock} from '@/lib/reminders/scheduler';
import {workerPayrollPeriod} from '@/lib/payroll/periods';
import {useManilaToday} from '@/lib/dates/useManilaToday';
import {parseWeeklyBaleReleaseList,type WeeklyBaleRelease,type WeeklyBaleReleaseList} from '@/lib/payroll/weeklyBaleRelease';
import {useWeeklyBaleReleaseGuard} from '@/lib/attendance/useWeeklyBaleReleaseGuard';
import {Button} from '@/components/ui/Button';
import {Input} from '@/components/ui/Input';
import {Modal} from '@/components/ui/Modal';

type State={key:string;list:WeeklyBaleReleaseList|null;error:string;loading:boolean};
const blank=(key:string):State=>({key,list:null,error:'',loading:false});
/** Experimental workflow: external release recording, never a payment transfer. */
export function WeeklyBaleReleasePanel(){
 const {user,isFounder,isSupervisor,assurance}=useAuth();const today=useManilaToday();const [open,setOpen]=useState(false),[date,setDate]=useState(()=>getManilaClock().dateIso);
 const guard=useWeeklyBaleReleaseGuard(user?.id||'');
 const [reviewedWarning,setReviewedWarning]=useState(false);
 useEffect(()=>setReviewedWarning(false),[user?.id,guard.status]);
 const [state,setState]=useState<State>(()=>blank('')),[selected,setSelected]=useState<{key:string;item:WeeklyBaleRelease}|null>(null),[ack,setAck]=useState(false),[saving,setSaving]=useState(false),[message,setMessage]=useState('');
 const seq=useRef(0),busy=useRef(false);let period:ReturnType<typeof workerPayrollPeriod>|null=null;try{period=workerPayrollPeriod(date);}catch{}
 const start=period?.start||'',key=JSON.stringify([user?.id,isFounder,isSupervisor,assurance,start,today]);const active=useRef(key);active.current=key;
 useEffect(()=>{const token=seq;token.current++;busy.current=false;setState(blank(key));setSelected(null);setAck(false);setSaving(false);setMessage('');return()=>{token.current++;};},[key]);
 const current=state.key===key?state:blank(key),currentSelected=selected?.key===key?selected.item:null;
 async function load(){
  if(!user?.id||(!isFounder&&!isSupervisor)||assurance!=='ready'||!start||busy.current)return;
  if(getManilaClock().dateIso!==today){setState(blank(key));setMessage('Philippine date changed. Wait for the date to refresh, then reload the list.');return;}
  const token=++seq.current;busy.current=true;setState({...blank(key),loading:true});setMessage('');
  try{const {data,error}=await createClient().rpc('weekly_bale_release_list',{p_start:start});if(error)throw new Error(error.message);if(getManilaClock().dateIso!==today)throw new Error('Philippine date changed; refresh and reload');const list=parseWeeklyBaleReleaseList(data,start);if(token===seq.current&&active.current===key)setState({key,list,error:'',loading:false});}
  catch(e){if(token===seq.current&&active.current===key)setState({...blank(key),error:e instanceof Error?e.message:'Unable to load'});}
  finally{if(token===seq.current&&active.current===key)busy.current=false;}
 }
 async function record(){
  if(!currentSelected||!ack||busy.current||guard.status!=='ready'||!user?.id||(!isFounder&&!isSupervisor)||assurance!=='ready'||currentSelected.status!=='approved_pending_payment'||(!isFounder&&currentSelected.assignment_review_required))return;
  if(getManilaClock().dateIso!==today||today!==currentSelected.release_date){setSelected(null);setState(blank(key));setMessage('Philippine date changed. No request was sent; investigate the original week and release ledger. Do not pay again.');return;}
  const token=++seq.current;busy.current=true;setSaving(true);
  try{
   const marker=guard.begin(start,currentSelected);if(!marker)throw new Error('Could not preserve the release warning; no release record was intentionally sent');
   const {data,error}=await createClient().rpc('record_weekly_bale_release',{p_request_id:currentSelected.request_id});if(error)throw new Error(error.message);
   if(!data||data.request_id!==currentSelected.request_id||!['updated','already_recorded'].includes(data.outcome)||typeof data.advance_id!=='string'||!data.advance_id)throw new Error('Release response could not be verified');
   if(token!==seq.current||active.current!==key)return;
   const readback=await createClient().rpc('weekly_bale_release_list',{p_start:start});if(readback.error)throw new Error('Release readback unavailable');
   const verified=parseWeeklyBaleReleaseList(readback.data,start).items.find(item=>item.request_id===currentSelected.request_id);
   if(!verified||verified.status!=='issued'||verified.worker_id!==currentSelected.worker_id||verified.project_id!==currentSelected.project_id||verified.amount!==currentSelected.amount||verified.release_date!==currentSelected.release_date||verified.issued_advance_id!==data.advance_id)throw new Error('Release readback did not match');
   if(token===seq.current&&active.current===key){if(!guard.confirmed(marker))throw new Error('Release warning changed or could not be cleared');setSelected(null);setState(blank(key));setMessage('External release recorded and read back. No money was transferred by this application.');}
  }catch(e){if(token===seq.current&&active.current===key){setSelected(null);setState(blank(key));setMessage(`Release not confirmed: ${e instanceof Error?e.message:'Unknown error'}. Reload and inspect the request and advance ledger before retrying; do not pay again based on this message.`);}}
  finally{if(token===seq.current&&active.current===key){busy.current=false;setSaving(false);}}
 }
 if(!user?.id||(!isFounder&&!isSupervisor))return null;
 return <section className="rounded-2xl border border-surface-border bg-white p-4 sm:p-5">
  <button type="button" className="min-h-11 text-left text-sm font-semibold text-navy" aria-expanded={open} onClick={()=>setOpen(v=>!v)}>Experimental weekly Bale release</button>
  {open&&<div className="space-y-3 text-sm text-ink-secondary">
   <p>Approved requests for authorized sites appear here. Refresh and verify the worker and site before any external release; assignment information can change after this list is loaded. Record only money already given on Wednesday; this does not transfer money. If cash was given but recording is blocked, stop and ask the Founder to investigate the original week. Do not pay again, create another Bale or carry it to a later week. Automatic rejection and this panel are not ready for live use.</p>
   {guard.status==='checking'&&<p role="status">Checking the release warning in this tab…</p>}
   {guard.status==='unavailable'&&<p role="alert">This tab cannot safely check or preserve the release warning. Recording is held; investigate the original request, restore storage if needed and reload the page.</p>}
   {guard.status==='pending'&&<div role="alert" className="space-y-2 rounded-lg bg-status-warning-bg p-3">
    <p>A Bale release record may have been sent but its result was not confirmed. Inspect the original request and advance ledger; do not give money again or create another Bale because of this warning.</p>
    {guard.marker&&<p className="break-all">Week {guard.marker.start} · request {guard.marker.request} · worker {guard.marker.worker} · site {guard.marker.project} · ₱{guard.marker.amount} · Wednesday {guard.marker.releaseDate}</p>}
    <p>This warning is stored only for this account in this tab and can be lost with browser storage; other accounts, tabs and devices are not locked. Clearing it does not cancel an in-flight request.</p>
    <label className="flex items-start gap-2"><input type="checkbox" checked={reviewedWarning} onChange={e=>setReviewedWarning(e.target.checked)} />I investigated the original request and understand this cannot cancel a request.</label>
    <Button type="button" size="sm" variant="secondary" disabled={!reviewedWarning||saving||busy.current} onClick={()=>{if(!busy.current&&guard.clearAfterReview()){setReviewedWarning(false);setSelected(null);setState(blank(key));setMessage('Warning cleared after review. Reload the list and independently inspect the original release before another action.');}}}>Clear release warning after review</Button>
   </div>}
   <div className="flex flex-wrap items-end gap-3"><div className="w-full sm:w-52"><Input label="Date in Bale week" type="date" value={date} onChange={e=>setDate(e.target.value)} min="1900-01-01" max="9998-12-24" /></div><Button type="button" size="sm" variant="secondary" disabled={!start||saving||assurance!=='ready'} isLoading={current.loading} onClick={load}>{current.list?'Refresh releases':'Load releases'}</Button></div>
   {period&&<p>Week: {period.start} to {period.end}.</p>}{current.error&&<p role="alert">Could not load releases: {current.error}</p>}{message&&<p role="status">{message}</p>}
   {current.list&&(!current.list.items.length?<p>No approved or issued weekly requests in the accessible list. This does not prove that no external release happened.</p>:<ul className="space-y-2">{current.list.items.map(item=><li key={item.request_id} className="rounded-xl border border-surface-border p-3"><p className="font-semibold text-navy">{item.worker_name} · {item.project_name} · ₱{item.amount}</p><p>{item.status==='issued'?'Release recorded':'Approved, awaiting release'} · Wednesday {item.release_date}</p>{item.assignment_review_required&&<p role="note">Worker is inactive, linked to a Supervisor account, moved or has conflicting assignments. {isFounder?'Review the original request and site before recording.':'Ask the Founder to review before any release.'}</p>}{item.status==='approved_pending_payment'&&<Button type="button" size="sm" variant="secondary" disabled={saving||guard.status!=='ready'||assurance!=='ready'||(!isFounder&&item.assignment_review_required)||today!==item.release_date||getManilaClock().dateIso!==today} onClick={()=>{setSelected({key,item});setAck(false);}}>Review external release</Button>}</li>)}</ul>)}
  </div>}
  <Modal isOpen={!!currentSelected} onClose={()=>setSelected(null)} title="Record external Bale release?" description="This records a past external release; it does not send money." dismissOnBackdrop={!saving} dismissOnEscape={!saving} showCloseButton={!saving}>
   {currentSelected&&<div className="space-y-3 text-sm text-ink-secondary"><p>{currentSelected.worker_name} · {currentSelected.project_name} · ₱{currentSelected.amount} · {currentSelected.release_date}</p>{currentSelected.assignment_review_required&&<p role="note">Assignment needs Founder review. Verify the worker, original site and release evidence before recording.</p>}<p>Only confirm if this exact amount was already given to the worker on the listed Wednesday. Verify other records to avoid duplicates.</p><label className="flex items-start gap-2"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)} />I verified this external release already happened.</label><div className="flex flex-wrap justify-end gap-2"><Button type="button" size="sm" variant="secondary" disabled={saving} onClick={()=>setSelected(null)}>Cancel</Button><Button type="button" size="sm" isLoading={saving} disabled={!ack||saving||guard.status!=='ready'||assurance!=='ready'||getManilaClock().dateIso!==today||today!==currentSelected?.release_date} onClick={record}>Record release</Button></div></div>}
  </Modal>
 </section>;
}
