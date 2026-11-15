// @vitest-environment jsdom
import React from 'react';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
import type {PaidReviewVoucher} from '@/lib/payroll/paidReview';
const mock=vi.hoisted(()=>({rpc:vi.fn()}));vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
import {LegacyVoucherAttribution} from '@/components/payroll/LegacyVoucherAttribution';
import {legacyVoucherAttributionPreviewEnabled} from '@/lib/finance/featureAvailability';
const actor='00000000-0000-0000-0000-000000000001',id='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004',other='00000000-0000-0000-0000-000000000005',request='f3000000-0000-4000-8000-000000000001';
const voucher:PaidReviewVoucher={id,worker_id:id,worker_name:'Test Worker',period_start:'2026-10-25',period_end:'2026-10-31',gross_pay:'600',bale_deduction:'0',other_deductions:'0',net_pay:'600',overlapping_paid:false,period_bale_total:'0',period_bale_count:0,unlinked_period_bale_count:0};
afterEach(()=>{cleanup();sessionStorage.clear();vi.restoreAllMocks();vi.unstubAllEnvs();});
function panel(){return React.createElement(LegacyVoucherAttribution,{actor,voucher});}
describe('held legacy voucher site attribution UI to synthetic SQL',()=>{
 it('requires an independent default-off gate even when the development cutover is enabled',()=>{vi.stubEnv('NEXT_PUBLIC_DEVELOPMENT_FINANCE_CUTOVER','true');vi.stubEnv('NEXT_PUBLIC_LEGACY_VOUCHER_ATTRIBUTION_PREVIEW','false');expect(legacyVoucherAttributionPreviewEnabled()).toBe(false);vi.stubEnv('NEXT_PUBLIC_LEGACY_VOUCHER_ATTRIBUTION_PREVIEW','true');expect(legacyVoucherAttributionPreviewEnabled()).toBe(true);});
 it('asks to reload after the database rejects a changed case on the first save',async()=>{
  const original={id,worker_id:id,period_start:voucher.period_start,period_end:voucher.period_end,status:'paid',gross_pay:'600',bale_deduction:'0',other_deductions:'0',net_pay:'600'},worker={id,name:'Test Worker',position:'Mason',active:true};
  mock.rpc.mockImplementation(async(name:string)=>name==='historical_worker_attribution_projects'?{data:{projects:[{id:site,name:'Site One'}]},error:null}:name==='legacy_paid_voucher_attribution'?{data:{payroll_id:id,worker_name:'Test Worker',worker,voucher:original,found:false,eligible:true,risks:[],cases:[]},error:null}:{data:null,error:{code:'40001'}});
  vi.spyOn(crypto,'randomUUID').mockReturnValue(request);render(panel());fireEvent.click(screen.getByRole('button',{name:'Attribute older voucher to projects'}));fireEvent.click(screen.getByRole('button',{name:'Load voucher attribution review'}));await screen.findByText(/Test Worker.*gross/);
  fireEvent.change(screen.getByLabelText('Voucher project 1'),{target:{value:site}});fireEvent.change(screen.getByLabelText('Voucher project gross 1 (₱)'),{target:{value:'600'}});fireEvent.change(screen.getByLabelText('Voucher attribution evidence note'),{target:{value:'Checked old ledger'}});fireEvent.click(screen.getByRole('checkbox',{name:/I checked the original records/}));fireEvent.click(screen.getByRole('button',{name:'Record voucher project attribution'}));
  await screen.findByText(/correction cases changed.*load the review again/);expect(sessionStorage.length).toBe(0);expect(screen.getByRole('button',{name:'Load voucher attribution review'})).toBeTruthy();expect(screen.queryByRole('button',{name:'Retry exact voucher attribution'})).toBeNull();
 });
 it('records a reviewed split once and verifies an exact retry after a lost response',async()=>{const db=new PGlite();try{
  await db.exec(baseFixture);await db.exec(`CREATE TABLE public.weekly_worker_draft_sources(payroll_id uuid);CREATE TABLE public.weekly_worker_paid_allocations(payroll_id uuid,project_id uuid,gross numeric);CREATE TABLE public.historical_external_worker_payroll(worker_id uuid,period_start date,period_end date);CREATE TABLE public.supervisor_period_payroll(supervisor_id uuid,supervisor_name text,period_start date,period_end date);CREATE TABLE public.paid_payroll_adjustment_cases(id uuid primary key,payroll_id uuid,status text);
   CREATE FUNCTION app_private.paid_adjustment_voucher_snapshot(p public.payroll) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('id',p.id,'worker_id',p.worker_id,'period_start',p.period_start,'period_end',p.period_end,'status',p.status,'gross_pay',p.gross_pay::text,'bale_deduction',p.bale_deduction::text,'other_deductions',p.other_deductions::text,'net_pay',p.net_pay::text)$$;
   BEGIN;${readFileSync('supabase/drafts/legacy_paid_voucher_attribution.sql','utf8')} COMMIT;SET ROLE authenticated;SET test.uid='${actor}';SET test.assurance='yes'`);
  let lose=true;mock.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>{try{
   if(name==='historical_worker_attribution_projects')return {data:{projects:[{id:site,name:'Site One'},{id:other,name:'Site Two'}]},error:null};
   if(name==='legacy_paid_voucher_attribution')return {data:(await db.query<{v:unknown}>('SELECT public.legacy_paid_voucher_attribution($1) v',[args.p_payroll])).rows[0].v,error:null};
   if(name==='record_legacy_paid_voucher_attribution'){const result=await db.query<{v:unknown}>('SELECT public.record_legacy_paid_voucher_attribution($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8::jsonb) v',[args.p_request,args.p_payroll,JSON.stringify(args.p_expected),JSON.stringify(args.p_expected_worker),JSON.stringify(args.p_split),args.p_note,args.p_ack,JSON.stringify(args.p_expected_cases)]);if(lose){lose=false;return {data:null,error:Error('response lost after commit')};}return {data:result.rows[0].v,error:null};}
   throw Error('unexpected RPC');}catch(error){return {data:null,error};}});vi.spyOn(crypto,'randomUUID').mockReturnValue(request);
  render(panel());fireEvent.click(screen.getByRole('button',{name:'Attribute older voucher to projects'}));fireEvent.click(screen.getByRole('button',{name:'Load voucher attribution review'}));await screen.findByText(/Test Worker.*gross/);
  fireEvent.change(screen.getByLabelText('Voucher project 1'),{target:{value:site}});fireEvent.change(screen.getByLabelText('Voucher project gross 1 (₱)'),{target:{value:'400'}});fireEvent.click(screen.getByRole('button',{name:'Add voucher project'}));fireEvent.change(screen.getByLabelText('Voucher project 2'),{target:{value:other}});fireEvent.change(screen.getByLabelText('Voucher project gross 2 (₱)'),{target:{value:'200'}});fireEvent.change(screen.getByLabelText('Voucher attribution evidence note'),{target:{value:'Checked old ledger'}});fireEvent.click(screen.getByRole('checkbox',{name:/I checked the original records/}));fireEvent.click(screen.getByRole('button',{name:'Record voucher project attribution'}));await screen.findByText(/outcome is unconfirmed/);
  cleanup();render(panel());fireEvent.click(screen.getByRole('button',{name:'Attribute older voucher to projects'}));await screen.findByRole('button',{name:'Retry exact voucher attribution'});fireEvent.click(screen.getByRole('button',{name:'Retry exact voucher attribution'}));await screen.findByText(/Attribution evidence recorded and verified/);
  const writes=mock.rpc.mock.calls.filter(([name])=>name==='record_legacy_paid_voucher_attribution');expect(writes).toHaveLength(2);expect(writes[0][1]).toEqual(writes[1][1]);expect(sessionStorage.length).toBe(0);
  await db.exec('RESET ROLE');expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.legacy_paid_voucher_attributions')).rows[0].n).toBe(1);expect((await db.query<{gross:string}>('SELECT gross_pay::text gross FROM public.payroll WHERE id=$1',[id])).rows[0].gross).toBe('600');
 }finally{cleanup();await db.close();}},30000);
});
