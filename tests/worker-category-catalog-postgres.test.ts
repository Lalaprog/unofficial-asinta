// Opt-in only: writes fixture data in an empty local disposable database.
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
const url=process.env.WORKER_CATEGORY_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const founder=id(1),category=id(2),request=id(3);
let admin:Client,first:Client,second:Client;
const change=(c:Client,req:string,cat:string,action:string,label:string|null,rev:number|null)=>c.query('SELECT public.change_worker_category($1,$2,$3,$4,$5) data',[req,cat,action,label,rev]);
const pause=()=>new Promise(resolve=>setTimeout(resolve,150));
suite('category catalog concurrency on disposable PostgreSQL',()=>{
 beforeAll(async()=>{
  const parsed=new URL(url!);
  if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||parsed.pathname!=='/asinta_test_worker_categories'||parsed.search||parsed.hash)throw new Error('Use the empty local asinta_test_worker_categories database without URL options');
  admin=new Client({connectionString:url});first=new Client({connectionString:url});second=new Client({connectionString:url});
  await Promise.all([admin.connect(),first.connect(),second.connect()]);
  const existing=await admin.query("SELECT (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')) AS objects,(SELECT count(*)::int FROM pg_namespace WHERE nspname='auth') AS schemas");
  if(existing.rows[0].objects || existing.rows[0].schemas)throw new Error('Test database must be empty');
  await admin.query(`DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;END$$;
   CREATE SCHEMA auth;CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
   CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.assurance',true)='yes'$$;
   CREATE TABLE public.users(id uuid primary key,role text);
   CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder')$$;
   INSERT INTO public.users VALUES('${founder}','founder');GRANT USAGE ON SCHEMA public,auth TO authenticated,anon;`);
  await admin.query(readFileSync('supabase/drafts/worker_category_catalog.sql','utf8'));
  await Promise.all([first.query(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'; SET lock_timeout='5s'`),second.query(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'; SET lock_timeout='5s'`)]);
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),first?.end(),second?.end()]);});
 it('serializes simultaneous retries into one event',async()=>{
  await first.query('BEGIN');await second.query('BEGIN');
  try {
   expect((await change(first,request,category,'add','Mason',null)).rows[0].data.replayed).toBe(false);
   let settled=false;const pending=change(second,request,category,'add','Mason',null).finally(()=>{settled=true;});
   await pause();expect(settled).toBe(false);await first.query('COMMIT');expect((await pending).rows[0].data.replayed).toBe(true);await second.query('COMMIT');
   expect((await admin.query('SELECT count(*)::int n FROM public.worker_category_events')).rows[0].n).toBe(1);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('rejects a stale concurrent rename rather than overwriting another change',async()=>{
  await first.query('BEGIN');await second.query('BEGIN');
  try {
   await change(first,id(4),category,'rename','Lead Mason',1);
   let settled=false;const pending=change(second,id(5),category,'rename','Senior Mason',1).then(()=>({code:'success'}),(err:{code:string})=>({code:err.code})).finally(()=>{settled=true;});
   await pause();expect(settled).toBe(false);await first.query('COMMIT');expect((await pending).code).toBe('40001');await second.query('ROLLBACK');
   expect((await admin.query('SELECT label,revision FROM public.worker_categories')).rows[0]).toEqual({label:'Lead Mason',revision:2});
   expect((await admin.query('SELECT count(*)::int n FROM public.worker_category_events')).rows[0].n).toBe(2);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('fails closed under repeatable read',async()=>{
  await first.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try{await expect(change(first,id(6),category,'archive',null,2)).rejects.toMatchObject({code:'P1002'});}finally{await first.query('ROLLBACK');}
 });
});
