import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const founder='00000000-0000-0000-0000-000000000001', supervisor='00000000-0000-0000-0000-000000000002', worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004',other='00000000-0000-0000-0000-000000000005';
const id=(n:number)=>`92000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sql=(p:string)=>readFileSync(`supabase/drafts/${p}.sql`,'utf8');
type Item={kind:string;case_id:string;source_in_snapshot:boolean;site_gross_change:string|null;evidence:{case:{status:string};latest_revision:number;attribution:null|{case_changed:boolean;gross_change:string}}};
async function setup(){
 const db=new PGlite();await db.exec(baseFixture);
 await db.exec(`BEGIN;${sql('paid_payroll_adjustments')} COMMIT;
 CREATE TABLE public.supervisor_period_payroll(id uuid PRIMARY KEY);CREATE TABLE public.paid_period_assertion_case_events(id uuid PRIMARY KEY);
 CREATE TABLE public.historical_external_worker_payroll(request_id uuid PRIMARY KEY,original jsonb NOT NULL);
 CREATE TABLE public.paid_period_assertion_cases(id uuid PRIMARY KEY,source_kind text NOT NULL,external_worker_id uuid REFERENCES public.historical_external_worker_payroll(request_id),original_snapshot jsonb NOT NULL,difference numeric(12,2) NOT NULL,status text NOT NULL);
 CREATE FUNCTION public.paid_period_assertion_snapshot(p_kind text,p_id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT original FROM public.historical_external_worker_payroll WHERE request_id=p_id AND p_kind='external_worker'$$;
 INSERT INTO public.historical_external_worker_payroll VALUES('${id(10)}','{"kind":"external_worker","gross":"600.00"}');
 INSERT INTO public.paid_period_assertion_cases VALUES('${id(11)}','external_worker','${id(10)}','{"kind":"external_worker","gross":"600.00"}',20,'settled_external');
 CREATE TABLE public.test_history(project_id uuid,source_id uuid);
 CREATE FUNCTION public.project_cost_historical_review(p_project uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('project_id',p_project,'base',jsonb_build_object('adjustment_cases',coalesce((SELECT jsonb_agg(jsonb_build_object('case_id',id)) FROM public.paid_payroll_adjustment_cases WHERE payroll_id='${worker}' AND p_project='${site}'),'[]'::jsonb)),'historical',coalesce((SELECT jsonb_agg(jsonb_build_object('source_id',source_id)) FROM public.test_history WHERE project_id=p_project),'[]'::jsonb))$$;
 BEGIN;${sql('project_cost_correction_attribution')} COMMIT; BEGIN;${sql('project_cost_correction_inventory')} COMMIT;`);
 const voucher=(await db.query<{v:unknown}>('SELECT app_private.paid_adjustment_voucher_snapshot(p) v FROM public.payroll p WHERE id=$1',[worker])).rows[0].v;
 await db.exec(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);
 await db.query('SELECT public.open_paid_payroll_adjustment($1,$2,$3::jsonb,100,$4)',[id(1),worker,JSON.stringify(voucher),'Synthetic case']);
 return db;
}
async function inventory(db:PGlite,project=site){return (await db.query<{v:{corrections:Item[]}}>('SELECT public.project_cost_correction_inventory($1) v',[project])).rows[0].v.corrections;}
async function save(db:PGlite,kind:string,cid:string,req:string,rev:number,gross:string,split:unknown){const source=(await db.query<{v:{case:unknown}}>('SELECT public.project_cost_correction_attribution($1,$2,NULL) v',[kind,cid])).rows[0].v.case;await db.query('SELECT public.record_project_cost_correction_attribution($1,$2,$3,$4,$5::jsonb,$6::numeric,$7::jsonb,$8,true)',[req,kind,cid,rev,JSON.stringify(source),gross,JSON.stringify(split),'Reviewed original']);}
describe('project correction inventory, synthetic and read-only',()=>{
 it('distinguishes pending, missing, explicit zero and replacement splits',async()=>{const db=await setup();try{
  let items=await inventory(db);expect(items).toHaveLength(1);expect(items[0]).toMatchObject({kind:'voucher',source_in_snapshot:true,site_gross_change:null,evidence:{case:{status:'pending'},attribution:null}});
  await db.query("SELECT public.resolve_paid_payroll_adjustment($1,'no_transfer',NULL,'Reviewed without transfer')",[id(1)]);
  await save(db,'voucher',id(1),id(2),0,'0.00',[]);items=await inventory(db);expect(items[0]).toMatchObject({site_gross_change:'0.00',evidence:{latest_revision:1,attribution:{case_changed:false,gross_change:'0.00'}}});
  await save(db,'voucher',id(1),id(3),1,'25.00',[{project_id:other,gross_change:'25.00'}]);
  expect((await inventory(db))[0]).toMatchObject({site_gross_change:'0.00',evidence:{latest_revision:2}});
  expect((await inventory(db,other))[0]).toMatchObject({source_in_snapshot:false,site_gross_change:'25.00',evidence:{latest_revision:2}});
  await save(db,'voucher',id(1),id(4),2,'10.00',[{project_id:site,gross_change:'10.00'}]);expect(await inventory(db,other)).toEqual([]);
  await db.exec('RESET ROLE');expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.advances')).rows[0].n).toBe(0);expect((await db.query<{status:string}>('SELECT status FROM public.payroll WHERE id=$1',[worker])).rows[0].status).toBe('paid');
 }finally{await db.close();}},30000);
 it('includes historical cases even without an attribution and flags changed sibling evidence',async()=>{const db=await setup();try{
  await db.exec(`RESET ROLE;INSERT INTO public.test_history VALUES('${site}','${id(10)}');SET ROLE authenticated`);
  let item=(await inventory(db)).find(x=>x.kind==='external_worker');expect(item).toMatchObject({source_in_snapshot:true,site_gross_change:null,evidence:{attribution:null}});
  await save(db,'external_worker',id(11),id(12),0,'-30.00',[{project_id:site,gross_change:'-30.00'}]);item=(await inventory(db)).find(x=>x.kind==='external_worker');expect(item).toMatchObject({site_gross_change:'-30.00',evidence:{attribution:{case_changed:false}}});
  await db.exec(`RESET ROLE; INSERT INTO public.paid_period_assertion_cases VALUES('${id(13)}','external_worker','${id(10)}','{"kind":"external_worker","gross":"600.00"}',10,'pending'); SET ROLE authenticated`);
  const items=await inventory(db);expect(items.find(x=>x.case_id===id(11))).toMatchObject({evidence:{attribution:{case_changed:true}}});expect(items.find(x=>x.case_id===id(13))).toMatchObject({site_gross_change:null,evidence:{case:{status:'pending'}}});
 }finally{await db.close();}},30000);
 it('rejects oversized inventories before loading individual case evidence',async()=>{const db=await setup();try{
  await db.exec(`RESET ROLE;CREATE OR REPLACE FUNCTION public.project_cost_historical_review(p_project uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('project_id',p_project,'base',jsonb_build_object('adjustment_cases',(SELECT jsonb_agg(jsonb_build_object('case_id',md5(n::text)::uuid)) FROM generate_series(1,501) n)),'historical','[]'::jsonb)$$;SET ROLE authenticated`);
  await expect(inventory(db)).rejects.toThrow(/More than 500 correction cases/);
 }finally{await db.close();}},30000);
 it('enforces roles and assurance and propagates inconsistent source errors',async()=>{const db=await setup();try{
  await db.exec(`SET test.uid='${supervisor}'`);await expect(inventory(db)).rejects.toThrow(/Founder/);await db.exec(`SET test.uid='${founder}';SET test.assurance='no'`);await expect(inventory(db)).rejects.toThrow(/Founder/);
  for(const role of ['anon','service_role']){await db.exec(`RESET ROLE;SET ROLE ${role}`);await expect(inventory(db)).rejects.toThrow(/permission denied/);}
  await db.exec(`RESET ROLE;UPDATE public.historical_external_worker_payroll SET original='{"different":true}';INSERT INTO public.test_history VALUES('${site}','${id(10)}');SET ROLE authenticated;SET test.assurance='yes'`);
  await expect(inventory(db)).rejects.toThrow(/evidence unavailable or changed/);
 }finally{await db.close();}},30000);
});
