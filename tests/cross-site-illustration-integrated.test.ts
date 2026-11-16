// @vitest-environment jsdom
// Real preview SQL with synthetic stub source readers; never connects to hosted data.
import React from 'react';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
import {parseAdjustmentList} from '@/lib/payroll/paidAdjustments';
import {parseCorrectionReview} from '@/lib/payroll/projectCostCorrection';
import {actor,site,voucher,worker,caseId,request} from './helpers/corrected-cost-ui-fixture';
import {correctionItem,makeEvidence,other,correctionReview} from './helpers/cross-site-illustration-fixture';
const m=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:m.rpc})}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:'11111111-1111-4111-8111-111111111111'},isFounder:true,assurance:'ready'})}));
import {CrossSiteIllustration} from '@/components/payroll/CrossSiteIllustration';
const founder='00000000-0000-0000-0000-000000000001';
afterEach(()=>{cleanup();vi.unstubAllEnvs();vi.restoreAllMocks();});
async function setup(){const db=new PGlite();await db.exec(baseFixture);await db.exec(`CREATE TABLE public.test_cross_illustration(original jsonb,correction jsonb);
 CREATE FUNCTION public.project_cost_correction_original_context(text,uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT original FROM public.test_cross_illustration$$;
 CREATE FUNCTION public.project_cost_correction_attribution(text,uuid,integer) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT correction FROM public.test_cross_illustration$$;`);
 const e=makeEvidence();await db.query('INSERT INTO public.test_cross_illustration VALUES($1::jsonb,$2::jsonb)',[JSON.stringify(e.original),JSON.stringify(e.correction)]);
 await db.exec(`BEGIN;${readFileSync('supabase/drafts/project_cost_cross_site_preview.sql','utf8')} COMMIT; SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes';`);
 vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_PROJECT_COST_CORRECTION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_CROSS_SITE_ILLUSTRATION_PREVIEW','true');
 m.rpc.mockReset().mockImplementation(async(name:string,a:Record<string,unknown>)=>{try{const result=name==='project_cost_cross_site_evidence'?await db.query<{v:unknown}>('SELECT public.project_cost_cross_site_evidence($1,$2) v',[a.p_kind,a.p_case]):await db.query<{v:unknown}>('SELECT public.project_cost_cross_site_preview($1,$2,$3::jsonb,$4) v',[a.p_kind,a.p_case,JSON.stringify(a.p_expected),a.p_ack]);return {data:result.rows[0].v,error:null};}catch(error){return {data:null,error};}});return db;}
async function open(){render(React.createElement(CrossSiteIllustration,{actor,kind:'voucher',item:correctionItem,review:correctionReview(),projects:[{id:site,name:'Original site'},{id:other,name:'Incoming site'}]}));fireEvent.click(screen.getByRole('button',{name:'Illustrate correction across sites'}));fireEvent.click(screen.getByRole('button',{name:'Load cross-site evidence'}));await screen.findByText(/Incoming site · .* · original/);}
describe('cross-site illustration UI to synthetic preview SQL',()=>{
 it('round-trips a real synthetic case, attribution, original-context and preview chain',async()=>{const db=new PGlite();try{
  const sql=(p:string)=>readFileSync(`supabase/drafts/${p}.sql`,'utf8');await db.exec(baseFixture);
  await db.exec(`INSERT INTO public.users VALUES('${actor}','Founder two','founder');INSERT INTO public.projects VALUES('${site}','Original'),('${other}','Incoming');INSERT INTO public.workers VALUES('${worker}','Worker A','Mason','none',600,'daily',true);INSERT INTO public.payroll VALUES('${voucher}','${worker}','2024-12-01','2024-12-07','paid',1,8,600,100,0,500);
   BEGIN;${sql('paid_payroll_adjustments')} COMMIT;
   CREATE TABLE public.supervisor_period_payroll(id uuid PRIMARY KEY);CREATE TABLE public.paid_period_assertion_case_events(id uuid PRIMARY KEY);CREATE TABLE public.historical_external_worker_payroll(request_id uuid PRIMARY KEY,original jsonb NOT NULL);CREATE TABLE public.paid_period_assertion_cases(id uuid PRIMARY KEY,source_kind text NOT NULL,external_worker_id uuid,original_snapshot jsonb NOT NULL,difference numeric(12,2) NOT NULL,status text NOT NULL);
   CREATE FUNCTION public.paid_period_assertion_snapshot(p_kind text,p_id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT original FROM public.historical_external_worker_payroll WHERE request_id=p_id AND p_kind='external_worker'$$;
   CREATE TABLE public.weekly_worker_paid_allocations(payroll_id uuid,project_id uuid);CREATE TABLE public.historical_worker_attributions(request_id uuid,source_id uuid);CREATE TABLE public.historical_worker_attribution_sites(attribution_id uuid,project_id uuid);
   CREATE TABLE public.test_cross_history(project_id uuid,value jsonb);CREATE FUNCTION public.project_cost_historical_review(p uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT value FROM public.test_cross_history WHERE project_id=p$$;
   INSERT INTO public.weekly_worker_paid_allocations VALUES('${voucher}','${site}');
   BEGIN;${sql('project_cost_correction_attribution')} COMMIT;BEGIN;${sql('project_cost_correction_original_context')} COMMIT;BEGIN;${sql('project_cost_cross_site_preview')} COMMIT;`);
  const history={project_id:site,base:{paid_allocations:[{payroll_id:voucher,worker_id:worker,period_start:'2024-12-01',period_end:'2024-12-07',voucher_gross:'600.00',gross:'600.00'}]}};await db.query('INSERT INTO public.test_cross_history VALUES($1,$2::jsonb)',[site,JSON.stringify(history)]);
  const original=(await db.query<{v:unknown}>('SELECT app_private.paid_adjustment_voucher_snapshot(p) v FROM public.payroll p WHERE id=$1',[voucher])).rows[0].v;
  await db.exec(`SET ROLE authenticated;SET test.uid='${actor}';SET test.assurance='yes'`);await db.query("SELECT public.open_paid_payroll_adjustment($1,$2,$3::jsonb,-30,'Reviewed')",[caseId,voucher,JSON.stringify(original)]);await db.query("SELECT public.resolve_paid_payroll_adjustment($1,'no_transfer',NULL,'Reviewed')",[caseId]);
  const prior=(await db.query<{v:{case:unknown}}>("SELECT public.project_cost_correction_attribution('voucher',$1,NULL) v",[caseId])).rows[0].v;await db.query("SELECT public.record_project_cost_correction_attribution($1,'voucher',$2,0,$3::jsonb,0,$4::jsonb,'Reviewed split',true)",[request,caseId,JSON.stringify(prior.case),JSON.stringify([{project_id:site,gross_change:'-100.25'},{project_id:other,gross_change:'100.25'}])]);
  const items=(await db.query<{v:unknown}>('SELECT public.paid_payroll_adjustment_list($1,0) v',[voucher])).rows[0].v;const item=parseAdjustmentList(items,voucher,0).items[0];const reviewRaw=(await db.query<{v:unknown}>("SELECT public.project_cost_correction_attribution('voucher',$1,NULL) v",[caseId])).rows[0].v;const review=parseCorrectionReview(reviewRaw,'voucher',item);
  vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_PROJECT_COST_CORRECTION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_CROSS_SITE_ILLUSTRATION_PREVIEW','true');
  m.rpc.mockReset().mockImplementation(async(name:string,a:Record<string,unknown>)=>{try{const r=name==='project_cost_cross_site_evidence'?await db.query<{v:unknown}>('SELECT public.project_cost_cross_site_evidence($1,$2) v',[a.p_kind,a.p_case]):await db.query<{v:unknown}>('SELECT public.project_cost_cross_site_preview($1,$2,$3::jsonb,$4) v',[a.p_kind,a.p_case,JSON.stringify(a.p_expected),a.p_ack]);return {data:r.rows[0].v,error:null};}catch(error){return {data:null,error};}});
  render(React.createElement(CrossSiteIllustration,{actor,kind:'voucher',item,review,projects:[{id:site,name:'Original site'},{id:other,name:'Incoming site'}]}));fireEvent.click(screen.getByRole('button',{name:'Illustrate correction across sites'}));fireEvent.click(screen.getByRole('button',{name:'Load cross-site evidence'}));await screen.findByText(/Incoming site · .* · original/);fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Verify cross-site illustration'}));await screen.findByText(/Illustration verified against the server snapshot/);
  await db.exec('RESET ROLE');expect((await db.query('SELECT count(*)::int n FROM public.project_cost_correction_attributions')).rows[0]).toEqual({n:1});expect((await db.query('SELECT status,gross_pay::text gross FROM public.payroll WHERE id=$1',[voucher])).rows[0]).toEqual({status:'paid',gross:'600'});
 }finally{cleanup();await db.close();}},30000);

 it('independently verifies real SQL output and leaves source records unchanged',async()=>{const db=await setup();try{await open();fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Verify cross-site illustration'}));await screen.findByText(/Illustration verified against the server snapshot/);await db.exec('RESET ROLE');expect((await db.query('SELECT status,gross_pay::text gross FROM public.payroll')).rows[0]).toEqual({status:'paid',gross:'600'});expect((await db.query('SELECT count(*)::int n FROM public.advances')).rows[0]).toEqual({n:0});}finally{cleanup();await db.close();}},30000);
 it('refuses a source changed after capture, and removes the stale illustration',async()=>{const db=await setup();try{await open();await db.exec("RESET ROLE; UPDATE public.test_cross_illustration SET original=jsonb_set(original,'{sites,0,gross}','\"599.99\"'::jsonb); SET ROLE authenticated;");fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Verify cross-site illustration'}));await screen.findByRole('alert');expect(screen.queryByText(/Incoming site · .* · original/)).toBeNull();expect(screen.queryByText(/Illustration verified/)).toBeNull();}finally{cleanup();await db.close();}},30000);
});
