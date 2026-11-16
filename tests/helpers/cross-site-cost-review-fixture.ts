import {actor,caseId,choices,expense,history,inventory,request,result,site} from './corrected-cost-ui-fixture';
import {makeEvidence,expected,other} from './cross-site-illustration-fixture';
export const key=`voucher:${caseId}`,reviewRequest='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export function crossFixture(){
 const e=makeEvidence(),sourceInventory=structuredClone(inventory);
 sourceInventory.corrections[0].evidence=structuredClone(e.correction);sourceInventory.corrections[0].site_gross_change='-100.25';
 const sourceResult={...result,correction_gross:'-100.25',incomplete_total:'950.25'};
 const sourceSaved={project_id:site,found:true,latest_revision:1,revision:1,request_id:reviewRequest,actor_id:actor,recorded_at:'2024-12-11T00:00:00Z',note:'Reviewed records',freshness:'matches',snapshot:sourceInventory,choices:structuredClone(choices),result:sourceResult};
 const destination=structuredClone(sourceInventory);destination.project_id=other;destination.historical_review.project_id=other;destination.historical_review.base.project_id=other;destination.historical_review.base.expenses=[];destination.historical_review.base.paid_allocations=[];destination.historical_review.base.adjustment_cases=[];destination.historical_review.historical=[];destination.corrections[0].source_in_snapshot=false;destination.corrections[0].site_gross_change='100.25';
 const context={destination:other,source_kind:'voucher',case_id:caseId,source_evidence:e,illustration:structuredClone(expected),original_site_reviews:[{project_id:site,original_gross:'600.00',gross_change:'-100.25',request_id:reviewRequest,revision:1,actor_id:actor,recorded_at:'2024-12-11T00:00:00Z'}],incomplete:true};
 const destinationChoices={expenses:{},historical:{},corrections:{[key]:{decision:'include',reason:'Original site reviewed'}}};
 const destinationResult={project_id:other,included_expenses:'0.00',excluded_expenses:'0.00',paid_gross:'0.00',historical_gross:'0.00',excluded_historical:'0.00',correction_gross:'100.25',excluded_cases:0,incomplete_total:'100.25',cross_site_gross:'100.25',cross_site_cases:1,incomplete:true};
 return {sourceInventory,sourceSaved,sourceResult,destination,destinationChoices,destinationResult,context,contexts:{[key]:context},sourceReviews:{[key]:{[site]:sourceSaved}},ids:{actor,caseId,site,other,request,expense,history}};
}
