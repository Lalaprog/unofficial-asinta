// Opt-in: synthetic records in an empty local disposable PostgreSQL database.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const url=process.env.HISTORICAL_EXTERNAL_WORKER_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const founder='00000000-0000-0000-0000-000000000001',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004';
const id=(n:number)=>`91000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let admin:Client,first:Client,second:Client;
const pause=()=>new Promise(resolve=>setTimeout(resolve,150));
suite('external historical worker assertions and finance races on PostgreSQL',()=>{
 beforeAll(async()=>{
  const u=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||!u.pathname.slice(1).startsWith('asinta_test_')||u.search||u.hash)throw Error('Use an empty local asinta_test_* database without URL options');
  admin=new Client({connectionString:url});first=new Client({connectionString:url});second=new Client({connectionString:url});await Promise.all([admin.connect(),first.connect(),second.connect()]);
  const o=(await admin.query(`SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S'))::int objects,(SELECT count(*) FROM pg_namespace WHERE nspname IN ('auth','app_private','storage'))::int schemas`)).rows[0];if(o.objects||o.schemas)throw Error('Database must be empty');
  await admin.query("DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END$$;");
  const roles='CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; ';if(!baseFixture.startsWith(roles))throw Error('Fixture bootstrap changed');await admin.query(baseFixture.slice(roles.length));
  await admin.query(`BEGIN; ${readFileSync('supabase/drafts/historical_external_worker_payroll.sql','utf8')} COMMIT;`);
  await first.query(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'; SET lock_timeout='4s'`);await second.query("SET lock_timeout='4s'");
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),first?.end(),second?.end()]);});
 const reviewed=async(start:string)=>(await first.query<{v:{worker:unknown}}>('SELECT public.historical_external_worker_review($1,$2) v',[worker,start])).rows[0].v.worker;
 const record=(c:Client,key:string,start:string,expected:unknown)=>c.query<{v:{replayed:boolean}}>('SELECT public.record_historical_external_worker_payroll($1,$2,$3,$3::date+6,600,100,0,500,$4,$5,true) v',[key,worker,start,'External ledger checked',JSON.stringify(expected)]);
 const insertPayroll=(c:Client,key:string,start:string)=>c.query("INSERT INTO public.payroll(id,worker_id,period_start,period_end,status) VALUES($1,$2,$3,$3::date+6,'draft')",[key,worker,start]);
 const insertBale=(c:Client,key:string,start:string)=>c.query("INSERT INTO public.advances(id,worker_id,project_id,date,amount,amount_deducted,status) VALUES($1,$2,$3,$4::date+3,100,0,'active')",[key,worker,site,start]);
 for(const type of ['payroll','bale'] as const)for(const winner of ['evidence','legacy'] as const){
  const n=(type==='payroll'?0:2)+(winner==='evidence'?0:1),start=['2024-11-03','2024-11-10','2024-11-17','2024-11-24'][n];
  it(`serializes ${type} against evidence when ${winner} commits first`,async()=>{
   const expected=await reviewed(start),insert=type==='payroll'?insertPayroll:insertBale;
   await first.query('BEGIN');await second.query('BEGIN');try{
    if(winner==='evidence'){
     expect((await record(first,id(n+1),start,expected)).rows[0].v.replayed).toBe(false);let done=false;
     const attempt=insert(second,id(n+21),start).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{done=true});await pause();expect(done).toBe(false);await first.query('COMMIT');expect((await attempt).code).toBe('22023');await second.query('ROLLBACK');
     expect((await record(first,id(n+1),start,expected)).rows[0].v.replayed).toBe(true);
    }else{
     await insert(second,id(n+21),start);let done=false;const attempt=record(first,id(n+1),start,expected).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{done=true});await pause();expect(done).toBe(false);await second.query('COMMIT');expect((await attempt).code).toBe('22023');await first.query('ROLLBACK');
    }
    const rows=(await admin.query<{n:number}>('SELECT count(*)::int n FROM public.historical_external_worker_payroll WHERE period_start=$1',[start])).rows[0].n;expect(rows).toBe(winner==='evidence'?1:0);
   }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
  },15000);
 }
 it('serializes simultaneous assertions and replays only an identical request',async()=>{
  const start='2024-10-20',expected=await reviewed(start);await second.query(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'`);
  await first.query('BEGIN');await second.query('BEGIN');try{
   await record(first,id(11),start,expected);let done=false;const waiting=record(second,id(11),start,expected).finally(()=>{done=true;});await pause();expect(done).toBe(false);await first.query('COMMIT');expect((await waiting).rows[0].v.replayed).toBe(true);await second.query('COMMIT');
   await expect(record(second,id(12),start,expected)).rejects.toMatchObject({code:'22023'});
   expect((await admin.query<{n:number}>('SELECT count(*)::int n FROM public.historical_external_worker_events WHERE request_id=$1',[id(11)])).rows[0].n).toBe(1);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');await second.query('RESET ROLE');}
 });
 it('rechecks Founder access after waiting for a concurrent role change',async()=>{
  const start='2024-10-13',expected=await reviewed(start);await second.query('BEGIN');try{
   await second.query("UPDATE public.users SET role='supervisor' WHERE id=$1",[founder]);let done=false;const waiting=record(first,id(13),start,expected).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{done=true;});await pause();expect(done).toBe(false);await second.query('COMMIT');expect((await waiting).code).toBe('42501');
  }finally{await second.query('ROLLBACK');await admin.query("UPDATE public.users SET role='founder' WHERE id=$1",[founder]);}
 });
 it('rejects repeatable-read legacy and evidence writers',async()=>{
  const expected=await reviewed('2024-12-01');await first.query('BEGIN ISOLATION LEVEL REPEATABLE READ');try{await expect(record(first,id(10),'2024-12-01',expected)).rejects.toMatchObject({code:'P1002'});}finally{await first.query('ROLLBACK');}
  await second.query('BEGIN ISOLATION LEVEL REPEATABLE READ');try{await expect(insertPayroll(second,id(30),'2024-12-01')).rejects.toMatchObject({code:'P1002'});}finally{await second.query('ROLLBACK');}
 });
});
