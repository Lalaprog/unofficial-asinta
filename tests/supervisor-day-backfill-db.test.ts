import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const founder='00000000-0000-0000-0000-000000000001',sup='00000000-0000-0000-0000-000000000002';
const id=(n:number)=>`50000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function setup(){const db=new PGlite();await db.exec(baseFixture);for(const p of ['supervisor_table_foundation','supervisor_rpc_rollout','supervisor_day_founder_backfill'])await db.exec(`BEGIN;${readFileSync(`supabase/drafts/${p}.sql`,'utf8')} COMMIT;`);await db.exec(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);return db;}
const record=async(db:PGlite,key:string,date:string,reason='Reviewed original record')=>(await db.query<{v:Record<string,unknown>}>('SELECT public.record_supervisor_day_backfill($1,$2,$3,$4,$5) v',[key,sup,date,'half_day',reason])).rows[0].v;
describe('Founder Supervisor daily backfill',()=>{
 it('records one pending day with immutable source evidence, exact retry and separate approval',async()=>{const db=await setup();try{
  await db.exec('RESET ROLE');const before=(await db.query('SELECT (SELECT count(*)::int FROM public.attendance) attendance,(SELECT count(*)::int FROM public.payroll) payroll')).rows[0];await db.exec('SET ROLE authenticated');
  expect(await record(db,id(1),'2024-08-04')).toMatchObject({status:'pending',replayed:false});expect(await record(db,id(1),'2024-08-04')).toMatchObject({replayed:true});
  await expect(record(db,id(1),'2024-08-04','Changed')).rejects.toThrow(/different attendance/);await expect(record(db,id(2),'2024-08-04')).rejects.toThrow(/already exists/);
  expect((await db.query<{v:unknown}>('SELECT public.supervisor_day_backfill_lookup($1) v',[id(1)])).rows[0].v).toMatchObject({id:id(1),supervisor_id:sup,founder_id:founder,date:'2024-08-04',work_status:'half_day',reason:'Reviewed original record',status:'pending'});
  await db.query("SELECT public.review_supervisor_day($1,'approved')",[id(1)]);expect(await record(db,id(1),'2024-08-04')).toMatchObject({status:'approved',replayed:true});
  await expect(db.query('SELECT * FROM public.supervisor_day_founder_backfills')).rejects.toThrow(/permission denied/);await db.exec('RESET ROLE');await expect(db.query("UPDATE public.supervisor_day_founder_backfills SET reason='changed'")).rejects.toThrow(/immutable/);
  expect((await db.query('SELECT (SELECT count(*)::int FROM public.attendance) attendance,(SELECT count(*)::int FROM public.payroll) payroll')).rows[0]).toEqual(before);
 }finally{await db.close();}},30000);
 it('denies other roles, bad inputs and future dates, without changing existing daily records',async()=>{const db=await setup();try{
  await expect(record(db,id(1),'9998-01-01')).rejects.toThrow(/future/);await expect(record(db,id(1),'2024-08-04',' ')).rejects.toThrow(/Invalid/);
  expect((await db.query<{v:unknown}>('SELECT public.supervisor_day_backfill_lookup($1) v',[id(9)])).rows[0].v).toBeNull();
  await db.exec(`SET test.uid='${sup}'`);await db.query("SELECT public.submit_supervisor_day($1,'2024-08-05','present')",[id(5)]);await expect(record(db,id(1),'2024-08-04')).rejects.toThrow(/Founder/);await expect(db.query('SELECT public.supervisor_day_backfill_lookup($1)',[id(1)])).rejects.toThrow(/Founder/);
  await db.exec(`SET test.uid='${founder}'`);await expect(record(db,id(6),'2024-08-05')).rejects.toThrow(/already exists/);
  await db.exec(`SET test.uid='${founder}';SET test.assurance='no'`);await expect(record(db,id(1),'2024-08-04')).rejects.toThrow(/Founder/);
  for(const role of ['anon','service_role']){await db.exec(`RESET ROLE;SET ROLE ${role}`);await expect(db.query('SELECT public.supervisor_day_backfill_catalog()')).rejects.toThrow(/permission denied/);}
 }finally{await db.close();}},30000);
});
