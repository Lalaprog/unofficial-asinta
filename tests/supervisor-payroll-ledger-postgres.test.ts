// Opt in only against a newly created empty local disposable PostgreSQL database.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const url=process.env.SUPERVISOR_LEDGER_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const founder='00000000-0000-0000-0000-000000000001',sup='00000000-0000-0000-0000-000000000002';
const id=(n:number)=>`78000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sql=(name:string)=>readFileSync(`supabase/drafts/${name}.sql`,'utf8');
let admin:Client,first:Client,second:Client;
const pause=()=>new Promise(r=>setTimeout(r,150));
suite('Supervisor ledger concurrency on isolated PostgreSQL',()=>{
 beforeAll(async()=>{
  const u=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||!u.pathname.slice(1).startsWith('asinta_test_')||u.search||u.hash)throw Error('Use empty local asinta_test_* database without options');
  admin=new Client({connectionString:url});first=new Client({connectionString:url});second=new Client({connectionString:url});await Promise.all([admin.connect(),first.connect(),second.connect()]);
  const o=(await admin.query("SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S'))::int objects,(SELECT count(*) FROM pg_namespace WHERE nspname IN ('auth','app_private','storage'))::int schemas")).rows[0];if(o.objects||o.schemas)throw Error('Database must be empty');
  await admin.query("DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END$$;");
  const roles='CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; ';if(!baseFixture.startsWith(roles))throw Error('Fixture bootstrap changed');await admin.query(baseFixture.slice(roles.length));
  for(const name of ['supervisor_table_foundation','supervisor_rpc_rollout','supervisor_payroll_preview','supervisor_payroll_ledger'])await admin.query(`BEGIN; ${sql(name)} COMMIT;`);
  await admin.query(`INSERT INTO public.workers VALUES ('${sup}','Supervisor','Supervisor','none',600,'daily',true)`);
  for(const [n,date] of ['2024-10-01','2024-10-16','2024-11-01','2024-11-16','2024-12-01','2024-12-16','2025-01-01'].entries())await admin.query("INSERT INTO public.supervisor_daily_attendance(id,supervisor_id,work_date,work_status,status,submitted_at,reviewed_by,reviewed_at) VALUES($1,$2,$3,'present','approved',now(),$4,now())",[id(n+1),sup,date,founder]);
  await first.query(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'; SET lock_timeout='4s'`);await second.query("SET lock_timeout='4s'");
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),first?.end(),second?.end()]);});
 const prep=async(start:string)=>(await first.query<{v:unknown}>('SELECT public.supervisor_period_prepare($1,$2) v',[sup,start])).rows[0].v;
 const create=(c:Client,key:string,start:string,expected:unknown)=>c.query<{v:{replayed:boolean}}>('SELECT public.create_supervisor_period_draft($1,$2,$3,600,$4) v',[key,sup,start,JSON.stringify(expected)]);
 const legacy=(c:Client,key:string,start:string)=>c.query("INSERT INTO public.payroll(id,worker_id,period_start,period_end,status) VALUES($1,$2,$3,$3::date+14,'draft')",[key,sup,start]);
 const change=(c:Client,request:string,payroll:string,action:string,paid:string|null=null)=>c.query('SELECT public.transition_supervisor_period_payroll($1,$2,$3,$4,true)',[request,payroll,action,paid]);
 for(const winner of ['ledger','legacy'] as const){it(`serializes legacy vouchers when ${winner} wins`,async()=>{
  const start=winner==='ledger'?'2024-10-01':'2024-10-16',expected=await prep(start);await first.query('BEGIN');await second.query('BEGIN');try{
   if(winner==='ledger'){await create(first,id(20),start,expected);let done=false;const attempt=legacy(second,id(30),start).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{done=true;});await pause();expect(done).toBe(false);await first.query('COMMIT');expect((await attempt).code).toBe('22023');await second.query('ROLLBACK');}
   else {await legacy(second,id(31),start);let done=false;const attempt=create(first,id(21),start,expected).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{done=true;});await pause();expect(done).toBe(false);await second.query('COMMIT');expect((await attempt).code).toBe('22023');await first.query('ROLLBACK');}
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);}
 for(const winner of ['payment','leave'] as const){it(`keeps late leave in its original period when ${winner} wins`,async()=>{
  const start=winner==='payment'?'2024-11-01':'2024-11-16',leaveDate=winner==='payment'?'2024-11-02':'2024-11-17',key=winner==='payment'?id(22):id(23),expected=await prep(start);await create(first,key,start,expected);await change(first,winner==='payment'?id(32):id(33),key,'approved');
  await second.query(`SET ROLE authenticated; SET test.uid='${sup}'; SET test.assurance='yes'`);await first.query('BEGIN');await second.query('BEGIN');try{
   if(winner==='payment'){
    await change(first,id(42),key,'recorded_paid',start);let done=false;const attempt=second.query("SELECT public.submit_supervisor_leave($1,$2,$2,'emergency','Late')",[id(52),leaveDate]).finally(()=>{done=true;});await pause();expect(done).toBe(false);await first.query('COMMIT');await attempt;await second.query('COMMIT');
    const result=(await first.query<{v:{status:string;source_changed:boolean}}>('SELECT public.supervisor_period_payroll_review($1,$2) v',[sup,start])).rows[0].v;expect(result).toMatchObject({status:'paid',source_changed:true});
   }else{
    await second.query("SELECT public.submit_supervisor_leave($1,$2,$2,'emergency','Late')",[id(53),leaveDate]);let done=false;const attempt=change(first,id(43),key,'recorded_paid',start).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{done=true;});await pause();expect(done).toBe(false);await second.query('COMMIT');expect((await attempt).code).toBe('22023');await first.query('ROLLBACK');
   }
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');await second.query('RESET ROLE');}
 },15000);}
 it('rechecks Founder role after waiting and rejects repeatable read writers',async()=>{
  const start='2024-12-01',expected=await prep(start);await second.query('BEGIN');try{await second.query("UPDATE public.users SET role='supervisor' WHERE id=$1",[founder]);let done=false;const attempt=create(first,id(24),start,expected).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{done=true;});await pause();expect(done).toBe(false);await second.query('COMMIT');expect((await attempt).code).toBe('42501');}finally{await second.query('ROLLBACK');await admin.query("UPDATE public.users SET role='founder' WHERE id=$1",[founder]);}
  await first.query('BEGIN ISOLATION LEVEL REPEATABLE READ');try{await expect(create(first,id(24),start,expected)).rejects.toMatchObject({code:'P1002'});}finally{await first.query('ROLLBACK');}
  await second.query('BEGIN ISOLATION LEVEL REPEATABLE READ');try{await expect(legacy(second,id(34),start)).rejects.toMatchObject({code:'P1002'});}finally{await second.query('ROLLBACK');}
 });
 it('serializes revision actions and exact retries after the coordinated upgrade',async()=>{
  const start='2024-12-16',expected=await prep(start),key=id(80);await create(first,key,start,expected);
  await admin.query(`BEGIN; ${sql('supervisor_payroll_revision')} COMMIT;`);
  await second.query(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'`);
  const act=(c:Client,request:string,revision:string,kind:string,rate:string|null=null,snapshot:unknown=null,reason:string|null=null)=>c.query<{v:{revision:string;replayed:boolean}}>('SELECT public.supervisor_payroll_revision_action($1,$2,$3,$4,$5,$6::jsonb,$7,NULL,true) v',[request,key,revision,kind,rate,snapshot===null?null:JSON.stringify(snapshot),reason]);
  await first.query('BEGIN');await second.query('BEGIN');try{
   await act(first,id(81),'0','approved');let done=false;
   const stale=act(second,id(82),'0','refresh','700',expected,'Rate review').then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{done=true;});
   await pause();expect(done).toBe(false);await first.query('COMMIT');expect((await stale).code).toBe('40001');await second.query('ROLLBACK');
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
  await first.query('BEGIN');await second.query('BEGIN');try{
   const initial=await act(first,id(83),'1','return_to_draft',null,null,'No payment made');let done=false;
   const retry=act(second,id(83),'1','return_to_draft',null,null,'No payment made').finally(()=>{done=true;});await pause();expect(done).toBe(false);await first.query('COMMIT');
   expect(initial.rows[0].v).toMatchObject({revision:'2',replayed:false});expect((await retry).rows[0].v).toMatchObject({revision:'2',replayed:true});await second.query('COMMIT');
   expect((await admin.query<{n:number}>('SELECT count(*)::int n FROM public.supervisor_payroll_revision_events WHERE request_id=$1',[id(83)])).rows[0].n).toBe(1);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');await second.query('RESET ROLE');}
 },15000);

});
