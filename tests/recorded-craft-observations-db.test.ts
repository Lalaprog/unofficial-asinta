import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const founder='00000000-0000-0000-0000-000000000001',sup='00000000-0000-0000-0000-000000000002',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004',other='00000000-0000-0000-0000-000000000005';
const id=(n:number)=>`83000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sql=(p:string)=>readFileSync(p,'utf8');
async function setup(){const db=new PGlite();await db.exec(baseFixture);await db.exec('ALTER TABLE public.attendance ADD CONSTRAINT attendance_unique_worker_site_date UNIQUE(worker_id,project_id,date)');
 for(const path of ['supabase/migrations/20261103000001_attendance_history.sql','supabase/migrations/20261112000001_payslip_batch_snapshot.sql','supabase/drafts/worker_category_catalog.sql','supabase/drafts/worker_category_workforce_cutover.sql'])await db.exec(`BEGIN;${sql(path)} COMMIT;`);return db;}
const observation=sql('supabase/drafts/recorded_craft_observations.sql');
describe('recorded craft observations (synthetic only)',()=>{
 it('preserves craft at entry after renames without inventing old craft or altering paid amounts',async()=>{const db=await setup();try{
  const before=(await db.query('SELECT * FROM public.payroll WHERE id=$1',[worker])).rows[0];await db.exec(`BEGIN;${observation} COMMIT;`);
  const category=(await db.query<{id:string}>("SELECT id FROM public.worker_categories WHERE label='Mason'")).rows[0].id;
  await db.query("INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked) VALUES($1,$2,$3,'2025-01-01','present',8)",[id(1),worker,site]);
  await db.query("INSERT INTO public.payroll(id,worker_id,period_start,period_end,status,days_worked,hours_worked,gross_pay,bale_deduction,other_deductions,net_pay) VALUES($1,$2,'2025-01-05','2025-01-11','draft',1,8,600,0,0,600)",[id(2),worker]);
  await db.exec(`SET test.uid='${founder}';SET test.assurance='yes';SET ROLE authenticated`);await db.query('SELECT public.change_worker_category($1,$2,$3,$4,$5)',[id(3),category,'rename','Concrete Lead',1]);
  const history=(await db.query<{v:{items:Array<Record<string,unknown>>}}>("SELECT public.attendance_history_page('records',$1,NULL,'2025-01-01',NULL,NULL,NULL,NULL,20) v",[site])).rows[0].v.items[0];
  expect(history).toMatchObject({worker_position:'Concrete Lead',entry_craft:'Mason'});expect(typeof history.entry_craft_at).toBe('string');
  const searched=(await db.query<{v:{items:Array<Record<string,unknown>>}}>("SELECT public.attendance_history_page('records',$1,NULL,'2025-01-01','Mason',NULL,NULL,NULL,20) v",[site])).rows[0].v.items;expect(searched).toHaveLength(1);expect(searched[0].entry_craft).toBe('Mason');
  const old=(await db.query<{v:{items:Array<Record<string,unknown>>}}>("SELECT public.attendance_history_page('records',$1,NULL,'2026-10-25',NULL,NULL,NULL,NULL,20) v",[site])).rows[0].v.items[0];expect(old).toMatchObject({worker_position:'Concrete Lead',entry_craft:null,entry_craft_at:null});
  const slips=(await db.query<{v:Array<Record<string,unknown>>}>("SELECT public.payslip_batch_snapshot('2025-01-05','2025-01-11') v")).rows[0].v;expect(slips[0]).toMatchObject({worker_position:'Concrete Lead',entry_craft:'Mason'});expect(typeof slips[0].entry_craft_at).toBe('string');
  const legacy=(await db.query<{v:Array<Record<string,unknown>>}>("SELECT public.payslip_batch_snapshot('2026-10-25','2026-10-31') v")).rows[0].v;expect(legacy[0]).toMatchObject({entry_craft:null,entry_craft_at:null});
  await db.exec('RESET ROLE');expect((await db.query('SELECT * FROM public.payroll WHERE id=$1',[worker])).rows[0]).toEqual(before);
  await db.query("INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked) VALUES($1,$2,$3,'2025-01-01','half_day',4) ON CONFLICT(worker_id,project_id,date) DO UPDATE SET status=EXCLUDED.status,hours_worked=EXCLUDED.hours_worked",[id(9),worker,site]);
  expect((await db.query('SELECT craft FROM public.attendance_craft_observations WHERE attendance_id=$1',[id(1)])).rows[0]).toEqual({craft:'Mason'});
  await expect(db.query('UPDATE public.attendance_craft_observations SET craft=$1',["Fabricated"])).rejects.toThrow(/immutable/);await expect(db.query('DELETE FROM public.payroll WHERE id=$1',[id(2)])).rejects.toThrow(/foreign key/);
 }finally{await db.close();}},30000);
 it('respects source RLS, refuses direct writes and hides an observation if identity changes',async()=>{const db=await setup();try{
  await db.exec(`BEGIN;${observation} COMMIT;`);await db.query("INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked) VALUES($1,$2,$3,'2025-01-01','present',8),($4,$2,$5,'2025-01-01','present',8)",[id(1),worker,site,id(2),other]);
  await db.query("INSERT INTO public.payroll(id,worker_id,period_start,period_end,status) VALUES($1,$2,'2025-01-05','2025-01-11','draft')",[id(3),worker]);
  await db.exec(`SET test.uid='${sup}';SET test.assurance='yes';SET ROLE authenticated`);
  expect((await db.query('SELECT attendance_id FROM public.attendance_craft_observations')).rows).toEqual([{attendance_id:id(1)}]);expect((await db.query('SELECT * FROM public.payroll_craft_observations')).rows).toEqual([]);
  await expect(db.query("INSERT INTO public.attendance_craft_observations(attendance_id,worker_id,craft) VALUES($1,$2,'Fake')",[id(4),worker])).rejects.toThrow(/permission denied/);
  await db.exec('RESET ROLE');await db.query("INSERT INTO public.workers(id,name,position,active) VALUES($1,'Other worker','Carpenter',true)",[id(5)]);await db.query('UPDATE public.attendance SET worker_id=$1 WHERE id=$2',[id(5),id(1)]);
  await db.exec(`SET ROLE authenticated;SET test.uid='${founder}'`);
  const row=(await db.query<{v:{items:Array<Record<string,unknown>>}}>("SELECT public.attendance_history_page('records',$1,NULL,'2025-01-01',NULL,NULL,NULL,NULL,20) v",[site])).rows[0].v.items[0];expect(row).toMatchObject({worker_id:id(5),entry_craft:null,entry_craft_at:null});
  await db.exec('RESET ROLE;SET ROLE anon');await expect(db.query('SELECT * FROM public.attendance_craft_observations')).rejects.toThrow(/permission denied/);
 }finally{await db.close();}},30000);
 it('rolls back the source insert if its observation cannot be retained',async()=>{const db=await setup();try{
  await db.exec(`BEGIN;${observation} COMMIT;`);
  await db.exec("CREATE FUNCTION public.fail_craft_capture() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic evidence failure'; END$$; CREATE TRIGGER fail_craft_capture BEFORE INSERT ON public.attendance_craft_observations FOR EACH ROW EXECUTE FUNCTION public.fail_craft_capture()");
  await expect(db.query("INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked) VALUES($1,$2,$3,'2025-01-01','present',8)",[id(60),worker,site])).rejects.toThrow(/synthetic evidence failure/);
  expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.attendance WHERE id=$1',[id(60)])).rows[0].n).toBe(0);
  expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.attendance_craft_observations')).rows[0].n).toBe(0);
 }finally{await db.close();}},30000);
 it('rolls back installation if an existing history function differs',async()=>{const db=await setup();try{
  await db.exec("CREATE OR REPLACE FUNCTION public.payslip_batch_snapshot(p_start date,p_end date) RETURNS jsonb LANGUAGE sql AS $$SELECT '[]'::jsonb$$");await expect(db.exec(`BEGIN;${observation} COMMIT;`)).rejects.toThrow(/Payslip function differs/);await db.exec('ROLLBACK');
  expect((await db.query<{v:string|null}>("SELECT to_regclass('public.attendance_craft_observations')::text v")).rows[0].v).toBeNull();
 }finally{await db.close();}},30000);
});
