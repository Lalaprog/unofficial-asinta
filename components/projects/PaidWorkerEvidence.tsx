'use client';
import React,{useCallback,useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/Button';
import {formatPeso} from '@/lib/email/format';
import {createClient} from '@/lib/supabase/client';
import {parsePaidWorkerPage,type PaidWorkerEvidence as Row} from '@/lib/projects/paidWorkerEvidence';
type State={key:string;items:Row[];hasMore:boolean;loading:boolean;error:boolean};
/** Evidence only: never add this to expenses without explicit reconciliation. */
export function PaidWorkerEvidence({projectId,userId}:{projectId:string;userId:string}){
 const [revision,setRevision]=useState(0),key=JSON.stringify([projectId,userId,revision]);const active=useRef(key);active.current=key;const request=useRef(0),busy=useRef(false);
 const [state,setState]=useState<State>({key:'',items:[],hasMore:false,loading:true,error:false});
 const load=useCallback(async(cursor?:Row)=>{
  if(busy.current)return;busy.current=true;const token=++request.current;
  setState(prev=>({key,items:cursor&&prev.key===key?prev.items:[],hasMore:false,loading:true,error:false}));
  try{const {data,error}=await createClient().rpc('project_paid_worker_evidence',{p_project:projectId,p_cursor_week:cursor?.start??null,p_cursor_payroll:cursor?.payrollId??null,p_limit:25});if(error)throw error;const page=parsePaidWorkerPage(data,projectId,cursor);
   if(active.current===key&&token===request.current)setState(prev=>({key,items:[...(cursor&&prev.key===key?prev.items:[]),...page.items],hasMore:page.hasMore,loading:false,error:false}));
  }catch{if(active.current===key&&token===request.current)setState({key,items:[],hasMore:false,loading:false,error:true});}
  finally{if(active.current===key&&token===request.current)busy.current=false;}
 },[projectId,key]);
 useEffect(()=>{const sequence=request;busy.current=false;void load();return()=>{sequence.current++;busy.current=false;};},[load]);
 const view=state.key===key?state:{key,items:[],hasMore:false,loading:true,error:false};
 return <section className="space-y-3 rounded-xl border border-surface-border bg-white p-4 text-xs text-ink-secondary"><h4 className="text-sm font-bold text-navy">Experimental paid worker payroll evidence</h4>
  <p>Gross wages and approved allowances attributed to this site from the new weekly workflow, after recorded approval and external payment. This is not proof of transfer. Legacy payroll, later corrections and unallocated zero-work vouchers are not included. Worker names are current, not historical.</p>
  <p className="rounded-lg bg-status-warning-bg p-3">Do not add these figures to recorded expenses until Bale, payroll and duplicate expense entries are reconciled. This is not a complete project cost or profit total.</p>
  <Button type="button" variant="secondary" size="sm" disabled={view.loading} onClick={()=>setRevision(x=>x+1)}>Refresh payroll evidence</Button>
  {view.loading&&<p role="status">Loading paid payroll evidence…</p>}{view.error&&<p role="alert">Could not verify paid payroll evidence. No empty or partial result is assumed; refresh and investigate.</p>}
  {!view.loading&&!view.error&&(view.items.length?<ul className="divide-y divide-surface-border">{view.items.map(row=><li key={row.payrollId} className="space-y-1 py-3"><p className="font-semibold text-navy break-words">{row.workerName} · {row.start} to {row.end}</p><p>Payment date recorded: {row.paymentDate} · Site hours: {row.hours}</p><p>Wages {formatPeso(Number(row.wage))} + allowance {formatPeso(Number(row.allowance))} = gross {formatPeso(Number(row.gross))}</p><p className="break-all">Voucher {row.payrollId}</p></li>)}</ul>:<p>No matching paid allocations returned. This does not establish that the project has no payroll cost.</p>)}
  {view.hasMore&&!view.error&&!view.loading&&<Button type="button" variant="secondary" size="sm" onClick={()=>void load(view.items.at(-1))}>Show older payroll evidence</Button>}
 </section>;
}
