import { describe, expect, it } from 'vitest';
import { planReminderChannels } from '@/lib/reminders/planChannels';
const old = '2026-10-01T00:00:00Z';
function input() { return {masterEnabled:true,dueDate:'2026-11-02',now:new Date('2026-11-02T01:00:00Z'),invoiceEffectiveSince:old,scheduleEffectiveSince:old,pausedUntil:null,channels:{email:{enabled:true,effectiveSince:old,lastContactAt:null as string|null,unresolvedAttempt:false},sms:{enabled:true,effectiveSince:old,lastContactAt:null as string|null,unresolvedAttempt:false}}}; }
describe('independent channel planning (no sending)',()=>{
  it('allows both channels on the same eligible slot',()=>{
    expect(planReminderChannels(input())).toEqual({email:{ok:true,slot:{type:'due_today',scheduledDate:'2026-11-02'}},sms:{ok:true,slot:{type:'due_today',scheduledDate:'2026-11-02'}}});
  });
  it('a recent email covers only email; SMS history and unresolved attempts are independent',()=>{
    const params=input();params.channels.email.lastContactAt='2026-11-01T02:00:00Z';
    expect(planReminderChannels(params)).toMatchObject({email:{ok:false,reason:'recent_contact'},sms:{ok:true}});
    params.channels.sms.unresolvedAttempt=true;
    expect(planReminderChannels(params)).toMatchObject({email:{ok:false,reason:'recent_contact'},sms:{ok:false,reason:'unresolved_attempt'}});
  });
  it('respects separate channel epochs and the master switch',()=>{
    const params=input();params.channels.email.effectiveSince='2026-11-02T00:00:00Z';params.channels.sms.enabled=false;
    expect(planReminderChannels(params)).toMatchObject({email:{ok:false,reason:'no_eligible_slot'},sms:{ok:false,reason:'channel_disabled_or_unavailable'}});
    params.masterEnabled=false;expect(planReminderChannels(params)).toMatchObject({email:{ok:false,reason:'master_disabled_or_unavailable'},sms:{ok:false,reason:'master_disabled_or_unavailable'}});
  });
  it('fails closed when per-channel history is absent or malformed',()=>{
    const params=input();(params.channels.sms as any).lastContactAt=undefined;(params.channels.email as any).unresolvedAttempt=undefined;
    expect(planReminderChannels(params)).toEqual({email:{ok:false,reason:'channel_history_unavailable'},sms:{ok:false,reason:'channel_history_unavailable'}});
  });
});
