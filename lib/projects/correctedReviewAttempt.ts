import {calculateCorrected,parseCorrectedInventory,type CorrectedChoices,type CorrectedSaved} from './correctedCostReview';
import {parseReviewMarker,validReviewNote,type ReviewMarker} from './projectCostReview';

export type CorrectedAttempt={marker:ReviewMarker;raw:unknown;choices:CorrectedChoices;note:string};
export type StoredCorrectedAttempt={marker:ReviewMarker;attempt:CorrectedAttempt|null};
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

/** A tab-local retry contains sensitive evidence. Invalid or oversized state is
 * never silently discarded or submitted. Old identifier-only markers remain
 * readable, but cannot reconstruct an exact request after navigation. */
export function parseStoredCorrectedAttempt(serialized:string,projectId:string,actorId:string):StoredCorrectedAttempt{
 if(serialized.length>3000000)throw Error('Saved review attempt too large');
 const value:unknown=JSON.parse(serialized);
 if(!record(value))throw Error('Invalid saved review attempt');
 if(!('version' in value)){
  if(Object.keys(value).sort().join(',')!=='actorId,expectedRevision,projectId,requestId')throw Error('Invalid saved review marker');
  return {marker:parseReviewMarker(value,projectId,actorId),attempt:null};
 }
 if(value.version!==1||Object.keys(value).sort().join(',')!=='choices,marker,note,raw,version')throw Error('Invalid saved review attempt');
 const marker=parseReviewMarker(value.marker,projectId,actorId);
 if(typeof value.note!=='string'||!validReviewNote(value.note))throw Error('Invalid saved review note');
 const inventory=parseCorrectedInventory(value.raw,projectId);
 const {choices}=calculateCorrected(inventory,value.choices);
 return {marker,attempt:{marker,raw:value.raw,choices,note:value.note}};
}
function canonical(value:unknown):unknown{
 if(Array.isArray(value))return value.map(canonical);
 if(record(value))return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
 return value;
}
function evidenceWithoutCaptureTime(value:unknown):unknown{
 const copy=JSON.parse(JSON.stringify(value));
 delete copy.historical_review.base.captured_at;
 return copy;
}
/** A confirmed revision must contain the same reviewed evidence, not merely
 * reuse the request ID. Capture time is assigned by the server. */
export function savedMatchesCorrectedAttempt(saved:CorrectedSaved,attempt:CorrectedAttempt):boolean{
 return saved.note===attempt.note &&
  JSON.stringify(canonical(saved.choices))===JSON.stringify(canonical(attempt.choices)) &&
  JSON.stringify(canonical(evidenceWithoutCaptureTime(saved.inventory.raw)))===JSON.stringify(canonical(evidenceWithoutCaptureTime(attempt.raw)));
}
export function serializeCorrectedAttempt(attempt:CorrectedAttempt,projectId:string,actorId:string):string{
 const value=JSON.stringify({version:1,marker:attempt.marker,raw:attempt.raw,choices:attempt.choices,note:attempt.note});
 const parsed=parseStoredCorrectedAttempt(value,projectId,actorId);
 if(!parsed.attempt)throw Error('Retry data missing');
 // Persist the validated, normalized form so an exact replay can be compared
 // byte-for-byte before every send, including after a page reload.
 return JSON.stringify({version:1,...parsed.attempt});
}
