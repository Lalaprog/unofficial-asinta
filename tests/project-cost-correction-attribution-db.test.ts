import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
import {parseAdjustmentList} from '@/lib/payroll/paidAdjustments';
import {parsePeriodCases,parsePeriodSnapshot} from '@/lib/payroll/paidPeriodCases';
import {parseCorrectionReview,parseCorrectionAttempt,correctionArguments} from '@/lib/payroll/projectCostCorrection';
import {parseProjectCorrectionEvidence} from '@/lib/projects/projectCostCorrections';
const founder='00000000-0000-0000-0000-000000000001',supervisor='00000000-0000-0000-0000-000000000002',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004',other='00000000-0000-0000-0000-000000000005';
const id=(n:number)=>`90000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sql=(p:string)=>readFileSync(`supabase/drafts/${p}.sql`,'utf8');
type Result={case:unknown;latest_revision:number;attribution:{revision:number;gross_change:string;split:unknown[];case_changed:boolean}|null};
const read=(db:PGlite,kind:string,cid:string,rev:number|null=null)=>db.query<{v:Result}>('SELECT public.project_cost_correction_attribution($1,$2,$3) v',[kind,cid,rev]);
const save=(db:PGlite,req:string,kind:string,cid:string,rev:number,source:unknown,gross:string,split:unknown,note='Original evidence reviewed',ack=true)=>db.query<{v:{revision:number;replayed:boolean}}>('SELECT public.record_project_cost_correction_attribution($1,$2,$3,$4,$5::jsonb,$6::numeric,$7::jsonb,$8,$9) v',[req,kind,cid,rev,JSON.stringify(source),gross,JSON.stringify(split),note,ack]);
async function setup(){
 const db=new PGlite();await db.exec(baseFixture);await db.exec(`BEGIN;${sql('paid_payroll_adjustments')} COMMIT;
 CREATE TABLE public.supervisor_period_payroll(id uuid PRIMARY KEY); CREATE TABLE public.paid_period_assertion_case_events(id uuid PRIMARY KEY);
 CREATE TABLE public.historical_external_worker_payroll(request_id uuid PRIMARY KEY, original jsonb NOT NULL);
 CREATE TABLE public.paid_period_assertion_cases(id uuid PRIMARY KEY,source_kind text NOT NULL,external_worker_id uuid REFERENCES public.historical_external_worker_payroll(request_id),original_snapshot jsonb NOT NULL,difference numeric(12,2) NOT NULL,status text NOT NULL);
 CREATE FUNCTION public.paid_period_assertion_snapshot(p_kind text,p_id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT original FROM public.historical_external_worker_payroll WHERE request_id=p_id AND p_kind='external_worker'$$;
 INSERT INTO public.historical_external_worker_payroll VALUES ('${id(10)}','{"kind":"external_worker","gross":"600.00","net":"500.00"}');
 INSERT INTO public.paid_period_assertion_cases VALUES('${id(11)}','external_worker','${id(10)}','{"kind":"external_worker","gross":"600.00","net":"500.00"}',20,'settled_external');
 BEGIN;${sql('project_cost_correction_attribution')} COMMIT;`);
 const voucher=(await db.query<{v:unknown}>('SELECT app_private.paid_adjustment_voucher_snapshot(p) v FROM public.payroll p WHERE id=$1',[worker])).rows[0].v;
 await db.exec(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);
 await db.query('SELECT public.open_paid_payroll_adjustment($1,$2,$3::jsonb,100,$4)',[id(1),worker,JSON.stringify(voucher),'Synthetic wage and deduction correction']);
 return {db,voucher};
}
const split=[{project_id:site,gross_change:'75.25'},{project_id:other,gross_change:'24.75'}];

describe('project cost correction attribution (synthetic candidate only)',()=>{
 it('requires a resolved case, supports audited revisions and never changes finance records',async()=>{const {db}=await setup();try{
  let source=(await read(db,'voucher',id(1))).rows[0].v.case;
  await expect(save(db,id(2),'voucher',id(1),0,source,'100.00',split)).rejects.toThrow(/Resolve the original-period case/);
  await db.query("SELECT public.resolve_paid_payroll_adjustment($1,'settled_external','2026-10-31','Synthetic external settlement')",[id(1)]);
  const initial=(await read(db,'voucher',id(1))).rows[0].v;expect(initial.latest_revision).toBe(0);source=initial.case;
  const voucherList=(await db.query<{v:unknown}>('SELECT public.paid_payroll_adjustment_list($1,0) v',[worker])).rows[0].v;
  const voucherCase=parseAdjustmentList(voucherList,worker,0).items[0];expect(parseCorrectionReview(initial,'voucher',voucherCase).latest_revision).toBe(0);
  expect((await save(db,id(2),'voucher',id(1),0,source,'100.00',split)).rows[0].v).toMatchObject({revision:1,replayed:false});
  expect((await save(db,id(2),'voucher',id(1),0,source,'100.00',[...split].reverse())).rows[0].v.replayed).toBe(true);
  await expect(save(db,id(2),'voucher',id(1),0,source,'100.00',split,'Changed note')).rejects.toThrow(/different details/);
  await expect(save(db,id(3),'voucher',id(1),0,source,'100.00',split)).rejects.toThrow(/changed; reload/);
  const correction=[{project_id:site,gross_change:'60.25'},{project_id:other,gross_change:'39.75'}];
  expect((await save(db,id(3),'voucher',id(1),1,source,'100.00',correction,'Correct original cost split')).rows[0].v).toMatchObject({revision:2,replayed:false});
  const latest=(await read(db,'voucher',id(1))).rows[0].v;expect(latest.attribution).toMatchObject({revision:2,gross_change:'100.00',case_changed:false});expect(latest.attribution?.split).toEqual(correction);
  expect(parseCorrectionReview(latest,'voucher',voucherCase).attribution?.revision).toBe(2);
  expect((await read(db,'voucher',id(1),1)).rows[0].v.attribution).toMatchObject({revision:1,gross_change:'100.00'});
  const siteReview=(await db.query<{v:{items:Array<{revision:number;site_gross_change:string}>}}>('SELECT public.project_cost_correction_attribution_sites($1) v',[site])).rows[0].v;
  expect(siteReview.items).toEqual([expect.objectContaining({revision:2,site_gross_change:'60.25'})]);
  expect(parseProjectCorrectionEvidence(siteReview,site)).toMatchObject([{revision:2,siteChange:'60.25',kind:'voucher'}]);
  await save(db,id(4),'voucher',id(1),2,source,'100.00',[{project_id:other,gross_change:'100.00'}],'Reviewed replacement');
  expect((await db.query<{v:{items:unknown[]}}>('SELECT public.project_cost_correction_attribution_sites($1) v',[site])).rows[0].v.items).toEqual([]);
  expect((await db.query<{v:{items:unknown[]}}>('SELECT public.project_cost_correction_attribution_sites($1) v',[other])).rows[0].v.items).toEqual([expect.objectContaining({revision:3,site_gross_change:'100.00'})]);
  await db.exec('RESET ROLE');expect((await db.query('SELECT status,gross_pay::text,net_pay::text FROM public.payroll WHERE id=$1',[worker])).rows).toEqual([{status:'paid',gross_pay:'600',net_pay:'600'}]);
  expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.advances')).rows[0].n).toBe(0);
  await expect(db.query('DELETE FROM public.project_cost_correction_attributions')).rejects.toThrow(/immutable/);
  await expect(db.query('DELETE FROM public.project_cost_correction_sites')).rejects.toThrow(/immutable/);
  await expect(db.query('DELETE FROM public.projects WHERE id=$1',[site])).rejects.toThrow(/foreign key/);
 }finally{await db.close();}},30000);
 it('supports historical worker assertions without assuming net difference is gross cost',async()=>{const {db}=await setup();try{
  const source=(await read(db,'external_worker',id(11))).rows[0].v.case;
  expect((await save(db,id(12),'external_worker',id(11),0,source,'0.00',[],'Difference relates only to deductions')).rows[0].v).toMatchObject({revision:1});
  expect((await read(db,'external_worker',id(11))).rows[0].v.attribution).toMatchObject({gross_change:'0.00',split:[]});
  await expect(read(db,'supervisor',id(11))).rejects.toThrow(/Invalid worker correction kind|Invalid correction attribution request/);
 }finally{await db.close();}},30000);
 it('refuses stale or malformed evidence, inconsistent cents, unknown sites and unauthorized users',async()=>{const {db}=await setup();try{
  await db.query("SELECT public.resolve_paid_payroll_adjustment($1,'no_transfer',NULL,'Synthetic no-transfer decision')",[id(1)]);const source=(await read(db,'voucher',id(1))).rows[0].v.case;
  await expect(save(db,id(20),'voucher',id(1),0,{},'100.00',split)).rejects.toThrow(/case changed/);
  await expect(save(db,id(20),'voucher',id(1),0,source,'99.99',split)).rejects.toThrow(/must equal/);
  await expect(save(db,id(20),'voucher',id(1),0,source,'150.50',[split[0],split[0]])).rejects.toThrow(/Duplicate project/);
  await expect(save(db,id(20),'voucher',id(1),0,source,'0.00',[{project_id:site,gross_change:'NaN'}])).rejects.toThrow(/Invalid correction/);
  await expect(save(db,id(20),'voucher',id(1),0,source,'1.00',[{project_id:id(99),gross_change:'1.00'}])).rejects.toThrow(/project unavailable/);
  await expect(save(db,id(20),'voucher',id(1),0,source,'100.00',split,'Reviewed',false)).rejects.toThrow(/Invalid correction/);
  await db.exec(`SET test.uid='${supervisor}'`);await expect(read(db,'voucher',id(1))).rejects.toThrow(/Founder/);await expect(save(db,id(20),'voucher',id(1),0,source,'100.00',split)).rejects.toThrow(/Founder/);
  await db.exec(`SET test.uid='${founder}';SET test.assurance='no'`);await expect(read(db,'voucher',id(1))).rejects.toThrow(/Founder/);
  await db.exec('RESET ROLE;SET ROLE service_role');await expect(read(db,'voucher',id(1))).rejects.toThrow(/permission denied/);await expect(db.query('SELECT * FROM public.project_cost_correction_sites')).rejects.toThrow(/permission denied/);
 }finally{await db.close();}},30000);
 it('integrates with the actual external paid-period case and records negative gross effects separately from net',async()=>{
  const db=new PGlite();try{
   await db.exec(baseFixture);
   for(const name of ['supervisor_table_foundation','supervisor_rpc_rollout','supervisor_payroll_preview','historical_external_worker_payroll','supervisor_payroll_ledger','paid_period_assertion_adjustments','paid_payroll_adjustments','project_cost_correction_attribution'])await db.exec(`BEGIN; ${sql(name)} COMMIT;`);
   await db.exec(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'`);
   const review=(await db.query<{v:{worker:unknown}}>("SELECT public.historical_external_worker_review($1,'2024-12-01') v",[worker])).rows[0].v;
   await db.query("SELECT public.record_historical_external_worker_payroll($1,$2,'2024-12-01','2024-12-07',600,100,0,500,'Synthetic ledger',$3,true)",[id(30),worker,JSON.stringify(review.worker)]);
   const original=(await db.query<{v:{snapshot:unknown}}>("SELECT public.paid_period_assertion_case_list('external_worker',$1) v",[id(30)])).rows[0].v.snapshot;
   await db.query("SELECT public.open_paid_period_assertion_case($1,'external_worker',$2,$3,-30,'Synthetic review')",[id(31),id(30),JSON.stringify(original)]);
   await db.query("SELECT public.resolve_paid_period_assertion_case($1,'no_transfer',NULL,'No transfer needed',true)",[id(31)]);
   const backend=(await read(db,'external_worker',id(31))).rows[0].v;
   const caseList=(await db.query<{v:{snapshot:unknown}}>("SELECT public.paid_period_assertion_case_list('external_worker',$1) v",[id(30)])).rows[0].v;
   const caseItem=parsePeriodCases(caseList,parsePeriodSnapshot(caseList.snapshot))[0];
   const checked=parseCorrectionReview(backend,'external_worker',caseItem);
   const attempt=parseCorrectionAttempt({actor:founder,request:id(32),kind:'external_worker',case_id:id(31),expected_revision:checked.latest_revision,expected_case:checked.case,gross_change:'-12.50',split:[{project_id:site,gross_change:'-12.50'}],note:'Reviewed wage correction; rest relates to deductions'},founder,'external_worker',caseItem);
   const args=correctionArguments(attempt);
   await db.query('SELECT public.record_project_cost_correction_attribution($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9)',[args.p_request,args.p_kind,args.p_case,args.p_expected_revision,JSON.stringify(args.p_expected_case),args.p_gross_change,JSON.stringify(args.p_split),args.p_note,args.p_ack]);
   const found=(await read(db,'external_worker',id(31))).rows[0].v;
   expect(found.attribution).toMatchObject({gross_change:'-12.50',case_changed:false});
   expect(parseCorrectionReview(found,'external_worker',caseItem).attribution?.gross_change).toBe('-12.50');
   expect(found.case).toMatchObject({difference:'-30.00',status:'no_transfer'});
   const rows=(await db.query<{v:{items:unknown[]}}>('SELECT public.project_cost_correction_attribution_sites($1) v',[site])).rows[0].v.items;
   expect(rows).toEqual([expect.objectContaining({site_gross_change:'-12.50',total_gross_change:'-12.50'})]);
   expect(parseProjectCorrectionEvidence({project_id:site,items:rows},site)).toMatchObject([{kind:'external_worker',siteChange:'-12.50',caseStatus:'no_transfer'}]);
   expect(()=>parseProjectCorrectionEvidence({project_id:site,items:[{...(rows[0] as object),site_gross_change:'-9.00'}]},site)).toThrow(/split differs/);
   await db.query("SELECT public.open_paid_period_assertion_case($1,'external_worker',$2,$3,-10,'Second case')",[id(33),id(30),JSON.stringify(original)]);
   const pending=(await read(db,'external_worker',id(31))).rows[0].v;expect(pending.attribution?.case_changed).toBe(true);
   await expect(save(db,id(32),'external_worker',id(31),0,checked.case,'-12.50',attempt.split,attempt.note)).rejects.toThrow(/case changed/);
   await expect(save(db,id(34),'external_worker',id(31),1,pending.case,'-12.50',attempt.split,attempt.note)).rejects.toThrow(/Resolve all pending cases/);
   await db.query("SELECT public.resolve_paid_period_assertion_case($1,'no_transfer',NULL,'Reviewed second case',true)",[id(33)]);
   await expect(save(db,id(34),'external_worker',id(31),1,pending.case,'-12.50',attempt.split,attempt.note)).rejects.toThrow(/case changed/);
   const refreshed=(await read(db,'external_worker',id(31))).rows[0].v.case;expect((await save(db,id(34),'external_worker',id(31),1,refreshed,'-12.50',attempt.split,attempt.note)).rows[0].v.revision).toBe(2);
   await db.exec('RESET ROLE; ALTER TABLE public.paid_period_assertion_cases DISABLE TRIGGER paid_period_case_immutable');
   await db.query("UPDATE public.paid_period_assertion_cases SET original_snapshot=original_snapshot||'{\"changed\":true}'::jsonb WHERE id=$1",[id(33)]);await db.exec('SET ROLE authenticated');
   await expect(read(db,'external_worker',id(31))).rejects.toThrow(/Related case original paid-period evidence differs/);
   await db.exec('RESET ROLE');
   expect((await db.query<{gross:string;net:string}>('SELECT gross::text,net::text FROM public.historical_external_worker_payroll WHERE request_id=$1',[id(30)])).rows[0]).toEqual({gross:'600.00',net:'500.00'});
  }finally{await db.close();}
 },30000);
 it('rolls back a partial split on a constraint failure',async()=>{const {db}=await setup();try{
  await db.query("SELECT public.resolve_paid_payroll_adjustment($1,'no_transfer',NULL,'Synthetic no-transfer decision')",[id(1)]);
  const source=(await read(db,'voucher',id(1))).rows[0].v.case;
  await db.exec('RESET ROLE; ALTER TABLE public.project_cost_correction_sites ADD CONSTRAINT reject_test CHECK(gross_change<>24.75) NOT VALID; SET ROLE authenticated');
  await expect(save(db,id(40),'voucher',id(1),0,source,'100.00',split)).rejects.toThrow(/reject_test/);
  await db.exec('RESET ROLE');expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.project_cost_correction_attributions')).rows[0].n).toBe(0);
  await db.exec('ALTER TABLE public.project_cost_correction_sites DROP CONSTRAINT reject_test; SET ROLE authenticated');
  expect((await save(db,id(40),'voucher',id(1),0,source,'100.00',split)).rows[0].v.replayed).toBe(false);
 }finally{await db.close();}},30000);
 it('rejects inherited table privileges at installation',async()=>{
  const db=new PGlite();try{
   await db.exec(baseFixture);await db.exec(`BEGIN;${sql('paid_payroll_adjustments')} COMMIT;
    CREATE TABLE public.supervisor_period_payroll(id uuid PRIMARY KEY); CREATE TABLE public.paid_period_assertion_case_events(id uuid PRIMARY KEY);
    CREATE TABLE public.historical_external_worker_payroll(request_id uuid PRIMARY KEY, original jsonb);
    CREATE TABLE public.paid_period_assertion_cases(id uuid PRIMARY KEY,source_kind text,external_worker_id uuid,original_snapshot jsonb,difference numeric);
    CREATE FUNCTION public.paid_period_assertion_snapshot(text,uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT NULL::jsonb$$;
    CREATE ROLE correction_inherited; GRANT correction_inherited TO service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO correction_inherited`);
   await expect(db.exec(`BEGIN;${sql('project_cost_correction_attribution')} COMMIT;`)).rejects.toThrow(/Unexpected correction evidence access/);await db.exec('ROLLBACK');
   expect((await db.query("SELECT to_regclass('public.project_cost_correction_attributions') IS NULL absent")).rows[0]).toEqual({absent:true});
  }finally{await db.close();}
 },30000);
 it('fails closed if evidence is altered or its original paid record changes',async()=>{const {db}=await setup();try{
  await db.query("SELECT public.resolve_paid_payroll_adjustment($1,'settled_external','2026-10-31','Synthetic settlement')",[id(1)]);const source=(await read(db,'voucher',id(1))).rows[0].v.case;await save(db,id(21),'voucher',id(1),0,source,'100.00',split);
  await db.exec('RESET ROLE;ALTER TABLE public.project_cost_correction_sites DISABLE TRIGGER guard_project_cost_correction_sites_immutable');await db.query('UPDATE public.project_cost_correction_sites SET gross_change=1 WHERE request_id=$1 AND project_id=$2',[id(21),site]);await db.exec('SET ROLE authenticated');
  await expect(read(db,'voucher',id(1))).rejects.toThrow(/split evidence differs/);await expect(save(db,id(21),'voucher',id(1),0,source,'100.00',split)).rejects.toThrow(/split evidence differs/);
  await db.exec('RESET ROLE');await db.query('UPDATE public.payroll SET gross_pay=601 WHERE id=$1',[worker]);await db.exec('SET ROLE authenticated');await expect(read(db,'voucher',id(1))).rejects.toThrow(/original paid-period evidence unavailable or changed/i);
 }finally{await db.close();}},30000);
});
