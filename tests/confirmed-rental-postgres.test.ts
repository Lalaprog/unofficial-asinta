// Only runs against this named empty local PostgreSQL database.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {args,call,expense,fixture,founder,roles,site} from './helpers/rental-fixture';
const url=process.env.CONFIRMED_RENTAL_TEST_DATABASE_URL;
const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
let admin:Client,a:Client,b:Client;
const delay=()=>new Promise(resolve=>setTimeout(resolve,150));
(url?describe:describe.skip)('confirmed rental race tests on isolated PostgreSQL',()=>{
 beforeAll(async()=>{
  const p=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(p.hostname)||p.pathname!=='/asinta_test_confirmed_rental'||p.search||p.hash)throw new Error('Use only empty local asinta_test_confirmed_rental');
  admin=new Client({connectionString:url});a=new Client({connectionString:url});b=new Client({connectionString:url});await Promise.all([admin.connect(),a.connect(),b.connect()]);
  const r=await admin.query("SELECT (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')) objects,(SELECT count(*)::int FROM pg_namespace WHERE nspname='auth') schemas");if(r.rows[0].objects||r.rows[0].schemas)throw new Error('Database must be empty');
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END $$;");
  await admin.query(fixture.slice(roles.length));await admin.query(`BEGIN; ${readFileSync('supabase/drafts/confirmed_rental_expense_link.sql','utf8')} COMMIT;`);
  await Promise.all([a.query(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'; SET lock_timeout='5s'`),b.query(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'; SET lock_timeout='5s'`)]);
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),a?.end(),b?.end()]);});
 it('serializes confirmations and blocks an old expense change',async()=>{
  await a.query('BEGIN');await b.query('BEGIN');try{
   await a.query(call,args(id(10)));expect((await b.query('SELECT public.rental_confirmation_status($1) v',[id(10)])).rows[0].v).toEqual({found:false});let settled=false;
   const pending=b.query('UPDATE public.expenses SET amount=5 WHERE id=$1',[expense]).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{settled=true;});
   await delay();expect(settled).toBe(false);await a.query('COMMIT');expect((await pending).code).toBe('23514');await b.query('ROLLBACK');
   expect((await b.query('SELECT public.rental_confirmation_status($1) v',[id(10)])).rows[0].v).toMatchObject({found:true,id:id(10),expense,amount:'1234.50'});
   await expect(b.query(call,args(id(11)))).rejects.toMatchObject({code:'23505'});expect((await b.query(call,args(id(10)))).rows[0].v.replayed).toBe(true);
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');}
 },15000);
 it('rejects stale expense snapshots after a concurrent old-client edit',async()=>{
  const e=id(20);await admin.query("INSERT INTO public.expenses(id,project_id,description,category,amount,expense_date,receipt_url,ai_bale_detection) VALUES($1,$2,'Excavator hire','equipment',1234.50,'2026-10-14',NULL,false)",[e,site]);
  await a.query('BEGIN');await b.query('BEGIN');try{
   await a.query('UPDATE public.expenses SET amount=900 WHERE id=$1',[e]);let settled=false;
   const pending=b.query(call,args(id(21),e)).then(()=>({code:'success'}),(err:{code:string})=>({code:err.code})).finally(()=>{settled=true;});
   await delay();expect(settled).toBe(false);await a.query('COMMIT');expect((await pending).code).toBe('40001');await b.query('ROLLBACK');
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');}
 },15000);
 it('does not allow competing confirmations for the same expense',async()=>{
  const e=id(25);await admin.query("INSERT INTO public.expenses(id,project_id,description,category,amount,expense_date,receipt_url,ai_bale_detection) VALUES($1,$2,'Excavator hire','equipment',1234.50,'2026-10-14',NULL,false)",[e,site]);
  await a.query('BEGIN');await b.query('BEGIN');try{
   await a.query(call,args(id(26),e));let settled=false;
   const pending=b.query(call,args(id(27),e)).then(()=>({code:'success'}),(err:{code:string})=>({code:err.code})).finally(()=>{settled=true;});
   await delay();expect(settled).toBe(false);await a.query('COMMIT');expect((await pending).code).toBe('23505');await b.query('ROLLBACK');
   expect((await admin.query('SELECT count(*)::int n FROM public.confirmed_rental_expenses WHERE expense_id=$1',[e])).rows[0].n).toBe(1);
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');}
 },15000);
 it('invalidates a repeatable-read writer snapshot predating a confirmation',async()=>{
  const e=id(30);await admin.query("INSERT INTO public.expenses(id,project_id,description,category,amount,expense_date,receipt_url,ai_bale_detection) VALUES($1,$2,'Excavator hire','equipment',1234.50,'2026-10-14',NULL,false)",[e,site]);
  await b.query('BEGIN ISOLATION LEVEL REPEATABLE READ');try{
   await b.query('SELECT amount FROM public.expenses WHERE id=$1',[e]);await a.query(call,args(id(31),e));
   await expect(b.query('UPDATE public.expenses SET amount=7 WHERE id=$1',[e])).rejects.toMatchObject({code:'40001'});
  }finally{await b.query('ROLLBACK');}
 },15000);
 it('serializes exact same confirmation retry without duplicate rental rows',async()=>{
  const e=id(40);await admin.query("INSERT INTO public.expenses(id,project_id,description,category,amount,expense_date,receipt_url,ai_bale_detection) VALUES($1,$2,'Excavator hire','equipment',1234.50,'2026-10-14',NULL,false)",[e,site]);
  await a.query('BEGIN');await b.query('BEGIN');try{
   await a.query(call,args(id(41),e));let settled=false;const pending=b.query(call,args(id(41),e)).finally(()=>{settled=true;});await delay();expect(settled).toBe(false);await a.query('COMMIT');expect((await pending).rows[0].v.replayed).toBe(true);await b.query('COMMIT');
   expect((await admin.query('SELECT count(*)::int n FROM public.confirmed_rental_expenses WHERE expense_id=$1',[e])).rows[0].n).toBe(1);
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');}
 },15000);
});
