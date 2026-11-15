import {parseCorrectedSaved} from './correctedCostReview';

/** Coverage warnings and the ordinary review come from one statement snapshot.
 * Zero signals do not establish that records or project attribution are complete. */
export function parseRecordedCostCoverage(raw:unknown,projectId:string) {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid cost coverage');
 const v=raw as Record<string,unknown>;
 const count=(value:unknown):number=>{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw Error('Invalid coverage count');return value;};
 if(v.project_id!==projectId||typeof v.captured_at!=='string'||!Number.isFinite(Date.parse(v.captured_at)))throw Error('Invalid coverage scope');
 const unallocatedPaid=count(v.unallocated_paid),attendanceMatches=count(v.attendance_matches),inconsistentAllocations=count(v.inconsistent_allocations),unattributedHistory=count(v.unattributed_history);
 if(attendanceMatches>unallocatedPaid)throw Error('Invalid attendance signal');
 return {capturedAt:v.captured_at,unallocatedPaid,attendanceMatches,inconsistentAllocations,unattributedHistory,review:parseCorrectedSaved(v.review,projectId)};
}
