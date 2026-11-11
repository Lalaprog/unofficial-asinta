'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Search, Users } from 'lucide-react';
import { useDataStore } from '@/lib/data/store';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { Worker } from '@/types';

export function ProjectWorkers({ projectId }: { projectId: string }) {
  const { workers, refresh, isLoaded, loadError } = useDataStore();
  const [ids, setIds] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [needsCheck, setNeedsCheck] = useState(false);
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState('');
  const [position, setPosition] = useState('');
  const [contact, setContact] = useState('');
  const [rate, setRate] = useState('');
  const [rateType, setRateType] = useState<'daily'|'hourly'>('daily');
  const [remove, setRemove] = useState<Worker | {id:string;name:string} | null>(null);
  const lock = useRef(false);
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/workers`;

  const load = useCallback(async (refreshWorkers = false) => {
    setLoading(true); setError('');
    try {
      if (refreshWorkers) await refresh();
      const res = await fetch(endpoint, {cache:'no-store'});
      const body = await res.json();
      if (!res.ok || !Array.isArray(body.workerIds) || body.workerIds.some((id:unknown) => typeof id !== 'string')) throw new Error('unavailable');
      setIds(body.workerIds); setNeedsCheck(false); return true;
    } catch {
      setIds(null); setNeedsCheck(true); setError('Could not load the project team. Please try again.'); return false;
    } finally { setLoading(false); }
  }, [endpoint, refresh]);
  // Refresh identity is not stable across store updates; load once for this mounted project.
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => { void loadRef.current(); }, [projectId]);

  const change = async (payload: Record<string, unknown>) => {
    if (lock.current || needsCheck) return false;
    lock.current = true; setPending(true); setError(''); setMessage('');
    try {
      const res = await fetch(endpoint, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        // 422 is a definite validation failure; all other outcomes are checked
        // before allowing another write, including a potentially lost response.
        if (res.status !== 422) { setNeedsCheck(true); setIds(null); }
        setError(body?.error || 'Change not confirmed. Refresh and check the project team before trying again.');
        return false;
      }
      const loaded = await load(true);
      if (!loaded) return false;
      return true;
    } catch {
      setNeedsCheck(true); setIds(null);
      setError('Change not confirmed. Refresh and check the project team before trying again.');
      return false;
    } finally { setPending(false); lock.current = false; }
  };

  const current = (ids || []).map((id) => workers.find((worker) => worker.id === id) || {id, name:'Worker unavailable'});
  const candidates = workers.filter((worker) => worker.active && !(ids || []).includes(worker.id))
    .filter((worker) => `${worker.name} ${worker.position}`.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a,b) => a.name.localeCompare(b.name));
  const similar = name.trim().length >= 2 ? workers.filter((worker) => worker.name.toLowerCase().includes(name.trim().toLowerCase())).slice(0,5) : [];

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !position.trim() || !rate.trim() || pending || needsCheck) return;
    const requestId = crypto.randomUUID();
    const ok = await change({action:'create',requestId,name,position,contact,rate,rateType});
    if (ok) { setName(''); setPosition(''); setContact(''); setRate(''); setShowNew(false); setMessage('Worker registered and added to this project.'); }
  };

  return <section className="animate-panel-enter animate-panel-lift space-y-4" aria-label="Project workers">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="flex items-center gap-2 text-sm font-bold text-navy"><Users className="h-4 w-4" />Project workers</h3>
        <p className="mt-1 text-xs text-ink-secondary">The current team for this project. Adding or removing someone does not mark attendance or change payroll.</p></div>
      <Button type="button" size="sm" variant="secondary" onClick={() => {setShowAdd(!showAdd);setShowNew(false);}} disabled={loading || needsCheck || pending} leftIcon={<Plus className="h-4 w-4" />}>{showAdd ? 'Close' : 'Add worker'}</Button>
    </div>
    <p className="text-xs text-ink-secondary">This list starts empty; past attendance does not automatically assign workers. Roll Call uses the project team and keeps saved attendance visible for the selected date.</p>
    {error && <div role="alert" className="rounded-xl border border-status-danger/20 bg-status-danger-bg p-3 text-xs text-status-danger">{error}</div>}
    {message && <p role="status" className="text-xs text-status-success">{message}</p>}
    {needsCheck && <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => void load(true)}>Refresh and check team</Button>}
    {showAdd && !needsCheck && <div className="space-y-3 rounded-xl border border-surface-border bg-white p-4">
      <div><h4 className="text-sm font-semibold text-navy">Add an existing worker</h4><p className="mt-1 text-xs text-ink-secondary">Search the shared workforce first to avoid duplicate profiles.</p></div>
      <Input label="Search existing workers" placeholder="Name or craft" leftIcon={<Search className="h-4 w-4" />} value={search} onChange={(e) => setSearch(e.target.value)} />
      {!isLoaded ? <p className="text-xs text-ink-secondary">Loading workforce…</p> : loadError ? <p className="text-xs text-status-danger">The workforce could not be fully loaded. Refresh before adding someone.</p> : <div className="max-h-64 overflow-y-auto rounded-lg border border-surface-border">
        {candidates.length ? candidates.map((worker) => <div key={worker.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-border p-3 last:border-0">
          <div><div className="text-xs font-semibold text-navy">{worker.name}</div><div className="text-xs text-ink-secondary">{worker.position}{worker.contact_number && worker.contact_number !== '—' ? ` · ${worker.contact_number}` : ''}</div></div>
          <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => void change({action:'assign',workerId:worker.id}).then(ok => {if(ok) setMessage(`${worker.name} added to this project.`);})} aria-label={`Add ${worker.name}`}>Add</Button>
        </div>) : <p className="p-3 text-xs text-ink-secondary">No matching available workers.</p>}
      </div>}
      <Button type="button" size="sm" variant="outline" disabled={pending || !isLoaded || Boolean(loadError)} onClick={() => setShowNew(!showNew)}>{showNew ? 'Cancel new worker' : 'Register a new worker'}</Button>
      {showNew && <form onSubmit={create} className="space-y-3 border-t border-surface-border pt-3">
        <p className="text-xs text-ink-secondary">A new profile will be created and added to this project. Check the existing list first.</p>
        <div className="grid gap-3 sm:grid-cols-2"><Input label="Full name" required maxLength={120} value={name} onChange={e=>setName(e.target.value)} /><Input label="Craft or position" required maxLength={120} value={position} onChange={e=>setPosition(e.target.value)} /><Input label="Contact number (optional)" maxLength={100} value={contact} onChange={e=>setContact(e.target.value)} /><Input label="Pay rate (PHP)" required inputMode="decimal" value={rate} onChange={e=>setRate(e.target.value)} /></div>
        {similar.length > 0 && <p className="rounded-lg bg-status-warning-bg p-3 text-xs text-navy">Similar existing names: {similar.map(w=>`${w.name} (${w.position})`).join(', ')}. Check whether this is the same person before creating another profile.</p>}
        <label className="block text-xs font-semibold text-ink-secondary">Pay rate type<select value={rateType} onChange={e=>setRateType(e.target.value as 'daily'|'hourly')} className="mt-1 block min-h-11 w-full rounded-lg border border-surface-border bg-white px-3 text-sm sm:min-h-9"><option value="daily">Daily</option><option value="hourly">Hourly</option></select></label>
        <Button type="submit" size="sm" isLoading={pending} disabled={pending}>Register and add to project</Button>
      </form>}
    </div>}
    {loading ? <p role="status" className="text-xs text-ink-secondary">Loading project team…</p> : ids && <div className="space-y-2">
      {current.length === 0 ? <p className="rounded-xl border border-surface-border bg-white p-5 text-xs text-ink-secondary">No workers have been assigned to this project yet.</p> :
        Array.from(current.reduce((groups, worker) => {
          const category = 'position' in worker && worker.position?.trim() ? worker.position.trim() : 'Uncategorized';
          const members = groups.get(category) || [];
          members.push(worker);
          groups.set(category, members);
          return groups;
        }, new Map<string, typeof current>()), ([category, members]) => ({ category, members }))
          .sort((a, b) => a.category.localeCompare(b.category))
          .map(({ category, members }) => <details key={category} open className="rounded-xl border border-surface-border bg-white">
            <summary className="cursor-pointer p-3 text-sm font-semibold text-navy">{category} <span className="text-xs font-normal text-ink-secondary">({members.length})</span></summary>
            <div className="divide-y divide-surface-border border-t border-surface-border">{members.map((worker) => <div key={worker.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="min-w-0"><div className="break-words text-sm font-semibold text-navy">{worker.name}</div>{'position' in worker && !worker.active && <div className="text-xs text-ink-secondary">Inactive</div>}</div>
              <Button type="button" size="sm" variant="ghost" disabled={pending || needsCheck} onClick={() => setRemove(worker)} aria-label={`Remove ${worker.name} from project`}>Remove from project</Button>
            </div>)}</div>
          </details>)}
    </div>}
    <ConfirmDialog isOpen={Boolean(remove)} title="Remove worker from this project?" message={`${remove?.name || 'This worker'} will leave this project list. Their profile, attendance, payroll and Bale records will not be deleted.`} destructive confirmLabel="Remove from project" isPending={pending} onCancel={()=>setRemove(null)} onConfirm={()=>{if(remove) void change({action:'remove',workerId:remove.id}).then(ok=>{if(ok)setMessage(`${remove.name} removed from this project.`);setRemove(null);});}} />
  </section>;
}
