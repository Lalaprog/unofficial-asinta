import {sameAttributionEvidence} from './historicalAttribution';
import {parseLegacyStatus} from './legacyVoucherAttribution';
import {parseCorrectionReview,relatedCorrectionCases,type CorrectionReview} from './projectCostCorrection';
import type {PaidAdjustment} from './paidAdjustments';

/** Verify the saved original split and current case evidence before display.
 * This is advisory context, not authorization to pay or a project total. */
export function parseLegacyCorrectionContext(raw:unknown,item:PaidAdjustment,loaded:CorrectionReview){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid legacy context');
 const v=raw as Record<string,unknown>;
 if(v.source_kind!=='legacy_voucher'||v.case_id!==item.id||v.payroll_id!==item.payroll_id||v.incomplete!==true)throw Error('Wrong legacy case');
 const status=parseLegacyStatus(v.original,item.original_voucher);
 if(!status.found||status.source_changed||!sameAttributionEvidence(status.snapshot,item.original_voucher))throw Error('Legacy source changed');
 const current=parseCorrectionReview(v.correction,'voucher',item);
 if(!sameAttributionEvidence(current,loaded)||status.case_count!==relatedCorrectionCases(current.case).length)throw Error('Correction evidence changed');
 const ids=relatedCorrectionCases(current.case).map(c=>c.id).sort();if(JSON.stringify(ids)!==JSON.stringify(status.cases.map(c=>c.id).sort()))throw Error('Legacy case list differs');
 return {status,review:current};
}
