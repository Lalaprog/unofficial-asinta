import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const migration=readFileSync('supabase/migrations/20261106000002_project_photos.sql','utf8');
describe('project photo storage isolation',()=>{
 it('refuses installation if storage has any unreviewed broad policy',async()=>{
  const db=new PGlite();try {
   await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema storage;
     create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
     create table storage.objects(bucket_id text);create table public.projects(id uuid primary key);
     create policy broad on storage.objects for select to authenticated using (true);`);
   await expect(db.exec(migration)).rejects.toThrow('Storage policies differ');
   expect((await db.query("select * from storage.buckets where id='project-photos'")).rows).toHaveLength(0);
  } finally {await db.close();}
 });
 it('creates a private limited bucket and metadata inaccessible to browser roles',async()=>{
  const db=new PGlite();try {
   await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema storage;
     alter default privileges in schema public grant all on tables to anon, authenticated;
     create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
     create table storage.objects(bucket_id text);
     create function public.is_founder() returns boolean language sql as $$select true$$;
     create policy "Founders can read expense receipts" on storage.objects for select to authenticated using (bucket_id = 'receipts' and public.is_founder());
     create policy "Founders can update expense receipts" on storage.objects for update to authenticated using (bucket_id = 'receipts' and public.is_founder());
     create policy "Founders can delete expense receipts" on storage.objects for delete to authenticated using (bucket_id = 'receipts' and public.is_founder());
     create policy "Founders can upload expense receipts" on storage.objects for insert to authenticated with check (bucket_id = 'receipts' and public.is_founder());
     create table public.projects(id uuid primary key);`);
   await db.exec(migration);
   const bucket=await db.query("select public,file_size_limit,allowed_mime_types from storage.buckets where id='project-photos'");
   expect(bucket.rows[0]).toMatchObject({public:false,file_size_limit:3145728,allowed_mime_types:['image/jpeg','image/png','image/webp']});
   await db.exec("insert into projects values('11111111-1111-4111-8111-111111111111'); insert into project_photos(project_id,object_path) values('11111111-1111-4111-8111-111111111111','a.jpg');");
   await db.exec('set role authenticated');await expect(db.query('select * from project_photos')).rejects.toThrow();await expect(db.query('delete from project_photos')).rejects.toThrow();
   await db.exec('reset role; set role anon');await expect(db.query('select * from project_photos')).rejects.toThrow();
   await db.exec('reset role; set role service_role');expect((await db.query('select * from project_photos')).rows).toHaveLength(1);
  } finally {await db.close();}
 });
});
