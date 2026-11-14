'use client';
import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/Button';
import {Input} from '@/components/ui/Input';
import {Select} from '@/components/ui/Select';
import {createClient} from '@/lib/supabase/client';
import {parseSupervisorCatalog,type SupervisorOption} from '@/lib/payroll/supervisorPreview';
import {SUPERVISOR_DAY_CHANGED} from '@/lib/attendance/supervisorDayEvents';

type Attempt={id:string;actor:string;supervisor:string;date:string;work:'present'|'half_day'|'absent';reason:string};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
function parseAttempt(x:unknown,actor:string):Attempt{
 if(!x||typeof x!=='object'||Array.isArray(x))throw Error('Invalid attempt');const a=x as Attempt;
 const d=new Date(`${a.date}T00:00:00Z`);
 if(!uuid(a.id)||!uuid(actor)||a.actor!==actor||!uuid(a.supervisor)||typeof a.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(a.date)||!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==a.date||!['present','half_day','absent'].includes(a.work)||typeof a.reason!=='string'||!a.reason||a.reason!==a.reason.trim()||a.reason.length>300||/[\u0000-\u001f\u007f-\u009f]/.test(a.reason))throw Error('Invalid attempt');
 return {id:a.id,actor,supervisor:a.supervisor,date:a.date,work:a.work,reason:a.reason};
}
/** Founder entry for the same daily queue. No approval or payroll is implied. */
export function SupervisorDayBackfill({userId}:{userId:string}){
 const key=`supervisor-day-backfill:${userId}`;const alive=useRef(false),lock=useRef(false);
 const [ready,setReady]=useState(false),[storageError,setStorageError]=useState(false),[pending,setPending]=useState<Attempt|null>(null),[catalog,setCatalog]=useState<SupervisorOption[]|null>(null);
 const [supervisor,setSupervisor]=useState(''),[date,setDate]=useState(''),[work,setWork]=useState<Attempt['work']>('present'),[reason,setReason]=useState(''),[ack,setAck]=useState(false),[clear,setClear]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
 useEffect(()=>{alive.current=true;try{const raw=sessionStorage.getItem(key);if(raw)setPending(parseAttempt(JSON.parse(raw),userId));}catch{setStorageError(true);}setReady(true);return()=>{alive.current=false;};},[key,userId]);
 async function load(){if(lock.current)return;lock.current=true;setBusy(true);setError('');try{const {data,error}=await createClient().rpc('supervisor_day_backfill_catalog');if(error)throw error;const options=parseSupervisorCatalog(data);if(alive.current){setCatalog(options);setSupervisor('');}}catch{if(alive.current)setError('Could not load the Supervisor list.');}finally{lock.current=false;if(alive.current)setBusy(false);}}
 async function verify(a:Attempt){
  const {data,error}=await createClient().rpc('supervisor_day_backfill_lookup',{p_id:a.id});if(error||!data||data.id!==a.id||data.founder_id!==a.actor||data.supervisor_id!==a.supervisor||data.date!==a.date||data.work_status!==a.work||data.reason!==a.reason||!['pending','approved','rejected'].includes(data.status))throw Error('Not confirmed');
  if(!alive.current)return;
  const stored=sessionStorage.getItem(key);if(!stored||JSON.stringify(parseAttempt(JSON.parse(stored),userId))!==JSON.stringify(a))throw Error('Attempt changed');sessionStorage.removeItem(key);setPending(null);setAck(false);setDate('');setReason('');setMessage(`Daily record verified as ${data.status}. Review it in the daily attendance list. No payroll or site attendance was changed.`);window.dispatchEvent(new Event(SUPERVISOR_DAY_CHANGED));
 }
 async function send(a:Attempt){if(lock.current||storageError)return;lock.current=true;setBusy(true);setError('');setMessage('');let stored=false;
  try{const existing=sessionStorage.getItem(key);if(existing&&JSON.stringify(parseAttempt(JSON.parse(existing),userId))!==JSON.stringify(a))throw Error('Different attempt');if(!existing)sessionStorage.setItem(key,JSON.stringify(a));const saved=sessionStorage.getItem(key);if(!saved||JSON.stringify(parseAttempt(JSON.parse(saved),userId))!==JSON.stringify(a))throw Error('Storage error');stored=true;if(alive.current)setPending(a);
   const {data,error}=await createClient().rpc('record_supervisor_day_backfill',{p_id:a.id,p_supervisor:a.supervisor,p_date:a.date,p_work_status:a.work,p_reason:a.reason});if(error||!data||data.id!==a.id||!['pending','approved','rejected'].includes(data.status)||typeof data.replayed!=='boolean')throw Error('Not confirmed');await verify(a);
  }catch{if(alive.current)setError(stored?'Outcome unconfirmed. The request may have completed; retry exactly or check the saved record.':'Could not preserve the retry in this tab; no request was sent.');}
  finally{lock.current=false;if(alive.current)setBusy(false);}
 }
 async function check(){if(!pending||lock.current)return;lock.current=true;setBusy(true);setError('');try{await verify(pending);}catch{if(alive.current)setError('Not confirmed. A missing record is not proof of failure; the request may still complete.');}finally{lock.current=false;if(alive.current)setBusy(false);}}
 function begin(e:React.FormEvent){e.preventDefault();if(!ready||pending||storageError||lock.current||!ack||!catalog?.some(s=>s.id===supervisor))return;try{void send(parseAttempt({id:crypto.randomUUID(),actor:userId,supervisor,date,work,reason},userId));}catch{setError('Enter a valid Supervisor, date, status and single-line reason without leading or trailing spaces.');}}
 function discard(){if(!pending||!clear||busy)return;try{const saved=sessionStorage.getItem(key);if(!saved||JSON.stringify(parseAttempt(JSON.parse(saved),userId))!==JSON.stringify(pending))throw Error('Attempt changed');sessionStorage.removeItem(key);setPending(null);setClear(false);setCatalog(null);setMessage('Retry cleared, not cancelled. The earlier request may still complete; inspect the daily records before creating another.');}catch{setError('Could not clear the retry. Investigate this tab before continuing.');}}
 return <section className="space-y-3 rounded-lg border border-surface-border p-3" aria-label="Founder Supervisor attendance backfill">
  <h4 className="font-semibold text-navy">Record a Supervisor day</h4><p>Use verified original records. This creates a pending general daily record, not a site row or payment. Review paid periods and legacy records separately. The exact retry, including the reason, stays in this tab until confirmed or cleared.</p>
  {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}{storageError&&<p role="alert">The saved retry is unreadable; new submissions are blocked. Investigate this browser session.</p>}
  {pending?<div className="space-y-2 rounded-lg bg-status-warning-bg p-3"><p>Unconfirmed request {pending.id}. It may already exist or still be processing.</p><div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={()=>void send(pending)}>Retry same request</Button><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={()=>void check()}>Check saved record</Button></div><details><summary>Resolve unconfirmed request</summary><p>Clear only after independent investigation. It does not cancel an in-flight request.</p><label><input type="checkbox" checked={clear} onChange={e=>setClear(e.target.checked)} /> I understand this request may still complete.</label><Button type="button" size="sm" variant="danger" disabled={!clear||busy} onClick={discard}>Clear retry after investigation</Button></details></div>:!storageError&&<><Button type="button" size="sm" variant="secondary" disabled={!ready||busy} onClick={()=>void load()}>{catalog?'Reload Supervisors':'Load Supervisors'}</Button>{catalog&&<form className="space-y-2" onSubmit={begin}>
   <Select label="Supervisor" value={supervisor} onChange={e=>{setSupervisor(e.target.value);setAck(false);}} required><option value="">Choose Supervisor</option>{catalog.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</Select>
   <Input label="Backfill work date" type="date" value={date} onChange={e=>{setDate(e.target.value);setAck(false);}} required />
   <Select label="Backfill work status" value={work} onChange={e=>{setWork(e.target.value as Attempt['work']);setAck(false);}}><option value="present">Present · full day</option><option value="half_day">Present · half day</option><option value="absent">Absent</option></Select>
   <Input label="Reason or source for backfill" value={reason} maxLength={300} onChange={e=>{setReason(e.target.value);setAck(false);}} required />
   <label className="flex items-start gap-2"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)} /> I checked the original record and understand this must be reviewed separately.</label>
   <Button type="submit" size="sm" disabled={busy||!ack||!supervisor||!date||!reason}>Record pending day</Button></form>}</>}
 </section>;
}

/** On-demand provenance for an existing daily record, scoped to Founder UI. */
export function SupervisorDayBackfillEvidence({id}:{id:string}){
 const alive=useRef(false),lock=useRef(false);const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[id]);
 async function load(){if(lock.current)return;lock.current=true;setBusy(true);setError('');setMessage('');try{
  const {data,error}=await createClient().rpc('supervisor_day_backfill_lookup',{p_id:id});if(error)throw error;
  if(data===null){if(alive.current)setMessage('No Founder backfill evidence was found for this daily record.');return;}
  if(!data||data.id!==id||!uuid(data.founder_id)||typeof data.reason!=='string'||!data.reason.trim()||data.reason.length>300||typeof data.recorded_at!=='string'||!Number.isFinite(Date.parse(data.recorded_at)))throw Error('Invalid evidence');
  if(alive.current)setMessage(`Founder ${data.founder_id} recorded this backfill on ${data.recorded_at}. Source: ${data.reason}`);
 }catch{if(alive.current)setError('Could not verify backfill evidence.');}finally{lock.current=false;if(alive.current)setBusy(false);}}
 return <div className="space-y-1"><Button type="button" variant="secondary" size="sm" disabled={busy} onClick={()=>void load()}>Check backfill evidence</Button>{message&&<p className="break-words">{message}</p>}{error&&<p role="alert">{error}</p>}</div>;
}
