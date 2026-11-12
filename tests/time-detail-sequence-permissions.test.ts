import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const migration=readFileSync('supabase/migrations/20261114000001_protect_time_detail_sequence.sql','utf8');
const sequence='public.attendance_time_details_revision_id_seq';
async function fixture(){
 const db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon,authenticated,service_role;
  CREATE TABLE public.attendance_time_details(id uuid primary key, revision_id bigint GENERATED ALWAYS AS IDENTITY UNIQUE);
  GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;`);
 return db;
}
describe('time detail identity sequence privileges',()=>{
 it('removes direct client sequence access while preserving service and existing values',async()=>{
  const db=await fixture();try{
   await db.exec("INSERT INTO public.attendance_time_details(id) VALUES ('00000000-0000-0000-0000-000000000001')");
   await db.exec(migration);
   for(const role of ['anon','authenticated']){
    expect((await db.query<{p:boolean}>(`SELECT has_sequence_privilege($1,$2,'USAGE,SELECT,UPDATE') p`,[role,sequence])).rows[0].p).toBe(false);
    await db.exec(`SET ROLE ${role}`);await expect(db.query(`SELECT nextval('${sequence}')`)).rejects.toThrow(/permission denied/);await db.exec('RESET ROLE');
   }
   expect((await db.query<{p:boolean}>(`SELECT has_sequence_privilege('service_role',$1,'USAGE') p`,[sequence])).rows[0].p).toBe(true);
   expect((await db.query<{revision_id:number}>('SELECT revision_id::int revision_id FROM public.attendance_time_details')).rows[0].revision_id).toBe(1);
  }finally{await db.close();}
 },30000);
 it('rolls back if an inherited grant still exposes the sequence',async()=>{
  const db=await fixture();try{
   await db.exec(`CREATE ROLE seq_reader; GRANT seq_reader TO authenticated; GRANT SELECT ON SEQUENCE ${sequence} TO seq_reader;`);
   await expect(db.exec(`BEGIN; ${migration} COMMIT;`)).rejects.toThrow(/Inherited client access/);await db.exec('ROLLBACK');
   expect((await db.query<{p:boolean}>(`SELECT has_sequence_privilege('anon',$1,'USAGE') p`,[sequence])).rows[0].p).toBe(true);
  }finally{await db.close();}
 },30000);
 it('rolls back if service access relies on the client role',async()=>{
  const db=await fixture();try{
   await db.exec(`REVOKE ALL ON SEQUENCE ${sequence} FROM service_role; GRANT authenticated TO service_role;`);
   await expect(db.exec(`BEGIN; ${migration} COMMIT;`)).rejects.toThrow(/Service sequence privileges would change/);await db.exec('ROLLBACK');
   expect((await db.query<{p:boolean}>(`SELECT has_sequence_privilege('service_role',$1,'USAGE') p`,[sequence])).rows[0].p).toBe(true);
  }finally{await db.close();}
 },30000);
});
