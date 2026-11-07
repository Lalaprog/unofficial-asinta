import { describe, expect, it, vi } from 'vitest';
import { claimAutomaticSlot, finishDelivery, readContactHistory, reserveDelivery } from '@/lib/reminders/coordination';
const claim = {invoiceId:'invoice',channel:'email' as const,source:'manual' as const,attemptId:'attempt'};
const finish = {invoiceId:'invoice',channel:'email' as const,attemptId:'attempt',outcome:'unconfirmed' as const};
describe('coordination RPC client (not wired)', () => {
  it('only grants ownership for an explicit reserved response', async () => {
    for (const result of ['reserved','busy','duplicate'] as const) {
      const db = {rpc:vi.fn().mockResolvedValue({data:result,error:null})};
      expect(await reserveDelivery(db,claim)).toBe(result);
      expect(db.rpc).toHaveBeenCalledWith('reserve_reminder_delivery', {p_invoice_id:'invoice',p_channel:'email',p_source:'manual',p_attempt_id:'attempt'});
    }
    for (const data of [null, false, 'invalid', {result:'reserved'}]) {
      expect(await reserveDelivery({rpc:vi.fn().mockResolvedValue({data,error:null})},claim)).toBe('unavailable');
    }
    expect(await reserveDelivery({rpc:vi.fn().mockRejectedValue(Error('lost response'))},claim)).toBe('unavailable');
    expect(await reserveDelivery({rpc:vi.fn().mockResolvedValue({data:'reserved',error:{message:'bad'}})},claim)).toBe('unavailable');
  });
  it('requires an explicit durable slot claim and a complete, well-formed history response', async () => {
    const slot={invoiceId:'invoice',channel:'email' as const,attemptId:'attempt',scheduledDate:'2026-11-02',type:'due_today' as const};
    expect(await claimAutomaticSlot({rpc:vi.fn().mockResolvedValue({data:'claimed',error:null})},slot)).toBe('claimed');
    expect(await claimAutomaticSlot({rpc:vi.fn().mockRejectedValue(Error('lost'))},slot)).toBe('unavailable');
    const input={invoiceId:'invoice',channel:'email' as const,ownAttemptId:null};
    expect(await readContactHistory({rpc:vi.fn().mockResolvedValue({data:{lastContactAt:null,unresolvedAttempt:false},error:null})},input)).toEqual({lastContactAt:null,unresolvedAttempt:false});
    for (const data of [null,{}, {lastContactAt:null,unresolvedAttempt:'false'}, {lastContactAt:123,unresolvedAttempt:false}]) {
      expect(await readContactHistory({rpc:vi.fn().mockResolvedValue({data,error:null})},input)).toBeNull();
    }
    expect(await readContactHistory({rpc:vi.fn().mockRejectedValue(Error('lost'))},input)).toBeNull();
  });
  it('does not claim a lock was released when the completion response is lost or malformed', async () => {
    expect(await finishDelivery({rpc:vi.fn().mockResolvedValue({data:true,error:null})},finish)).toBe(true);
    expect(await finishDelivery({rpc:vi.fn().mockResolvedValue({data:false,error:null})},finish)).toBe(false);
    expect(await finishDelivery({rpc:vi.fn().mockRejectedValue(Error('lost response'))},finish)).toBe(false);
    expect(await finishDelivery({rpc:vi.fn().mockResolvedValue({data:true,error:{message:'bad'}})},finish)).toBe(false);
  });
});
