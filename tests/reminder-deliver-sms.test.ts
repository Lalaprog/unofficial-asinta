import {describe,expect,it,vi} from 'vitest';
import {deliverPreparedReminderSms} from '@/lib/reminders/deliverSms';
import {createFakeDb} from './helpers/fakeDb';
function setup(){const db=createFakeDb({sms_logs:[]});const send=vi.fn(async()=>({success:true,messageId:'id'}));const beforeSend=vi.fn(async()=>true);const prepared={invoiceId:'invoice',clientId:'client',recipient:'Ana',phone:'639171234567',message:'Reminder',fingerprint:'hash'};return {db,send,beforeSend,run:()=>deliverPreparedReminderSms({db,send,beforeSend,prepared,attemptId:'attempt'})};}
describe('staged coordinated SMS adapter',()=>{
  it('logs before sending and reports accepted',async()=>{const {db,send,run}=setup();send.mockImplementation(async()=>{expect(db.tables.sms_logs[0].status).toBe('pending');return {success:true,messageId:'id'};});expect(await run()).toBe('accepted');expect(db.tables.sms_logs[0].status).toBe('sent');});
  it('does not call provider if the final check fails',async()=>{const {db,send,beforeSend,run}=setup();beforeSend.mockResolvedValue(false);expect(await run()).toBe('cancelled');expect(send).not.toHaveBeenCalled();expect(db.tables.sms_logs[0].status).toBe('failed');});
  it('never treats a lost provider response as a rejection',async()=>{const {db,send,run}=setup();send.mockRejectedValue(Error('lost'));expect(await run()).toBe('unconfirmed');expect(db.tables.sms_logs[0].status).toBe('pending');});
  it('reports an unconfirmed outcome if the result log cannot be updated',async()=>{const {db,run}=setup();const from=db.from;db.from=(table:string)=>{const q=from(table);q.update=()=>{throw Error('offline');};return q;};expect(await run()).toBe('unconfirmed');expect(db.tables.sms_logs[0].status).toBe('pending');});
});
