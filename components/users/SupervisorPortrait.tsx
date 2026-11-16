'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import {HardHat} from 'lucide-react';
import {createClient} from '@/lib/supabase/client';
import {parseSupervisorPortrait, prepareSupervisorPortrait, type SupervisorPortraitRecord} from '@/lib/users/supervisorPortrait';
type Operation = {p_supervisor: string; p_operation: string; p_expected_version: string | null; p_mime: string | null; p_data: string | null};

/** Reset all image and pending state if a reused component changes target. */
export function SupervisorPortrait(props: {id: string; name: string}) {
  return <SupervisorPortraitForId key={props.id} {...props} />;
}

function SupervisorPortraitForId({id, name}: {id: string; name: string}) {
  const [portrait,setPortrait]=useState<SupervisorPortraitRecord | null>(null);
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);
  const [pending,setPending]=useState<Operation | null>(null);
  const lock=useRef(false);
  const mounted=useRef(false);
  const load=useCallback(async()=>{
    const {data,error}=await createClient().rpc('supervisor_profile_photo',{p_supervisor:id});
    if (!mounted.current) return;
    try {
      if(error) throw error;
      setPortrait(parseSupervisorPortrait(data,id));setMessage('');return true;
    } catch {setPortrait(null);setMessage('Photo unavailable. Check access or try refreshing.');return false;}
  },[id]);
  useEffect(()=>{mounted.current=true;void load().catch(()=>{if(mounted.current)setMessage('Photo unavailable. Try refreshing.');});return()=>{mounted.current=false;};},[load]);
  const send=async(op:Operation)=>{
    const {error}=await createClient().rpc('set_supervisor_profile_photo',op);
    if(!mounted.current) return;
    if(error){
      if(error.code==='40001' || error.code==='22023' || error.code==='42501') {setPending(null);setMessage('This attempt was refused. An earlier attempt may have succeeded; refresh and check before making another change.');setPortrait(null);}
      else {setPending(op);setMessage('Save outcome is unknown. Retry the same change or refresh to check.');}
      return;
    }
    setPending(null);
    await load();
  };
  const run=async(op:Operation)=>{
    if(lock.current)return;lock.current=true;setBusy(true);
    try{await send(op);}catch{if(mounted.current){setPending(op);setMessage('Save outcome is unknown. Retry the same change or refresh to check.');}}
    finally{lock.current=false;if(mounted.current)setBusy(false);}
  };
  const select=async(file:File | undefined)=>{
    if(!file || !portrait || lock.current || pending)return;
    lock.current=true;setBusy(true);
    try{
      const prepared=await prepareSupervisorPortrait(file);
      const op={p_supervisor:id,p_operation:crypto.randomUUID(),p_expected_version:portrait.version,p_mime:prepared.mime,p_data:prepared.data};
      try { await send(op); } catch { if(mounted.current){setPending(op);setMessage('Save outcome is unknown. Retry the same change or refresh to check.');} }
    }catch(error){if(mounted.current)setMessage(error instanceof Error ? error.message : 'Photo could not be prepared.');}
    finally{lock.current=false;if(mounted.current)setBusy(false);}
  };
  const refresh=async()=>{if(lock.current)return;lock.current=true;setBusy(true);try{if(await load() && mounted.current)setPending(null);}catch{if(mounted.current)setMessage('Photo unavailable. Try refreshing.');}finally{lock.current=false;if(mounted.current)setBusy(false);}};
  return <div className="rounded-xl border border-surface-border p-3 text-xs space-y-2">
    <div className="flex items-center gap-3">
      <div className="w-12 h-12 rounded-xl bg-surface-inset border border-surface-border overflow-hidden flex items-center justify-center shrink-0">
        {portrait?.has_photo && portrait.mime && portrait.data ?
          // Portrait is an authenticated, bounded RPC result, not a public URL.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`data:${portrait.mime};base64,${portrait.data}`} alt={`${name} profile photo`} className="h-full w-full object-cover" /> :
          <HardHat aria-hidden="true" className="w-6 h-6 text-status-warning" />}
      </div>
      <div><p className="font-semibold text-navy">Optional profile photo</p><p className="text-ink-secondary">Private to Founder and this Supervisor. Default icon if absent.</p></div>
    </div>
    {message && <p role="status" className="text-status-warning">{message}</p>}
    <div className="flex flex-wrap items-center gap-2">
      {portrait && !pending && <label className={`inline-flex min-h-11 items-center rounded-lg border border-surface-border px-3 font-semibold text-navy focus-within:ring-2 focus-within:ring-brand ${busy ? 'opacity-50' : 'cursor-pointer'}`}>
        {portrait.has_photo ? 'Replace photo' : 'Choose photo'}
        <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" disabled={busy} onChange={e=>{const file=e.currentTarget.files?.[0];e.currentTarget.value='';void select(file);}} />
      </label>}
      {portrait?.has_photo && !pending && <button type="button" disabled={busy} onClick={()=>void run({p_supervisor:id,p_operation:crypto.randomUUID(),p_expected_version:portrait.version,p_mime:null,p_data:null})} className="min-h-11 rounded-lg px-3 font-semibold text-status-danger disabled:opacity-50">Remove photo</button>}
      {pending && <button type="button" disabled={busy} onClick={()=>void run(pending)} className="min-h-11 rounded-lg border border-surface-border px-3 font-semibold text-navy disabled:opacity-50">Retry same change</button>}
      {(message || pending) && <button type="button" disabled={busy} onClick={()=>void refresh()} className="min-h-11 rounded-lg px-3 font-semibold text-brand disabled:opacity-50">Refresh photo</button>}
    </div>
  </div>;
}
