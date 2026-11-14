import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const draft=readFileSync('supabase/drafts/supervisor_profile_photo.sql','utf8');
const founder='10000000-0000-4000-8000-000000000001',sup='10000000-0000-4000-8000-000000000002',other='10000000-0000-4000-8000-000000000003';
const op=(n:number)=>`20000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nm7sAAAAASUVORK5CYII=';
const fixture=`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
 CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT coalesce(current_setting('test.assurance',true)='yes',false)$$;
 CREATE TABLE public.users(id uuid PRIMARY KEY,role text NOT NULL);
 CREATE TABLE public.audit_log(actor_id uuid,action text NOT NULL,table_name text NOT NULL,record_id uuid,before_row jsonb,after_row jsonb);
 INSERT INTO public.users VALUES('${founder}','founder'),('${sup}','supervisor'),('${other}','supervisor');
 CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder')$$;
 GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;`;
const get=async(db:PGlite,id=sup)=>(await db.query<{v:Record<string,unknown>}>('SELECT public.supervisor_profile_photo($1) v',[id])).rows[0].v;
const set=async(db:PGlite,id:string,version:string|null,mime:string|null,data:string|null,target=sup)=>(await db.query<{v:Record<string,unknown>}>('SELECT public.set_supervisor_profile_photo($1,$2,$3,$4,$5) v',[target,id,version,mime,data])).rows[0].v;

describe('uninstalled private Supervisor portrait candidate',()=>{
 it('keeps photos private, supports Founder writes and self reads, and uses versioned retries/removal',async()=>{const db=new PGlite();try{
  await db.exec(fixture);await db.exec(`BEGIN;${draft} COMMIT;`);
  await db.exec(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);
  expect(await get(db)).toEqual({supervisor_id:sup,version:null,has_photo:false,mime:null,data:null});
  expect(await set(db,op(1),null,'image/png',image)).toMatchObject({version:op(1),has_photo:true,replayed:false});
  expect(await set(db,op(1),null,'image/png',image)).toMatchObject({version:op(1),has_photo:true,replayed:true});
  await expect(set(db,op(1),null,null,null)).rejects.toThrow(/retry differs/);
  await expect(set(db,op(2),null,'image/png',image)).rejects.toThrow(/changed/);
  await expect(db.query('SELECT photo FROM public.supervisor_profile_photos')).rejects.toThrow(/permission denied/);
  await db.exec(`SET test.uid='${sup}'`);expect(await get(db)).toMatchObject({supervisor_id:sup,version:op(1),mime:'image/png',data:image});
  await expect(get(db,other)).rejects.toThrow(/access required/);
  await expect(set(db,op(2),op(1),null,null)).rejects.toThrow(/Founder access/);
  await db.exec(`SET test.uid='${founder}'`);
  expect(await set(db,op(2),op(1),null,null)).toMatchObject({version:op(2),has_photo:false,replayed:false});
  expect(await set(db,op(2),op(1),null,null)).toMatchObject({version:op(2),has_photo:false,replayed:true});
  expect(await get(db)).toEqual({supervisor_id:sup,version:op(2),has_photo:false,mime:null,data:null});
  await expect(set(db,op(1),null,'image/png',image)).rejects.toThrow(/changed/);
  await db.exec("SET test.assurance='no'");await expect(get(db)).rejects.toThrow(/access required/);await expect(set(db,op(3),op(2),'image/png',image)).rejects.toThrow(/access required/);
  await db.exec("SET test.assurance='yes';SET test.uid=''");await expect(get(db)).rejects.toThrow(/access required/);
  await db.exec('RESET ROLE');
  const audit=(await db.query<{action:string;before_row:Record<string,unknown>|null;after_row:Record<string,unknown>}>("SELECT action,before_row,after_row FROM public.audit_log WHERE table_name='supervisor_profile_photos' ORDER BY action")).rows;
  expect(audit).toEqual([{action:'insert',before_row:null,after_row:{version:op(1),has_photo:true,mime:'image/png'}},{action:'update',before_row:{version:op(1),has_photo:true,mime:'image/png'},after_row:{version:op(2),has_photo:false,mime:null}}]);
  expect(JSON.stringify(audit)).not.toContain(image);
  await db.exec(`DELETE FROM public.users WHERE id='${sup}'`);expect((await db.query('SELECT count(*)::int n FROM public.supervisor_profile_photos')).rows[0]).toEqual({n:0});
 }finally{await db.close();}},30000);
 it('rejects invalid images and cannot create portraits for Founders or unknown profiles',async()=>{const db=new PGlite();try{
  await db.exec(fixture);await db.exec(`BEGIN;${draft} COMMIT;SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);
  for(const [mime,data] of [['image/svg+xml',image],['image/jpeg',image],['image/png','!!!!'],['image/png',''],['image/png','A'.repeat(349532)],[null,image],['image/png',null]] as const)
   await expect(set(db,op(3),null,mime,data)).rejects.toThrow(/Invalid profile photo/);
  await expect(set(db,op(3),null,'image/png',image,founder)).rejects.toThrow(/Supervisor unavailable/);
  expect(await get(db)).toMatchObject({has_photo:false,version:null});
 }finally{await db.close();}},30000);
 it('hides a portrait across role changes without silently deleting it',async()=>{const db=new PGlite();try{
  await db.exec(fixture);await db.exec(`BEGIN;${draft} COMMIT;SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);
  await set(db,op(1),null,'image/png',image);await db.exec(`RESET ROLE;UPDATE public.users SET role='founder' WHERE id='${sup}';SET ROLE authenticated`);
  await expect(get(db)).rejects.toThrow(/access required/);await expect(set(db,op(2),op(1),null,null)).rejects.toThrow(/Supervisor unavailable/);
  await db.exec(`RESET ROLE;UPDATE public.users SET role='supervisor' WHERE id='${sup}';SET ROLE authenticated`);expect(await get(db)).toMatchObject({version:op(1),has_photo:true});
 }finally{await db.close();}},30000);
 it('rolls back the portrait if its metadata audit cannot be recorded',async()=>{const db=new PGlite();try{
  await db.exec(fixture);await db.exec(`BEGIN;${draft} COMMIT;CREATE FUNCTION public.fail_photo_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic audit failure';END$$;CREATE TRIGGER fail_photo_audit BEFORE INSERT ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.fail_photo_audit();SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);
  await expect(set(db,op(1),null,'image/png',image)).rejects.toThrow(/synthetic audit failure/);expect(await get(db)).toMatchObject({version:null,has_photo:false});
 }finally{await db.close();}},30000);
 it('aborts installation on inherited portrait-table access',async()=>{const db=new PGlite();try{
  await db.exec(fixture);await db.exec('CREATE ROLE inherited_role; GRANT inherited_role TO authenticated; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO inherited_role;');
  await expect(db.exec(`BEGIN;${draft} COMMIT;`)).rejects.toThrow(/Unexpected inherited portrait-table privilege/);await db.exec('ROLLBACK');
  expect((await db.query("SELECT to_regclass('public.supervisor_profile_photos') v")).rows[0]).toEqual({v:null});
 }finally{await db.close();}},30000);
});
