'use client';
import {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/Button';

type Status={available:true;ok:true;state:'active'|'revoked';authBan:'confirmed'|'unconfirmed'|'not_checked'};
/** Hidden until the server explicitly enables the reviewed rollout. */
export function DeactivateSupervisor({userId,name,onBusy,disabled}:{userId:string;name:string;onBusy:(busy:boolean)=>void;disabled:boolean}) {
  const [status,setStatus]=useState<Status|null>(null);
  const [error,setError]=useState('');
  const [warning,setWarning]=useState('');
  const [confirming,setConfirming]=useState(false);
  const [busy,setBusy]=useState(false);
  const active=useRef(true);
  const lock=useRef(false);
  async function read(signal?:AbortSignal,clearError=true) {
    try {
      const response=await fetch(`/api/users/deactivation?id=${encodeURIComponent(userId)}`,{cache:'no-store',signal});
      const result=await response.json();
      if(!active.current)return;
      if(result.available===true && result.ok===true && (result.state==='active'||result.state==='revoked')){setStatus(result);if(clearError)setError('');}
      else if(result.available===true){setStatus(null);setError(result.error||'Account access could not be verified.');}
      else {setStatus(null);setError('');}
    } catch {if(active.current){setStatus(null);setError('Account access could not be verified.');}}
  }
  useEffect(()=>{active.current=true;const controller=new AbortController();void read(controller.signal);return()=>{active.current=false;controller.abort();};
  // userId is fixed for this keyed component.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[userId]);
  async function deactivate() {
    if(lock.current || disabled)return;lock.current=true;setBusy(true);onBusy(true);setError('');setWarning('');
    try {
      const response=await fetch('/api/users/deactivation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId,confirmation:'DEACTIVATE'})});
      const result=await response.json();
      if(!response.ok || !result.ok){setError(result.error||'Access change was not confirmed. Check status before retrying.');}
      else {setWarning(result.warning||'Access restriction saved and login ban confirmed.');setConfirming(false);}
    } catch {setError('Access change was not confirmed. Check status before retrying; the change may have been saved.');}
    finally {await read(undefined,false);lock.current=false;setBusy(false);onBusy(false);}
  }
  if(!status)return error?<div className="text-xs text-ink-secondary space-y-2"><p role="status">{error}</p><Button type="button" variant="secondary" size="sm" disabled={busy||disabled} onClick={()=>void read()}>Retry access status</Button></div>:null;
  return <section className="pt-3 border-t border-surface-border space-y-2" aria-label="Supervisor access">
    <p className="font-bold text-navy">Account access: {status.state==='active'?'Active':'Restricted'}</p>
    {status.state==='revoked' && <p className="text-ink-secondary">Login ban: {status.authBan==='confirmed'?'confirmed':'not confirmed — check or retry the ban'}. History and payroll records are unchanged.</p>}
    <p className="text-ink-secondary">Deactivation preserves the person&apos;s records. Work already in progress and previously issued links may still be usable; copied information cannot be recalled.</p>
    {error && <p role="alert" className="text-status-danger">{error}</p>}{warning && <p role="status" className="text-ink-secondary">{warning}</p>}
    {confirming ? <div className="space-y-2"><p className="font-semibold">{status.state==='active'?`Deactivate ${name}'s Supervisor account?`:`Retry the login ban for ${name}?`}</p>
      <div className="flex gap-2"><Button type="button" variant="danger" size="sm" isLoading={busy} disabled={disabled} onClick={deactivate}>Confirm</Button><Button type="button" variant="secondary" size="sm" disabled={busy} onClick={()=>setConfirming(false)}>Cancel</Button></div></div>
      : <div className="flex flex-wrap gap-2">{(status.state==='active'||status.authBan==='unconfirmed') && <Button type="button" variant="secondary" size="sm" disabled={busy || disabled} onClick={()=>setConfirming(true)}>{status.state==='active'?'Deactivate account…':'Retry login ban…'}</Button>}
        <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={()=>void read()}>Check status</Button></div>}
  </section>;
}
