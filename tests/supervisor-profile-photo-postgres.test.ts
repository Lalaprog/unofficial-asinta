// Opt-in: only an empty local disposable PostgreSQL database.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
const url=process.env.SUPERVISOR_PORTRAIT_TEST_DATABASE_URL;
const founder='10000000-0000-4000-8000-000000000001',supervisor='10000000-0000-4000-8000-000000000002';
const op=(n:number)=>`20000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const photo='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nm7sAAAAASUVORK5CYII=';
let admin:Client,a:Client,b:Client,pid:number;
const write=(client:Client,request:string,expected:string|null,mime:string|null='image/png',data:string|null=photo)=>client.query('SELECT public.set_supervisor_profile_photo($1,$2,$3,$4,$5) v',[supervisor,request,expected,mime,data]);
const pending=async(promise:Promise<unknown>)=>{
 let done=false;const result=promise.then((value:any)=>({code:'success',value}),(error:{code:string})=>({code:error.code,value:null})).finally(()=>{done=true;});
 await new Promise(resolve=>setTimeout(resolve,150));expect(done).toBe(false);
 expect((await admin.query('SELECT cardinality(pg_blocking_pids($1))::int n',[pid])).rows[0].n).toBeGreaterThan(0);
 return {result};
};
(url?describe:describe.skip)('private portrait races on disposable PostgreSQL',()=>{
 beforeAll(async()=>{
  const parsed=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||!parsed.pathname.slice(1).startsWith('asinta_test_')||parsed.search||parsed.hash)throw Error('Use an empty local disposable asinta_test_* database without URL options');
  admin=new Client({connectionString:url});a=new Client({connectionString:url});b=new Client({connectionString:url});await Promise.all([admin.connect(),a.connect(),b.connect()]);
  const existing=(await admin.query("SELECT (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')) objects,(SELECT count(*)::int FROM pg_namespace WHERE nspname='auth') schemas")).rows[0];
  if(existing.objects||existing.schemas)throw Error('Database must be empty');
  await admin.query(`DO $$BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon;END IF;IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated;END IF;IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role;END IF;END$$;
   CREATE SCHEMA auth;CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
   CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT coalesce(current_setting('test.assurance',true)='yes',false)$$;
   CREATE TABLE public.users(id uuid PRIMARY KEY,role text NOT NULL);
 CREATE TABLE public.audit_log(actor_id uuid,action text NOT NULL,table_name text NOT NULL,record_id uuid,before_row jsonb,after_row jsonb);
   CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder')$$;
   INSERT INTO public.users VALUES('${founder}','founder'),('${supervisor}','supervisor');GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role;`);
  await admin.query(`BEGIN;${readFileSync('supabase/drafts/supervisor_profile_photo.sql','utf8')} COMMIT;`);
  await Promise.all([a.query(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes';SET lock_timeout='5s'`),b.query(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes';SET lock_timeout='5s'`)]);
  pid=(await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),a?.end(),b?.end()]);});
 it('serializes simultaneous initial saves and rejects the stale version',async()=>{
  await a.query('BEGIN');await b.query('BEGIN');try{
   await write(a,op(1),null);const waiting=await pending(write(b,op(2),null));await a.query('COMMIT');expect((await waiting.result).code).toBe('40001');await b.query('ROLLBACK');
   expect((await admin.query('SELECT version FROM public.supervisor_profile_photos WHERE supervisor_id=$1',[supervisor])).rows[0].version).toBe(op(1));
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');}
 },15000);
 it('serializes simultaneous exact retries without a second write',async()=>{
  await a.query('BEGIN');await b.query('BEGIN');try{
   expect((await write(a,op(3),op(1))).rows[0].v.replayed).toBe(false);
   const waiting=await pending(write(b,op(3),op(1)));await a.query('COMMIT');const response=await waiting.result;expect(response.code).toBe('success');expect(response.value.rows[0].v.replayed).toBe(true);await b.query('COMMIT');
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');}
 },15000);
 it('serializes removal and prevents an old replacement from resurrecting it',async()=>{
  await a.query('BEGIN');await b.query('BEGIN');try{
   await write(a,op(4),op(3),null,null);const waiting=await pending(write(b,op(5),op(3)));await a.query('COMMIT');expect((await waiting.result).code).toBe('40001');await b.query('ROLLBACK');
   expect((await admin.query('SELECT version,photo IS NULL removed FROM public.supervisor_profile_photos WHERE supervisor_id=$1',[supervisor])).rows[0]).toEqual({version:op(4),removed:true});
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');}
 },15000);
 it('rechecks Founder role after a concurrent demotion',async()=>{
  await a.query('RESET ROLE');await a.query('BEGIN');await b.query('BEGIN');try{
   await a.query("UPDATE public.users SET role='supervisor' WHERE id=$1",[founder]);const waiting=await pending(write(b,op(6),op(4)));await a.query('COMMIT');expect((await waiting.result).code).toBe('42501');await b.query('ROLLBACK');
   expect((await admin.query('SELECT version FROM public.supervisor_profile_photos WHERE supervisor_id=$1',[supervisor])).rows[0].version).toBe(op(4));
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');await admin.query("UPDATE public.users SET role='founder' WHERE id=$1",[founder]);await a.query('SET ROLE authenticated');}
 },15000);
 it('rechecks the target role after concurrent demotion and retains the old tombstone',async()=>{
  await a.query('RESET ROLE');await a.query('BEGIN');await b.query('BEGIN');try{
   await a.query("UPDATE public.users SET role='founder' WHERE id=$1",[supervisor]);const waiting=await pending(write(b,op(8),op(4)));await a.query('COMMIT');expect((await waiting.result).code).toBe('22023');await b.query('ROLLBACK');
   expect((await admin.query('SELECT version,photo IS NULL removed FROM public.supervisor_profile_photos WHERE supervisor_id=$1',[supervisor])).rows[0]).toEqual({version:op(4),removed:true});
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');await admin.query("UPDATE public.users SET role='supervisor' WHERE id=$1",[supervisor]);await a.query('SET ROLE authenticated');}
 },15000);
 it('audits successful writes once without copying photo bytes',async()=>{
  const rows=(await admin.query("SELECT action,before_row,after_row FROM public.audit_log WHERE table_name='supervisor_profile_photos' ORDER BY after_row->>'version'")).rows;
  expect(rows.map(r=>r.after_row.version)).toEqual([op(1),op(3),op(4)]);expect(JSON.stringify(rows)).not.toContain(photo);
  expect(rows[2]).toMatchObject({action:'update',before_row:{has_photo:true,mime:'image/png'},after_row:{has_photo:false,mime:null}});
 });
 it('fails closed at repeatable read',async()=>{
  await a.query('BEGIN ISOLATION LEVEL REPEATABLE READ');try{await expect(write(a,op(7),op(4))).rejects.toMatchObject({code:'P1002'});}finally{await a.query('ROLLBACK');}
 });
});
