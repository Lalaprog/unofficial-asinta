import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const founder='00000000-0000-0000-0000-000000000001',sup='00000000-0000-0000-0000-000000000002';
const id=(n:number)=>`77000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sql=(name:string)=>readFileSync(`supabase/drafts/${name}.sql`,'utf8');
async function setup(){const db=new PGlite();await db.exec(baseFixture);for(const name of ['supervisor_table_foundation','supervisor_rpc_rollout','supervisor_payroll_preview','supervisor_payroll_ledger','supervisor_payroll_revision'])await db.exec(`BEGIN; ${sql(name)} COMMIT;`);await db.exec(`INSERT INTO public.workers VALUES ('${sup}','Supervisor','Supervisor','none',600,'daily',true); SET ROLE authenticated; SET test.assurance='yes'; SET test.uid='${sup}'`);await db.query("SELECT public.submit_supervisor_day($1,'2024-12-01','present')",[id(1)]);await db.exec(`SET test.uid='${founder}'`);await db.query("SELECT public.review_supervisor_day($1,'approved')",[id(1)]);return db;}
async function prepared(db:PGlite){return (await db.query<{v:unknown}>("SELECT public.supervisor_period_prepare($1,'2024-12-01') v",[sup])).rows[0].v;}
async function create(db:PGlite){await db.query("SELECT public.create_supervisor_period_draft($1,$2,'2024-12-01',600,$3)",[id(10),sup,JSON.stringify(await prepared(db))]);}
async function review(db:PGlite){return (await db.query<{v:{revision:string;status:string;gross:string;source_changed:boolean}}>("SELECT public.supervisor_period_payroll_review_v2($1,'2024-12-01') v",[sup])).rows[0].v;}
async function action(db:PGlite,key:string,revision:string,kind:string,rate:string|null=null,expected:unknown=null,reason:string|null=null,paid:string|null=null,ack=true){return (await db.query<{v:{id:string;request_id:string;revision:string;replayed:boolean}}>('SELECT public.supervisor_payroll_revision_action($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) v',[key,id(10),revision,kind,rate,expected===null?null:JSON.stringify(expected),reason,paid,ack])).rows[0].v;}
describe('Supervisor payroll revision upgrade (synthetic only)',()=>{
 it('returns an approved unpaid period, refreshes current sources and pays the explicitly reviewed revision exactly once',async()=>{const db=await setup();try{
  await create(db);expect(await review(db)).toMatchObject({revision:'0',status:'draft',gross:'600.00'});
  expect(await action(db,id(11),'0','approved')).toMatchObject({revision:'1',replayed:false});
  expect((await action(db,id(11),'0','approved')).replayed).toBe(true);
  await db.exec(`SET test.uid='${sup}'`);await db.query("SELECT public.submit_supervisor_day($1,'2024-12-02','half_day')",[id(2)]);await db.exec(`SET test.uid='${founder}'`);await db.query("SELECT public.review_supervisor_day($1,'approved')",[id(2)]);
  expect(await review(db)).toMatchObject({revision:'1',status:'approved',source_changed:true});
  await expect(action(db,id(12),'1','recorded_paid',null,null,null,'2024-12-15')).rejects.toThrow(/sources changed/i);
  await expect(action(db,id(13),'1','return_to_draft',null,null,null)).rejects.toThrow(/return details/i);
  await action(db,id(13),'1','return_to_draft',null,null,'Verified no external payment');
  const snapshot=await prepared(db);await action(db,id(14),'2','refresh','655.55',snapshot,'Updated attendance and rate');
  expect(await review(db)).toMatchObject({revision:'3',status:'draft',gross:'983.33',source_changed:false});
  await expect(action(db,id(15),'2','approved')).rejects.toThrow(/revision changed/i);
  await action(db,id(15),'3','approved');await action(db,id(16),'4','recorded_paid',null,null,null,'2024-12-15');
  expect(await review(db)).toMatchObject({revision:'5',status:'paid',gross:'983.33'});
  await expect(action(db,id(17),'5','return_to_draft',null,null,'Already paid')).rejects.toThrow(/only an approved unpaid/i);
  await expect(action(db,id(17),'5','refresh','600',snapshot,'No')).rejects.toThrow(/only a draft/i);
  await db.exec('RESET ROLE');const rows=(await db.query<{action:string;before_row:{status:string};after_row:{status:string};expected_revision:number}>('SELECT action,before_row,after_row,expected_revision FROM public.supervisor_payroll_revision_events ORDER BY expected_revision')).rows;
  expect(rows.map(x=>x.action)).toEqual(['approved','return_to_draft','refresh','approved','recorded_paid']);expect(rows[1].before_row.status).toBe('approved');expect(rows[1].after_row.status).toBe('draft');
  await expect(db.exec('DELETE FROM public.supervisor_payroll_revision_events')).rejects.toThrow(/immutable/i);
 }finally{await db.close();}},30000);
 it('rejects stale snapshots, inherited access, conflicting retries and missing assurance without partial changes',async()=>{const db=await setup();try{
  await create(db);const old=await prepared(db);await db.exec(`SET test.uid='${sup}'`);await db.query("SELECT public.submit_supervisor_day($1,'2024-12-02','present')",[id(3)]);await db.exec(`SET test.uid='${founder}'`);await db.query("SELECT public.review_supervisor_day($1,'approved')",[id(3)]);
  await expect(action(db,id(20),'0','refresh','600',old,'Refresh stale')).rejects.toThrow(/snapshot changed/i);expect(await review(db)).toMatchObject({revision:'0',gross:'600.00'});
  const now=await prepared(db);await action(db,id(20),'0','refresh','600',now,'Refresh');
  expect((await action(db,id(20),'0','refresh','600',now,'Refresh')).replayed).toBe(true);
  await expect(action(db,id(20),'0','refresh','601',now,'Refresh')).rejects.toThrow(/different action/i);
  await expect(db.query("SELECT public.transition_supervisor_period_payroll($1,$2,'approved',NULL,true)",[id(21),id(10)])).rejects.toThrow(/permission denied/i);
  await db.exec(`SET test.uid='${sup}'`);await expect(action(db,id(21),'1','approved')).rejects.toThrow(/Founder/i);await db.exec(`SET test.uid='${founder}'; SET test.assurance='no'`);await expect(action(db,id(21),'1','approved')).rejects.toThrow(/Founder/i);
  await db.exec("SET test.assurance='yes'; RESET ROLE; ALTER TABLE public.supervisor_payroll_revision_events ADD CONSTRAINT fail_refresh CHECK(action<>'refresh') NOT VALID; SET ROLE authenticated");
  await expect(action(db,id(22),'1','refresh','600',now,'Audit failure')).rejects.toThrow(/fail_refresh/i);expect(await review(db)).toMatchObject({revision:'1',gross:'1200.00'});
 }finally{await db.close();}},30000);
 it('exposes bounded revision history only to an assured Founder',async()=>{const db=await setup();try{
  await db.exec('RESET ROLE');await db.exec(`BEGIN; ${sql('supervisor_payroll_revision_history')} COMMIT;`);await db.exec(`SET ROLE authenticated; SET test.assurance='yes'; SET test.uid='${founder}'`);
  await create(db);await action(db,id(31),'0','approved');await action(db,id(32),'1','return_to_draft',null,null,'No payment was made');
  const page=(await db.query<{v:{payroll_id:string;items:{revision:string;action:string;reason:string|null;before_status:string;after_status:string}[];has_more:boolean}}>('SELECT public.supervisor_payroll_revision_history($1,NULL) v',[id(10)])).rows[0].v;
  expect(page.payroll_id).toBe(id(10));expect(page.has_more).toBe(false);expect(page.items.map(x=>x.revision)).toEqual(['1','0']);expect(page.items[0]).toMatchObject({action:'return_to_draft',reason:'No payment was made',before_status:'approved',after_status:'draft'});
  const older=(await db.query<{v:{items:{revision:string}[]}}>('SELECT public.supervisor_payroll_revision_history($1,1) v',[id(10)])).rows[0].v;expect(older.items.map(x=>x.revision)).toEqual(['0']);
  await db.exec(`SET test.uid='${sup}'`);await expect(db.query('SELECT public.supervisor_payroll_revision_history($1,NULL)',[id(10)])).rejects.toThrow(/Founder access/i);
  await db.exec(`SET test.uid='${founder}'; SET test.assurance='no'`);await expect(db.query('SELECT public.supervisor_payroll_revision_history($1,NULL)',[id(10)])).rejects.toThrow(/Founder access/i);
  await db.exec('RESET ROLE');expect((await db.query<{anon:boolean;service:boolean}>("SELECT has_function_privilege('anon','public.supervisor_payroll_revision_history(uuid,bigint)','EXECUTE') anon,has_function_privilege('service_role','public.supervisor_payroll_revision_history(uuid,bigint)','EXECUTE') service")).rows[0]).toEqual({anon:false,service:false});
 }finally{await db.close();}},30000);
 it('paginates 51 revision events without skipping or duplicating and rejects conflicting evidence',async()=>{const db=await setup();try{
  await create(db);await db.exec('RESET ROLE');await db.exec(`BEGIN; ${sql('supervisor_payroll_revision_history')} COMMIT;`);
  await db.exec(`INSERT INTO public.supervisor_payroll_revision_events(request_id,payroll_id,actor_id,action,expected_revision,arguments,before_row,after_row) SELECT ('88000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'${id(10)}','${founder}','refresh',n,'{}',to_jsonb(p),to_jsonb(p) FROM generate_series(0,50) n CROSS JOIN public.supervisor_period_payroll p WHERE p.id='${id(10)}'; SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'`);
  const first=(await db.query<{v:{items:{revision:string}[];has_more:boolean}}>('SELECT public.supervisor_payroll_revision_history($1,NULL) v',[id(10)])).rows[0].v;
  expect(first.items).toHaveLength(50);expect(first.has_more).toBe(true);expect(first.items[0].revision).toBe('50');expect(first.items[49].revision).toBe('1');
  const second=(await db.query<{v:{items:{revision:string}[];has_more:boolean}}>('SELECT public.supervisor_payroll_revision_history($1,1) v',[id(10)])).rows[0].v;expect(second.items.map(x=>x.revision)).toEqual(['0']);expect(second.has_more).toBe(false);
  await db.exec(`RESET ROLE; INSERT INTO public.supervisor_payroll_revision_events(request_id,payroll_id,actor_id,action,expected_revision,arguments,before_row,after_row) SELECT '${id(49)}','${id(10)}','${founder}','refresh',0,'{}',to_jsonb(p),to_jsonb(p) FROM public.supervisor_period_payroll p WHERE p.id='${id(10)}'; SET ROLE authenticated`);
  await expect(db.query('SELECT public.supervisor_payroll_revision_history($1,NULL)',[id(10)])).rejects.toThrow(/Duplicate revision evidence/i);
 }finally{await db.close();}},30000);
 it('rolls back the upgrade if a legacy decision grant is inherited',async()=>{
  const db=new PGlite();try{await db.exec(baseFixture);for(const name of ['supervisor_table_foundation','supervisor_rpc_rollout','supervisor_payroll_preview','supervisor_payroll_ledger'])await db.exec(`BEGIN; ${sql(name)} COMMIT;`);
   await db.exec('CREATE ROLE legacy_inherited; GRANT EXECUTE ON FUNCTION public.transition_supervisor_period_payroll(uuid,uuid,text,date,boolean) TO legacy_inherited; GRANT legacy_inherited TO authenticated');
   await expect(db.exec(`BEGIN; ${sql('supervisor_payroll_revision')} COMMIT;`)).rejects.toThrow(/Internal Supervisor writer exposed/);await db.exec('ROLLBACK');
   const state=(await db.query<{column_exists:boolean;old_access:boolean}>("SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.supervisor_period_payroll'::regclass AND attname='revision' AND NOT attisdropped) column_exists,has_function_privilege('authenticated','public.transition_supervisor_period_payroll(uuid,uuid,text,date,boolean)','EXECUTE') old_access")).rows[0];expect(state).toEqual({column_exists:false,old_access:true});
  }finally{await db.close();}
 },30000);

});
