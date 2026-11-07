import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb, createFakeSupabase, type FakeDb } from './helpers/fakeDb';
import { requireFounder } from '@/lib/auth/serverRole';
import { sendRequestForPayment, previewRequestForPayment, type EmailServiceDeps } from '@/lib/email/service';

const FIRM = { fromAddress: 'billing@asinta.ph', replyTo: 'billing@asinta.ph', firmContactNumber: '+63 917 800 2026' };

function seedDb(): FakeDb {
  return createFakeDb({
    users: [
      { id: 'founder-1', role: 'founder', email: 'junel@asinta.ph' },
      { id: 'supervisor-1', role: 'supervisor', email: 'marco@asinta.ph' },
    ],
    clients: [
      {
        id: 'client-1',
        name: 'Laurel Medical Group',
        contact_person: 'Dr. Eduardo Laurel',
        email: 'eduardo@laurel.ph',
        phone: '+639178421190',
      },
      { id: 'client-2', name: 'No Email Corp', contact_person: 'X', email: 'not-an-email', phone: '' },
    ],
    projects: [{ id: 'project-1', name: 'Laurel Clinic Extension' }],
    invoices: [
      {
        id: 'invoice-1',
        project_id: 'project-1',
        client_id: 'client-1',
        invoice_number: 'ASINTA-2026-014',
        amount: 1500000,
        amount_paid: 500000,
        issue_date: '2026-01-05',
        due_date: '2026-01-20',
        status: 'pending',
        notes: 'Progress billing',
      },
      {
        id: 'invoice-cancelled',
        project_id: 'project-1',
        client_id: 'client-1',
        invoice_number: 'ASINTA-2026-015',
        amount: 100,
        amount_paid: 0,
        issue_date: '2026-01-05',
        due_date: '2026-01-20',
        status: 'cancelled',
        notes: null,
      },
      {
        id: 'invoice-bad-email',
        project_id: 'project-1',
        client_id: 'client-2',
        invoice_number: 'ASINTA-2026-016',
        amount: 100,
        amount_paid: 0,
        issue_date: '2026-01-05',
        due_date: '2026-01-20',
        status: 'pending',
        notes: null,
      },
    ],
    email_templates: [],
    email_logs: [],
  });
}

function makeDeps(db: FakeDb, overrides: Partial<EmailServiceDeps> = {}): EmailServiceDeps {
  return {
    db,
    sendEmail: vi.fn(async () => ({ accepted: true, providerMessageId: '<smtp-123@mail>' })),
    isSmtpConfigured: () => true,
    firmIdentity: FIRM,
    ...overrides,
  };
}

describe('Founder authorization (server-side)', () => {
  let db: FakeDb;
  beforeEach(() => {
    db = seedDb();
  });

  it('rejects unauthenticated requests with 401', async () => {
    const supabase = createFakeSupabase(db, null);
    const result = await requireFounder(supabase as never);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('rejects Supervisor accounts with 403', async () => {
    const supabase = createFakeSupabase(db, { id: 'supervisor-1' });
    const result = await requireFounder(supabase as never);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
  });

  it('accepts Founder accounts', async () => {
    const supabase = createFakeSupabase(db, { id: 'founder-1', email: 'junel@asinta.ph' });
    const result = await requireFounder(supabase as never);
    expect(result.ok).toBe(true);
    expect(result.userId).toBe('founder-1');
  });
});

describe('sendRequestForPayment', () => {
  let db: FakeDb;
  beforeEach(() => {
    db = seedDb();
  });

  it('rejects missing invoices with 404', async () => {
    const deps = makeDeps(db);
    const result = await sendRequestForPayment(deps, {
      invoiceId: 'does-not-exist',
      idempotencyKey: 'key-00000001',
      sentBy: 'founder-1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.status).toBe(404);
  });

  it('rejects cancelled invoices', async () => {
    const deps = makeDeps(db);
    const result = await sendRequestForPayment(deps, {
      invoiceId: 'invoice-cancelled',
      idempotencyKey: 'key-00000002',
      sentBy: 'founder-1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.status).toBe(422);
  });

  it('rejects invalid client email addresses', async () => {
    const deps = makeDeps(db);
    const result = await sendRequestForPayment(deps, {
      invoiceId: 'invoice-bad-email',
      idempotencyKey: 'key-00000003',
      sentBy: 'founder-1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(422);
      expect(result.error.error).toContain('email');
    }
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it('rejects sends when SMTP is not configured', async () => {
    const deps = makeDeps(db, { isSmtpConfigured: () => false });
    const result = await sendRequestForPayment(deps, {
      invoiceId: 'invoice-1',
      idempotencyKey: 'key-00000004',
      sentBy: 'founder-1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.status).toBe(503);
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it('rejects unresolved/unsupported placeholders in Founder-edited wording', async () => {
    const deps = makeDeps(db);
    const result = await sendRequestForPayment(deps, {
      invoiceId: 'invoice-1',
      bodyTemplate: 'Dear {{client_contact_name}}, pay {{secret_hack}} now.',
      idempotencyKey: 'key-00000005',
      sentBy: 'founder-1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.status).toBe(422);
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it('does not use a default when a saved-template read fails or returns an inactive row', async () => {
    const from = db.from;
    db.from = (table: string) => {
      const query = from(table);
      if (table === 'email_templates') query.maybeSingle = async () => ({data:null,error:{message:'offline'}});
      return query;
    };
    const deps = makeDeps(db);
    expect(await previewRequestForPayment(deps,{invoiceId:'invoice-1'})).toMatchObject({ok:false,error:{status:503}});
    expect(await sendRequestForPayment(deps,{invoiceId:'invoice-1',idempotencyKey:'key-template-error',sentBy:'founder-1'})).toMatchObject({ok:false,error:{status:503}});
    expect(deps.sendEmail).not.toHaveBeenCalled(); expect(db.tables.email_logs).toHaveLength(0);
    db.from = from;
    db.tables.email_templates.push({template_type:'initial_request',subject_template:'Subject',body_template:'Body',version:1,active:false});
    expect(await previewRequestForPayment(deps,{invoiceId:'invoice-1'})).toMatchObject({ok:false,error:{status:503}});
  });

  it.each([
    {amount:100,paid:null}, {amount:'',paid:0}, {amount:'100',paid:'invalid'},
    {amount:100,paid:-1}, {amount:-1,paid:0},
  ])('never previews or sends unreadable invoice amounts %#', async ({amount,paid}) => {
    Object.assign(db.tables.invoices[0],{amount,amount_paid:paid});
    const deps = makeDeps(db);
    expect((await previewRequestForPayment(deps,{invoiceId:'invoice-1'})).ok).toBe(false);
    const result = await sendRequestForPayment(deps,{invoiceId:'invoice-1',idempotencyKey:'key-invalid-amount',sentBy:'founder-1'});
    expect(result.ok).toBe(false); expect(deps.sendEmail).not.toHaveBeenCalled(); expect(db.tables.email_logs).toHaveLength(0);
  });

  it('loads authoritative recipient and financial data server-side and logs accepted', async () => {
    const deps = makeDeps(db);
    const result = await sendRequestForPayment(deps, {
      invoiceId: 'invoice-1',
      idempotencyKey: 'key-00000006',
      sentBy: 'founder-1',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe('accepted');
      expect(result.providerMessageId).toBe('<smtp-123@mail>');
    }

    // Authoritative recipient came from the database client record.
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    const sentArgs = (deps.sendEmail as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sentArgs.to).toBe('eduardo@laurel.ph');
    expect(sentArgs.text).toContain('₱1,000,000.00');

    // Exact snapshot stored with accepted status + provider message id.
    const log = db.tables.email_logs[0];
    expect(log.status).toBe('accepted');
    expect(log.recipient).toBe('eduardo@laurel.ph');
    expect(log.subject).toContain('ASINTA-2026-014');
    expect(log.body_text).toContain('Outstanding Balance: ₱1,000,000.00');
    expect(log.body_html).toContain('ASINTA ARCHITECTS');
    expect(log.template_type).toBe('initial_request');
    expect(log.template_version).toBe(1);
    expect(log.sent_by).toBe('founder-1');
    expect(log.provider_message_id).toBe('<smtp-123@mail>');
    expect(log.sent_at).toBeTruthy();
  });

  it('records failed sends with a safe error message', async () => {
    const deps = makeDeps(db, {
      sendEmail: vi.fn(async () => ({ accepted: false, uncertain: false, error: 'SMTP authentication failed. Verify SMTP_USER and SMTP_PASS on the server.' })),
    });
    const result = await sendRequestForPayment(deps, {
      invoiceId: 'invoice-1',
      idempotencyKey: 'key-00000007',
      sentBy: 'founder-1',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe('failed');
      expect(result.error).toContain('SMTP authentication failed');
    }
    const log = db.tables.email_logs[0];
    expect(log.status).toBe('failed');
    expect(log.error_message).toContain('SMTP authentication failed');
  });

  it('retains an unconfirmed attempt and never repeats it after a timeout', async () => {
    const deps = makeDeps(db, { sendEmail: vi.fn(async () => ({ accepted: false, uncertain: true, error: 'Timed out' })) });
    const input = { invoiceId: 'invoice-1', idempotencyKey: 'key-timeout-01', sentBy: 'founder-1' };
    const first = await sendRequestForPayment(deps, input);
    expect(first.ok && first.status).toBe('unconfirmed');
    expect(db.tables.email_logs[0].status).toBe('pending');
    const again = await sendRequestForPayment(deps, input);
    expect(again.ok && again.status).toBe('unconfirmed');
    expect(again.ok && again.duplicate).toBe(true);
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('treats a thrown provider error as unconfirmed and retains the key', async () => {
    const deps = makeDeps(db, { sendEmail: vi.fn(async () => { throw Error('lost response'); }) });
    const input = { invoiceId: 'invoice-1', idempotencyKey: 'key-throw-001', sentBy: 'founder-1' };
    const first = await sendRequestForPayment(deps, input);
    expect(first.ok && first.status).toBe('unconfirmed');
    expect(db.tables.email_logs[0].status).toBe('pending');
    await sendRequestForPayment(deps, input);
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('reports when a provider result cannot be recorded in email history', async () => {
    const deps = makeDeps(db); const from = db.from;
    db.from = (table: string) => {
      const query = from(table);
      if (table === 'email_logs') query.update = () => ({ eq: () => ({ select: () => ({ maybeSingle: async () => ({data:null,error:{message:'unavailable'}}) }) }) });
      return query;
    };
    const result = await sendRequestForPayment(deps, {invoiceId:'invoice-1',idempotencyKey:'key-log-0001',sentBy:'founder-1'});
    expect(result.ok && result.status).toBe('accepted');
    expect(result.ok && result.logUpdateFailed).toBe(true);
    expect(db.tables.email_logs[0].status).toBe('pending');
  });

  it('never sends twice for the same idempotency key', async () => {
    const deps = makeDeps(db);
    const first = await sendRequestForPayment(deps, {
      invoiceId: 'invoice-1',
      idempotencyKey: 'key-repeat-01',
      sentBy: 'founder-1',
    });
    const second = await sendRequestForPayment(deps, {
      invoiceId: 'invoice-1',
      idempotencyKey: 'key-repeat-01',
      sentBy: 'founder-1',
    });

    expect(first.ok && second.ok).toBe(true);
    if (second.ok) expect(second.duplicate).toBe(true);
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    expect(db.tables.email_logs).toHaveLength(1);
  });

  it('requires an idempotency key', async () => {
    const deps = makeDeps(db);
    const result = await sendRequestForPayment(deps, {
      invoiceId: 'invoice-1',
      idempotencyKey: '',
      sentBy: 'founder-1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.status).toBe(400);
  });
});

describe('previewRequestForPayment', () => {
  it('returns authoritative context and rendered previews', async () => {
    const db = seedDb();
    const result = await previewRequestForPayment(
      { db, firmIdentity: FIRM },
      { invoiceId: 'invoice-1' }
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.recipient).toBe('eduardo@laurel.ph');
      expect(result.context.invoice.amount).toBe(1500000);
      expect(result.rendered.subject).toContain('Laurel Clinic Extension');
      expect(result.rendered.bodyHtml).toContain('ASINTA ARCHITECTS');
    }
  });
});

describe('reviewed email safeguards', () => {
  it('allows a matching reviewed message and records the customized snapshot', async () => {
    const db = seedDb(); const deps = makeDeps(db);
    const preview = await previewRequestForPayment(deps, { invoiceId:'invoice-1', bodyTemplate:'Hello {{client_contact_name}}! Your invoice {{invoice_number}} is due.' });
    expect(preview.ok).toBe(true); if (!preview.ok) return;
    const { emailPreviewFingerprint } = await import('@/lib/email/service');
    const result = await sendRequestForPayment(deps, {invoiceId:'invoice-1', bodyTemplate:'Hello {{client_contact_name}}! Your invoice {{invoice_number}} is due.', previewFingerprint:emailPreviewFingerprint(preview.context,preview.rendered), idempotencyKey:'reviewed-001', sentBy:'founder-1'});
    expect(result.ok).toBe(true);expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    expect(db.tables.email_logs[0].body_text).toContain('Hello Dr. Eduardo Laurel!');
    expect(db.tables.email_templates).toHaveLength(0);
  });
  it.each(['amount_paid','recipient','message','status'] as const)('blocks a send when reviewed %s has changed', async (changed) => {
    const db=seedDb(); const deps=makeDeps(db);const preview=await previewRequestForPayment(deps,{invoiceId:'invoice-1'});
    expect(preview.ok).toBe(true);if(!preview.ok)return;
    const {emailPreviewFingerprint}=await import('@/lib/email/service'); const fingerprint=emailPreviewFingerprint(preview.context,preview.rendered);
    if(changed==='amount_paid')db.tables.invoices[0].amount_paid=700000;
    if(changed==='recipient')db.tables.clients[0].email='new@example.com';
    if(changed==='status')db.tables.invoices[0].status='paid';
    const result=await sendRequestForPayment(deps,{invoiceId:'invoice-1', bodyTemplate:changed==='message'?'A changed message':undefined, previewFingerprint:fingerprint,idempotencyKey:'reviewed-002',sentBy:'founder-1'});
    expect(result.ok).toBe(false);if(!result.ok)expect(result.error.status).toBe(409);
    expect(deps.sendEmail).not.toHaveBeenCalled();expect(db.tables.email_logs).toHaveLength(0);
  });
  it('still reports a previously accepted key without sending again if the invoice changes later',async()=>{
    const db=seedDb();const deps=makeDeps(db);const preview=await previewRequestForPayment(deps,{invoiceId:'invoice-1'});if(!preview.ok)throw new Error('preview failed');
    const {emailPreviewFingerprint}=await import('@/lib/email/service');const input={invoiceId:'invoice-1',previewFingerprint:emailPreviewFingerprint(preview.context,preview.rendered),idempotencyKey:'reviewed-003',sentBy:'founder-1'};
    expect((await sendRequestForPayment(deps,input)).ok).toBe(true);db.tables.invoices[0].amount_paid=900000;
    const again=await sendRequestForPayment(deps,input);expect(again.ok && again.duplicate).toBe(true);expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  });
});
