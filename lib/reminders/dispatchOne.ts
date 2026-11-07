/**
 * STAGED: dependency-injected delivery coordinator. Not wired to a route or a
 * provider. All dependencies must be backed by durable database operations and
 * manual sends must share the same reservation before this can be used live.
 * A successful last check is not a lock on invoices/settings during provider
 * I/O; disabling reminders cannot recall a request already in flight.
 */
import { planReminderChannels } from './planChannels';
import type { CatchUpPlan } from './planCatchUp';

type Channel = 'email'|'sms';
type Slot = Extract<CatchUpPlan,{ok:true}>['slot'];
type Snapshot = Parameters<typeof planReminderChannels>[0] & {
  /** Fingerprint of recipient, message, invoice, template and provider-relevant data. */
  fingerprint: string;
  /** True only when a fresh check confirms this specific provider is configured. */
  providerReady: boolean;
};
type Outcome = 'accepted'|'rejected'|'cancelled'|'unconfirmed';
type Dependencies = {
  // Returns null on ANY unreadable/incomplete data, including history.
  read: () => Promise<Snapshot | null>;
  reserve: (attemptId:string) => Promise<'reserved'|'busy'|'duplicate'|'unavailable'>;
  // Atomically insert a unique invoice/channel/scheduled-slot dispatch record.
  // A lost response is unavailable, not success. No provider call without claimed.
  claim: (slot:Slot,attemptId:string) => Promise<'claimed'|'duplicate'|'unavailable'>;
  // Only return rejected for a definite rejection; ambiguous results are unconfirmed.
  send: (snapshot:Snapshot) => Promise<'accepted'|'rejected'|'unconfirmed'>;
  finish: (attemptId:string,outcome:Outcome) => Promise<boolean>;
};
export type DispatchOneResult = {outcome:string; slot?:Slot; lockUnconfirmed?:boolean};

function candidate(snapshot:Snapshot | null,channel:Channel): {snapshot:Snapshot;slot:Slot}|null {
  if (!snapshot || snapshot.providerReady !== true || typeof snapshot.fingerprint !== 'string' || !snapshot.fingerprint) return null;
  const result=planReminderChannels(snapshot)[channel];
  return result.ok ? {snapshot,slot:result.slot}:null;
}
function same(a:{snapshot:Snapshot;slot:Slot},b:{snapshot:Snapshot;slot:Slot}|null):boolean {
  return Boolean(b && a.slot.type===b.slot.type && a.slot.scheduledDate===b.slot.scheduledDate && a.snapshot.fingerprint===b.snapshot.fingerprint);
}

/** Operates on exactly one invoice/channel; no retry, sleep, batching or provider calls unless all checks pass. */
export async function dispatchOne(params:{channel:Channel;attemptId:string;deps:Dependencies}):Promise<DispatchOneResult> {
  const {channel,attemptId,deps}=params;
  if (!attemptId || !['email','sms'].includes(channel)) return {outcome:'invalid'};
  let initial:ReturnType<typeof candidate>;
  try {initial=candidate(await deps.read(),channel);} catch {return {outcome:'unavailable'};}
  if (!initial) return {outcome:'ineligible_or_unavailable'};
  let reservation:'reserved'|'busy'|'duplicate'|'unavailable';
  try {reservation=await deps.reserve(attemptId);} catch {reservation='unavailable';}
  if (reservation !== 'reserved') return {outcome:reservation};

  let started=false;
  const finish=async(outcome:Outcome):Promise<boolean>=>{
    try {return await deps.finish(attemptId,outcome) === true;} catch {return false;}
  };
  const cancel=async(outcome:string):Promise<DispatchOneResult>=>({outcome,slot:initial!.slot, ...(!await finish('cancelled')?{lockUnconfirmed:true}:{})});
  try {
    if (!same(initial,candidate(await deps.read(),channel))) return await cancel('changed_or_unavailable');
    const claim=await deps.claim(initial.slot,attemptId);
    if (claim !== 'claimed') return await cancel(claim === 'duplicate'?'slot_already_claimed':'claim_unavailable');
    const final=candidate(await deps.read(),channel);
    if (!same(initial,final) || !final) return await cancel('changed_or_unavailable');
    started=true;
    const result=await deps.send(final.snapshot);
    const outcome:Outcome=result==='accepted'||result==='rejected'?result:'unconfirmed';
    const settled=await finish(outcome);
    return {outcome,slot:initial.slot,...(!settled?{lockUnconfirmed:true}:{})};
  } catch {
    if (!started) return await cancel('unavailable');
    const settled=await finish('unconfirmed');
    return {outcome:'unconfirmed',slot:initial.slot,...(!settled?{lockUnconfirmed:true}:{})};
  }
}
