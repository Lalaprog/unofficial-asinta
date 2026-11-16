import type {PaidReviewVoucher} from './paidReview';
export type PaidAttendanceStatus='changed'|'unchanged'|'unavailable';
/** Bind a response to the exact voucher and reject malformed/incomplete results. */
export function parsePaidAttendanceReview(raw:unknown,v:PaidReviewVoucher):PaidAttendanceStatus {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Invalid attendance comparison');
 const value=raw as Record<string,unknown>;
 if(value.payroll_id!==v.id||value.worker_id!==v.worker_id||value.period_start!==v.period_start||value.period_end!==v.period_end||!['changed','unchanged','unavailable'].includes(value.attendance as string))throw new Error('Attendance comparison does not match this voucher');
 return value.attendance as PaidAttendanceStatus;
}
