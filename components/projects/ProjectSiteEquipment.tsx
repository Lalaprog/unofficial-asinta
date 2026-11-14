'use client';
import React,{useEffect,useState} from 'react';
import {Wrench} from 'lucide-react';
import {Badge} from '@/components/ui/Badge';
import {Button} from '@/components/ui/Button';
import {createClient} from '@/lib/supabase/client';
import {parseProjectEquipment,type ProjectEquipmentItem} from '@/lib/tools/projectEquipment';

type State={key:string;status:'loading'|'ready'|'error';items:ProjectEquipmentItem[]};
/** A site-scoped live snapshot; never merges in an incomplete legacy cache. */
export function ProjectSiteEquipment({projectId,userId,isFounder,isSupervisor,assurance}:{projectId:string;userId:string|undefined;isFounder:boolean;isSupervisor:boolean;assurance:string}){
 const [revision,setRevision]=useState(0);const key=JSON.stringify([projectId,userId,isFounder,isSupervisor,assurance,revision]);
 const [state,setState]=useState<State>({key:'',status:'loading',items:[]});
 const eligible=!!projectId&&!!userId&&(isFounder||isSupervisor)&&assurance==='ready';
 useEffect(()=>{
  if(!eligible)return;
  let active=true;setState({key,status:'loading',items:[]});
  void (async()=>{try{const {data,error}=await createClient().rpc('project_equipment_snapshot',{p_project:projectId});if(error)throw error;const parsed=parseProjectEquipment(data,projectId);if(active)setState({key,status:'ready',items:parsed.items});}catch{if(active)setState({key,status:'error',items:[]});}})();
  return()=>{active=false;};
 },[eligible,key,projectId]);
 if(!eligible)return <p role="status" className="text-xs text-ink-secondary">Project equipment is unavailable until your authorized session is ready.</p>;
 const current=state.key===key?state:{key,status:'loading' as const,items:[]};
 return <div className="space-y-3"><p className="text-xs text-ink-secondary">Recorded quantities at this site only. Legacy entries reflect the old single-site record; allocations reflect the new stock system. Neither confirms physical location or condition. Refresh after changes.</p>
  <Button type="button" size="sm" variant="secondary" disabled={current.status==='loading'} onClick={()=>setRevision(v=>v+1)}>Refresh site equipment</Button>
  {current.status==='loading'&&<p role="status" className="text-xs text-ink-secondary">Loading site equipment…</p>}
  {current.status==='error'&&<p role="alert" className="text-xs text-status-danger">Could not verify site equipment. No empty result is assumed; refresh to try again.</p>}
  {current.status==='ready'&&(current.items.length?<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{current.items.map(item=><div key={item.id} className="space-y-2 rounded-xl border border-surface-border bg-white p-4"><div className="flex items-center justify-between"><div className="flex h-8 w-8 items-center justify-center rounded-xl bg-surface-inset text-navy"><Wrench className="h-4 w-4"/></div><Badge variant={item.condition==='excellent'?'success':'warning'} size="sm">{item.condition.replace('_',' ')}</Badge></div><p className="break-words text-xs font-bold text-navy">{item.name}</p><p className="text-xs text-ink-secondary">Quantity at this site: {item.quantity} · {item.source==='legacy'?'legacy record':'allocated stock'}</p></div>)}</div>:<p className="rounded-xl border border-surface-border bg-white p-4 text-xs text-ink-secondary">No equipment records returned for this site. This is not proof that the site has no equipment.</p>)}
 </div>;
}
