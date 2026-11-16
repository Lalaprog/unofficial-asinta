import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
import {parseHistoryTimeBatch} from '@/lib/attendance/historyTime';
import type {HistoryRecord} from '@/lib/attendance/history';
const founder='00000000-0000-0000-0000-000000000001',sup='00000000-0000-0000-0000-000000000002',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004',other='00000000-0000-0000-0000-000000000005';
const id=(n:number)=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const draft=readFileSync('supabase/drafts/attendance_history_time_batch.sql','utf8');
describe('draft attendance history and project log time detail batch',()=>{
 it('reads only authorized records, flags stale details and does not change payroll or attendance',async()=>{
  const db=new PGlite();try{
   await db.exec(baseFixture);await expect(db.exec(`BEGIN; ${draft} COMMIT;`)).rejects.toThrow(/prerequisites missing/);await db.exec('ROLLBACK');
   await db.exec(readFileSync('supabase/migrations/20261113000000_weekly_worker_preview.sql','utf8'));await db.exec(readFileSync('supabase/migrations/20261113000001_attendance_time_detail.sql','utf8'));await db.exec(readFileSync('supabase/migrations/20261103000001_attendance_history.sql','utf8'));
   await db.exec(`INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at) VALUES ('${id(1)}','${worker}','${site}','2024-11-03','present',8,'2024-11-03T08:00:00Z'),('${id(2)}','${worker}','${site}','2024-11-04','present',8,'2024-11-04T08:00:00Z'),('${id(3)}','${worker}','${other}','2024-11-04','present',8,'2024-11-04T08:00:00Z');`);
   const before=(await db.query<{payroll:unknown;attendance:unknown}>('SELECT (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.payroll p) payroll,(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.attendance a) attendance')).rows[0];
   await db.exec(`BEGIN; ${draft} COMMIT;`);await expect(db.exec(`BEGIN; ${draft} COMMIT;`)).rejects.toThrow(/already exists/);await db.exec('ROLLBACK');
   await db.exec(`SET test.uid='${sup}'; SET test.assurance='yes'; SET ROLE authenticated`);
   await db.query("SELECT public.record_attendance_time_detail($1,$2,'2024-11-03T08:00:00Z',8,2.5,'Reviewed time sheet')",[id(10),id(1)]);
   const get=async(ids:string[])=>(await db.query<{v:{items:HistoryRecord[]}}>('SELECT public.attendance_history_time_batch($1::uuid[]) v',[ids])).rows[0].v;
   const result=await get([id(1),id(2)]);expect(result.items[0]).toMatchObject({id:id(1),worker_id:worker,project_id:site,detail:{regular_hours:'8.00',overtime_hours:'2.50',stale:false}});expect(result.items[1]).toMatchObject({id:id(2),detail:null});
   const page=(await db.query<{v:{items:HistoryRecord[]}}>("SELECT public.attendance_history_page('records',$1,NULL,'2024-11-03',NULL,NULL,NULL,NULL,20) v",[site])).rows[0].v;
   expect(page.items).toHaveLength(1);expect(parseHistoryTimeBatch({items:[result.items[0]]},page.items).get(id(1))).toMatchObject({regular_hours:'8.00',overtime_hours:'2.50',stale:false});
   // A later detail at a different site is hidden by RLS; the Supervisor sees
   // an older visible revision, not a claim about the global latest detail.
   await db.exec(`RESET ROLE; INSERT INTO public.attendance_time_details(request_id,attendance_id,worker_id,project_id,attendance_date,attendance_status,attendance_hours,attendance_submitted_at,regular_hours,overtime_hours,note,recorded_by) VALUES ('${id(11)}','${id(1)}','${worker}','${other}','2024-11-03','present',8,'2024-11-03T08:00:00Z',7,1,'Other site revision','${founder}'); SET ROLE authenticated;`);
   expect((await get([id(1)])).items[0]).toMatchObject({detail:{regular_hours:'8.00',overtime_hours:'2.50',stale:false}});
   await db.exec(`SET test.uid='${founder}'`);expect((await get([id(1)])).items[0]).toMatchObject({detail:{regular_hours:'7.00',overtime_hours:'1.00',stale:true}});await db.exec(`SET test.uid='${sup}'`);
   await expect(get([id(1),id(3)])).rejects.toThrow(/unavailable/);await expect(get([id(1),id(1)])).rejects.toThrow(/distinct/);await expect(get([])).rejects.toThrow(/1 to 100/);await expect(get(Array.from({length:101},(_,i)=>id(100+i)))).rejects.toThrow(/1 to 100/);
   await db.exec(`SET test.assurance='no'`);await expect(get([id(1)])).rejects.toThrow(/Attendance access/);await db.exec(`RESET ROLE; UPDATE public.attendance SET hours_worked=7 WHERE id='${id(1)}'; SET ROLE authenticated; SET test.assurance='yes'`);
   expect((await get([id(1)])).items[0]).toMatchObject({detail:{regular_hours:'8.00',overtime_hours:'2.50',stale:true}});
   await db.exec(`SET test.uid='${founder}'`);expect((await get([id(3)])).items[0]).toMatchObject({id:id(3),detail:null});
   await db.exec('RESET ROLE; SET ROLE anon');await expect(get([id(1)])).rejects.toThrow(/permission denied/);await db.exec('RESET ROLE');
   const after=(await db.query<{payroll:unknown;attendance:unknown}>('SELECT (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.payroll p) payroll,(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.attendance a) attendance')).rows[0];
   // Only the deliberate test edit to attendance differs; the read RPC changes no financial state.
   expect(after.payroll).toEqual(before.payroll);
  }finally{await db.close();}
 },30000);
});
