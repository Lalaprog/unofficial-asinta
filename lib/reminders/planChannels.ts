/** No-send planner for the approved per-channel catch-up policy.
 * Callers must provide complete, authoritative history separately for each
 * channel. This does not reserve a send, check providers or authorize I/O.
 */
import { planCatchUp, type CatchUpPlan } from './planCatchUp';

type ChannelState = {
  enabled: boolean;
  effectiveSince: string | null;
  /** Null means an authoritative, complete read found no accepted contact. */
  lastContactAt: string | null;
  unresolvedAttempt: boolean;
};
type Channel = 'email' | 'sms';
type Input = {
  masterEnabled: boolean;
  dueDate: string;
  now: Date;
  invoiceEffectiveSince: string;
  scheduleEffectiveSince: string;
  pausedUntil: string | null;
  channels: Record<Channel, ChannelState>;
};

export function planReminderChannels(input: Input): Record<Channel, CatchUpPlan> {
  const plan = (channel: Channel): CatchUpPlan => {
    if (input.masterEnabled !== true) return {ok:false,reason:'master_disabled_or_unavailable'};
    const state = input.channels?.[channel];
    if (!state || state.enabled !== true) return {ok:false,reason:'channel_disabled_or_unavailable'};
    if (typeof state.effectiveSince !== 'string' ||
        !(state.lastContactAt === null || typeof state.lastContactAt === 'string') ||
        typeof state.unresolvedAttempt !== 'boolean') return {ok:false,reason:'channel_history_unavailable'};
    return planCatchUp({
      dueDate:input.dueDate,now:input.now,channelEffectiveSince:state.effectiveSince,
      invoiceEffectiveSince:input.invoiceEffectiveSince,scheduleEffectiveSince:input.scheduleEffectiveSince,
      pausedUntil:input.pausedUntil,lastContactAt:state.lastContactAt,unresolvedAttempt:state.unresolvedAttempt,
    });
  };
  return {email:plan('email'),sms:plan('sms')};
}
