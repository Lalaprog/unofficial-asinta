import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const founder='00000000-0000-0000-0000-000000000001',sup='00000000-0000-0000-0000-000000000002',site='00000000-0000-0000-0000-000000000004';
const id=(n:number)=>`77000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sql=(name:string)=>readFileSync(`supabase/drafts/${name}.sql`,'utf8');
async function setup(){const db=new PGlite();await db.exec(baseFixture);for(const name of ['supervisor_table_foundation','supervisor_rpc_rollout','supervisor_payroll_preview','supervisor_payroll_ledger'])await db.exec(`BEGIN; ${sql(name)} COMMIT;`);await db.exec(`INSERT INTO public.workers VALUES ('${sup}','Supervisor','Supervisor','none',600,'daily',true); INSERT INTO public.project_supervisors VALUES ('00000000-0000-0000-0000-000000000005','${sup}'); SET ROLE authenticated; SET test.assurance='yes'; SET test.uid='${sup}'`);return db;}
async function seed(db:PGlite){await db.query("SELECT public.submit_supervisor_day($1,'2024-12-01','present')",[id(1)]);await db.query("SELECT public.submit_supervisor_day($1,'2024-12-02','half_day')",[id(2)]);await db.query("SELECT public.submit_supervisor_leave($1,'2024-12-03','2024-12-03','emergency','')",[id(3)]);await db.exec(`SET test.uid='${founder}'`);await db.query("SELECT public.review_supervisor_day($1,'approved')",[id(1)]);await db.query("SELECT public.review_supervisor_day($1,'approved')",[id(2)]);await db.query("SELECT public.review_supervisor_leave($1,'approved')",[id(3)]);}
async function prepared(db:PGlite){return (await db.query<{v:unknown}>("SELECT public.supervisor_period_prepare($1,'2024-12-01') v",[sup])).rows[0].v;}
async function create(db:PGlite,key:string,expected:unknown,rate='655.55'){return (await db.query<{v:{id:string;replayed:boolean}}>("SELECT public.create_supervisor_period_draft($1,$2,'2024-12-01',$3,$4) v",[key,sup,rate,JSON.stringify(expected)])).rows[0].v;}
async function transition(db:PGlite,request:string,payroll:string,action:string,date:string|null=null,ack=true){return (await db.query<{v:{id:string;request_id:string;replayed:boolean}}>('SELECT public.transition_supervisor_period_payroll($1,$2,$3,$4,$5) v',[request,payroll,action,date,ack])).rows[0].v;}
async function review(db:PGlite){return (await db.query<{v:{id:string;status:string;gross:string;daily_rate:string;half_day_units:number;paid_on:string|null;source_changed:boolean;unmarked_dates:string[]}}>("SELECT public.supervisor_period_payroll_review($1,'2024-12-01') v",[sup])).rows[0].v;}
describe('uninstalled Supervisor period payroll ledger',()=>{
 it('uses one daily record across two sites, preserves unpaid leave and records an external payment without transactions or project cost',async()=>{
  const db=await setup();try{await seed(db);await db.exec('RESET ROLE');const before=(await db.query("SELECT (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.payroll p) payroll,(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.attendance a) attendance,(SELECT count(*)::int FROM public.expenses) expenses,(SELECT count(*)::int FROM public.advances) advances")).rows[0];await db.exec('SET ROLE authenticated');
   const snapshot=await prepared(db);expect(await create(db,id(10),snapshot)).toEqual({id:id(10),replayed:false});expect((await create(db,id(10),snapshot)).replayed).toBe(true);
   const draft=await review(db);expect(draft).toMatchObject({id:id(10),status:'draft',gross:'983.33',daily_rate:'655.55',half_day_units:3,paid_on:null,source_changed:false});expect(draft.unmarked_dates).toContain('2024-12-04');expect(draft.unmarked_dates).not.toContain('2024-12-03');
   await expect(transition(db,id(11),id(10),'recorded_paid','2024-12-15')).rejects.toThrow(/status/);await expect(transition(db,id(11),id(10),'approved',null,false)).rejects.toThrow(/confirmation/);
   expect((await transition(db,id(11),id(10),'approved')).replayed).toBe(false);expect((await transition(db,id(11),id(10),'approved')).replayed).toBe(true);await expect(transition(db,id(11),id(10),'recorded_paid','2024-12-15')).rejects.toThrow(/different/);
   expect((await db.query<{v:{count:number;total:string}}>("SELECT public.supervisor_paid_company_evidence('2024-12-01','2024-12-31') v")).rows[0].v).toMatchObject({count:0,total:'0.00'});
   expect((await transition(db,id(12),id(10),'recorded_paid','2024-12-15')).replayed).toBe(false);expect((await transition(db,id(12),id(10),'recorded_paid','2024-12-15')).replayed).toBe(true);expect(await review(db)).toMatchObject({status:'paid',paid_on:'2024-12-15',source_changed:false});
   expect((await db.query<{v:{count:number;total:string;items:unknown[]}}>("SELECT public.supervisor_paid_company_evidence('2024-12-01','2024-12-31') v")).rows[0].v).toMatchObject({count:1,total:'983.33',items:[{id:id(10),supervisor_id:sup,paid_on:'2024-12-15',gross:'983.33'}]});
   await expect(db.query("SELECT public.supervisor_paid_company_evidence('2020-01-01','2024-12-31')")).rejects.toThrow(/366 days/);
   await db.exec(`SET test.uid='${sup}'`);await db.query("SELECT public.submit_supervisor_leave($1,'2024-12-04','2024-12-04','emergency','Late leave')",[id(13)]);
   const own=(await db.query<{v:{items:{id:string;possible_paid_overlap:boolean|null}[]}}>('SELECT public.supervisor_leave_list() v')).rows[0].v;expect(own.items.find(x=>x.id===id(13))?.possible_paid_overlap).toBeNull();
   await db.exec(`SET test.uid='${founder}'`);expect((await review(db)).source_changed).toBe(true);
   const queue=(await db.query<{v:{items:{id:string;possible_paid_overlap:boolean}[]}}>('SELECT public.supervisor_leave_list() v')).rows[0].v;expect(queue.items.find(x=>x.id===id(13))?.possible_paid_overlap).toBe(true);
   const days=(await db.query<{v:{items:{id:string;possible_paid_overlap:boolean}[]}}>('SELECT public.supervisor_day_list() v')).rows[0].v;expect(days.items.find(x=>x.id===id(1))?.possible_paid_overlap).toBe(true);
   await db.query("SELECT public.review_supervisor_leave($1,'approved')",[id(13)]);expect(await review(db)).toMatchObject({status:'paid',gross:'983.33',paid_on:'2024-12-15',source_changed:true});
   await expect(db.query('SELECT * FROM public.supervisor_period_payroll')).rejects.toThrow(/permission denied/);await db.exec('RESET ROLE');
   expect((await db.query("SELECT (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.payroll p) payroll,(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.attendance a) attendance,(SELECT count(*)::int FROM public.expenses) expenses,(SELECT count(*)::int FROM public.advances) advances")).rows[0]).toEqual(before);
   await expect(db.query("INSERT INTO public.payroll(id,worker_id,period_start,period_end,status) VALUES($1,$2,'2024-12-10','2024-12-16','draft')",[id(14),sup])).rejects.toThrow(/Supervisor ledger/);expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.supervisor_period_payroll_events')).rows[0].n).toBe(3);await expect(db.exec('DELETE FROM public.supervisor_period_payroll_events')).rejects.toThrow(/immutable/);
  }finally{await db.close();}
 },30000);
 it('blocks stale source, pending and legacy overlap; rolls back when audit fails',async()=>{
  const db=await setup();try{await seed(db);const old=await prepared(db);await db.exec(`SET test.uid='${sup}'`);await db.query("SELECT public.submit_supervisor_day($1,'2024-12-04','present')",[id(20)]);await db.exec(`SET test.uid='${founder}'`);await expect(create(db,id(21),old)).rejects.toThrow(/Pending/);await db.query("SELECT public.review_supervisor_day($1,'rejected')",[id(20)]);
   await db.exec(`RESET ROLE; UPDATE public.workers SET name='Changed supervisor' WHERE id='${sup}'; SET ROLE authenticated`);await expect(create(db,id(21),old)).rejects.toThrow(/linked worker identity/);await db.exec(`RESET ROLE; UPDATE public.workers SET name='Supervisor' WHERE id='${sup}'; INSERT INTO public.payroll(id,worker_id,period_start,period_end,status) VALUES ('${id(22)}','${sup}','2024-12-01','2024-12-15','paid'); SET ROLE authenticated`);await expect(create(db,id(21),await prepared(db))).rejects.toThrow(/legacy records/);
   await db.exec(`RESET ROLE; DELETE FROM public.payroll WHERE id='${id(22)}'; ALTER TABLE public.supervisor_period_payroll_events ADD CONSTRAINT fail_event CHECK(action<>'created') NOT VALID; SET ROLE authenticated`);await expect(create(db,id(21),await prepared(db))).rejects.toThrow(/fail_event/);await db.exec('RESET ROLE');expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.supervisor_period_payroll')).rows[0].n).toBe(0);
  }finally{await db.close();}
 },30000);
 it('handles the 16th through leap-month end and preserves an approved unpaid-only period',async()=>{
  const db=await setup();try{
   await db.query("SELECT public.submit_supervisor_leave($1,'2024-02-29','2024-02-29','emergency','')",[id(60)]);await db.exec(`SET test.uid='${founder}'`);await db.query("SELECT public.review_supervisor_leave($1,'approved')",[id(60)]);
   const snapshot=(await db.query<{v:unknown}>("SELECT public.supervisor_period_prepare($1,'2024-02-16') v",[sup])).rows[0].v;
   await db.query("SELECT public.create_supervisor_period_draft($1,$2,'2024-02-16',600,$3)",[id(61),sup,JSON.stringify(snapshot)]);
   const row=(await db.query<{v:{period_end:string;gross:string;half_day_units:number;unmarked_dates:string[]}}>("SELECT public.supervisor_period_payroll_review($1,'2024-02-16') v",[sup])).rows[0].v;
   expect(row).toMatchObject({period_end:'2024-02-29',gross:'0.00',half_day_units:0});expect(row.unmarked_dates).toHaveLength(13);expect(row.unmarked_dates).not.toContain('2024-02-29');
  }finally{await db.close();}
 },30000);
 it('rolls back a payment-status change if its immutable audit event fails',async()=>{
  const db=await setup();try{await seed(db);await create(db,id(40),await prepared(db));await transition(db,id(41),id(40),'approved');await db.exec("RESET ROLE; ALTER TABLE public.supervisor_period_payroll_events ADD CONSTRAINT fail_payment_event CHECK(action<>'recorded_paid') NOT VALID; SET ROLE authenticated");
   await expect(transition(db,id(42),id(40),'recorded_paid','2024-12-15')).rejects.toThrow(/fail_payment_event/);expect(await review(db)).toMatchObject({status:'approved',paid_on:null});
   await db.exec('RESET ROLE');expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.supervisor_period_payroll_events')).rows[0].n).toBe(2);
  }finally{await db.close();}
 },30000);
 it('refuses both cross-ledger installation orders pending coordinated identity protection',async()=>{
  const db=await setup();try{await db.exec('RESET ROLE');await expect(db.exec(`BEGIN; ${sql('historical_external_worker_payroll')} COMMIT;`)).rejects.toThrow(/cross-ledger reconciliation/);await db.exec('ROLLBACK');}finally{await db.close();}
  const reverse=new PGlite();try{await reverse.exec(baseFixture);for(const name of ['supervisor_table_foundation','supervisor_rpc_rollout','supervisor_payroll_preview','historical_external_worker_payroll'])await reverse.exec(`BEGIN; ${sql(name)} COMMIT;`);await expect(reverse.exec(`BEGIN; ${sql('supervisor_payroll_ledger')} COMMIT;`)).rejects.toThrow(/cross-ledger reconciliation/);await reverse.exec('ROLLBACK');}finally{await reverse.close();}
 },30000);
 it('rejects non-Founder, bad assurance and changed sources before approval or payment',async()=>{
  const db=await setup();try{await seed(db);const snapshot=await prepared(db);await create(db,id(30),snapshot);await db.exec(`SET test.uid='${sup}'`);await expect(transition(db,id(31),id(30),'approved')).rejects.toThrow(/Founder/);await expect(review(db)).rejects.toThrow(/Founder/);await db.exec(`SET test.uid='${founder}'; SET test.assurance='no'`);await expect(review(db)).rejects.toThrow(/Founder/);await db.exec(`SET test.assurance='yes'; SET test.uid='${sup}'`);await db.query("SELECT public.submit_supervisor_leave($1,'2024-12-04','2024-12-04','emergency','')",[id(32)]);await db.exec(`SET test.uid='${founder}'`);await expect(transition(db,id(31),id(30),'approved')).rejects.toThrow(/Pending/);expect((await review(db)).source_changed).toBe(true);
  }finally{await db.close();}
 },30000);
});
