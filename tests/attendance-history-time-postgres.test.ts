// Opt-in: synthetic records in an empty local disposable PostgreSQL database.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
import {parseHistoryTimeBatch} from '@/lib/attendance/historyTime';
import type {HistoryRecord} from '@/lib/attendance/history';
const url=process.env.ATTENDANCE_TIME_HISTORY_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const founder='00000000-0000-0000-0000-000000000001',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004',att='80000000-0000-4000-8000-000000000001',req='80000000-0000-4000-8000-000000000002';
let admin:Client,writer:Client,reader:Client;
suite('attendance history time read consistency on PostgreSQL',()=>{
 beforeAll(async()=>{
  const parsed=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||!parsed.pathname.slice(1).startsWith('asinta_test_')||parsed.search||parsed.hash)throw Error('Use an empty local asinta_test_* database without URL options');
  admin=new Client({connectionString:url});writer=new Client({connectionString:url});reader=new Client({connectionString:url});await Promise.all([admin.connect(),writer.connect(),reader.connect()]);
  const o=(await admin.query(`SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S'))::int objects,(SELECT count(*) FROM pg_namespace WHERE nspname IN ('auth','app_private','storage'))::int schemas`)).rows[0];if(o.objects||o.schemas)throw Error('Database must be empty');
  await admin.query("DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END$$;");
  const roles='CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; ';if(!baseFixture.startsWith(roles))throw Error('Fixture bootstrap changed');await admin.query(baseFixture.slice(roles.length));
  for(const path of ['supabase/migrations/20261103000001_attendance_history.sql','supabase/migrations/20261113000000_weekly_worker_preview.sql','supabase/migrations/20261113000001_attendance_time_detail.sql'])await admin.query(readFileSync(path,'utf8'));
  await admin.query(`BEGIN; ${readFileSync('supabase/drafts/attendance_history_time_batch.sql','utf8')} COMMIT;`);
  await admin.query(`INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at,is_founder_override) VALUES ('${att}','${worker}','${site}','2024-11-03','present',8,'2024-11-03T08:00:00Z',false);`);
  await reader.query(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'`);
  await reader.query("SELECT public.record_attendance_time_detail($1,$2,'2024-11-03T08:00:00Z',8,2,'Synthetic source')",[req,att]);
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),writer?.end(),reader?.end()]);});
 it('rejects a changed history snapshot after another transaction commits',async()=>{
  const page=async()=>(await reader.query<{v:{items:HistoryRecord[]}}>("SELECT public.attendance_history_page('records',$1,NULL,'2024-11-03',NULL,NULL,NULL,NULL,20) v",[site])).rows[0].v.items;
  const batch=async()=>(await reader.query<{v:unknown}>('SELECT public.attendance_history_time_batch($1::uuid[]) v',[[att]])).rows[0].v;
  const initial=await page();expect(initial).toHaveLength(1);expect(parseHistoryTimeBatch(await batch(),initial).get(att)).toMatchObject({regular_hours:'8.00',overtime_hours:'2.00',stale:false});
  await writer.query('BEGIN');try{
   await writer.query('UPDATE public.attendance SET hours_worked=7 WHERE id=$1',[att]);
   // A committed-only snapshot cannot see an uncommitted writer.
   expect(parseHistoryTimeBatch(await batch(),initial).get(att)).toMatchObject({stale:false});await writer.query('COMMIT');
   expect(()=>parseHistoryTimeBatch(null,initial)).toThrow();const changed=await batch();expect(()=>parseHistoryTimeBatch(changed,initial)).toThrow(/Attendance changed/);
   const refreshed=await page();expect(parseHistoryTimeBatch(changed,refreshed).get(att)).toMatchObject({stale:true});
  }finally{await writer.query('ROLLBACK');}
 },15000);
});
