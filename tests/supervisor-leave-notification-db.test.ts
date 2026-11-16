import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const read=(f:string)=>readFileSync(`supabase/drafts/${f}.sql`,'utf8');
const founder='00000000-0000-0000-0000-000000000001',supervisor='00000000-0000-0000-0000-000000000002',request='00000000-0000-0000-0000-000000000090';
describe('draft Supervisor leave notification summary',()=>{
 it('requires the rollout, restricts access and follows pending decisions without changing financial records',async()=>{
  const db=new PGlite();try{
   await db.exec(baseFixture);await db.exec(`BEGIN; ${read('supervisor_table_foundation')} COMMIT;`);
   await expect(db.exec(`BEGIN; ${read('supervisor_leave_notification')} COMMIT;`)).rejects.toThrow(/prerequisites missing/);await db.exec('ROLLBACK');
   await db.exec(`BEGIN; ${read('supervisor_rpc_rollout')} COMMIT;`);
   const before=(await db.query('SELECT (SELECT count(*) FROM public.payroll) payroll,(SELECT count(*) FROM public.attendance) attendance')).rows[0];
   await db.exec(`BEGIN; ${read('supervisor_leave_notification')} COMMIT;`);
   await expect(db.exec(`BEGIN; ${read('supervisor_leave_notification')} COMMIT;`)).rejects.toThrow(/already exists/);await db.exec('ROLLBACK');
   await db.exec(`SET test.uid='${supervisor}'; SET test.assurance='yes'; SET ROLE authenticated`);
   await expect(db.query('SELECT public.supervisor_leave_pending_summary()')).rejects.toThrow(/Founder access/);
   await db.query("SELECT public.submit_supervisor_leave($1,'2020-01-01','2020-01-01','emergency','')",[request]);
   await db.exec(`SET test.uid='${founder}'`);
   const count=async()=>(await db.query<{data:{pending_count:number}}>('SELECT public.supervisor_leave_pending_summary() data')).rows[0].data.pending_count;
   expect(await count()).toBe(1);
   await db.exec("SET test.assurance='no'");await expect(count()).rejects.toThrow(/Founder access/);await db.exec("SET test.assurance='yes'");
   await db.query("SELECT public.review_supervisor_leave($1,'rejected')",[request]);expect(await count()).toBe(0);
   await db.exec('RESET ROLE; SET ROLE anon');await expect(db.query('SELECT public.supervisor_leave_pending_summary()')).rejects.toThrow(/permission denied/);await db.exec('RESET ROLE');
   expect((await db.query('SELECT (SELECT count(*) FROM public.payroll) payroll,(SELECT count(*) FROM public.attendance) attendance')).rows[0]).toEqual(before);
  }finally{await db.close();}
 },30000);
 it('rejects unexpected direct table grants and does not leave an installed function',async()=>{
  const db=new PGlite();try{
   await db.exec(baseFixture);await db.exec(`BEGIN; ${read('supervisor_table_foundation')} COMMIT;`);await db.exec(`BEGIN; ${read('supervisor_rpc_rollout')} COMMIT;`);
   await db.exec('GRANT SELECT ON public.supervisor_leave_requests TO authenticated');
   await expect(db.exec(`BEGIN; ${read('supervisor_leave_notification')} COMMIT;`)).rejects.toThrow(/not safely locked/);await db.exec('ROLLBACK');
   expect((await db.query<{missing:boolean}>("SELECT to_regprocedure('public.supervisor_leave_pending_summary()') IS NULL missing")).rows[0].missing).toBe(true);
  }finally{await db.close();}
 },30000);
});
