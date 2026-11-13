// Opt-in only: an empty local disposable PostgreSQL database.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const url=process.env.ATTENDANCE_ASSIGNMENT_GUARD_TEST_DATABASE_URL;
const founder='00000000-0000-0000-0000-000000000001',supervisor='00000000-0000-0000-0000-000000000002',site='00000000-0000-0000-0000-000000000004',other='00000000-0000-0000-0000-000000000005';
const id=(n:number)=>`50000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const pause=()=>new Promise(r=>setTimeout(r,150));
let admin:Client,attendance:Client,mover:Client,attendancePid:number,moverPid:number;
const setup=async(n:number)=>{await admin.query("INSERT INTO public.workers(id,name,position,contact_number,pay_rate,pay_rate_type,active) VALUES($1,'Synthetic','Mason','none',600,'daily',true)",[id(n)]);await admin.query('INSERT INTO public.project_worker_assignments(project_id,worker_id,active) VALUES($1,$2,true)',[site,id(n)]);};
const insert=(n:number)=>attendance.query("INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked) VALUES($1,$2,$3,'2024-08-04','present',8)",[id(n+100),id(n),site]);
const move=async(n:number)=>{await mover.query('SELECT public.set_project_worker_guarded($1,$2,$3,false)',[founder,site,id(n)]);await mover.query('SELECT public.set_project_worker_guarded($1,$2,$3,true)',[founder,other,id(n)]);};
// Querying waiter while a request is in flight would queue behind it. Confirm
// blocking using pg_blocking_pids from the independent admin connection instead.
const pending=async(p:Promise<unknown>,pid:number)=>{let settled=false;const outcome=p.then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{settled=true;});await pause();expect(settled).toBe(false);expect((await admin.query('SELECT cardinality(pg_blocking_pids($1))::int n',[pid])).rows[0].n).toBeGreaterThan(0);return {outcome};};
(url?describe:describe.skip)('attendance assignment guard concurrency on isolated PostgreSQL',()=>{
 beforeAll(async()=>{
  const u=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||!u.pathname.slice(1).startsWith('asinta_test_')||u.search||u.hash)throw Error('Use an empty local disposable asinta_test_* database without URL options');
  admin=new Client({connectionString:url});attendance=new Client({connectionString:url});mover=new Client({connectionString:url});await Promise.all([admin.connect(),attendance.connect(),mover.connect()]);
  attendancePid=(await attendance.query('SELECT pg_backend_pid() pid')).rows[0].pid;moverPid=(await mover.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const o=(await admin.query("SELECT (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')) objects,(SELECT count(*)::int FROM pg_namespace WHERE nspname IN ('auth','app_private','storage')) schemas")).rows[0];if(o.objects||o.schemas)throw Error('Database must be empty');
  await admin.query("DO $$BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END$$;");
  const roles='CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; ';if(!baseFixture.startsWith(roles))throw Error('Fixture role bootstrap changed');await admin.query(baseFixture.slice(roles.length));
  for(const p of ['supabase/migrations/20261107000002_project_worker_lists.sql','supabase/migrations/20261112000000_guarded_single_project_worker.sql'])await admin.query(readFileSync(p,'utf8'));
  await admin.query('CREATE POLICY site_insert ON public.attendance FOR INSERT TO authenticated WITH CHECK(public.is_supervisor_assigned(project_id))');
  await admin.query('CREATE POLICY site_update ON public.attendance FOR UPDATE TO authenticated USING(public.is_supervisor_assigned(project_id))');
  await admin.query(`BEGIN; ${readFileSync('supabase/drafts/attendance_assignment_guard.sql','utf8')} COMMIT;`);
  await attendance.query(`SET ROLE authenticated;SET test.uid='${supervisor}';SET test.assurance='yes';SET lock_timeout='4s'`);await mover.query("SET lock_timeout='4s'");
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),attendance?.end(),mover?.end()]);});
 it('waits for a committed move and rejects a now-unassigned worker without writing',async()=>{
  await setup(1);await mover.query('BEGIN');await attendance.query('BEGIN');try{
   await move(1);const result=await pending(insert(1),attendancePid);await mover.query('COMMIT');expect((await result.outcome).code).toBe('22023');await attendance.query('ROLLBACK');
   expect((await admin.query('SELECT count(*)::int n FROM public.attendance WHERE id=$1',[id(101)])).rows[0].n).toBe(0);
  }finally{await mover.query('ROLLBACK');await attendance.query('ROLLBACK');}
 },15000);
 it('lets an earlier valid attendance commit before a later guarded move',async()=>{
  await setup(2);await attendance.query('BEGIN');await mover.query('BEGIN');try{
   await insert(2);const result=await pending(move(2),moverPid);await attendance.query('COMMIT');expect((await result.outcome).code).toBe('success');await mover.query('COMMIT');
   expect((await admin.query('SELECT worker_id,project_id FROM public.attendance WHERE id=$1',[id(102)])).rows).toEqual([{worker_id:id(2),project_id:site}]);
   expect((await admin.query('SELECT project_id FROM public.project_worker_assignments WHERE worker_id=$1 AND active',[id(2)])).rows).toEqual([{project_id:other}]);
  }finally{await mover.query('ROLLBACK');await attendance.query('ROLLBACK');}
 },15000);
 it('rejects repeatable-read writes rather than using a stale assignment snapshot',async()=>{
  await setup(5);await attendance.query('BEGIN ISOLATION LEVEL REPEATABLE READ');try{
   const result=await insert(5).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code}));expect(result.code).toBe('P1002');
  }finally{await attendance.query('ROLLBACK');}
  expect((await admin.query('SELECT count(*)::int n FROM public.attendance WHERE id=$1',[id(105)])).rows[0].n).toBe(0);
 },15000);
 it('waits for worker deactivation and refuses a stale Roll Call entry',async()=>{
  await setup(4);await mover.query('BEGIN');await attendance.query('BEGIN');try{
   await mover.query('UPDATE public.workers SET active=false WHERE id=$1',[id(4)]);const result=await pending(insert(4),attendancePid);await mover.query('COMMIT');expect((await result.outcome).code).toBe('22023');await attendance.query('ROLLBACK');
   expect((await admin.query('SELECT count(*)::int n FROM public.attendance WHERE id=$1',[id(104)])).rows[0].n).toBe(0);
  }finally{await mover.query('ROLLBACK');await attendance.query('ROLLBACK');}
 },15000);
 it('waits for site-access revocation and denies a stale write',async()=>{
  await setup(3);await mover.query('BEGIN');await attendance.query('BEGIN');try{
   await mover.query('DELETE FROM public.project_supervisors WHERE supervisor_id=$1 AND project_id=$2',[supervisor,site]);const result=await pending(insert(3),attendancePid);await mover.query('COMMIT');expect((await result.outcome).code).toBe('42501');await attendance.query('ROLLBACK');
   expect((await admin.query('SELECT count(*)::int n FROM public.attendance WHERE id=$1',[id(103)])).rows[0].n).toBe(0);
  }finally{await mover.query('ROLLBACK');await attendance.query('ROLLBACK');await admin.query('INSERT INTO public.project_supervisors(project_id,supervisor_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[site,supervisor]);}
 },15000);
});
