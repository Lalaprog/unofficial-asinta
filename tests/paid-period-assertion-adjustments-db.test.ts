import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
import {parsePeriodCases,samePeriodSnapshot,snapshotFromExternal,snapshotFromSupervisor} from '@/lib/payroll/paidPeriodCases';
import {parseSupervisorLedgerRow} from '@/lib/payroll/supervisorLedger';
import {parseExternalList} from '@/lib/payroll/historicalExternalWorker';
const founder='00000000-0000-0000-0000-000000000001',sup='00000000-0000-0000-0000-000000000002',worker='00000000-0000-0000-0000-000000000003';
const id=(n:number)=>`79000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sql=(name:string)=>readFileSync(`supabase/drafts/${name}.sql`,'utf8');
async function setup(){
 const db=new PGlite();await db.exec(baseFixture);for(const name of ['supervisor_table_foundation','supervisor_rpc_rollout','supervisor_payroll_preview','historical_external_worker_payroll','supervisor_payroll_ledger','paid_period_assertion_adjustments'])await db.exec(`BEGIN; ${sql(name)} COMMIT;`);
 await db.exec(`INSERT INTO public.workers VALUES ('${sup}','Supervisor','Supervisor','none',600,'daily',true); SET ROLE authenticated; SET test.uid='${sup}'; SET test.assurance='yes'`);
 await db.query("SELECT public.submit_supervisor_day($1,'2024-12-01','present')",[id(1)]);await db.exec(`SET test.uid='${founder}'`);await db.query("SELECT public.review_supervisor_day($1,'approved')",[id(1)]);
 const plan=(await db.query<{v:unknown}>("SELECT public.supervisor_period_prepare($1,'2024-12-01') v",[sup])).rows[0].v;
 await db.query("SELECT public.create_supervisor_period_draft($1,$2,'2024-12-01',600,$3)",[id(2),sup,JSON.stringify(plan)]);await db.query("SELECT public.transition_supervisor_period_payroll($1,$2,'approved',NULL,true)",[id(3),id(2)]);await db.query("SELECT public.transition_supervisor_period_payroll($1,$2,'recorded_paid','2024-12-15',true)",[id(4),id(2)]);
 const old=(await db.query<{v:{worker:unknown}}>("SELECT public.historical_external_worker_review($1,'2024-12-01') v",[worker])).rows[0].v;
 await db.query("SELECT public.record_historical_external_worker_payroll($1,$2,'2024-12-01','2024-12-07',600,100,0,500,'Ledger',$3,true)",[id(5),worker,JSON.stringify(old.worker)]);return db;
}
const list=async(db:PGlite,kind:string,source:string)=>(await db.query<{v:{snapshot:unknown;total:number;items:{id:string;status:string;difference:string}[]}}>('SELECT public.paid_period_assertion_case_list($1,$2) v',[kind,source])).rows[0].v;
const open=async(db:PGlite,caseId:string,kind:string,source:string,snapshot:unknown,diff:string,reason='Original source')=>(await db.query<{v:{id:string;status:string;replayed:boolean}}>('SELECT public.open_paid_period_assertion_case($1,$2,$3,$4,$5,$6) v',[caseId,kind,source,JSON.stringify(snapshot),diff,reason])).rows[0].v;
const resolve=async(db:PGlite,caseId:string,decision:string,date:string|null,note:string,ack=true)=>(await db.query<{v:{id:string;status:string;replayed:boolean}}>('SELECT public.resolve_paid_period_assertion_case($1,$2,$3,$4,$5) v',[caseId,decision,date,note,ack])).rows[0].v;
describe('paid Supervisor and external worker original-period cases (uninstalled)',()=>{
 it('reviews both kinds, preserves originals and never carries differences forward',async()=>{
  const db=await setup();try{
   await db.exec('RESET ROLE');const before=(await db.query("SELECT (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.supervisor_period_payroll p) supervisor,(SELECT jsonb_agg(to_jsonb(h) ORDER BY request_id) FROM public.historical_external_worker_payroll h) worker,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.payroll p) payroll,(SELECT count(*)::int FROM public.advances) advances,(SELECT count(*)::int FROM public.expenses) expenses")).rows[0];await db.exec('SET ROLE authenticated');
   const a=await list(db,'supervisor',id(2)),b=await list(db,'external_worker',id(5));expect(a.total).toBe(0);expect(b.total).toBe(0);expect(a.snapshot).toMatchObject({kind:'supervisor',gross:'600.00',paid_on:'2024-12-15'});expect(b.snapshot).toMatchObject({kind:'external_worker',gross:'600.00',net:'500.00',paid_on:'2024-12-07'});
   const sr=(await db.query<{v:unknown}>("SELECT public.supervisor_period_payroll_review($1,'2024-12-01') v",[sup])).rows[0].v;const supervisorRow=parseSupervisorLedgerRow(sr,sup,'2024-12-01');expect(supervisorRow).not.toBeNull();const s=snapshotFromSupervisor(supervisorRow!);expect(samePeriodSnapshot(s,a.snapshot as typeof s)).toBe(true);expect(parsePeriodCases(a,s)).toEqual([]);
   const wr=(await db.query<{v:unknown}>('SELECT public.historical_external_worker_list($1,0) v',[worker])).rows[0].v;const w=snapshotFromExternal(parseExternalList(wr,worker).items[0]);expect(samePeriodSnapshot(w,b.snapshot as typeof w)).toBe(true);expect(parsePeriodCases(b,w)).toEqual([]);
   await expect(open(db,id(10),'supervisor',id(2),{},'10')).rejects.toThrow(/changed/);await expect(open(db,id(10),'supervisor',id(2),a.snapshot,'0')).rejects.toThrow(/Invalid/);
   expect((await open(db,id(10),'supervisor',id(2),a.snapshot,'75.25')).replayed).toBe(false);expect((await open(db,id(10),'supervisor',id(2),a.snapshot,'75.25')).replayed).toBe(true);await expect(open(db,id(11),'supervisor',id(2),a.snapshot,'75.25')).rejects.toThrow(/open case/);
   await expect(resolve(db,id(10),'settled_external','2024-12-14','Paid',true)).rejects.toThrow(/precede/);await expect(resolve(db,id(10),'settled_external','2024-12-16','Paid',false)).rejects.toThrow(/acknowledgement/);
   expect((await resolve(db,id(10),'settled_external','2024-12-16','Externally settled')).replayed).toBe(false);expect((await resolve(db,id(10),'settled_external','2024-12-16','Externally settled')).replayed).toBe(true);await expect(resolve(db,id(10),'no_transfer',null,'Different')).rejects.toThrow(/already resolved/);
   await open(db,id(12),'external_worker',id(5),b.snapshot,'-30');await resolve(db,id(12),'no_transfer',null,'No transfer needed');expect((await list(db,'external_worker',id(5))).items).toMatchObject([{id:id(12),status:'no_transfer',difference:'-30.00'}]);
   await expect(db.query('SELECT * FROM public.paid_period_assertion_cases')).rejects.toThrow(/permission denied/);await db.exec(`SET test.uid='${sup}'`);await expect(list(db,'supervisor',id(2))).rejects.toThrow(/Founder/);await db.exec(`SET test.uid='${founder}'; SET test.assurance='no'`);await expect(list(db,'supervisor',id(2))).rejects.toThrow(/Founder/);await db.exec('RESET ROLE');
   expect((await db.query("SELECT (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.supervisor_period_payroll p) supervisor,(SELECT jsonb_agg(to_jsonb(h) ORDER BY request_id) FROM public.historical_external_worker_payroll h) worker,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.payroll p) payroll,(SELECT count(*)::int FROM public.advances) advances,(SELECT count(*)::int FROM public.expenses) expenses")).rows[0]).toEqual(before);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.paid_period_assertion_case_events')).rows[0].n).toBe(4);await expect(db.exec('DELETE FROM public.paid_period_assertion_case_events')).rejects.toThrow(/immutable/);
  }finally{await db.close();}
 },30000);
 it('refuses resolution if a privileged writer changes the paid source snapshot',async()=>{
  const db=await setup();try{const a=await list(db,'supervisor',id(2));await open(db,id(30),'supervisor',id(2),a.snapshot,'5');await db.exec(`RESET ROLE; UPDATE public.supervisor_period_payroll SET gross=601 WHERE id='${id(2)}'; SET ROLE authenticated`);await expect(resolve(db,id(30),'no_transfer',null,'Reviewed')).rejects.toThrow(/Original paid period changed/);const revised=await list(db,'supervisor',id(2));await expect(open(db,id(31),'supervisor',id(2),revised.snapshot,'10')).rejects.toThrow(/Prior case has a different original period/);await db.exec('RESET ROLE');expect((await db.query<{s:string}>("SELECT status s FROM public.paid_period_assertion_cases WHERE id=$1",[id(30)])).rows[0].s).toBe('pending');
  }finally{await db.close();}
 },30000);
 it('binds cases to frozen Supervisor source details and unmarked days, not just totals',async()=>{
  const db=await setup();try{const old=await list(db,'supervisor',id(2));await db.exec(`RESET ROLE; UPDATE public.supervisor_period_payroll SET source_snapshot=source_snapshot||'{"privileged_change":true}'::jsonb WHERE id='${id(2)}'; SET ROLE authenticated`);
   await expect(open(db,id(32),'supervisor',id(2),old.snapshot,'5')).rejects.toThrow(/Original period changed/);const current=await list(db,'supervisor',id(2));await open(db,id(32),'supervisor',id(2),current.snapshot,'5');
   await db.exec(`RESET ROLE; UPDATE public.supervisor_period_payroll SET unmarked_dates=unmarked_dates||'["2024-12-01"]'::jsonb WHERE id='${id(2)}'; SET ROLE authenticated`);await expect(resolve(db,id(32),'no_transfer',null,'Reviewed')).rejects.toThrow(/Original paid period changed/);expect((await list(db,'supervisor',id(2))).items[0].status).toBe('pending');
  }finally{await db.close();}
 },30000);
 it('rolls back a decision if its event fails, then supports an exact retry',async()=>{
  const db=await setup();try{const a=await list(db,'supervisor',id(2));await open(db,id(20),'supervisor',id(2),a.snapshot,'5');await db.exec("RESET ROLE; ALTER TABLE public.paid_period_assertion_case_events ADD CONSTRAINT fail_test_event CHECK(kind<>'resolved') NOT VALID; SET ROLE authenticated");await expect(resolve(db,id(20),'no_transfer',null,'Reviewed')).rejects.toThrow(/fail_test_event/);expect((await list(db,'supervisor',id(2))).items[0].status).toBe('pending');await db.exec('RESET ROLE; ALTER TABLE public.paid_period_assertion_case_events DROP CONSTRAINT fail_test_event; SET ROLE authenticated');expect((await resolve(db,id(20),'no_transfer',null,'Reviewed')).replayed).toBe(false);expect((await resolve(db,id(20),'no_transfer',null,'Reviewed')).replayed).toBe(true);
  }finally{await db.close();}
 },30000);
});
