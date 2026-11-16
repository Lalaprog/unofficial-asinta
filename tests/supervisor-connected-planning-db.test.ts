import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
import {buildSupervisorPreview,parseSupervisorPreview} from '@/lib/payroll/supervisorPreview';
const sql=(name:string)=>readFileSync(`supabase/drafts/${name}.sql`,'utf8');
const founder='00000000-0000-0000-0000-000000000001',sup='00000000-0000-0000-0000-000000000002';
const siteA='00000000-0000-0000-0000-000000000004',siteB='00000000-0000-0000-0000-000000000005';
const id=(n:number)=>`50000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

describe('connected Supervisor day, leave, queue and planning candidates (synthetic only)',()=>{
 it('counts one person across two sites, blocks pending and conflicting leave, and leaves finance untouched',async()=>{
  const db=new PGlite();try{
   await db.exec(baseFixture);await db.exec(`BEGIN; ${sql('supervisor_table_foundation')} COMMIT;`);await db.exec(`BEGIN; ${sql('supervisor_rpc_rollout')} COMMIT;`);await db.exec(`BEGIN; ${sql('supervisor_leave_notification')} COMMIT;`);await db.exec(`BEGIN; ${sql('supervisor_payroll_preview')} COMMIT;`);
   await db.exec(`INSERT INTO public.workers VALUES ('${sup}','Supervisor','Supervisor','none',600,'daily',true); INSERT INTO public.project_supervisors VALUES ('${siteB}','${sup}')`);
   const before=(await db.query('SELECT (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.payroll p) payroll,(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.attendance a) attendance,(SELECT count(*)::int FROM public.advances) advances,(SELECT count(*)::int FROM public.expenses) expenses')).rows[0];
   await db.exec(`SET test.uid='${sup}'; SET test.assurance='yes'; SET ROLE authenticated;`);
   await db.query("SELECT public.submit_supervisor_day($1,'2024-12-01','present')",[id(1)]);await db.query("SELECT public.submit_supervisor_day($1,'2024-12-02','half_day')",[id(2)]);await db.query("SELECT public.submit_supervisor_day($1,'2024-12-03','present')",[id(3)]);
   await db.query("SELECT public.submit_supervisor_leave($1,'2024-12-03','2024-12-03','emergency','')",[id(4)]);
   await db.exec(`SET test.uid='${founder}';`);
   const count=async()=>(await db.query<{v:{pending_count:number}}>('SELECT public.supervisor_leave_pending_summary() v')).rows[0].v.pending_count;
   const calc=async()=>{const raw=(await db.query<{v:unknown}>("SELECT public.supervisor_payroll_preview_inputs($1,'2024-12-01') v",[sup])).rows[0].v;const parsed=parseSupervisorPreview(raw,sup,'2024-12-01');return buildSupervisorPreview(parsed,'655.55',parsed.as_of);};
   expect(await count()).toBe(1);expect((await calc()).gross).toBeNull();
   const list=(await db.query<{v:{items:{id:string;sites:{id:string;has_entries:boolean}[]}[]}}>('SELECT public.supervisor_day_list() v')).rows[0].v;
   expect(list.items.find(x=>x.id===id(1))?.sites).toEqual([{id:siteA,name:'Site One',has_entries:false},{id:siteB,name:'Site Two',has_entries:false}]);
   await db.query("SELECT public.review_supervisor_day($1,'approved')",[id(1)]);await db.query("SELECT public.review_supervisor_day($1,'approved')",[id(2)]);
   expect((await calc()).gross).toBeNull();
   // Founder can approve while both site indicators are empty; then conflicting leave is blocked.
   await db.query("SELECT public.review_supervisor_day($1,'approved')",[id(3)]);await expect(db.query("SELECT public.review_supervisor_leave($1,'approved')",[id(4)])).rejects.toThrow(/Approved daily attendance/);
   expect(await count()).toBe(1);expect((await calc()).gross).toBeNull();await db.query("SELECT public.review_supervisor_leave($1,'rejected')",[id(4)]);expect(await count()).toBe(0);
   const estimate=await calc();expect(estimate.gross).toBe('1638.88');expect(estimate.halfDayUnits).toBe(5n);expect(estimate.unmarkedPast).toBe(12);
   await db.exec(`SET test.uid='${sup}';`);await db.query("SELECT public.submit_supervisor_leave($1,'2024-12-04','2024-12-05','emergency','')",[id(5)]);await db.exec(`SET test.uid='${founder}';`);
   expect(await count()).toBe(1);expect((await calc()).gross).toBeNull();await db.query("SELECT public.review_supervisor_leave($1,'approved')",[id(5)]);expect(await count()).toBe(0);
   const afterLeave=await calc();expect(afterLeave.gross).toBe('1638.88');expect(afterLeave.days.find(d=>d.date==='2024-12-04')?.label).toBe('Approved leave · unpaid');
   await db.exec('RESET ROLE');expect((await db.query('SELECT (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.payroll p) payroll,(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.attendance a) attendance,(SELECT count(*)::int FROM public.advances) advances,(SELECT count(*)::int FROM public.expenses) expenses')).rows[0]).toEqual(before);
  }finally{await db.close();}
 },30000);
});
