// Opt-in: creates schema and synthetic rows in an EMPTY local disposable database.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const url=process.env.PAID_ADJUSTMENT_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const founder='00000000-0000-0000-0000-000000000001',voucher='00000000-0000-0000-0000-000000000003';
const one='10000000-0000-0000-0000-000000000001',two='10000000-0000-0000-0000-000000000002';
let admin:Client,first:Client,second:Client,expected:unknown;
const pause=()=>new Promise(resolve=>setTimeout(resolve,150));
const open=(c:Client,id:string)=>c.query('SELECT public.open_paid_payroll_adjustment($1,$2,$3,$4,$5) data',[id,voucher,expected,'50.25','Missed OT']);
const resolve=(c:Client,resolution:string,date:string|null)=>c.query('SELECT public.resolve_paid_payroll_adjustment($1,$2,$3,$4) data',[one,resolution,date,'Founder verified']);

suite('paid adjustment concurrent actions on PostgreSQL 17',()=>{
 beforeAll(async()=>{
  const parsed=new URL(url!);
  if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||!parsed.pathname.slice(1).startsWith('asinta_test_')||parsed.search||parsed.hash)throw new Error('Use an empty local disposable cluster/database named asinta_test_* without URL options.');
  admin=new Client({connectionString:url});first=new Client({connectionString:url});second=new Client({connectionString:url});await Promise.all([admin.connect(),first.connect(),second.connect()]);
  const existing=(await admin.query(`SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S'))::int objects, (SELECT count(*) FROM pg_namespace WHERE nspname IN ('auth','app_private','storage'))::int schemas`)).rows[0];
  if(existing.objects||existing.schemas)throw new Error('Use an empty disposable database.');
  await admin.query(`DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END$$;`);
  const roles='CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; ';if(!baseFixture.startsWith(roles))throw new Error('Fixture role bootstrap changed');
  await admin.query(baseFixture.slice(roles.length));
  await admin.query(readFileSync('supabase/drafts/paid_payroll_adjustments.sql','utf8'));
  expected=(await admin.query('SELECT app_private.paid_adjustment_voucher_snapshot(p) snapshot FROM public.payroll p WHERE id=$1',[voucher])).rows[0].snapshot;
  await Promise.all([first.query(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'; SET lock_timeout='4s'`),second.query(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'; SET lock_timeout='4s'`)]);
 },30000);
 beforeEach(async()=>{await admin.query('DELETE FROM public.paid_payroll_adjustment_cases');});
 afterAll(async()=>{await Promise.all([admin?.end(),first?.end(),second?.end()]);});
 it('serializes separate pending cases for the same paid voucher',async()=>{
  await first.query('BEGIN');await second.query('BEGIN');
  try{
   await open(first,one);let finished=false;
   const competing=open(second,two).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{finished=true});
   await pause();expect(finished).toBe(false);await first.query('COMMIT');expect((await competing).code).toBe('22023');await second.query('ROLLBACK');
   expect((await admin.query('SELECT count(*)::int n FROM public.paid_payroll_adjustment_cases')).rows[0].n).toBe(1);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('deduplicates concurrent retries using the same client ID',async()=>{
  await first.query('BEGIN');await second.query('BEGIN');try{
   expect((await open(first,one)).rows[0].data.replayed).toBe(false);let finished=false;const retry=open(second,one).finally(()=>{finished=true});
   await pause();expect(finished).toBe(false);await first.query('COMMIT');expect((await retry).rows[0].data.replayed).toBe(true);await second.query('COMMIT');
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('serializes contradictory resolution attempts instead of overwriting the first',async()=>{
  await open(first,one);await first.query('BEGIN');await second.query('BEGIN');try{
   await resolve(first,'settled_external','2020-01-01');let finished=false;
   const conflicting=resolve(second,'no_transfer',null).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{finished=true});
   await pause();expect(finished).toBe(false);await first.query('COMMIT');expect((await conflicting).code).toBe('22023');await second.query('ROLLBACK');
   expect((await admin.query('SELECT status,settled_on::text FROM public.paid_payroll_adjustment_cases WHERE id=$1',[one])).rows[0]).toEqual({status:'settled_external',settled_on:'2020-01-01'});
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
});
