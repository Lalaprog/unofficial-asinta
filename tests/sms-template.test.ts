import { describe, expect, it } from 'vitest';
import { buildReminderSMS, DEFAULT_SMS_TEMPLATE, validateSMSTemplate } from '@/lib/sms/templates';
const sample={contactPerson:'Ada',companyName:'Co',invoiceNumber:'INV-01',projectName:'Project',outstandingBalance:100,dueDate:'2026-11-06'};
describe('custom SMS templates',()=>{
  it('uses a real successful email date only when available and valid',()=>{
    const t='{{client_contact_name}} {{invoice_number}} {{email_reference}}';
    expect(buildReminderSMS(sample,t)).not.toContain('emailed on');
    expect(buildReminderSMS({...sample,paymentRequestSentDate:'invalid'},t)).not.toContain('emailed on');
    expect(buildReminderSMS({...sample,paymentRequestSentDate:'2026-11-06'},t)).toContain('emailed on Nov 6, 2026');
  });
  it('validates unsupported, incomplete and overly long fields',()=>{
    for(const input of ['', '{{secret}}', '{{due_date', 'x'.repeat(1001)]) expect(validateSMSTemplate(input).valid).toBe(false);
    expect(validateSMSTemplate(DEFAULT_SMS_TEMPLATE)).toEqual({valid:true,missing:[]});
    expect(validateSMSTemplate('Hello {{client_contact_name}}').missing).toContain('outstanding_balance');
  });
});
