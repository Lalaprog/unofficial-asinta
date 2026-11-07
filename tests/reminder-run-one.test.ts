import {describe,expect,it,vi} from 'vitest';
import {runOneReminder} from '@/lib/reminders/runOne';
import {createFakeDb} from './helpers/fakeDb';
const old='2026-10-01T00:00:00Z',now='2026-11-02T01:00:00Z';
function setup(){
  const db=createFakeDb({reminder_settings:[{singleton:true,master_enabled:true,email_enabled:true,sms_enabled:true,revision:1,email_effective_since:old,sms_effective_since:old}],invoices:[{id:'inv',invoice_number:'I-001',client_id:'client',project_id:'project',amount:'1000',amount_paid:'250',issue_date:'2026-10-01',due_date:'2026-11-02',status:'pending',notes:null,automatic_reminders_enabled:true,reminders_paused_until:null,reminder_invoice_effective_since:old,reminder_schedule_effective_since:old}],clients:[{id:'client',name:'Client Co',contact_person:'Ana',phone:'09171234567',email:'ana@example.test'}],projects:[{id:'project',name:'Office'}],email_templates:[],sms_template_settings:[],email_logs:[],sms_logs:[]});
  const locks:Record<string,string>={};const attempts:Record<string,string>={};const slots=new Set<string>();
  const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
    const channel=String(args.p_channel),id=String(args.p_attempt_id);
    if(name==='read_reminder_contact_history')return {data:{lastContactAt:null,unresolvedAttempt:Object.entries(locks).some(([ch,value])=>ch===channel && (value!==args.p_own_attempt || attempts[value]==='unconfirmed'))},error:null};
    if(name==='reserve_reminder_delivery'){if(locks[channel])return {data:'busy',error:null};if(attempts[id])return {data:'duplicate',error:null};locks[channel]=id;attempts[id]='reserved';return {data:'reserved',error:null};}
    if(name==='reminder_recipient_matches')return {data:locks[channel]===id,error:null};
    if(name==='claim_automatic_reminder_slot'){const key=`${channel}:${args.p_scheduled_date}`;if(locks[channel]!==id)return {data:'not_owner',error:null};if(slots.has(key))return {data:'duplicate',error:null};slots.add(key);return {data:'claimed',error:null};}
    if(name==='finish_reminder_delivery'){if(locks[channel]!==id)return {data:false,error:null};attempts[id]=String(args.p_outcome);if(args.p_outcome!=='unconfirmed')delete locks[channel];return {data:true,error:null};}
    throw Error(`unexpected ${name}`);
  });
  const sendEmail=vi.fn(async()=>({accepted:true,providerMessageId:'mail-id'}));const sendSms=vi.fn(async()=>({success:true,messageId:'sms-id'}));
  const run=(channel:'email'|'sms',attemptId:string)=>runOneReminder({db:{...db,rpc},invoiceId:'inv',channel,attemptId,now:()=>new Date(now),automationAllowed:()=>true,providerReady:()=>true,firmEmail:'office@example.test',firmContactNumber:'123',sendEmail,sendSms});
  return {db,rpc,sendEmail,sendSms,locks,attempts,run};
}
describe('staged one-invoice integrated dispatcher',()=>{
  it('prepares and logs both independent channels and never resends the same slot',async()=>{
    const {db,run,sendEmail,sendSms}=setup();expect((await run('email','email-1')).outcome).toBe('accepted');expect((await run('sms','sms-1')).outcome).toBe('accepted');
    expect(db.tables.email_logs[0]).toMatchObject({status:'accepted',reminder_attempt_id:'email-1'});expect(db.tables.sms_logs[0]).toMatchObject({status:'sent',reminder_attempt_id:'sms-1'});
    expect((await run('email','email-2')).outcome).toBe('slot_already_claimed');expect(sendEmail).toHaveBeenCalledOnce();expect(sendSms).toHaveBeenCalledOnce();
  });
  it('stops before reservation when the master is off',async()=>{const {db,run,rpc,sendEmail}=setup();db.tables.reminder_settings[0].master_enabled=false;expect((await run('email','e1')).outcome).toBe('ineligible_or_unavailable');expect(rpc.mock.calls.some(([name])=>name==='reserve_reminder_delivery')).toBe(false);expect(sendEmail).not.toHaveBeenCalled();});
  it('rechecks settings after creating the pending log and never sends after it turns off',async()=>{
    const {db,run,sendEmail}=setup();const original=db.from;db.from=(table:string)=>{const query=original(table);if(table==='email_logs'){const insert=query.insert;query.insert=(row:any)=>{const result=insert(row);db.tables.reminder_settings[0].master_enabled=false;return result;};}return query;};
    expect((await run('email','e1')).outcome).toBe('cancelled');expect(sendEmail).not.toHaveBeenCalled();expect(db.tables.email_logs[0].status).toBe('failed');
  });
  it('cancels before provider I/O when the reserved destination cannot be confirmed',async()=>{const {run,rpc,sendEmail}=setup();const original=rpc.getMockImplementation()!;rpc.mockImplementation(async(name,args)=>name==='reminder_recipient_matches'?{data:false,error:null}:original(name,args));expect((await run('email','e1')).outcome).toBe('cancelled');expect(sendEmail).not.toHaveBeenCalled();});
  it('leaves an ambiguous provider result blocked',async()=>{const {run,sendEmail,locks}=setup();sendEmail.mockRejectedValue(Error('lost'));expect((await run('email','e1')).outcome).toBe('unconfirmed');expect(locks.email).toBe('e1');expect((await run('email','e2')).outcome).toBe('ineligible_or_unavailable');expect(sendEmail).toHaveBeenCalledOnce();});
});
