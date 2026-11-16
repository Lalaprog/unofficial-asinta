import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';

describe('development staged attendance time foundation',()=>{
 it('installs the time functions with all client writes disabled and leaves the old preview intact',async()=>{
  const db=new PGlite();
  try{
   await db.exec(baseFixture);
   await db.exec(readFileSync('supabase/migrations/20261113000000_weekly_worker_preview.sql','utf8'));
   const sql=readFileSync('supabase/applied_development/staged_attendance_time_foundation.sql','utf8');
   await db.exec(`BEGIN; ${sql} COMMIT;`);
   const result=await db.query<{role_name:string;writer:boolean;table_write:boolean;sequence_access:boolean}>(`SELECT r role_name,
    has_function_privilege(r,'public.record_attendance_time_detail(uuid,uuid,timestamptz,numeric,numeric,text)','EXECUTE') writer,
    has_table_privilege(r,'public.attendance_time_details','INSERT,UPDATE,DELETE,TRUNCATE') table_write,
    has_sequence_privilege(r,pg_get_serial_sequence('public.attendance_time_details','revision_id'),'USAGE,SELECT,UPDATE') sequence_access
    FROM unnest(ARRAY['anon','authenticated','service_role']) AS roles(r)`);
   expect(result.rows).toEqual(['anon','authenticated','service_role'].map(role_name=>({role_name,writer:false,table_write:false,sequence_access:false})));
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.attendance_time_details')).rows[0].n).toBe(0);
   const preview=readFileSync('supabase/applied_development/staged_attendance_time_preview.sql','utf8');
   await db.exec(`BEGIN; ${preview} COMMIT;`);
   expect((await db.query<{present:boolean}>("SELECT to_regprocedure('public.weekly_worker_preview_base_inputs(date)') IS NOT NULL present")).rows[0].present).toBe(true);
   expect((await db.query<{allowed:boolean}>("SELECT has_function_privilege('authenticated','public.record_attendance_time_detail(uuid,uuid,timestamptz,numeric,numeric,text)','EXECUTE') allowed")).rows[0].allowed).toBe(false);
   await expect(db.exec(`BEGIN; ${preview} COMMIT;`)).rejects.toThrow(/Weekly preview base changed/);
   await db.exec('ROLLBACK');
   await expect(db.exec(`BEGIN; ${sql} COMMIT;`)).rejects.toThrow(/Time detail objects exist/);
   await db.exec('ROLLBACK');
   // Exercise the next original dependency order on the staged shape. The
   // future cutover still needs its own controlled activation and guards.
   await db.exec(readFileSync('supabase/migrations/20261113000002_worker_allowances.sql','utf8'));
   await db.exec(readFileSync('supabase/migrations/20261113000003_weekly_payroll_context.sql','utf8'));
   const continuation=await db.query<{base:boolean;time:boolean;record_allowed:boolean}>(`SELECT
    to_regprocedure('public.weekly_worker_preview_base_inputs(date)') IS NOT NULL base,
    to_regprocedure('public.weekly_worker_time_preview_inputs(date)') IS NOT NULL time,
    has_function_privilege('authenticated','public.record_attendance_time_detail(uuid,uuid,timestamptz,numeric,numeric,text)','EXECUTE') record_allowed`);
   expect(continuation.rows[0]).toEqual({base:true,time:true,record_allowed:false});
  }finally{await db.close();}
 },30000);
});
