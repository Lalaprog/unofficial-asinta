'use client';
import {useCallback,useEffect,useState} from 'react';
import {Button} from '@/components/ui/Button';
type Attempt={attemptId:string;invoiceId:string|null;clientId:string|null;channel:'sms'|'email';state:'reserved'|'unconfirmed';createdAt:string;invoiceNumber:string|null;clientName:string|null};
type Legacy={kind:'email_log'|'sms_log'|'dispatch';recordId:string;invoiceId:string|null;channel:'sms'|'email';state:string;createdAt:string|null;invoiceNumber:string|null;clientName:string|null;contact:string|null};
export function ReminderDeliveryReview(){
  const [available,setAvailable]=useState(false);const [attempts,setAttempts]=useState<Attempt[]>([]);const [legacy,setLegacy]=useState<Legacy[]>([]);const [more,setMore]=useState(false);const [legacyMore,setLegacyMore]=useState(false);const [error,setError]=useState('');
  const [selected,setSelected]=useState<Attempt|Legacy|null>(null);const [outcome,setOutcome]=useState('');const [evidence,setEvidence]=useState('');const [confirmed,setConfirmed]=useState(false);const [busy,setBusy]=useState(false);
  const refresh=useCallback(async()=>{try{const response=await fetch('/api/reminders/review',{cache:'no-store'});const data=await response.json();
    if(data.available!==true){setAvailable(false);return;}setAvailable(true);
    if(!response.ok||!data.ok||!Array.isArray(data.attempts)||typeof data.hasMore!=='boolean'||!Array.isArray(data.legacyRecords)||typeof data.legacyHasMore!=='boolean')throw Error();setAttempts(data.attempts);setLegacy(data.legacyRecords);setMore(data.hasMore);setLegacyMore(data.legacyHasMore);setError('');
  }catch{setError('Could not check messages needing review.');}},[]);
  useEffect(()=>{void refresh();},[refresh]);
  async function save(){if(!selected||busy)return;setBusy(true);setError('');try{const response=await fetch('/api/reminders/review',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...selected,outcome,evidence,noSenderRunning:confirmed})});const data=await response.json();if(!response.ok||!data.ok){setError(data.error||'Review was not confirmed. Refresh before retrying.');return;}setSelected(null);setOutcome('');setEvidence('');setConfirmed(false);await refresh();}catch{setError('Review was not confirmed. Refresh before retrying.');}finally{setBusy(false);}}
  if(!available)return null;
  return <section className="p-4 rounded-2xl border border-surface-border bg-surface-card space-y-3 text-xs" aria-label="Messages needing review">
    <div className="flex justify-between gap-2"><h2 className="font-bold text-navy">Messages needing review</h2><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={refresh}>Refresh</Button></div>
    <p className="text-ink-secondary">Some messages may still be sending. Before resolving one, verify the provider outcome and independently confirm no sender is still running. An incorrect decision can cause a duplicate. One older message can have more than one record; check each against the provider and message history.</p>
    {error&&<p role="alert" className="text-status-danger">{error}</p>}
    {attempts.length===0?<p>No current coordinated messages need review.</p>:<ul className="space-y-2">{attempts.map(a=><li key={a.attemptId} className="flex flex-wrap justify-between items-center gap-2 border-t border-surface-border pt-2"><span>{a.channel.toUpperCase()} · {a.invoiceNumber||'Client message'} · {a.clientName||'Client'} · {a.state==='unconfirmed'?'Not confirmed':'Still reserved'} · {new Date(a.createdAt).toLocaleString()} <span className="text-ink-muted">({a.attemptId})</span></span><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={()=>{setSelected(a);setOutcome('');setEvidence('');setConfirmed(false);}}>Review…</Button></li>)}</ul>}
    {more&&<p>More messages need review; refresh after resolving items.</p>}
    {legacy.length>0&&<div className="space-y-2"><h3 className="font-semibold">Older message records</h3><ul className="space-y-2">{legacy.map(a=><li key={`${a.kind}-${a.recordId}`} className="flex flex-wrap justify-between items-center gap-2 border-t border-surface-border pt-2"><span>{a.channel.toUpperCase()} · {a.invoiceNumber||'Unlinked message'} · {a.clientName||a.contact||'Unknown client'} · {a.state} · {a.createdAt?new Date(a.createdAt).toLocaleString():'Date unavailable'} <span className="text-ink-muted">({a.kind} · {a.recordId})</span></span><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={()=>{setSelected(a);setOutcome('');setEvidence('');setConfirmed(false);}}>Review…</Button></li>)}</ul></div>}
    {legacyMore&&<p>More older records need review; refresh after resolving items.</p>}
    {selected&&<div className="p-3 rounded-xl bg-surface-inset border border-surface-border space-y-2">
      <h3 className="font-bold">Review {selected.channel.toUpperCase()} · {selected.invoiceNumber||'Client message'}</h3>
      <label className="block space-y-1">Verified outcome<select className="w-full rounded-lg border border-surface-border p-2" value={outcome} onChange={e=>setOutcome(e.target.value)}><option value="">Choose after checking the provider</option><option value="accepted">Provider accepted the message</option><option value="rejected">Provider definitely rejected the message</option><option value="cancelled">Provider was never contacted</option></select></label>
      <label className="block space-y-1">What did you check? (at least 20 characters)<textarea className="w-full rounded-lg border border-surface-border p-2" value={evidence} maxLength={500} onChange={e=>setEvidence(e.target.value)} /></label>
      <label className="flex gap-2"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} /> I independently confirmed no sender is still running for this attempt.</label>
      <div className="flex gap-2"><Button type="button" size="sm" disabled={!outcome||evidence.trim().length<20||!confirmed||busy} isLoading={busy} onClick={save}>Save review</Button><Button type="button" variant="secondary" size="sm" disabled={busy} onClick={()=>setSelected(null)}>Cancel</Button></div>
    </div>}
  </section>;
}
