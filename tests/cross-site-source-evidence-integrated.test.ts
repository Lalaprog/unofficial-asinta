// @vitest-environment jsdom
// Actual context/destination preview SQL with synthetic stubbed source readers.
import React from 'react';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
import {crossFixture,key} from './helpers/cross-site-cost-review-fixture';
import {parseCorrectedInventory} from '@/lib/projects/correctedCostReview';
import {calculateCrossSite,verifyCrossSiteTotals} from '@/lib/projects/crossSiteCostReview';
const m=vi.hoisted(()=>({rpc:vi.fn()}));vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:m.rpc})}));vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:'11111111-1111-4111-8111-111111111111'},isFounder:true,assurance:'ready'})}));
import {CrossSiteSourceEvidence} from '@/components/projects/CrossSiteSourceEvidence';
import {CorrectedProjectCostReview} from '@/components/projects/CorrectedProjectCostReview';
afterEach(()=>{cleanup();vi.unstubAllEnvs();vi.restoreAllMocks();});
describe('incoming source UI and client calculation against synthetic SQL',()=>{
 it('checks source inclusion through the real context and destination-preview functions',async()=>{const db=new PGlite(),f=crossFixture();try{
  await db.exec(baseFixture);await db.exec(`CREATE TABLE public.test_cross_payload(evidence jsonb,illustration jsonb,review jsonb);
   CREATE FUNCTION public.project_cost_cross_site_evidence(text,uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT evidence FROM public.test_cross_payload$$;
   CREATE FUNCTION public.project_cost_cross_site_preview(text,uuid,jsonb,boolean) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT illustration FROM public.test_cross_payload$$;
   CREATE FUNCTION public.project_cost_corrected_review(uuid,integer) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT review FROM public.test_cross_payload$$;
   CREATE FUNCTION public.project_cost_corrected_preview(p uuid,s jsonb,c jsonb,a boolean) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$BEGIN
    IF c->'corrections'->'${key}'->>'decision' IS DISTINCT FROM 'exclude' THEN RAISE EXCEPTION 'Incoming not excluded from base'; END IF;
    RETURN jsonb_build_object('project_id',p,'included_expenses','0.00','excluded_expenses','0.00','paid_gross','0.00','historical_gross','0.00','excluded_historical','0.00','correction_gross','0.00','excluded_cases',1,'incomplete_total','0.00','incomplete',true);END$$;`);
  await db.query('INSERT INTO public.test_cross_payload VALUES($1::jsonb,$2::jsonb,$3::jsonb)',[JSON.stringify(f.context.source_evidence),JSON.stringify(f.context.illustration),JSON.stringify(f.sourceSaved)]);
  for(const name of ['project_cost_cross_site_review_context','project_cost_cross_site_corrected_preview'])await db.exec(`BEGIN;${readFileSync(`supabase/drafts/${name}.sql`,'utf8')} COMMIT;`);
  await db.exec("SET ROLE authenticated;SET test.uid='00000000-0000-0000-0000-000000000001';SET test.assurance='yes'");
  vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_PROJECT_COST_CORRECTION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_CORRECTED_PROJECT_COST_REVIEW_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_CROSS_SITE_SOURCE_REVIEW_PREVIEW','true');
  m.rpc.mockReset().mockImplementation(async(name:string,a:Record<string,unknown>)=>{try{const r=name==='project_cost_cross_site_review_context'?await db.query<{v:unknown}>('SELECT public.project_cost_cross_site_review_context($1,$2,$3) v',[a.p_destination,a.p_kind,a.p_case]):await db.query<{v:unknown}>('SELECT public.project_cost_corrected_review($1,$2) v',[a.p_project,a.p_revision]);return {data:r.rows[0].v,error:null};}catch(error){return {data:null,error};}});
  const inv=parseCorrectedInventory(f.destination,f.ids.other);render(React.createElement(CrossSiteSourceEvidence,{projectId:f.ids.other,userId:f.ids.actor,item:inv.cases[0]}));fireEvent.click(screen.getByRole('button',{name:'Inspect incoming source-site reviews'}));fireEvent.click(screen.getByRole('button',{name:'Load original-site reviews'}));await screen.findByText(/Incoming gross effect ₱100.25/);
  const context=(await db.query<{v:unknown}>('SELECT public.project_cost_cross_site_review_context($1,$2,$3) v',[f.ids.other,'voucher',f.ids.caseId])).rows[0].v;
  const actual=(await db.query<{v:unknown}>('SELECT public.project_cost_cross_site_corrected_preview($1,$2::jsonb,$3::jsonb,$4::jsonb,true) v',[f.ids.other,JSON.stringify(f.destination),JSON.stringify(f.destinationChoices),JSON.stringify({[key]:context})])).rows[0].v;
  const calculated=calculateCrossSite(inv,f.destinationChoices,{[key]:context},f.sourceReviews);expect(verifyCrossSiteTotals(actual,f.ids.other,calculated.totals)).toEqual(calculated.totals);
  cleanup();m.rpc.mockImplementation(async(name:string,a:Record<string,unknown>)=>{try{
   if(name==='project_cost_correction_inventory')return {data:f.destination,error:null};
   const r=name==='project_cost_cross_site_review_context'?await db.query<{v:unknown}>('SELECT public.project_cost_cross_site_review_context($1,$2,$3) v',[a.p_destination,a.p_kind,a.p_case]):name==='project_cost_corrected_review'?await db.query<{v:unknown}>('SELECT public.project_cost_corrected_review($1,$2) v',[a.p_project,a.p_revision]):await db.query<{v:unknown}>('SELECT public.project_cost_cross_site_corrected_preview($1,$2::jsonb,$3::jsonb,$4::jsonb,$5) v',[a.p_project,JSON.stringify(a.p_snapshot),JSON.stringify(a.p_choices),JSON.stringify(a.p_cross_sites),a.p_ack]);return {data:r.rows[0].v,error:null};}catch(error){return {data:null,error};}});
  render(React.createElement(CorrectedProjectCostReview,{projectId:f.ids.other,userId:f.ids.actor}));fireEvent.click(screen.getByRole('button',{name:'Review costs including worker corrections'}));fireEvent.click(screen.getByRole('button',{name:'Load corrected evidence'}));await screen.findByText(/Snapshot captured/);const group=screen.getByRole('group',{name:`Corrected case ${key}`});fireEvent.click(within(group).getByLabelText('Include correction'));fireEvent.change(within(group).getByLabelText(`Reason for correction ${key}`),{target:{value:'Reviewed'}});fireEvent.click(within(group).getByRole('button',{name:'Inspect incoming source-site reviews'}));fireEvent.click(within(group).getByRole('button',{name:'Load original-site reviews'}));await screen.findByText(/Incoming gross effect ₱100.25/);fireEvent.click(screen.getByRole('checkbox',{name:/I reviewed all destination decisions/}));fireEvent.click(screen.getByRole('button',{name:'Verify incoming cross-site preview'}));await screen.findByText(/Incoming cross-site gross ₱100.25/);
  await db.exec(`RESET ROLE;UPDATE public.test_cross_payload SET review=jsonb_set(review,'{freshness}','"changed"'::jsonb);SET ROLE authenticated`);fireEvent.click(screen.getByRole('button',{name:'Load original-site reviews'}));await screen.findByRole('alert');expect(screen.queryByText(/Incoming gross effect/)).toBeNull();
 }finally{cleanup();await db.close();}},30000);
});
