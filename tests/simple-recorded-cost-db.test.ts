// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {afterEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn()}));vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:m.rpc})}));
import {ProjectReviewedCostSummary} from '@/components/projects/ProjectReviewedCostSummary';
import {parseSimpleRecordedCost} from '@/lib/projects/simpleRecordedCost';
import {baleExpense,candidatePaths,confirmRental,fixture,founder,payroll,roles,site,supervisor} from './helpers/project-cost-reconciliation-fixture';
const sql=(name:string)=>readFileSync(`supabase/drafts/${name}.sql`,'utf8');
async function setup(){const db=new PGlite();try{
 await db.exec(`${roles} ${fixture}`);
 await db.exec(`ALTER TABLE public.users ADD COLUMN name text;UPDATE public.users SET name=role;
 ALTER TABLE public.workers ADD COLUMN position text,ADD COLUMN active boolean DEFAULT true;UPDATE public.workers SET position='Mason';
 CREATE TABLE public.advances(id uuid PRIMARY KEY);CREATE TABLE public.supervisor_period_payroll(id uuid PRIMARY KEY,supervisor_id uuid,supervisor_name text,period_start date,period_end date);
 CREATE TABLE public.paid_period_assertion_case_events(id uuid PRIMARY KEY);CREATE TABLE public.historical_external_worker_payroll(request_id uuid PRIMARY KEY,worker_id uuid,period_start date,period_end date,original jsonb,gross numeric);
 CREATE TABLE public.attendance(worker_id uuid,project_id uuid,date date);CREATE TABLE public.paid_period_assertion_cases(id uuid PRIMARY KEY,source_kind text,external_worker_id uuid,original_snapshot jsonb,difference numeric,status text);
 CREATE TABLE public.historical_worker_attributions(request_id uuid,source_id uuid);CREATE TABLE public.historical_worker_attribution_sites(attribution_id uuid,project_id uuid);
 CREATE FUNCTION public.paid_period_assertion_snapshot(p_kind text,p_id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT original FROM public.historical_external_worker_payroll WHERE request_id=p_id AND p_kind='external_worker'$$;
 CREATE FUNCTION public.project_historical_worker_attributions(p_project uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('project_id',p_project,'items','[]'::jsonb)$$;`);
 for(const path of candidatePaths)await db.exec(`BEGIN;${readFileSync(path,'utf8')} COMMIT;`);
 for(const name of ['project_cost_historical_review','project_cost_correction_attribution','project_cost_correction_inventory','project_cost_corrected_preview','project_cost_corrected_review_ledger','project_cost_recorded_coverage','project_recorded_cost_snapshot'])await db.exec(`BEGIN;${sql(name)} COMMIT;`);
 return db;
 }catch(e){await db.close();throw e;}}
const snapshot=async(db:PGlite)=> (await db.query<{v:unknown}>('SELECT public.project_recorded_cost_snapshot($1) v',[site])).rows[0].v;
afterEach(()=>{cleanup();vi.unstubAllEnvs();m.rpc.mockReset();});
describe('simple project recorded cost through real SQL candidates',()=>{
 it('uses one snapshot, avoids a duplicate rental, and withholds when Bale or a later correction needs review',async()=>{const db=await setup();try{
  await db.exec(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);await db.exec(confirmRental);
  let checked=parseSimpleRecordedCost(await snapshot(db),site);expect(checked.totals).toBeNull();expect(checked.issues.join(' ')).toMatch(/Bale/);
  await db.exec('RESET ROLE');await db.query('DELETE FROM public.expenses WHERE id=$1',[baleExpense]);await db.exec('SET ROLE authenticated');
  checked=parseSimpleRecordedCost(await snapshot(db),site);expect(checked.issues).toEqual([]);expect(checked.totals).toMatchObject({expenses:105000n,paid:60000n,historical:0n,correction:0n,total:165000n});
  await db.exec('RESET ROLE');const original=(await db.query<{v:unknown}>('SELECT app_private.paid_adjustment_voucher_snapshot(p) v FROM public.payroll p WHERE id=$1',[payroll])).rows[0].v;await db.exec('SET ROLE authenticated');
  await db.query("SELECT public.open_paid_payroll_adjustment($1,$2,$3::jsonb,10,'Original period review')",['ac000000-0000-4000-8000-000000000099',payroll,JSON.stringify(original)]);checked=parseSimpleRecordedCost(await snapshot(db),site);expect(checked.totals).toBeNull();expect(checked.issues.join(' ')).toMatch(/corrections need review/);
  await db.exec('RESET ROLE');const before=(await db.query('SELECT gross_pay::text,bale_deduction::text,net_pay::text FROM public.payroll')).rows;expect(before).toEqual([{gross_pay:'750.00',bale_deduction:'100.00',net_pay:'650.00'}]);
 }finally{await db.close();}},30000);
 it('shows the SQL-backed amount in the UI and hides it when a new Bale expense appears',async()=>{const db=await setup();try{
  await db.exec(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);await db.exec(confirmRental);await db.exec('RESET ROLE');await db.query('DELETE FROM public.expenses WHERE id=$1',[baleExpense]);await db.exec('SET ROLE authenticated');
  for(const flag of ['FINANCE_FOUNDATION_PREVIEW','PROJECT_COST_CORRECTION_PREVIEW','CORRECTED_PROJECT_COST_REVIEW_PREVIEW','SIMPLE_RECORDED_COST_PREVIEW'])vi.stubEnv(`NEXT_PUBLIC_${flag}`,'true');
  m.rpc.mockImplementation(async(name:string)=>name==='project_recorded_cost_snapshot'?{data:await snapshot(db),error:null}:{data:null,error:Error('Unexpected RPC')});
  render(React.createElement(ProjectReviewedCostSummary,{projectId:site,userId:founder,onReview:()=>{}}));await screen.findByText('Recorded cost so far: ₱1,650.00');
  await db.exec('RESET ROLE');await db.query("INSERT INTO public.expenses(id,project_id,description,category,amount,expense_date,ai_bale_detection) VALUES($1,$2,'Bale given','other',100,'2024-11-03',true)",[baleExpense,site]);await db.exec('SET ROLE authenticated');
  fireEvent.click(screen.getByRole('button',{name:'Refresh reviewed cost'}));await screen.findByText(/Recorded cost needs review/);expect(screen.queryByText('Recorded cost so far: ₱1,650.00')).toBeNull();
 }finally{cleanup();await db.close();}},30000);
 it('denies supervisors, insufficient assurance and anonymous callers',async()=>{const db=await setup();try{
  await db.exec(`SET ROLE authenticated;SET test.uid='${supervisor}';SET test.assurance='yes'`);await expect(snapshot(db)).rejects.toThrow(/Founder access/);
  await db.exec(`SET test.uid='${founder}';SET test.assurance='no'`);await expect(snapshot(db)).rejects.toThrow(/Founder access/);
  await db.exec('RESET ROLE;SET ROLE anon');await expect(snapshot(db)).rejects.toThrow(/permission denied/);
 }finally{await db.close();}},30000);
});
