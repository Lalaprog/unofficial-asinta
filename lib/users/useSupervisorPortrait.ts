'use client';

import {useEffect, useState} from 'react';
import {createClient} from '@/lib/supabase/client';
import {parseSupervisorPortrait, supervisorPortraitPreviewEnabled} from './supervisorPortrait';

/** Only keep an assured account's own image in memory; never a public URL. */
export function useSupervisorPortrait(id: string | undefined, enabled: boolean): string | null {
  const [result,setResult]=useState<{id:string;src:string | null} | null>(null);
  const allowed=supervisorPortraitPreviewEnabled() && enabled && Boolean(id);
  useEffect(()=>{
    if(!allowed || !id) {setResult(null);return;}
    let active=true;
    setResult(null);
    void (async()=>{
      try {
        const {data,error}=await createClient().rpc('supervisor_profile_photo',{p_supervisor:id});
        if(error) throw error;
        const photo=parseSupervisorPortrait(data,id);
        if(active)setResult({id,src:photo.has_photo ? `data:${photo.mime};base64,${photo.data}` : null});
      } catch {if(active)setResult({id,src:null});}
    })();
    return ()=>{active=false;};
  },[id,allowed]);
  // Synchronous scope check prevents one frame of a previous account's photo
  // during a role/account/assurance change, before the effect cleanup runs.
  return allowed && result && result.id===id ? result.src : null;
}
