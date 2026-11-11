import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
const founder='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',path=`${founder}/inbox/${id}.jpg`;
let db:PGlite;
beforeEach(async()=>{
 db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth; CREATE SCHEMA storage;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
 CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.aal',true)='aal2'$$;
 CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.role',true)='founder' AND public.session_assurance_satisfied()$$;
 CREATE TABLE public.users(id uuid primary key); INSERT INTO public.users VALUES ('${founder}'),('${other}');
 CREATE TABLE storage.objects(bucket_id text,name text); ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
 CREATE POLICY founder_storage ON storage.objects FOR SELECT TO authenticated USING (public.is_founder());
 GRANT USAGE ON SCHEMA public,auth,storage TO authenticated,anon; GRANT SELECT ON storage.objects TO authenticated;`);
 await db.exec(readFileSync('supabase/migrations/20261112000004_receipt_photo_inbox.sql','utf8'));
 await db.exec(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.role='founder'; SET test.aal='aal2';`);
},30000);
afterEach(async()=>{await db.close()});
const add=()=>db.query('INSERT INTO public.receipt_photo_inbox(id,saved_by,object_path,file_name,mime_type,file_size,sha256) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,founder,path,'receipt.jpg','image/jpeg',10,'a'.repeat(64)]);
describe('receipt inbox permissions',()=>{
 it('requires an object before a Founder can finish and disallows direct deletion or mutation',async()=>{
  await add(); await expect(db.query("UPDATE public.receipt_photo_inbox SET status='ready' WHERE id=$1",[id])).rejects.toThrow(/not found/);
  await db.exec(`RESET ROLE; INSERT INTO storage.objects VALUES ('receipts','${path}'); SET ROLE authenticated;`);
  await db.query("UPDATE public.receipt_photo_inbox SET status='ready' WHERE id=$1",[id]);
  const page=await db.query<{data:{items:{status:string}[]}}>('SELECT public.receipt_photo_inbox_page() AS data');expect(page.rows[0].data.items[0].status).toBe('ready');
  await expect(db.query("UPDATE public.receipt_photo_inbox SET status='pending' WHERE id=$1",[id])).rejects.toThrow(/Invalid receipt state/);
  await expect(db.query('DELETE FROM public.receipt_photo_inbox WHERE id=$1',[id])).rejects.toThrow(/permission denied/);
  await expect(db.query("UPDATE public.receipt_photo_inbox SET file_name='new' WHERE id=$1",[id])).rejects.toThrow(/permission denied/);
 });
 it('isolates writes by owner and denies Supervisor, anonymous and inadequate assurance',async()=>{
  await expect(db.query('INSERT INTO public.receipt_photo_inbox(id,saved_by,object_path,file_name,mime_type,file_size,sha256) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,other,path,'receipt.jpg','image/jpeg',10,'a'.repeat(64)])).rejects.toThrow();
  await add();await db.exec(`SET test.uid='${other}'`);
  expect((await db.query("UPDATE public.receipt_photo_inbox SET status='ready' WHERE id=$1 RETURNING id",[id])).rows).toHaveLength(0);
  await db.exec("SET test.role='supervisor'");expect((await db.query('SELECT * FROM public.receipt_photo_inbox')).rows).toHaveLength(0);
  await expect(db.query('SELECT public.receipt_photo_inbox_page()')).rejects.toThrow(/Founder/);
  await db.exec("SET test.role='founder'; SET test.aal='aal1'");expect((await db.query('SELECT * FROM public.receipt_photo_inbox')).rows).toHaveLength(0);
  await db.exec('RESET ROLE; SET ROLE anon');await expect(db.query('SELECT * FROM public.receipt_photo_inbox')).rejects.toThrow(/permission denied/);
 });
});
