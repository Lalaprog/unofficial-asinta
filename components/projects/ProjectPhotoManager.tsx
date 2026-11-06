'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { checkProjectPhoto } from '@/lib/projects/photos';

type PhotoInfo = {hasPhoto:boolean; version:string | null};

export function ProjectPhotoManager({projectId}: {projectId:string}) {
  const [expanded, setExpanded] = useState(false);
  const [info, setInfo] = useState<PhotoInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const lock = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/photo`;
  const load = useCallback(async () => {
    setInfo(null); setError(null);
    try {
      const response = await fetch(`${endpoint}?info=1`, {cache:'no-store'});
      const data = await response.json().catch(()=>null);
      if (!response.ok || typeof data?.hasPhoto !== 'boolean' || (data.hasPhoto && typeof data.version !== 'string')) throw new Error();
      setInfo({hasPhoto:data.hasPhoto,version:data.version ?? null});
    } catch {setError('Could not check the project photo. Try again.');}
  }, [endpoint]);
  useEffect(()=>{void load();}, [load]);
  useEffect(()=>{
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file); setPreview(url);
    return ()=>URL.revokeObjectURL(url);
  },[file]);
  useEffect(()=>setImageFailed(false), [preview, info?.version]);
  const selectFile = (value:File | null) => {
    setMessage(null); const validation=checkProjectPhoto(value);
    if (validation) {setFile(null);setError(validation);return;}
    setError(null);setFile(value);
  };
  const submit = async (remove = false) => {
    if (!info || lock.current || (!remove && !file)) return;
    lock.current = true; setPending(true);setError(null);setMessage(null);
    try {
      let response:Response;
      if (remove) response=await fetch(endpoint,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:info.version})});
      else {const body=new FormData();body.set('version',info.version || '');body.set('photo',file!);response=await fetch(endpoint,{method:'PUT',body});}
      const data=await response.json().catch(()=>null);
      if (!response.ok) {setConfirmRemove(false);setInfo(null);setError(data?.error || 'Change was not confirmed. Check the current photo before trying again.');return;}
      setInfo({hasPhoto:data.hasPhoto,version:data.version ?? null});setFile(null);if(inputRef.current) inputRef.current.value='';setConfirmRemove(false);
      setMessage(remove?'Photo removed. Project cards will use the original blueprint.':'Photo saved. Project cards will show it the next time they open.');
    } catch {setConfirmRemove(false);setInfo(null);setError('Change was not confirmed. Check the current photo before trying again.');}
    finally {lock.current=false;setPending(false);}
  };
  return <Card>
    <CardHeader className={expanded ? undefined : 'pb-0'}><div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><ImagePlus className="h-5 w-5 text-navy"/><CardTitle>Project card photo</CardTitle></div><Button type="button" size="sm" variant="secondary" aria-expanded={expanded} aria-controls={`photo-manager-${projectId}`} onClick={()=>setExpanded(!expanded)}>{expanded ? 'Close photo editor' : 'Manage photo'}</Button></div><CardDescription>Optional. Only people who can access this project can view its photo. Without one, the original blueprint appears.</CardDescription></CardHeader>
    <CardContent id={`photo-manager-${projectId}`} hidden={!expanded} className="space-y-3 text-xs">
      {error && <p role="alert" className="text-status-danger">{error}</p>}
      {message && <p role="status" className="text-status-success">{message}</p>}
      {!info ? <Button type="button" size="sm" variant="secondary" onClick={()=>void load()} disabled={pending}>Check current photo</Button> : <>
        <div className="relative h-36 overflow-hidden rounded-xl bg-[#0b1f3a] bg-cover bg-center" style={{backgroundImage:"url('/brand/project-blueprint.webp')"}}>
          {!imageFailed && (preview || info.hasPhoto) && <img onError={()=>setImageFailed(true)} key={preview || info.version || ''} src={preview || `${endpoint}?v=${info.version}`} alt={preview ? 'Selected project photo preview' : 'Current project photo'} className="h-full w-full object-cover" />}
        </div>
        {imageFailed && <p role="alert" className="text-status-danger">The photo could not be displayed. Try checking it again.</p>}
        <p className="text-ink-secondary">{file ? 'Preview of the selected photo. Save to apply it.' : info.hasPhoto ? 'A project photo is currently set.' : 'Using the original blueprint.'}</p>
        <label className="block font-semibold text-ink-secondary" htmlFor={`project-photo-${projectId}`}>Choose a photo</label>
        <input id={`project-photo-${projectId}`} ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" disabled={pending} onChange={event=>selectFile(event.target.files?.[0] ?? null)} className="block w-full text-xs text-ink-secondary file:mr-3 file:min-h-11 file:rounded-lg file:border file:border-surface-border file:bg-white file:px-3 file:font-semibold file:text-navy sm:file:min-h-10" />
        <p className="text-ink-secondary">JPEG, PNG or WebP, up to 3 MB. Cards crop photos and add a dark overlay to keep the name readable.</p>
        <div className="flex flex-wrap gap-2"><Button type="button" size="sm" onClick={()=>void submit()} disabled={!file || pending} isLoading={pending}>Save photo</Button>{file && <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={()=>{setFile(null);if(inputRef.current) inputRef.current.value='';}}>Discard selection</Button>}{info.hasPhoto && <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={()=>setConfirmRemove(true)}>Remove photo</Button>}</div>
      </>}
    </CardContent>
    <ConfirmDialog isOpen={confirmRemove} title="Remove project photo?" message="The original blueprint will appear on the project card instead." destructive confirmLabel="Remove photo" isPending={pending} onCancel={()=>setConfirmRemove(false)} onConfirm={()=>void submit(true)} />
  </Card>;
}
