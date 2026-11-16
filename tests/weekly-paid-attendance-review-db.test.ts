import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const founder='00000000-0000-0000-0000-000000000001',supervisor='00000000-0000-0000-0000-000000000002',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004';
const legacy='70000000-0000-4000-8000-000000000031',added='70000000-0000-4000-8000-000000000032';
async function fixture(){
 const db=new PGlite();await db.exec(baseFixture);
 await db.exec(`CREATE TABLE public.attendance_time_details(request_id uuid PRIMARY KEY,revision_id bigint UNIQUE,attendance_id uuid,regular_hours numeric,overtime_hours numeric);
 CREATE TABLE public.weekly_worker_draft_sources(payroll_id uuid PRIMARY KEY,worker_id uuid,period_start date,source_snapshot jsonb);
 ALTER TABLE public.weekly_worker_draft_sources ENABLE ROW LEVEL SECURITY;REVOKE ALL ON public.weekly_worker_draft_sources FROM PUBLIC,anon,authenticated,service_role;
 INSERT INTO public.attendance_time_details VALUES ('${added}',1,'${worker}',8,2);
 INSERT INTO public.weekly_worker_draft_sources SELECT p.id,p.worker_id,p.period_start,jsonb_build_object('version',1,'attendance',
  (SELECT jsonb_agg(jsonb_build_object('record',to_jsonb(a),'latest_detail',d.detail) ORDER BY a.date,a.id) FROM public.attendance a
   LEFT JOIN LATERAL (SELECT to_jsonb(t) detail FROM public.attendance_time_details t WHERE t.attendance_id=a.id ORDER BY t.revision_id DESC LIMIT 1)d ON true
   WHERE a.worker_id=p.worker_id AND a.date BETWEEN p.period_start AND p.period_end)) FROM public.payroll p WHERE p.id='${worker}';
 INSERT INTO public.payroll VALUES('${legacy}','${worker}','2026-10-11','2026-10-17','paid',1,8,600,0,0,600);
 ${readFileSync('supabase/drafts/weekly_paid_attendance_change_review.sql','utf8')}
 SET test.uid='${founder}';SET test.assurance='yes';SET ROLE authenticated;`);
 return db;
}
const review=(db:PGlite,id=worker)=>db.query<{v:{attendance:string}}>('SELECT public.weekly_paid_attendance_change_review($1) v',[id]);
describe('paid weekly attendance comparison, synthetic database only',()=>{
 it('distinguishes changes and legacy absence without changing financial history',async()=>{
  const db=await fixture();try{
   expect((await review(db)).rows[0].v.attendance).toBe('unchanged');expect((await review(db,legacy)).rows[0].v.attendance).toBe('unavailable');
   await db.exec('RESET ROLE');await db.query("INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked) VALUES($1,$2,$3,'2026-10-26','present',8)",[added,worker,site]);await db.exec('SET ROLE authenticated');
   expect((await review(db)).rows[0].v.attendance).toBe('changed');
   await db.exec('RESET ROLE');await db.query('DELETE FROM public.attendance WHERE id=$1',[added]);await db.exec('SET ROLE authenticated');expect((await review(db)).rows[0].v.attendance).toBe('unchanged');
   await db.exec('RESET ROLE');await db.query('UPDATE public.attendance_time_details SET overtime_hours=3 WHERE request_id=$1',[added]);await db.exec('SET ROLE authenticated');expect((await review(db)).rows[0].v.attendance).toBe('changed');
   await db.exec('RESET ROLE');expect((await db.query('SELECT status,gross_pay::text,net_pay::text FROM public.payroll WHERE id=$1',[worker])).rows).toEqual([{status:'paid',gross_pay:'600',net_pay:'600'}]);
  }finally{await db.close();}
 },30000);
 it('refuses a comparison that exceeds the bounded current attendance scope',async()=>{
  const db=await fixture();try{
   await db.exec('RESET ROLE');await db.query("INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked) SELECT md5('synthetic-'||g)::uuid,$1,$2,'2026-10-26','present',8 FROM generate_series(1,500) g",[worker,site]);await db.exec('SET ROLE authenticated');
   await expect(review(db)).rejects.toThrow(/Too many attendance records/);
  }finally{await db.close();}
 },30000);
 it('fails closed for missing authorization, non-paid voucher and damaged evidence',async()=>{
  const db=await fixture();try{
   await db.exec(`SET test.uid='${supervisor}'`);await expect(review(db)).rejects.toThrow(/Founder access/);await db.exec(`SET test.uid='${founder}';SET test.assurance='no'`);await expect(review(db)).rejects.toThrow(/Founder access/);
   await db.exec("SET test.assurance='yes'");await expect(review(db,added)).rejects.toThrow(/Paid voucher unavailable/);
   await db.exec('RESET ROLE');expect((await db.query("SELECT has_function_privilege('anon','public.weekly_paid_attendance_change_review(uuid)','EXECUTE') a,has_function_privilege('service_role','public.weekly_paid_attendance_change_review(uuid)','EXECUTE') s")).rows).toEqual([{a:false,s:false}]);
   await db.query("UPDATE public.weekly_worker_draft_sources SET source_snapshot=jsonb_set(source_snapshot,'{attendance}','[]') WHERE payroll_id=$1",[worker]);await db.exec('SET ROLE authenticated');await expect(review(db)).rejects.toThrow(/incomplete/);
  }finally{await db.close();}
 },30000);
});
