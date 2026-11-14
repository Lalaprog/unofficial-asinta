'use client';
import {useEffect,useState} from 'react';
import {createClient} from '@/lib/supabase/client';
import {categoryWorkforceEnabled,parseCategoryCatalog,type WorkerCategory} from './categoryCatalog';

export const CATEGORY_CHANGED='asinta:worker-category-changed';
export function useActiveCategories(userId:string|undefined,assurance:string){
 const enabled=categoryWorkforceEnabled(),eligible=enabled&&Boolean(userId)&&assurance==='ready';
 const [version,setVersion]=useState(0),[state,setState]=useState<{key:string;items:WorkerCategory[]|null;error:boolean}>({key:'',items:null,error:false});
 const key=JSON.stringify([eligible,userId,assurance,version]);
 useEffect(()=>{const changed=()=>setVersion(v=>v+1);window.addEventListener(CATEGORY_CHANGED,changed);return()=>window.removeEventListener(CATEGORY_CHANGED,changed);},[]);
 useEffect(()=>{let live=true;if(!eligible)return()=>{live=false;};
  void(async()=>{try{const {data,error}=await createClient().rpc('active_worker_categories');if(error)throw error;const items=parseCategoryCatalog(data);if(items.some(c=>c.archived)||new Set(items.map(c=>c.label.toLowerCase())).size!==items.length)throw Error('Invalid active catalog');if(live)setState({key,items,error:false});}catch{if(live)setState({key,items:null,error:true});}})();return()=>{live=false;};
 },[eligible,key]);
 const current=state.key===key?state:{items:null,error:false};
 return {enabled,items:current.items,error:current.error,loading:eligible&&!current.items&&!current.error,retry:()=>setVersion(v=>v+1)};
}
