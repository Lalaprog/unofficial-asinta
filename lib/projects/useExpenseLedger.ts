'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {createClient} from '@/lib/supabase/client';
import {parseExpensePage,type ProjectExpenseRow} from './expenseLedger';
type State={key:string;items:ProjectExpenseRow[];hasMore:boolean;loading:boolean;error:boolean};
export function useExpenseLedger(userId:string|undefined,isFounder:boolean,projectId:string,enabled:boolean) {
 const [revision,setRevision]=useState(0);
 const key=JSON.stringify([userId,isFounder,projectId,enabled,revision]);
 const current=useRef(key);current.current=key;
 const request=useRef(0),busy=useRef(false);
 const [state,setState]=useState<State>({key:'',items:[],hasMore:false,loading:false,error:false});
 const load=useCallback(async(cursor?:ProjectExpenseRow)=>{
  if(!enabled || !userId || !isFounder || !projectId || busy.current) return;
  const token=++request.current; busy.current=true;
  setState(prev=>({key,items:cursor && prev.key===key?prev.items:[],hasMore:cursor && prev.key===key?prev.hasMore:false,loading:true,error:false}));
  try{
   const {data,error}=await createClient().rpc('project_expense_page',{p_project_id:projectId,p_cursor_date:cursor?.expense_date??null,p_cursor_id:cursor?.id??null,p_limit:25});
   if(error) throw error;
   const page=parseExpensePage(data,projectId,cursor);
   if(current.current!==key || token!==request.current) return;
   setState(prev=>({key,items:[...(cursor && prev.key===key?prev.items:[]),...page.items],hasMore:page.hasMore,loading:false,error:false}));
  }catch{if(current.current===key && token===request.current) setState(prev=>({key,items:cursor && prev.key===key?prev.items:[],hasMore:cursor && prev.key===key?prev.hasMore:false,loading:false,error:true}));}
  finally{if(current.current===key && token===request.current) busy.current=false;}
 },[enabled,userId,isFounder,projectId,key]);
 useEffect(()=>{busy.current=false; if(enabled && userId && isFounder && projectId) void load(); return ()=>{request.current+=1;busy.current=false};},[enabled,userId,isFounder,projectId,load]);
 const view=state.key===key?state:{key,items:[],hasMore:false,loading:enabled && Boolean(userId) && isFounder,error:false};
 return {...view,loadMore:()=>{const last=view.items.at(-1);if(view.hasMore && !view.loading && last) void load(last);},reload:()=>setRevision(n=>n+1)};
}
