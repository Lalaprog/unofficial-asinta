import {describe,expect,it,vi} from 'vitest';
import {coordinateManualDelivery} from '@/lib/reminders/manualDelivery';
function setup({history='clear',reserve='reserved',finish=true}:{history?:'clear'|'blocked'|'missing';reserve?:string;finish?:boolean}={}) {
 const rpc=vi.fn(async(name:string)=>({data:name.startsWith('reserve')?reserve:name.startsWith('finish')?finish:history==='missing'?null:{lastContactAt:null,unresolvedAttempt:history==='blocked'},error:null}));
 const deliver=vi.fn(async(_id:string,beforeSend:()=>Promise<boolean>)=>{if(!await beforeSend())return 'cancelled' as const;return 'accepted' as const;});
 const run=(invoiceId:string|null='invoice')=>coordinateManualDelivery({db:{rpc},invoiceId,clientId:'client',channel:'sms',attemptId:'attempt',deliver,outcome:r=>r});return {rpc,deliver,run};
}
describe('manual delivery reservation',()=>{
 it('reserves first, checks history twice, and finishes after delivery',async()=>{const {rpc,deliver,run}=setup();expect(await run()).toEqual({status:'completed',result:'accepted'});expect(rpc.mock.calls.map(x=>x[0])).toEqual(['reserve_reminder_delivery','read_reminder_contact_history','read_reminder_contact_history','finish_reminder_delivery']);expect(deliver).toHaveBeenCalledOnce();});
 it('uses the client lock for client-only SMS',async()=>{const {rpc,run}=setup();expect(await run(null)).toMatchObject({status:'completed'});expect(rpc.mock.calls.map(x=>x[0])).toEqual(['reserve_client_sms_delivery','read_client_sms_history','read_client_sms_history','finish_client_sms_delivery']);});
 it('never sends when busy, history is unknown, or history is unresolved',async()=>{for(const config of [{reserve:'busy'},{history:'missing' as const},{history:'blocked' as const}]){const {deliver,run}=setup(config);expect((await run()).status).not.toBe('completed');expect(deliver).not.toHaveBeenCalled();}});
 it('marks thrown provider paths and failed completion as unconfirmed',async()=>{const one=setup();one.deliver.mockRejectedValue(Error('network'));expect((await one.run()).status).toBe('unconfirmed');expect(one.rpc.mock.calls.at(-1)?.[0]).toBe('finish_reminder_delivery');const two=setup({finish:false});expect((await two.run()).status).toBe('unconfirmed');});
});
