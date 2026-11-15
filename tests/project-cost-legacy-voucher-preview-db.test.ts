import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const founder='00000000-0000-0000-0000-000000000001',supervisor='00000000-0000-0000-0000-000000000002',voucher='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004',other='00000000-0000-0000-0000-000000000005';
const request='f2000000-0000-4000-8000-000000000001',expense='f2000000-0000-4000-8000-000000000002',weekly='f2000000-0000-4000-8000-000000000003',caseId='f2000000-0000-4000-8000-000000000004';
const sql=(name:string)=>readFileSync(`supabase/drafts/${name}.sql`,'utf8');
async function setup(){const db=new PGlite();await db.exec(baseFixture);await db.exec(`
 CREATE TABLE public.weekly_worker_draft_sources(payroll_id uuid);
 CREATE TABLE public.weekly_worker_paid_allocations(payroll_id uuid,project_id uuid,gross numeric);
 CREATE TABLE public.historical_external_worker_payroll(worker_id uuid,period_start date,period_end date);
 CREATE TABLE public.supervisor_period_payroll(supervisor_id uuid,supervisor_name text,period_start date,period_end date);
 CREATE TABLE public.paid_payroll_adjustment_cases(id uuid primary key,payroll_id uuid,status text);
 CREATE FUNCTION app_private.paid_adjustment_voucher_snapshot(p public.payroll) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('id',p.id,'worker_id',p.worker_id,'period_start',p.period_start,'period_end',p.period_end,'status',p.status,'gross_pay',p.gross_pay::text,'bale_deduction',p.bale_deduction::text,'other_deductions',p.other_deductions::text,'net_pay',p.net_pay::text)$$;
 BEGIN;${sql('legacy_paid_voucher_attribution')} COMMIT;
 CREATE TABLE public.test_base_inventory(value jsonb NOT NULL);
 CREATE FUNCTION public.project_cost_correction_inventory(p uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$SELECT value FROM public.test_base_inventory WHERE value->>'project_id'=p::text$$;
 BEGIN;${sql('project_cost_corrected_preview')} COMMIT;BEGIN;${sql('project_cost_legacy_voucher_preview')} COMMIT;
 SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);
 const old=(await db.query<{v:{voucher:unknown;worker:unknown}}>('SELECT public.legacy_paid_voucher_attribution($1) v',[voucher])).rows[0].v;
 await db.query('SELECT public.record_legacy_paid_voucher_attribution($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,true)',[request,voucher,JSON.stringify(old.voucher),JSON.stringify(old.worker),JSON.stringify([{project_id:site,gross:'400.00'},{project_id:other,gross:'200.00'}]),'Original reviewed']);
 await db.exec('RESET ROLE');const base={project_id:site,historical_review:{project_id:site,base:{captured_at:'2026-10-01T00:00:00Z',expenses:[{id:expense,amount:'100.00'}],paid_allocations:[{payroll_id:weekly,gross:'50.00'}],adjustment_cases:[]},historical:[]},corrections:[]};await db.query('INSERT INTO public.test_base_inventory VALUES($1::jsonb)',[JSON.stringify(base)]);await db.exec('SET ROLE authenticated');return db;}
async function inventory(db:PGlite){return (await db.query<{v:Record<string,unknown>}>('SELECT public.project_cost_legacy_voucher_inventory($1) v',[site])).rows[0].v;}
const choices={expenses:{[expense]:{decision:'include',reason:null}},historical:{},corrections:{}};
async function preview(db:PGlite,s:unknown,l:unknown,c:unknown=choices){return (await db.query<{v:Record<string,unknown>}>('SELECT public.project_cost_legacy_voucher_preview($1,$2::jsonb,$3::jsonb,$4::jsonb,true) v',[site,JSON.stringify(s),JSON.stringify(c),JSON.stringify(l)])).rows[0].v;}
describe('held legacy voucher cost preview',()=>{
 it('adds a reviewed split exactly once to real corrected-preview math, or records its exclusion',async()=>{const db=await setup();try{
  const s=await inventory(db);expect(s.legacy_vouchers).toMatchObject([{payroll_id:voucher,site_gross:'400.00'}]);
  expect(await preview(db,s,{[request]:{decision:'include',reason:null}})).toMatchObject({legacy_included_gross:'400.00',legacy_excluded_gross:'0.00',incomplete_total:'550.00',incomplete:true,base:{incomplete_total:'150.00'}});
  expect(await preview(db,s,{[request]:{decision:'exclude',reason:'Investigate'}})).toMatchObject({legacy_included_gross:'0.00',legacy_excluded_gross:'400.00',legacy_excluded_count:1,incomplete_total:'150.00'});
  await expect(preview(db,s,{})).rejects.toThrow(/every legacy voucher/);await expect(preview(db,s,{[request]:{decision:'exclude',reason:''}})).rejects.toThrow(/Invalid legacy/);
  await expect(preview(db,s,{[request]:{decision:'include',reason:null}},{expenses:{},historical:{},corrections:{}})).rejects.toThrow(/Review every/);
  await db.exec('RESET ROLE');expect((await db.query<{gross:string}>('SELECT gross_pay::text gross FROM public.payroll WHERE id=$1',[voucher])).rows[0].gross).toBe('600');
 }finally{await db.close();}},30000);
 it('fails closed for a stale snapshot, duplicate allocation and later correction',async()=>{const db=await setup();try{
  const s=await inventory(db);await db.exec(`RESET ROLE; UPDATE public.test_base_inventory SET value=jsonb_set(value,'{historical_review,base,expenses,0,amount}','"101.00"'::jsonb);SET ROLE authenticated`);await expect(preview(db,s,{[request]:{decision:'include',reason:null}})).rejects.toThrow(/evidence changed/);
  await db.exec(`RESET ROLE; UPDATE public.test_base_inventory SET value=jsonb_set(value,'{historical_review,base,paid_allocations,0,payroll_id}',to_jsonb('${voucher}'::text));SET ROLE authenticated`);await expect(inventory(db)).rejects.toThrow(/overlaps a paid allocation/);
  await db.exec(`RESET ROLE; UPDATE public.test_base_inventory SET value=jsonb_set(value,'{historical_review,base,paid_allocations,0,payroll_id}',to_jsonb('${weekly}'::text));INSERT INTO public.paid_payroll_adjustment_cases VALUES('${caseId}','${voucher}','pending');SET ROLE authenticated`);await expect(inventory(db)).rejects.toThrow(/has a correction/);
 }finally{await db.close();}},30000);
 it('denies unauthorised or low-assurance reads and previews',async()=>{const db=await setup();try{const s=await inventory(db);await db.exec(`SET test.uid='${supervisor}'`);await expect(inventory(db)).rejects.toThrow(/Founder/);await expect(preview(db,s,{})).rejects.toThrow(/Founder/);await db.exec(`SET test.uid='${founder}';SET test.assurance='no'`);await expect(inventory(db)).rejects.toThrow(/Founder/);await db.exec('RESET ROLE; SET ROLE anon');await expect(inventory(db)).rejects.toThrow(/permission denied/);}finally{await db.close();}},30000);
});
