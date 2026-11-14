// @vitest-environment jsdom
// Real destination ledger/context/preview SQL, with synthetic source-reader stubs.
import React from 'react';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
import {crossFixture,key} from './helpers/cross-site-cost-review-fixture';
import type {CorrectedChoices} from '@/lib/projects/correctedCostReview';
const m=vi.hoisted(()=>({rpc:vi.fn()}));vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:m.rpc})}));vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:'11111111-1111-4111-8111-111111111111'},isFounder:true,assurance:'ready'})}));
import {CrossSiteReviewLedger} from '@/components/projects/CrossSiteReviewLedger';
afterEach(()=>{cleanup();sessionStorage.clear();vi.unstubAllEnvs();vi.restoreAllMocks();});
describe('cross-site ledger UI against synthetic database',()=>{
 it('saves once, retries an ambiguous response after remount, and reports a stale source',async()=>{const db=new PGlite(),f=crossFixture();try{
  await db.exec(baseFixture);await db.exec(`INSERT INTO public.users VALUES('${f.ids.actor}','Founder two','founder');INSERT INTO public.projects VALUES('${f.ids.other}','Destination');
   CREATE TABLE public.test_cross_payload(evidence jsonb,illustration jsonb,review jsonb,inventory jsonb);
   CREATE FUNCTION public.project_cost_cross_site_evidence(text,uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT evidence FROM public.test_cross_payload$$;
   CREATE FUNCTION public.project_cost_cross_site_preview(text,uuid,jsonb,boolean) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT illustration FROM public.test_cross_payload$$;
   CREATE FUNCTION public.project_cost_corrected_review(uuid,integer) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT review FROM public.test_cross_payload$$;
   CREATE FUNCTION public.project_cost_correction_inventory(uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT inventory FROM public.test_cross_payload$$;
   CREATE FUNCTION public.project_cost_corrected_preview(p uuid,s jsonb,c jsonb,a boolean) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$BEGIN IF c->'corrections'->'${key}'->>'decision' IS DISTINCT FROM 'exclude' THEN RAISE EXCEPTION 'Not excluded'; END IF;
    RETURN jsonb_build_object('project_id',p,'included_expenses','0.00','excluded_expenses','0.00','paid_gross','0.00','historical_gross','0.00','excluded_historical','0.00','correction_gross','0.00','excluded_cases',1,'incomplete_total','0.00','incomplete',true);END$$;`);
  await db.query('INSERT INTO public.test_cross_payload VALUES($1::jsonb,$2::jsonb,$3::jsonb,$4::jsonb)',[JSON.stringify(f.context.source_evidence),JSON.stringify(f.context.illustration),JSON.stringify(f.sourceSaved),JSON.stringify(f.destination)]);
  for(const name of ['project_cost_cross_site_review_context','project_cost_cross_site_corrected_preview','project_cost_cross_site_review_ledger'])await db.exec(`BEGIN;${readFileSync(`supabase/drafts/${name}.sql`,'utf8')} COMMIT;`);
  await db.exec(`SET ROLE authenticated;SET test.uid='${f.ids.actor}';SET test.assurance='yes'`);
  for(const flag of ['FINANCE_FOUNDATION_PREVIEW','PROJECT_COST_CORRECTION_PREVIEW','CORRECTED_PROJECT_COST_REVIEW_PREVIEW','CROSS_SITE_SOURCE_REVIEW_PREVIEW','CROSS_SITE_LEDGER_PREVIEW'])vi.stubEnv(`NEXT_PUBLIC_${flag}`,'true');
  let lose=true;const writes:unknown[]=[];m.rpc.mockReset().mockImplementation(async(name:string,a:Record<string,unknown>)=>{try{let r;
   if(name==='project_cost_cross_site_review')r=await db.query<{v:unknown}>('SELECT public.project_cost_cross_site_review($1,$2) v',[a.p_project,a.p_revision]);
   else if(name==='project_cost_corrected_review')r=await db.query<{v:unknown}>('SELECT public.project_cost_corrected_review($1,$2) v',[a.p_project,a.p_revision]);
   else if(name==='record_project_cost_cross_site_review'){writes.push(a);r=await db.query<{v:unknown}>('SELECT public.record_project_cost_cross_site_review($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8) v',[a.p_request,a.p_project,a.p_expected_revision,JSON.stringify(a.p_snapshot),JSON.stringify(a.p_choices),JSON.stringify(a.p_cross_sites),a.p_note,a.p_ack]);if(lose){lose=false;return {data:null,error:Error('Lost response')};}}
   else throw Error('Unexpected RPC');return {data:r.rows[0].v,error:null};}catch(error){return {data:null,error};}});
  const prepared={raw:f.destination,choices:f.destinationChoices as CorrectedChoices,contexts:f.contexts,sourceReviews:f.sourceReviews};const renderLedger=()=>render(React.createElement(CrossSiteReviewLedger,{projectId:f.ids.other,userId:f.ids.actor,prepared}));
  renderLedger();fireEvent.click(screen.getByRole('button',{name:'Cross-site review history and save'}));fireEvent.click(screen.getByRole('button',{name:'Load latest cross-site review'}));await screen.findByText(/No cross-site review was returned/);fireEvent.change(screen.getByLabelText('Cross-site review note'),{target:{value:'Reviewed destination'}});fireEvent.click(screen.getByRole('checkbox',{name:/I reviewed the verified destination preview/}));fireEvent.click(screen.getByRole('button',{name:'Save cross-site review'}));await screen.findByText(/outcome is unconfirmed/);expect(sessionStorage.length).toBe(1);
  await db.exec(`RESET ROLE;UPDATE public.test_cross_payload SET review=jsonb_set(jsonb_set(review,'{freshness}','"changed"'::jsonb),'{latest_revision}','2'::jsonb);SET ROLE authenticated`);
  cleanup();renderLedger();fireEvent.click(screen.getByRole('button',{name:'Cross-site review history and save'}));await screen.findByText(/Unconfirmed request/);fireEvent.click(screen.getByRole('button',{name:'Retry exact cross-site request'}));await screen.findByText(/recorded and independently verified/);expect(writes).toHaveLength(2);expect(writes[1]).toEqual(writes[0]);expect(sessionStorage.length).toBe(0);expect(screen.getByText(/Revision 1 of 1/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Load latest cross-site review'}));await screen.findByText(/destination freshness unavailable.*original-source freshness changed/);expect(screen.getByText(/Incomplete total ₱100.25/)).toBeTruthy();
  await db.exec('RESET ROLE');expect((await db.query('SELECT count(*)::integer AS n FROM public.project_cost_cross_site_reviews')).rows).toEqual([{n:1}]);expect((await db.query('SELECT status FROM public.payroll')).rows[0]).toEqual({status:'paid'});
 }finally{cleanup();await db.close();}},30000);
});
