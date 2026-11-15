import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const founder='00000000-0000-0000-0000-000000000001',supervisor='00000000-0000-0000-0000-000000000002',voucher='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004',other='00000000-0000-0000-0000-000000000005';
const request='f1000000-0000-4000-8000-000000000001',request2='f1000000-0000-4000-8000-000000000002';
const sql=readFileSync('supabase/drafts/legacy_paid_voucher_attribution.sql','utf8');
async function setup(){const db=new PGlite();await db.exec(baseFixture);await db.exec(`
 CREATE TABLE public.weekly_worker_draft_sources(payroll_id uuid);
 CREATE TABLE public.weekly_worker_paid_allocations(payroll_id uuid,project_id uuid,gross numeric);
 CREATE TABLE public.historical_external_worker_payroll(worker_id uuid,period_start date,period_end date);
 CREATE TABLE public.paid_payroll_adjustment_cases(id uuid primary key,payroll_id uuid,status text);
 CREATE FUNCTION app_private.paid_adjustment_voucher_snapshot(p public.payroll) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT jsonb_build_object('id',p.id,'worker_id',p.worker_id,'period_start',p.period_start,'period_end',p.period_end,'status',p.status,'gross_pay',p.gross_pay::text,'bale_deduction',p.bale_deduction::text,'other_deductions',p.other_deductions::text,'net_pay',p.net_pay::text) $$;
 BEGIN;${sql} COMMIT;
 SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes';`);return db;}
async function read(db:PGlite){return (await db.query<{v:Record<string,unknown>}>('SELECT public.legacy_paid_voucher_attribution($1) v',[voucher])).rows[0].v;}
async function record(db:PGlite,id:string,expected:unknown,split:unknown,note='Checked original payroll'){return (await db.query<{v:unknown}>('SELECT public.record_legacy_paid_voucher_attribution($1,$2,$3::jsonb,$4::jsonb,$5,true) v',[id,voucher,JSON.stringify(expected),JSON.stringify(split),note])).rows[0].v;}
const split=[{project_id:site,gross:'400.00'},{project_id:other,gross:'200.00'}];
describe('held legacy paid voucher site attribution',()=>{
 it('records one exact gross split without modifying payroll, retries and detects later cases',async()=>{const db=await setup();try{
  const initial=await read(db);expect(initial).toMatchObject({found:false,eligible:true,risks:[]});const expected=initial.voucher;
  expect(await record(db,request,expected,split)).toMatchObject({request_id:request,payroll_id:voucher,replayed:false});
  expect(await record(db,request,expected,[...split].reverse())).toMatchObject({replayed:true});
  expect(await read(db)).toMatchObject({found:true,source_changed:false,case_count:0,split,note:'Checked original payroll'});
  await expect(record(db,request2,expected,split)).rejects.toThrow(/separate reconciliation/);
  await expect(record(db,request,expected,split,'changed')).rejects.toThrow(/Retry differs/);
  await db.exec('RESET ROLE');expect((await db.query('SELECT status,gross_pay::text gross,net_pay::text net FROM public.payroll WHERE id=$1',[voucher])).rows[0]).toEqual({status:'paid',gross:'600',net:'600'});
  await expect(db.exec(`UPDATE public.legacy_paid_voucher_attribution_sites SET gross=1`)).rejects.toThrow(/immutable/);
  await db.exec(`INSERT INTO public.paid_payroll_adjustment_cases VALUES('${request2}','${voucher}','pending');SET ROLE authenticated`);
  expect(await read(db)).toMatchObject({found:true,source_changed:true,case_count:1,risks:['correction_cases']});await expect(record(db,request,expected,split)).rejects.toThrow(/source evidence changed/);
 }finally{await db.close();}},30000);
 it('rejects invalid or stale splits and leaves no partial evidence',async()=>{const db=await setup();try{const expected=(await read(db)).voucher;
  for(const bad of [[{project_id:site,gross:'599.99'}],[{project_id:site,gross:'600.00'},{project_id:site,gross:'1.00'}],[{project_id:site,gross:'-600.00'}],[{project_id:site,gross:'600'}],[{project_id:request2,gross:'600.00'}]])await expect(record(db,request,expected,bad)).rejects.toThrow();
  await expect(record(db,request,{...(expected as object),net_pay:'1'},split)).rejects.toThrow(/Voucher changed/);
  expect(await read(db)).toMatchObject({found:false,eligible:true});await db.exec('RESET ROLE');expect((await db.query('SELECT count(*)::int n FROM public.legacy_paid_voucher_attributions')).rows[0]).toEqual({n:0});
 }finally{await db.close();}},30000);
 it('blocks generated, conflicting, corrected and possible Supervisor records',async()=>{const db=await setup();try{
  const expected=(await read(db)).voucher;
  await db.exec(`RESET ROLE; INSERT INTO public.weekly_worker_draft_sources VALUES('${voucher}');SET ROLE authenticated`);expect((await read(db)).risks).toContain('generated_or_allocated');await expect(record(db,request,expected,split)).rejects.toThrow(/separate reconciliation/);
  await db.exec(`RESET ROLE;DELETE FROM public.weekly_worker_draft_sources;INSERT INTO public.historical_external_worker_payroll VALUES('${voucher}','2026-10-25','2026-10-31');SET ROLE authenticated`);expect((await read(db)).risks).toContain('overlapping_payroll');
  await db.exec(`RESET ROLE;DELETE FROM public.historical_external_worker_payroll;UPDATE public.workers SET position='Site Supervisor' WHERE id='${voucher}';SET ROLE authenticated`);expect((await read(db)).risks).toContain('possible_supervisor');
 }finally{await db.close();}},30000);
 it('denies non-Founders, insufficient assurance and direct table access',async()=>{const db=await setup();try{
  await expect(db.query('SELECT * FROM public.legacy_paid_voucher_attributions')).rejects.toThrow(/permission denied/);
  await db.exec(`SET test.uid='${supervisor}';SET test.assurance='yes'`);await expect(read(db)).rejects.toThrow(/Founder access/);
  await db.exec(`SET test.uid='${founder}';SET test.assurance='no'`);await expect(read(db)).rejects.toThrow(/Founder access/);
  await db.exec('RESET ROLE; SET ROLE anon');await expect(read(db)).rejects.toThrow(/permission denied/);
 }finally{await db.close();}},30000);
});
