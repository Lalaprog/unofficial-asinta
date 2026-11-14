'use client';
import {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/Button';
import {createClient} from '@/lib/supabase/client';
import {parseSupervisorRevisionHistory,type SupervisorRevisionEvent} from '@/lib/payroll/supervisorLedger';

/** Founder-only read; the RPC enforces role and assurance independently of the UI. */
export function SupervisorRevisionHistory({payroll}:{payroll:string}){
 const [items,setItems]=useState<SupervisorRevisionEvent[]>([]),[more,setMore]=useState(false),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const alive=useRef(true),busyRef=useRef(false);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 async function load(next:boolean){
  if(busyRef.current)return;const before=next?items.at(-1)?.revision:null;if(next&&!before)return;
  busyRef.current=true;setBusy(true);setError('');
  try{const {data,error}=await createClient().rpc('supervisor_payroll_revision_history',{p_payroll:payroll,p_before:before});if(error)throw error;const page=parseSupervisorRevisionHistory(data,payroll,before??null);
   if(alive.current){setItems(prev=>next?[...prev,...page.items]:page.items);setMore(page.has_more);setLoaded(true);}
  }catch{if(alive.current)setError('Could not verify revision history. Reload or investigate before relying on it.');}
  finally{busyRef.current=false;if(alive.current)setBusy(false);}
 }
 return <section className="space-y-2 rounded-xl border border-surface-border p-3"><p className="font-semibold">Supervisor payroll revision history</p><p>Shows revision actions after this upgrade. Earlier creation and decisions are retained separately. This is not proof of external payment.</p>
  <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={()=>load(false)}>{loaded?'Reload revision history':'Load revision history'}</Button>
  {error&&<p role="alert" className="text-status-warning">{error}</p>}
  {loaded&&items.length===0&&<p>No revision actions recorded.</p>}
  <ol className="space-y-2">{items.map(e=><li key={e.request_id} className="rounded-lg bg-surface-muted p-2"><p className="font-semibold">Revision {e.revision} → {(BigInt(e.revision)+1n).toString()} · {e.action.replaceAll('_',' ')}</p><p>{e.occurred_at} · actor {e.actor_id}</p><p>{e.before_status} → {e.after_status} · rate ₱{e.before_rate} → ₱{e.after_rate} · gross ₱{e.before_gross} → ₱{e.after_gross}</p>{e.reason&&<p>Reason: {e.reason}</p>}{e.paid_on&&<p>Recorded payment date: {e.paid_on}</p>}</li>)}</ol>
  {more&&<Button type="button" variant="secondary" size="sm" disabled={busy} onClick={()=>load(true)}>Load older revisions</Button>}
 </section>;
}
