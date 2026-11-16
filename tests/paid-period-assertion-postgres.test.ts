// Opt-in only for a new empty local disposable PostgreSQL database.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const url=process.env.PAID_PERIOD_ASSERTION_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const founder='00000000-0000-0000-0000-000000000001',sup='00000000-0000-0000-0000-000000000002',worker='00000000-0000-0000-0000-000000000003';
const id=(n:number)=>`80000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sql=(name:string)=>readFileSync(`supabase/drafts/${name}.sql`,'utf8');
let admin:Client,first:Client,second:Client;const pause=()=>new Promise(r=>setTimeout(r,150));
suite.each(['historical-first','supervisor-first'])('cross-ledger and paid-period PostgreSQL races (%s)',order=>{
 beforeAll(async()=>{
  const u=new URL(url!);if(order==='supervisor-first')u.pathname+='_reverse';if(!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||!u.pathname.slice(1).startsWith('asinta_test_')||u.search||u.hash)throw Error('Use an empty local asinta_test_* database');
  admin=new Client({connectionString:u.toString()});first=new Client({connectionString:u.toString()});second=new Client({connectionString:u.toString()});await Promise.all([admin.connect(),first.connect(),second.connect()]);
  const o=(await admin.query("SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S'))::int objects,(SELECT count(*) FROM pg_namespace WHERE nspname IN ('auth','app_private','storage'))::int schemas")).rows[0];if(o.objects||o.schemas)throw Error('Database must be empty');
  await admin.query("DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END$$;");
  const roles='CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; ';if(!baseFixture.startsWith(roles))throw Error('Fixture bootstrap changed');await admin.query(baseFixture.slice(roles.length));
  for(const name of ['supervisor_table_foundation','supervisor_rpc_rollout','supervisor_payroll_preview',...(order==='historical-first'?['historical_external_worker_payroll','supervisor_payroll_ledger']:['supervisor_payroll_ledger','historical_external_worker_payroll']),'paid_period_assertion_adjustments'])await admin.query(`BEGIN; ${sql(name)} COMMIT;`);
  await admin.query(`INSERT INTO public.workers VALUES ('${sup}','Supervisor','Supervisor','none',600,'daily',true)`);
  for(const [i,date] of ['2024-12-01','2024-09-01'].entries())await admin.query("INSERT INTO public.supervisor_daily_attendance(id,supervisor_id,work_date,work_status,status,submitted_at,reviewed_by,reviewed_at) VALUES($1,$2,$3,'present','approved',now(),$4,now())",[id(i+1),sup,date,founder]);
  await first.query(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'; SET lock_timeout='4s'`);await second.query("SET lock_timeout='4s'");
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),first?.end(),second?.end()]);});
 const prep=async(start:string)=>(await first.query<{v:unknown}>('SELECT public.supervisor_period_prepare($1,$2) v',[sup,start])).rows[0].v;
 const create=(c:Client,key:string,start:string,expected:unknown)=>c.query('SELECT public.create_supervisor_period_draft($1,$2,$3,600,$4)',[key,sup,start,JSON.stringify(expected)]);
 const histReview=async(person:string,start:string)=>(await first.query<{v:{worker:unknown;supervisor_periods:number}}>('SELECT public.historical_external_worker_review($1,$2) v',[person,start])).rows[0].v;
 const hist=(c:Client,key:string,person:string,start:string,expected:unknown)=>c.query('SELECT public.record_historical_external_worker_payroll($1,$2,$3,$3::date+6,600,0,0,600,$4,$5,true)',[key,person,start,'Ledger',JSON.stringify(expected)]);
 it('serializes Supervisor entry before a role change and blocks the later worker claim',async()=>{
  const start='2024-12-01',expected=await prep(start);await first.query('BEGIN');await second.query('BEGIN');try{
   await create(first,id(10),start,expected);let done=false;const role=second.query("UPDATE public.users SET role='founder' WHERE id=$1",[sup]).finally(()=>{done=true;});await pause();expect(done).toBe(false);await first.query('COMMIT');await role;await second.query("UPDATE public.workers SET position='Mason' WHERE id=$1",[sup]);await second.query('COMMIT');
   const review=await histReview(sup,start);expect(review.supervisor_periods).toBe(1);await expect(hist(first,id(11),sup,start,review.worker)).rejects.toMatchObject({code:'22023'});
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('serializes a historical claim before a role change and blocks the later Supervisor period',async()=>{
  const start='2024-09-01',expected=await histReview(sup,start);await first.query('BEGIN');await second.query('BEGIN');try{
   await hist(first,id(12),sup,start,expected.worker);let done=false;const role=second.query("UPDATE public.users SET role='supervisor' WHERE id=$1",[sup]).finally(()=>{done=true;});await pause();expect(done).toBe(false);await first.query('COMMIT');await role;await second.query("UPDATE public.workers SET position='Supervisor' WHERE id=$1",[sup]);await second.query('COMMIT');
   const plan=await prep(start);expect(plan).toMatchObject({historical_worker_conflicts:1});await expect(create(first,id(13),start,plan)).rejects.toMatchObject({code:'22023'});
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('serializes competing original-period cases and exact retries',async()=>{
  const start='2024-12-08',review=await histReview(worker,start);await hist(first,id(20),worker,start,review.worker);
  const snapshot=(await first.query<{v:{snapshot:unknown}}>("SELECT public.paid_period_assertion_case_list('external_worker',$1) v",[id(20)])).rows[0].v.snapshot;
  await second.query(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'`);await first.query('BEGIN');await second.query('BEGIN');try{
   const open=(c:Client,key:string)=>c.query<{v:{replayed:boolean}}>("SELECT public.open_paid_period_assertion_case($1,'external_worker',$2,$3,50,'Review') v",[key,id(20),JSON.stringify(snapshot)]);
   await open(first,id(21));let done=false;const wait=open(second,id(21)).finally(()=>{done=true;});await pause();expect(done).toBe(false);await first.query('COMMIT');expect((await wait).rows[0].v.replayed).toBe(true);await second.query('COMMIT');await expect(open(second,id(22))).rejects.toMatchObject({code:'22023'});
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('rolls back an audit failure and allows an exact retry on PostgreSQL',async()=>{
  const start='2024-11-10',review=await histReview(worker,start);await hist(first,id(40),worker,start,review.worker);const snapshot=(await first.query<{v:{snapshot:unknown}}>("SELECT public.paid_period_assertion_case_list('external_worker',$1) v",[id(40)])).rows[0].v.snapshot;
  await admin.query("CREATE FUNCTION public.test_reject_case_event() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'simulated audit failure'; END$$; CREATE TRIGGER test_reject_case_event BEFORE INSERT ON public.paid_period_assertion_case_events FOR EACH ROW EXECUTE FUNCTION public.test_reject_case_event()");
  const open=()=>first.query("SELECT public.open_paid_period_assertion_case($1,'external_worker',$2,$3,25,'Audit check')",[id(41),id(40),JSON.stringify(snapshot)]);try{await expect(open()).rejects.toThrow(/simulated audit failure/);expect((await admin.query('SELECT count(*)::int n FROM public.paid_period_assertion_cases WHERE id=$1',[id(41)])).rows[0].n).toBe(0);}finally{await admin.query('DROP TRIGGER test_reject_case_event ON public.paid_period_assertion_case_events; DROP FUNCTION public.test_reject_case_event()');}
  await open();const replay=await open();expect(replay.rows[0].open_paid_period_assertion_case.replayed).toBe(true);expect((await admin.query('SELECT count(*)::int n FROM public.paid_period_assertion_case_events WHERE case_id=$1',[id(41)])).rows[0].n).toBe(1);
 });
 it('serializes contradictory final decisions and rejects repeatable-read writers',async()=>{
  await first.query('BEGIN');await second.query('BEGIN');try{
   await first.query("SELECT public.resolve_paid_period_assertion_case($1,'no_transfer',NULL,'Reviewed',true)",[id(21)]);let done=false;const wait=second.query("SELECT public.resolve_paid_period_assertion_case($1,'settled_external','2024-12-20','Paid',true)",[id(21)]).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{done=true;});await pause();expect(done).toBe(false);await first.query('COMMIT');expect((await wait).code).toBe('22023');await second.query('ROLLBACK');
   const history=(await first.query<{v:{items:{status:string}[]}}>("SELECT public.paid_period_assertion_case_list('external_worker',$1) v",[id(20)])).rows[0].v;expect(history.items[0].status).toBe('no_transfer');
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
  await first.query('BEGIN ISOLATION LEVEL REPEATABLE READ');try{await expect(first.query("SELECT public.resolve_paid_period_assertion_case($1,'no_transfer',NULL,'Reviewed',true)",[id(21)])).rejects.toMatchObject({code:'P1002'});}finally{await first.query('ROLLBACK');}
 });
 it('rejects decisions after frozen Supervisor source details change without changing the amount',async()=>{
  await first.query("SELECT public.transition_supervisor_period_payroll($1,$2,'approved',NULL,true)",[id(50),id(10)]);await first.query("SELECT public.transition_supervisor_period_payroll($1,$2,'recorded_paid','2024-12-15',true)",[id(51),id(10)]);
  const original=(await first.query("SELECT public.paid_period_assertion_case_list('supervisor',$1) v",[id(10)])).rows[0].v.snapshot;await first.query("SELECT public.open_paid_period_assertion_case($1,'supervisor',$2,$3,5,'Review')",[id(52),id(10),JSON.stringify(original)]);
  await admin.query("UPDATE public.supervisor_period_payroll SET source_snapshot=source_snapshot||'{\"changed\":true}'::jsonb WHERE id=$1",[id(10)]);
  const current=(await first.query("SELECT public.paid_period_assertion_case_list('supervisor',$1) v",[id(10)])).rows[0].v.snapshot;expect(current.details.source_fingerprint).not.toBe(original.details.source_fingerprint);expect(current.gross).toBe(original.gross);
  await expect(first.query("SELECT public.resolve_paid_period_assertion_case($1,'no_transfer',NULL,'Reviewed',true)",[id(52)])).rejects.toMatchObject({code:'40001'});
 });

});
