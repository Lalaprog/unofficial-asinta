import {describe,expect,it,vi} from 'vitest';
import {dispatchOne} from '@/lib/reminders/dispatchOne';
const old='2026-10-01T00:00:00Z';
function snapshot(){return {masterEnabled:true,dueDate:'2026-11-02',now:new Date('2026-11-02T01:00:00Z'),invoiceEffectiveSince:old,scheduleEffectiveSince:old,pausedUntil:null,channels:{email:{enabled:true,effectiveSince:old,lastContactAt:null,unresolvedAttempt:false},sms:{enabled:true,effectiveSince:old,lastContactAt:null,unresolvedAttempt:false}},fingerprint:'prepared-hash',providerReady:true};}
function setup(){const value=snapshot();return {read:vi.fn(async()=>value as ReturnType<typeof snapshot>|null),reserve:vi.fn(async()=>'reserved' as const),claim:vi.fn(async()=>'claimed' as const),send:vi.fn(async()=>'accepted' as const),finish:vi.fn(async()=>true)};}
const run=(deps:ReturnType<typeof setup>)=>dispatchOne({channel:'email',attemptId:'unique-attempt',deps});
describe('staged one-channel dispatch coordinator',()=>{
  it('checks fresh state twice around a durable unique claim, and settles a confirmed result',async()=>{
    const deps=setup();expect(await run(deps)).toMatchObject({outcome:'accepted',slot:{scheduledDate:'2026-11-02'}});
    expect(deps.read).toHaveBeenCalledTimes(3);expect(deps.reserve).toHaveBeenCalledOnce();expect(deps.claim).toHaveBeenCalledOnce();expect(deps.send).toHaveBeenCalledOnce();expect(deps.finish).toHaveBeenCalledWith('unique-attempt','accepted');
    expect(deps.reserve.mock.invocationCallOrder[0]).toBeLessThan(deps.claim.mock.invocationCallOrder[0]);
    expect(deps.claim.mock.invocationCallOrder[0]).toBeLessThan(deps.send.mock.invocationCallOrder[0]);
  });
  it('does not reserve or send when settings, provider or history are unavailable',async()=>{
    const deps=setup();const value=snapshot();value.providerReady=false;deps.read.mockResolvedValue(value);
    expect((await run(deps)).outcome).toBe('ineligible_or_unavailable');expect(deps.reserve).not.toHaveBeenCalled();expect(deps.send).not.toHaveBeenCalled();
  });
  it('does not send on a lost reservation response',async()=>{
    const deps=setup();deps.reserve.mockRejectedValue(Error('lost'));
    expect((await run(deps)).outcome).toBe('unavailable');expect(deps.finish).not.toHaveBeenCalled();expect(deps.send).not.toHaveBeenCalled();
  });
  it('cancels before dispatch if details change or the switch is turned off',async()=>{
    const deps=setup();const changed={...snapshot(),masterEnabled:false};deps.read.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(changed);
    expect((await run(deps)).outcome).toBe('changed_or_unavailable');expect(deps.finish).toHaveBeenCalledWith('unique-attempt','cancelled');expect(deps.send).not.toHaveBeenCalled();
  });
  it('does not send if the slot claim is lost or the final fingerprint changes',async()=>{
    const deps=setup();deps.claim.mockRejectedValue(Error('lost'));
    expect((await run(deps)).outcome).toBe('unavailable');expect(deps.send).not.toHaveBeenCalled();expect(deps.finish).toHaveBeenCalledWith('unique-attempt','cancelled');
    const second=setup();second.read.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot()).mockResolvedValueOnce({...snapshot(),fingerprint:'changed'});
    expect((await run(second)).outcome).toBe('changed_or_unavailable');expect(second.send).not.toHaveBeenCalled();
  });
  it('keeps a provider exception unconfirmed and reports an unconfirmed settlement',async()=>{
    const deps=setup();deps.send.mockRejectedValue(Error('response lost'));deps.finish.mockResolvedValue(false);
    expect(await run(deps)).toMatchObject({outcome:'unconfirmed',lockUnconfirmed:true});expect(deps.finish).toHaveBeenCalledWith('unique-attempt','unconfirmed');
  });
  it('does not dispatch a slot already claimed',async()=>{
    const deps=setup();(deps.claim as any).mockResolvedValue('duplicate');expect((await run(deps)).outcome).toBe('slot_already_claimed');expect(deps.send).not.toHaveBeenCalled();
  });
});
