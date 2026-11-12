'use client';
import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/Button';
import {Input} from '@/components/ui/Input';
import {Select} from '@/components/ui/Select';
import {Modal} from '@/components/ui/Modal';
import {createClient} from '@/lib/supabase/client';
import {parseToolQuantity} from '@/lib/tools/validation';
import {equipmentAttempt,parseEquipmentAttempt,parseEquipmentSnapshot,verifyEquipmentResult,verifyEquipmentStatus,type EquipmentAttempt,type EquipmentItem,type EquipmentProject,type EquipmentSnapshot} from '@/lib/tools/ownedEquipment';

export function OwnedEquipmentManager({userId}:{userId:string}){
 const [open,setOpen]=useState(false);
 return <section className="rounded-2xl border border-surface-border bg-white p-4"><button type="button" aria-expanded={open} onClick={()=>setOpen(v=>!v)} className="min-h-11 w-full text-left text-sm font-semibold text-navy">Owned equipment allocation workspace {open?'▴':'▾'}</button>{open&&<Contents key={userId} userId={userId}/>}</section>;
}
function Contents({userId}:{userId:string}){
 const storageKey=`owned-equipment-attempt:${userId}`;
 const [snapshot,setSnapshot]=useState<EquipmentSnapshot|null>(null),[pending,setPending]=useState<EquipmentAttempt|null>(null),[storageReady,setStorageReady]=useState(false),[storageError,setStorageError]=useState(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[confirm,setConfirm]=useState<{attempt:EquipmentAttempt;item:EquipmentItem;projectName:string|null}|null>(null),[discard,setDiscard]=useState(false);
 const lock=useRef(false),alive=useRef(true);
 useEffect(()=>{alive.current=true;try{const raw=sessionStorage.getItem(storageKey);if(raw)setPending(parseEquipmentAttempt(JSON.parse(raw)));}catch{setStorageError(true);}setStorageReady(true);return()=>{alive.current=false;};},[storageKey]);
 async function load(){
  if(lock.current||!storageReady)return;lock.current=true;setBusy(true);setError('');setSnapshot(null);
  try{const {data,error}=await createClient().rpc('owned_equipment_snapshot');if(error)throw error;const result=parseEquipmentSnapshot(data);if(alive.current)setSnapshot(result);}
  catch{if(alive.current)setError('Could not verify equipment and project data. Refresh before making changes.');}
  finally{lock.current=false;if(alive.current)setBusy(false);}
 }
 async function finish(attempt:EquipmentAttempt,result:unknown){
  const verified=verifyEquipmentResult(result,attempt);
  sessionStorage.removeItem(storageKey);
  if(alive.current){setPending(null);setConfirm(null);setSnapshot(null);setMessage(verified.replayed?'The original operation was confirmed. Reload inventory to see its current state.':'Operation recorded. Reload inventory to see its current state.');}
 }
 async function send(attempt:EquipmentAttempt){
  if(lock.current||storageError)return;lock.current=true;setBusy(true);setError('');setMessage('');let stored=false;
  try{
   sessionStorage.setItem(storageKey,JSON.stringify(attempt));stored=true;if(alive.current){setPending(attempt);setConfirm(null);}
   const {data,error}=await createClient().rpc('change_owned_equipment',{p_id:attempt.id,p_tool:attempt.tool,p_action:attempt.action,p_project:attempt.project,p_quantity:attempt.quantity,p_expected_stock:attempt.expectedStock,p_expected_site:attempt.expectedSite});
   if(error)throw error;await finish(attempt,data);
  }catch{if(alive.current)setError(stored?'Operation not confirmed. It may already have been recorded; check or retry the same ID before creating another.':'Could not save the retry record; no request was sent this time. Check any previous operation before retrying.');}
  finally{lock.current=false;if(alive.current)setBusy(false);}
 }
 async function checkPending(){
  if(!pending||lock.current)return;lock.current=true;setBusy(true);setError('');setMessage('');
  try{const {data,error}=await createClient().rpc('owned_equipment_operation_status',{p_id:pending.id});if(error)throw error;
   const status=verifyEquipmentStatus(data,pending);
   if(!status.found){if(alive.current)setMessage('No completed event was found yet. The request may still be processing; retry the same ID or check again later.');}
   else await finish(pending,status.result);
  }catch{if(alive.current)setError('Could not confirm the operation. Keep the retry record and check again.');}
  finally{lock.current=false;if(alive.current)setBusy(false);}
 }
 function stopRetry(){
  if(!discard||busy)return;
  try{sessionStorage.removeItem(storageKey);setPending(null);setStorageError(false);setSnapshot(null);setDiscard(false);setMessage('Retry stopped without undoing anything. Reload and independently inspect equipment before another operation.');setError('');}
  catch{setError('Could not clear the retry record. No new changes are available.');}
 }
 function prepare(item:EquipmentItem,project:string|null,quantity:number|null,projectName:string|null){
  if(lock.current||pending||storageError||!snapshot)return;
  try{const attempt=equipmentAttempt(item,project,quantity);setError('');setConfirm({attempt,item,projectName});}catch(e){setError(e instanceof Error?e.message:'Could not prepare this operation.');}
 }
 return <div className="space-y-4 border-t border-surface-border pt-4 text-xs">
  <p className="rounded-lg bg-status-warning-bg p-3 text-ink-secondary">Experimental Founder-only workspace. Confirm the physical location and ownership before adoption: an unassigned legacy record does not prove units are in the depot. Existing site-assigned records cannot yet be converted here. This does not track rentals or costs. Older screens and Supervisor views do not understand split stock; do not use until the complete rollout is reviewed.</p>
  {error&&<p role="alert" className="text-status-danger">{error}</p>}{message&&<p role="status">{message}</p>}
  {storageError&&<p role="alert">The saved retry record could not be read. New operations are blocked. Investigate any previous request before clearing it.</p>}
  {(pending||storageError)&&<div className="space-y-2 rounded-lg border border-status-warning/25 bg-status-warning-bg p-3"><p className="font-semibold text-navy">An operation may have been sent.</p>{pending&&<><p className="break-all">Request {pending.id} · tool {pending.tool} · {pending.action}{pending.project?` · project ${pending.project} · quantity ${pending.quantity}`:''}</p><div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={()=>void checkPending()}>Check operation</Button><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={()=>void send(pending)}>Retry same request</Button></div></>}
   <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={()=>setDiscard(v=>!v)}>Review stopping retry</Button>{discard&&<div className="space-y-2"><p>Stopping a retry does not undo a completed or still-running operation. Inspect inventory and investigate the request first. Browser storage is tab-specific and may be cleared or unavailable.</p><Button type="button" size="sm" variant="danger" disabled={busy} onClick={stopRetry}>I checked; stop retrying</Button></div>}
  </div>}
  <Button type="button" size="sm" variant="secondary" disabled={busy||!storageReady} onClick={()=>void load()}>{snapshot?'Refresh inventory':'Load inventory'}</Button>{busy&&<p role="status">Contacting server…</p>}
  {snapshot&&(snapshot.items.length?<ul className="space-y-3">{snapshot.items.map(item=><EquipmentRow key={item.id} item={item} projects={snapshot.projects} disabled={busy||!!pending||storageError} onPrepare={prepare}/>)}</ul>:<p>No equipment records found.</p>)}
  <Modal isOpen={!!confirm} onClose={()=>setConfirm(null)} title={confirm?.attempt.action==='adopt'?'Adopt owned equipment?':'Change site allocation?'} description="This records inventory locations, not a payment or rental." dismissOnBackdrop={!busy} dismissOnEscape={!busy} showCloseButton={!busy}>
   {confirm&&<div className="space-y-3 text-xs"><p className="font-semibold break-all">{confirm.item.name} · equipment ID {confirm.item.id} · total stock {confirm.item.stock}</p>{confirm.attempt.action==='adopt'?<p>Confirm these are owned units physically at the depot. The old record says unassigned; it does not verify their location. No site allocation is created.</p>:<p className="break-all">{confirm.projectName} · project ID {confirm.attempt.project}: {confirm.attempt.expectedSite} → {confirm.attempt.quantity} units. Setting zero returns those units to the depot remainder; physically move or verify them independently.</p>}<p>Other sessions may change stock or allocations. If the values are stale, refresh and review before trying again.</p><div className="flex flex-wrap justify-end gap-2"><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={()=>setConfirm(null)}>Cancel</Button><Button type="button" size="sm" disabled={busy} onClick={()=>void send(confirm.attempt)}>Confirm operation</Button></div></div>}
  </Modal>
 </div>;
}
function EquipmentRow({item,projects,disabled,onPrepare}:{item:EquipmentItem;projects:EquipmentProject[];disabled:boolean;onPrepare:(item:EquipmentItem,project:string|null,quantity:number|null,name:string|null)=>void}){
 const [project,setProject]=useState(''),[quantity,setQuantity]=useState('0');
 const allocated=item.sites.reduce((n,s)=>n+s.quantity,0);
 return <li className="space-y-2 rounded-xl border border-surface-border p-3"><p className="break-words font-semibold text-navy">{item.name} · {item.stock} owned unit(s) · {item.condition.replace('_',' ')}</p><p className="break-all text-ink-secondary">Equipment ID: {item.id}</p>
  {item.managed?<><p>Allocated to sites: {allocated} · Depot remainder: {item.stock-allocated}. Locations reflect recorded allocations, not a physical inventory count.</p>{item.sites.length>0&&<ul className="list-disc pl-4">{item.sites.map(s=><li key={s.project_id}>{s.name}: {s.quantity}</li>)}</ul>}
   <div className="grid gap-2 sm:grid-cols-2"><Select label={`Project for ${item.name}`} value={project} onChange={e=>{const id=e.target.value;setProject(id);setQuantity(String(item.sites.find(s=>s.project_id===id)?.quantity??0));}} disabled={disabled}><option value="">Choose a project</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name} · {p.id}</option>)}</Select><Input label={`Units at project for ${item.name}`} inputMode="numeric" value={quantity} onChange={e=>setQuantity(e.target.value)} disabled={disabled} hint="Enter the total at this project; 0 returns all to depot."/></div><Button type="button" size="sm" variant="secondary" disabled={disabled||!project} onClick={()=>onPrepare(item,project,parseToolQuantity(quantity),projects.find(p=>p.id===project)?.name??null)}>Review allocation</Button></>:item.legacy_project_id?<p className="font-semibold text-status-warning">Legacy site-assigned stock. No automatic conversion; reconcile the original location before using allocations.</p>:<><p>Legacy unassigned/depot record. No location or allocation has been verified.</p><Button type="button" size="sm" variant="secondary" disabled={disabled} onClick={()=>onPrepare(item,null,null,null)}>Review adoption</Button></>}
 </li>;
}
