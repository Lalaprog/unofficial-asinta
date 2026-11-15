import React from 'react';

/** A review hint only; no automatic accounting decision follows from a match. */
export function PotentialDuplicateExpense({ids}:{ids:string[]|undefined}) {
 if(!ids?.length)return null;
 return <p className="rounded-lg bg-status-warning-bg p-2 text-status-warning break-words">Possible duplicate: {ids.length} other expense{ids.length===1?' has':'s have'} the same description, date and amount. Compare the original records; separate purchases can match. Other duplicates may not be detected. Related expense ID{ids.length===1?'':'s'}: {ids.slice(0,3).join(', ')}{ids.length>3?' and others':''}.</p>;
}
