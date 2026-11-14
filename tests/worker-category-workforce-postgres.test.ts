// Disposable local PostgreSQL only. No hosted records or payments.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const url=process.env.WORKER_CATEGORY_WORKFORCE_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const founder='00000000-0000-0000-0000-000000000001';
const id=(n:number)=>`82000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let admin:Client,first:Client,second:Client;
const pause=()=>new Promise(resolve=>setTimeout(resolve,150));
suite('category workforce cutover on PostgreSQL',()=>{
 beforeAll(async()=>{
  const parsed=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||parsed.pathname!=='/asinta_test_category_workforce'||parsed.search||parsed.hash)throw Error('Use the empty local asinta_test_category_workforce database');
  admin=new Client({connectionString:url});first=new Client({connectionString:url});second=new Client({connectionString:url});await Promise.all([admin.connect(),first.connect(),second.connect()]);
  const objects=(await admin.query("SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S'))::int objects,(SELECT count(*) FROM pg_namespace WHERE nspname IN ('auth','storage','app_private'))::int schemas")).rows[0];if(objects.objects||objects.schemas)throw Error('Database must be empty');
  await admin.query("DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;END$$;");
  const prefix='CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; ';if(!baseFixture.startsWith(prefix))throw Error('Fixture bootstrap changed');await admin.query(baseFixture.slice(prefix.length));
  for(const name of ['worker_category_catalog','worker_category_workforce_cutover'])await admin.query(`BEGIN; ${readFileSync(`supabase/drafts/${name}.sql`,'utf8')} COMMIT;`);
  await first.query(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes';SET lock_timeout='5s'`);
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),first?.end(),second?.end()]);});
 it.each([['Mason','rename','Senior Mason'],['Carpenter','archive',null]])('rechecks %s after a concurrent %s',async(label,action,newLabel)=>{
  const category=(await admin.query('SELECT id,revision FROM public.worker_categories WHERE label=$1',[label])).rows[0];
  await first.query('BEGIN');await second.query('BEGIN');try{
   await first.query('SELECT public.change_worker_category($1,$2,$3,$4,$5)',[id(action==='rename'?1:2),category.id,action,newLabel,category.revision]);
   const pid=(await second.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   let settled=false;const pending=second.query("INSERT INTO public.workers(id,name,position,contact_number,pay_rate,pay_rate_type,active) VALUES($1,'Synthetic', $2,'none',600,'daily',true)",[id(action==='rename'?3:4),label]).then(()=>({code:'success'}),(err:{code:string})=>({code:err.code})).finally(()=>{settled=true;});
   await pause();expect(settled).toBe(false);expect((await admin.query('SELECT cardinality(pg_blocking_pids($1))::int n',[pid])).rows[0].n).toBeGreaterThan(0);
   await first.query('COMMIT');expect((await pending).code).toBe('22023');await second.query('ROLLBACK');
   expect((await admin.query('SELECT count(*)::int n FROM public.workers WHERE id=$1',[id(action==='rename'?3:4)])).rows[0].n).toBe(0);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('captures the committed craft when entry races a category rename',async()=>{
  for(const path of ['supabase/migrations/20261103000001_attendance_history.sql','supabase/migrations/20261112000001_payslip_batch_snapshot.sql','supabase/drafts/recorded_craft_observations.sql']) await admin.query(`BEGIN;${readFileSync(path,'utf8')} COMMIT`);
  const worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004';
  const cat=(await admin.query("SELECT id,revision FROM public.worker_categories WHERE label='Senior Mason'")).rows[0];
  await first.query('BEGIN');await second.query('BEGIN');try{
   await first.query('SELECT public.change_worker_category($1,$2,$3,$4,$5)',[id(20),cat.id,'rename','Lead Mason',cat.revision]);
   const pid=(await second.query('SELECT pg_backend_pid() pid')).rows[0].pid;let settled=false;
   const insert=second.query("INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked) VALUES($1,$2,$3,'2024-08-01','present',8)",[id(21),worker,site]).finally(()=>{settled=true});
   await pause();expect(settled).toBe(false);expect((await admin.query('SELECT cardinality(pg_blocking_pids($1))::int n',[pid])).rows[0].n).toBeGreaterThan(0);
   await first.query('COMMIT');await insert;await second.query('COMMIT');
   expect((await admin.query('SELECT craft FROM public.attendance_craft_observations WHERE attendance_id=$1',[id(21)])).rows[0]).toEqual({craft:'Lead Mason'});
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
  await first.query('BEGIN');await second.query('BEGIN');try{
   await second.query("INSERT INTO public.payroll(id,worker_id,period_start,period_end,status) VALUES($1,$2,'2024-08-04','2024-08-10','draft')",[id(22),worker]);
   const pid=(await first.query('SELECT pg_backend_pid() pid')).rows[0].pid;let settled=false;
   const rename=first.query('SELECT public.change_worker_category($1,$2,$3,$4,$5)',[id(23),cat.id,'rename','Expert Mason',cat.revision+1]).finally(()=>{settled=true});
   await pause();expect(settled).toBe(false);expect((await admin.query('SELECT cardinality(pg_blocking_pids($1))::int n',[pid])).rows[0].n).toBeGreaterThan(0);
   await second.query('COMMIT');await rename;await first.query('COMMIT');
   expect((await admin.query('SELECT craft FROM public.payroll_craft_observations WHERE payroll_id=$1',[id(22)])).rows[0]).toEqual({craft:'Lead Mason'});
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);

});
