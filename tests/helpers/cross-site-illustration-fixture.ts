import {parseCorrectionReview} from '@/lib/payroll/projectCostCorrection';
import {actor,caseId,inventory,request,site,voucher,worker} from './corrected-cost-ui-fixture';
import type {PaidAdjustment} from '@/lib/payroll/paidAdjustments';
export const other='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const base=inventory.corrections[0].evidence.case;
const {related_cases:unused,...item}=base;
void unused;
export const correctionItem=item as PaidAdjustment;
export const makeEvidence=()=>({source_kind:'voucher',case_id:caseId,original:{source_kind:'voucher',case_id:caseId,source_id:voucher,worker_id:worker,period_start:'2024-12-01',period_end:'2024-12-07',original_gross:'600.00',case_snapshot:structuredClone(base),case_fingerprint:'a'.repeat(64),sites:[{project_id:site,gross:'600.00'}]},correction:{source_kind:'voucher',case_id:caseId,case:structuredClone(base),latest_revision:1,attribution:{request_id:request,revision:1,case_snapshot:structuredClone(base),case_changed:false,gross_change:'0.00',split:[{project_id:site,gross_change:'-100.25'},{project_id:other,gross_change:'100.25'}],note:'Reviewed split',recorded_by:actor,recorded_at:'2024-12-11T00:00:00Z'}}});
export const expected={source_kind:'voucher',case_id:caseId,source_id:voucher,original_gross:'600.00',gross_change:'0.00',corrected_gross:'600.00',sites:[{project_id:site,original_gross:'600.00',gross_change:'-100.25',corrected_gross:'499.75'},{project_id:other,original_gross:'0.00',gross_change:'100.25',corrected_gross:'100.25'}],incomplete:true};
export const externalItem:import('@/lib/payroll/paidPeriodCases').PeriodCase={id:caseId,source_kind:'external_worker',source_id:voucher,original_snapshot:{kind:'external_worker',id:voucher,person_id:worker,name:'Worker',start:'2024-12-01',end:'2024-12-07',paid_on:'2024-12-07',gross:'600.00',net:'500.00',status:'paid_assertion',details:{bale:'100.00',other_deductions:'0.00',evidence_note:'Original ledger',recorded_by:actor,recorded_at:'2024-12-11T00:00:00Z',worker_snapshot:{id:worker,name:'Worker',position:'Mason',active:true}}},difference:'-30.00',reason:'Reviewed',status:'no_transfer',created_by:actor,created_at:'2024-12-10T00:00:00Z',resolved_by:actor,resolved_at:'2024-12-11T00:00:00Z',settled_on:null,resolution_note:'No transfer needed'};
export const makeExternalEvidence=()=>{
 const {source_id:sourceId,...fields}=externalItem;const c={...fields,external_worker_id:sourceId,supervisor_payroll_id:null,related_cases:[{id:caseId,status:'no_transfer',difference:'-30.00',reason:'Reviewed',resolution_note:'No transfer needed',original_fingerprint:'a'.repeat(64)}]};
 const value=makeEvidence();return {...value,source_kind:'external_worker',original:{...value.original,source_kind:'external_worker',case_snapshot:structuredClone(c)},correction:{...value.correction,source_kind:'external_worker',case:structuredClone(c),attribution:{...value.correction.attribution,case_snapshot:structuredClone(c)}}};
};

export const correctionReview=()=>parseCorrectionReview(makeEvidence().correction,'voucher',correctionItem);
export const externalReview=()=>parseCorrectionReview(makeExternalEvidence().correction,'external_worker',externalItem);
