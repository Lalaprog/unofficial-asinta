'use client';
import React,{useEffect,useState} from 'react';
import {Button} from '@/components/ui/Button';
import {createClient} from '@/lib/supabase/client';
import {formatPeso} from '@/lib/email/format';
import {parseConfirmedRentals,type ConfirmedRental} from '@/lib/projects/confirmedRentals';
type State={key:string;status:'loading'|'ready'|'error';items:ConfirmedRental[]};
/** Read-only draft: the separate confirmation UI is not implemented yet. */
export function ConfirmedRentals({projectId,userId}:{projectId:string;userId:string}){
 const [revision,setRevision]=useState(0);const key=JSON.stringify([projectId,userId,revision]);const [state,setState]=useState<State>({key:'',status:'loading',items:[]});
 useEffect(()=>{let active=true;setState({key,status:'loading',items:[]});void(async()=>{try{const {data,error}=await createClient().rpc('project_confirmed_rentals',{p_project:projectId});if(error)throw error;const items=parseConfirmedRentals(data,projectId);if(active)setState({key,status:'ready',items});}catch{if(active)setState({key,status:'error',items:[]});}})();return()=>{active=false;};},[key,projectId]);
 const current=state.key===key?state:{key,status:'loading' as const,items:[]};
 return <section className="rounded-xl border border-surface-border bg-white p-4 text-xs text-ink-secondary space-y-3"><h4 className="text-sm font-bold text-navy">Experimental confirmed rentals</h4><p>These are linked to existing expense entries, not additional costs. Review for duplicate expenses separately. This list is read-only and does not prove payment.</p>
  <Button type="button" variant="secondary" size="sm" disabled={current.status==='loading'} onClick={()=>setRevision(x=>x+1)}>Refresh rentals</Button>
  {current.status==='loading'&&<p role="status">Loading rentals…</p>}{current.status==='error'&&<p role="alert">Could not verify rentals. No empty result is assumed; refresh or ask an operator.</p>}
  {current.status==='ready'&&(current.items.length?<ul className="divide-y divide-surface-border">{current.items.map(r=><li key={r.id} className="py-3"><p className="font-semibold text-navy break-words">{r.item} · {r.quantity} · {r.supplier}</p><p>{r.start} to {r.end} · linked expense {formatPeso(r.expenseAmount)} on {r.expenseDate}</p><p className="break-words">Expense: {r.description}</p></li>)}</ul>:<p>No confirmed rental links returned. This does not establish that the project has no rentals.</p>)}
 </section>;
}
