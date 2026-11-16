// A tab-local recovery record, not authorization or proof of a database write.
// It preserves the exact idempotency key and parameters for an uncertain request.
export type AllowanceAttempt = {
  version: 1; actor: string; attendance: string; worker: string; project: string;
  date: string; submittedAt: string; id: string; amount: string; description: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function allowanceAttemptKey(actor: string, attendance: string): string {
  return JSON.stringify(['worker-allowance-attempt-v1', actor, attendance]);
}
export function parseAllowanceAttempt(value: unknown): AllowanceAttempt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid allowance retry record');
  const a = value as AllowanceAttempt;
  if (a.version !== 1 || [a.actor,a.attendance,a.worker,a.project,a.date,a.submittedAt].some(v => typeof v !== 'string' || !v || v.length > 200)
    || typeof a.id !== 'string' || !uuid.test(a.id)
    || typeof a.amount !== 'string' || !/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(a.amount) || Number(a.amount) <= 0
    || typeof a.description !== 'string' || !a.description.trim() || a.description !== a.description.trim() || a.description.length > 500) {
    throw new Error('Invalid allowance retry record');
  }
  return {version:1,actor:a.actor,attendance:a.attendance,worker:a.worker,project:a.project,date:a.date,submittedAt:a.submittedAt,id:a.id,amount:a.amount,description:a.description};
}
