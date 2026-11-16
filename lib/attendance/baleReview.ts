import type {AdvanceRequest} from '@/types';

type Decision = 'approve' | 'reject';

/** Only a matching returned transition confirms this call to the client.
 * This validates a response, not a subsequent read or a cash handover. */
export function verifyBaleReviewRows(raw:unknown, expected:AdvanceRequest[], decision:Decision, actor:string):AdvanceRequest[] {
 if(!actor || expected.length===0 || expected.length>50 || new Set(expected.map(row=>row.id)).size!==expected.length || expected.some(row=>row.status!=='pending_approval')) throw Error('Invalid request selection');
 if(!Array.isArray(raw) || raw.length!==expected.length) throw Error('Incomplete decision response');
 const byId=new Map(expected.map(row=>[row.id,row]));
 const seen=new Set<string>();
 const result:AdvanceRequest[]=[];
 for(const value of raw){
  if(!value || typeof value!=='object' || Array.isArray(value)) throw Error('Invalid decision response');
  const row=value as Record<string,unknown>;
  const prior=typeof row.id==='string'?byId.get(row.id):undefined;
  const amount=typeof row.requested_amount==='number' || typeof row.requested_amount==='string' ? Number(row.requested_amount) : NaN;
  const recordedBy=decision==='approve'?row.approved_by:row.rejected_by;
  const recordedAt=decision==='approve'?row.approved_at:row.rejected_at;
  if(!prior || seen.has(prior.id) || row.worker_id!==prior.worker_id || row.project_id!==prior.project_id || row.submitted_by!==prior.submitted_by ||
    !Number.isFinite(amount) || amount<=0 || amount!==prior.requested_amount ||
    row.status!==(decision==='approve'?'approved_pending_payment':'rejected') || recordedBy!==actor ||
    typeof recordedAt!=='string' || !Number.isFinite(Date.parse(recordedAt))) throw Error('Decision response did not match the selected requests');
  seen.add(prior.id);
  result.push({...row,requested_amount:amount} as unknown as AdvanceRequest);
 }
 return result;
}
