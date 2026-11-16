// Opt-in synthetic rehearsal: use only an empty local disposable database.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
import {buildSupervisorPreview,parseSupervisorPreview} from '@/lib/payroll/supervisorPreview';
const url=process.env.SUPERVISOR_CONNECTED_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const founder='00000000-0000-0000-0000-000000000001',sup='00000000-0000-0000-0000-000000000002',siteB='00000000-0000-0000-0000-000000000005';
const id=(n:number)=>`60000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let admin:Client,writer:Client,reader:Client;
suite('Supervisor planning snapshots with concurrent transactions on PostgreSQL',()=>{
 beforeAll(async()=>{
  const parsed=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||!parsed.pathname.slice(1).startsWith('asinta_test_')||parsed.search||parsed.hash)throw Error('Use an empty local disposable asinta_test_* database without URL options');
  admin=new Client({connectionString:url});writer=new Client({connectionString:url});reader=new Client({connectionString:url});await Promise.all([admin.connect(),writer.connect(),reader.connect()]);
  const found=(await admin.query(`SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S'))::int objects,(SELECT count(*) FROM pg_namespace WHERE nspname IN ('auth','storage','app_private'))::int schemas`)).rows[0];if(found.objects||found.schemas)throw Error('Test database must be empty');
  await admin.query("DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END$$");
  const roles='CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; ';if(!baseFixture.startsWith(roles))throw Error('Fixture bootstrap changed');await admin.query(baseFixture.slice(roles.length));
  for(const name of ['supervisor_table_foundation','supervisor_rpc_rollout','supervisor_leave_notification','supervisor_payroll_preview'])await admin.query(`BEGIN; ${readFileSync(`supabase/drafts/${name}.sql`,'utf8')} COMMIT;`);
  await admin.query(`INSERT INTO public.workers VALUES ('${sup}','Supervisor','Supervisor','none',600,'daily',true); INSERT INTO public.project_supervisors VALUES ('${siteB}','${sup}');`);
  await Promise.all([writer.query(`SET ROLE authenticated; SET test.uid='${sup}'; SET test.assurance='yes'`),reader.query(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'`)]);
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),writer?.end(),reader?.end()]);});
 it('shows committed state only and requires reload after an unseen concurrent leave submission',async()=>{
  const before=(await admin.query('SELECT (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.payroll p) payroll,(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.attendance a) attendance,(SELECT count(*)::int FROM public.advances) advances')).rows[0];
  const calc=async()=>{const raw=(await reader.query<{v:unknown}>("SELECT public.supervisor_payroll_preview_inputs($1,'2024-12-01') v",[sup])).rows[0].v;const parsed=parseSupervisorPreview(raw,sup,'2024-12-01');return buildSupervisorPreview(parsed,'600',parsed.as_of);};
  const count=async()=>(await reader.query<{v:{pending_count:number}}>('SELECT public.supervisor_leave_pending_summary() v')).rows[0].v.pending_count;
  await writer.query("SELECT public.submit_supervisor_day($1,'2024-12-01','present')",[id(1)]);await writer.query("SELECT public.submit_supervisor_leave($1,'2024-12-02','2024-12-02','emergency','')",[id(2)]);
  await reader.query("SELECT public.review_supervisor_day($1,'approved')",[id(1)]);expect(await count()).toBe(1);expect((await calc()).gross).toBeNull();
  await writer.query(`SET test.uid='${founder}'; BEGIN`);try{
   await writer.query("SELECT public.review_supervisor_leave($1,'approved')",[id(2)]);expect(await count()).toBe(1);expect((await calc()).gross).toBeNull();
   await writer.query('COMMIT');expect(await count()).toBe(0);const value=await calc();expect(value.gross).toBe('600.00');expect(value.days.find(x=>x.date==='2024-12-02')?.label).toBe('Approved leave · unpaid');
  }finally{await writer.query('ROLLBACK');}
  await writer.query(`SET test.uid='${sup}'; BEGIN`);try{
   await writer.query("SELECT public.submit_supervisor_leave($1,'2024-12-01','2024-12-01','emergency','')",[id(3)]);
   // MVCC cannot reveal another transaction's uncommitted request; this
   // illustrative amount is therefore a snapshot, never a payment authority.
   expect(await count()).toBe(0);expect((await calc()).gross).toBe('600.00');await writer.query('COMMIT');
   expect(await count()).toBe(1);expect((await calc()).gross).toBeNull();
   await expect(reader.query("SELECT public.review_supervisor_leave($1,'approved')",[id(3)])).rejects.toThrow(/Approved daily attendance/);await reader.query("SELECT public.review_supervisor_leave($1,'rejected')",[id(3)]);expect((await calc()).gross).toBe('600.00');
  }finally{await writer.query('ROLLBACK');}
  expect((await admin.query('SELECT (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.payroll p) payroll,(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.attendance a) attendance,(SELECT count(*)::int FROM public.advances) advances')).rows[0]).toEqual(before);
 },15000);
});
