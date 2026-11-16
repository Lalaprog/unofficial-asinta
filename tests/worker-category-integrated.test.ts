// @vitest-environment jsdom
import React from 'react';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
import {WorkerCategoryManager} from '@/components/workforce/WorkerCategoryManager';
const founder='00000000-0000-0000-0000-000000000001';
afterEach(()=>{cleanup();sessionStorage.clear();mock.rpc.mockReset();});
describe('category manager against synthetic SQL',()=>{
 it('adds, renames, archives and reads history without touching workers or payroll',async()=>{
  const db=new PGlite();try{
   await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
    CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.assurance',true)='yes'$$;
    CREATE TABLE public.users(id uuid primary key,role text);CREATE TABLE public.workers(id uuid primary key,position text);CREATE TABLE public.payroll(id uuid primary key,status text);
    CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder')$$;
    INSERT INTO public.users VALUES('${founder}','founder');INSERT INTO public.workers VALUES('00000000-0000-0000-0000-000000000002','Legacy Mason');INSERT INTO public.payroll VALUES('00000000-0000-0000-0000-000000000003','paid');
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated;`);
   await db.exec(readFileSync('supabase/drafts/worker_category_catalog.sql','utf8'));
   await db.exec(`SET test.assurance='yes';SET test.uid='${founder}';SET ROLE authenticated`);
   mock.rpc.mockImplementation(async(name:string,p:Record<string,unknown>={})=>{
    try{
     let query:string,params:unknown[];
     if(name==='worker_category_catalog'){query='SELECT public.worker_category_catalog() data';params=[];}
     else if(name==='change_worker_category'){query='SELECT public.change_worker_category($1,$2,$3,$4,$5) data';params=[p.p_request_id,p.p_category_id,p.p_action,p.p_label,p.p_expected_revision];}
     else if(name==='worker_category_history'){query='SELECT public.worker_category_history($1,$2,$3) data';params=[p.p_category_id,p.p_before_at,p.p_before_id];}
     else throw new Error('Unknown RPC');
     const result=await db.query<{data:unknown}>(query,params);return {data:result.rows[0].data,error:null};
    }catch(error){return {data:null,error};}
   });
   render(React.createElement(WorkerCategoryManager,{userId:founder}));fireEvent.click(screen.getByRole('button',{name:/Worker category catalog/}));
   fireEvent.click(screen.getByRole('button',{name:'Load catalog'}));await screen.findByText('No categories are recorded in this catalog.');
   fireEvent.change(screen.getByLabelText('New category'),{target:{value:'Mason'}});fireEvent.click(screen.getByRole('button',{name:'Add category'}));await screen.findByText(/Change recorded/);
   fireEvent.click(screen.getByRole('button',{name:'Load catalog'}));await screen.findByText('Mason');fireEvent.click(screen.getByRole('button',{name:'Rename Mason'}));
   fireEvent.change(screen.getByLabelText('Rename Mason'),{target:{value:'Senior Mason'}});fireEvent.click(screen.getByRole('button',{name:'Save name'}));await screen.findByText(/Change recorded/);
   fireEvent.click(screen.getByRole('button',{name:'Load catalog'}));await screen.findByText('Senior Mason');fireEvent.click(screen.getByRole('button',{name:'Archive Senior Mason'}));fireEvent.click(screen.getByRole('button',{name:'Confirm archive'}));await screen.findByText(/Change recorded/);
   fireEvent.click(screen.getByRole('button',{name:'Load catalog'}));await screen.findByText('Senior Mason · archived');fireEvent.click(screen.getByRole('button',{name:'Category change history'}));fireEvent.click(screen.getByRole('button',{name:'Load history'}));await screen.findByText(/rename · Mason → Senior Mason/);
   await db.exec('RESET ROLE');expect((await db.query('SELECT position FROM public.workers')).rows).toEqual([{position:'Legacy Mason'}]);expect((await db.query('SELECT status FROM public.payroll')).rows).toEqual([{status:'paid'}]);expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.worker_category_events')).rows[0].n).toBe(3);
  }finally{await db.close();}
 },30000);
});
