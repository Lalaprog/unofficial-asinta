import { describe, expect, it } from 'vitest';
import { prepareReminderEmail } from '@/lib/reminders/prepareEmail';
import { createFakeDb } from './helpers/fakeDb';

function setup() {
  const db = createFakeDb({
    invoices:[{id:'inv',invoice_number:'I-001',client_id:'client',project_id:'project',amount:'1000.00',amount_paid:'250.00',issue_date:'2026-11-01',due_date:'2026-11-10',status:'pending',notes:null,automatic_reminders_enabled:true,reminders_paused_until:null}],
    clients:[{id:'client',name:'Client Co',contact_person:'Ana',email:'ana@example.test'}],
    projects:[{id:'project',name:'Office'}], email_templates:[],
  });
  const run = () => prepareReminderEmail({db, invoiceId:'inv',now:new Date('2026-11-07T02:00:00Z'),firmEmail:'firm@example.test',firmContactNumber:'123'});
  return {db,run};
}
describe('automatic reminder email preparation (no sending)', () => {
  it('renders authoritative invoice data and detects meaningful changes', async () => {
    const {db,run}=setup(); const first=await run(); expect(first.ok).toBe(true);
    if (!first.ok) throw Error('preparation failed');
    expect(first.prepared.recipient).toBe('ana@example.test'); expect(first.prepared.rendered.bodyText).toContain('I-001');
    expect(first.prepared.rendered.bodyText).toMatch(/750/); expect(first.prepared.rendered.bodyHtml).toContain('Office');
    db.tables.invoices[0].amount_paid='500.00'; const changed=await run();
    expect(changed.ok).toBe(true); if (changed.ok) expect(changed.prepared.fingerprint).not.toBe(first.prepared.fingerprint);
  });
  it.each([
    ['paid',{status:'paid'}],['missing payment',{amount_paid:null}],['negative payment',{amount_paid:-1}],
    ['disabled',{automatic_reminders_enabled:false}],['zero balance',{amount_paid:'1000'}],
    ['bad date',{due_date:'2026-02-30'}],['paused',{reminders_paused_until:'2026-11-08T00:00:00Z'}],['bad pause',{reminders_paused_until:'oops'}],['ambiguous pause',{reminders_paused_until:'2026-11-06'}],['impossible pause',{reminders_paused_until:'2026-02-30T00:00:00Z'}],
  ])('rejects %s invoices',async(_label,patch)=>{const {db,run}=setup();Object.assign(db.tables.invoices[0],patch);expect((await run()).ok).toBe(false);});
  it('rejects invalid recipient or a malformed saved template rather than using stale defaults', async()=>{
    const {db,run}=setup();db.tables.clients[0].email='bad\naddress@example.test';expect(await run()).toMatchObject({ok:false,reason:'recipient_unavailable'});
    db.tables.clients[0].email='a@example.test';db.tables.email_templates.push({template_type:'upcoming_reminder',subject_template:'{{bad}}',body_template:'body',version:1,active:true});
    expect(await run()).toMatchObject({ok:false,reason:'template_invalid'});
  });
  it('never silently uses a default on read errors', async()=>{
    const {db,run}=setup(); const original=db.from; db.from=(table:string)=>{if(table==='email_templates') throw Error('offline');return original(table);};
    expect(await run()).toMatchObject({ok:false,reason:'preparation_unavailable'});
    db.from=(table:string)=>{const query=original(table);if(table==='email_templates')query.maybeSingle=async()=>({data:undefined,error:null});return query;};
    expect(await run()).toMatchObject({ok:false,reason:'template_unavailable'});
  });
});
