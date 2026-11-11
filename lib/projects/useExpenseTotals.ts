'use client';
import {useEffect,useRef,useState} from 'react';
import {createClient} from '@/lib/supabase/client';
import {parseExpenseTotals,type ProjectExpenseTotal} from './expenseLedger';
type TotalsState={key:string;status:'idle'|'loading'|'ready'|'error';totals:Map<string,ProjectExpenseTotal>};
export function useExpenseTotals(userId:string|undefined,isFounder:boolean,ids:string[]) {
 const idsKey=JSON.stringify([...new Set(ids)].sort());
 const [revision,setRevision]=useState(0);
 const key=JSON.stringify([userId,isFounder,idsKey,revision]);
 const current=useRef(key);current.current=key;
 const [state,setState]=useState<TotalsState>({key:'',status:'idle',totals:new Map()});
 useEffect(()=>{
  if(!userId || !isFounder) return;
  let live=true;setState({key,status:'loading',totals:new Map()});
  void (async()=>{try{
   const projectIds=JSON.parse(idsKey) as string[];
   const {data,error}=await createClient().rpc('project_expense_totals',{p_project_ids:projectIds});
   if(error) throw error;
   const totals=parseExpenseTotals(data,projectIds);
   if(live && current.current===key) setState({key,status:'ready',totals});
  }catch {if(live && current.current===key) setState({key,status:'error',totals:new Map()});}})();
  return ()=>{live=false};
 },[key,idsKey,userId,isFounder,revision]);
 const visible:TotalsState=!userId || !isFounder ? {key,status:'idle',totals:new Map()} : state.key===key ? state : {key,status:'loading',totals:new Map()};
 return {...visible,refresh:()=>setRevision(n=>n+1)};
}
