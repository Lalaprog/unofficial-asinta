'use client';

import { useEffect } from 'react';
import { useAuth } from '@/lib/auth/authContext';

/** Only an open, visible Founder session asks the server to check reminders. */
export function ReminderListener() {
  const {user,isFounder,assurance}=useAuth();
  useEffect(()=>{
    // This build-time rollout gate is deliberately separate from the persistent
    // master switch. It stays off until the staged backend is reviewed.
    if(process.env.NEXT_PUBLIC_REMINDER_LISTENER_ENABLED!=='true' || !user || !isFounder || assurance!=='ready')return;
    let stopped=false,active=false;
    let controller:AbortController|undefined;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const check=async()=>{
      if(stopped || active || document.visibilityState!=='visible' || !navigator.onLine)return;
      active=true;
      controller=new AbortController();
      const timeout=setTimeout(()=>controller?.abort(),45_000);
      try {
        await fetch('/api/reminders/listen',{method:'POST',headers:{'Content-Type':'application/json','X-BALE-Reminder-Listener':'1'},body:'{}',cache:'no-store',signal:controller.signal});
      } catch { /* Next visible/online check will retry; never infer delivery. */ }
      finally {
        clearTimeout(timeout);
        controller=undefined;
        active=false;
        if(!stopped)timer=setTimeout(check,60_000);
      }
    };
    const wake=()=>{if(document.visibilityState==='visible' && navigator.onLine){if(timer)clearTimeout(timer);void check();}};
    void check();
    document.addEventListener('visibilitychange',wake);
    window.addEventListener('online',wake);
    return ()=>{stopped=true;controller?.abort();if(timer)clearTimeout(timer);document.removeEventListener('visibilitychange',wake);window.removeEventListener('online',wake);};
  },[user,isFounder,assurance]);
  return null;
}
