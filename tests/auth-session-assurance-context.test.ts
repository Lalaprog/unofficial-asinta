// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  callback:null as null | ((event:string,session:any)=>void),
  decision:false as boolean, pending:null as null | Promise<{data:boolean,error:null}>,
  session:{user:{id:'user-1'}},
  pendingProfile:null as null | Promise<{data:any,error:null}>,
}));
vi.mock('@/lib/supabase/client', () => ({createClient:() => ({
  auth:{
    getSession:async()=>({data:{session:mock.session},error:null}),
    onAuthStateChange:(cb:any)=>{mock.callback=cb;return {data:{subscription:{unsubscribe:vi.fn()}}}},
    signOut:async()=>{mock.callback?.('SIGNED_OUT',null);return {error:null}},
  },
  from:()=>({select:()=>({eq:(_key:string,id:string)=>({maybeSingle:async()=>{ const pending=mock.pendingProfile; mock.pendingProfile=null; return pending ?? {data:{id,name:'User',email:'user@example.test',role:'founder'},error:null}; }})})}),
  rpc:async()=>{const pending=mock.pending;mock.pending=null;return pending ?? {data:mock.decision,error:null}},
})}));
import { AuthProvider, useAuth } from '@/lib/auth/authContext';
let auth:ReturnType<typeof useAuth>;
function Probe(){auth=useAuth();return null;}
beforeEach(()=>{mock.callback=null;mock.decision=false;mock.pending=null;mock.pendingProfile=null;mock.session={user:{id:'user-1'}};});
afterEach(()=>cleanup());

describe('auth context assurance lifecycle',()=>{
  it('moves from challenge required to ready after verification, then clears on sign out',async()=>{
    render(React.createElement(AuthProvider,null,React.createElement(Probe)));
    await waitFor(()=>expect(auth.user?.id).toBe('user-1'));
    await waitFor(()=>expect(auth.assurance).toBe('required'));
    mock.decision=true;
    act(()=>mock.callback?.('MFA_CHALLENGE_VERIFIED',mock.session));
    await waitFor(()=>expect(auth.assurance).toBe('ready'));
    await act(async()=>{await auth.logout()});
    expect(auth.user).toBeNull(); expect(auth.assurance).toBe('signed_out');
  });
  it('clears the old account while a different account profile resolves',async()=>{
    mock.decision=true;
    render(React.createElement(AuthProvider,null,React.createElement(Probe)));
    await waitFor(()=>expect(auth.user?.id).toBe('user-1'));
    await waitFor(()=>expect(auth.assurance).toBe('ready'));
    let resolve!:(v:{data:any,error:null})=>void;
    mock.pendingProfile=new Promise(r=>{resolve=r});
    act(()=>mock.callback?.('SIGNED_IN',{user:{id:'user-2'}}));
    expect(auth.user).toBeNull();
    await waitFor(()=>expect(auth.assurance).toBe('ready'));
    expect(auth.user).toBeNull();
    await act(async()=>resolve({data:{id:'user-2',name:'User 2',email:'two@example.test',role:'supervisor'},error:null}));
    expect(auth.user?.id).toBe('user-2');
  });
  it('discards a late successful verification after sign-out',async()=>{
    render(React.createElement(AuthProvider,null,React.createElement(Probe)));
    await waitFor(()=>expect(auth.assurance).toBe('required'));
    let resolve!:(v:{data:boolean,error:null})=>void;
    mock.pending=new Promise(r=>{resolve=r});
    let result:Promise<unknown>;
    act(()=>{result=auth.refreshAssurance()});
    expect(auth.assurance).toBe('checking');
    act(()=>mock.callback?.('SIGNED_OUT',null));
    await act(async()=>{resolve({data:true,error:null});await result!});
    expect(auth.assurance).toBe('signed_out'); expect(auth.user).toBeNull();
  });
});
