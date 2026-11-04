import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { founder, supervisor, invoice, otherInvoice, request, secondRequest, invoiceFixture, paymentSQL } from './helpers/invoice-payment-fixture';

const migration = readFileSync('supabase/migrations/20261104000000_atomic_invoice_payments.sql', 'utf8');
let db: PGlite;
const pay = async (args: unknown[] = [request, invoice, '30.25', 100, 0, 'pending']) =>
  (await db.query<{result:{outcome:string; invoice?:{amount_paid:number;status:string}}}>(paymentSQL, args)).rows[0].result;

beforeEach(async () => {
  db = new PGlite();
  await db.exec(invoiceFixture);
  await db.exec(migration);
  await db.exec(`SELECT set_config('request.jwt.claim.sub','${founder}',false); SET ROLE authenticated;`);
}, 30000);
afterEach(async () => { await db.close(); });

describe('transactional invoice payments', () => {
  it('records, audits, returns a harmless retry, and rejects stale or mismatched requests', async () => {
    const first = await pay(); expect(first.outcome).toBe('recorded'); expect(Number(first.invoice?.amount_paid)).toBe(30.25);
    expect((await pay()).outcome).toBe('already_recorded');
    expect((await pay([request, invoice, 31, 100, 0, 'pending'])).outcome).toBe('request_mismatch');
    expect((await pay([request, otherInvoice, '30.25', 100, 0, 'pending'])).outcome).toBe('request_mismatch');
    expect((await pay([secondRequest, invoice, 20, 100, 0, 'pending'])).outcome).toBe('stale');
    expect((await pay([secondRequest, invoice, '69.75', 100, '30.25', 'partially_paid'])).outcome).toBe('recorded');
    await db.exec('RESET ROLE');
    const audits = await db.query<{actor_id:string; before_row:{amount_paid:number};after_row:{amount_paid:number;status:string}}>('SELECT * FROM public.audit_log ORDER BY before_row->>\'amount_paid\'');
    expect(audits.rows).toHaveLength(2);
    expect(audits.rows[0].actor_id).toBe(founder); expect(Number(audits.rows[0].before_row.amount_paid)).toBe(0);
    expect(Number(audits.rows[1].after_row.amount_paid)).toBe(100); expect(audits.rows[1].after_row.status).toBe('paid');
    expect((await db.query('SELECT * FROM public.invoice_payment_operations')).rows).toHaveLength(2);
  });
  it('rolls back invoice and operation if the audit insert fails', async () => {
    await db.exec("RESET ROLE; ALTER TABLE public.audit_log ADD CONSTRAINT reject_invoice CHECK(table_name <> 'invoices'); SET ROLE authenticated");
    await expect(pay()).rejects.toThrow();
    expect((await db.query<{amount_paid:string}>('SELECT amount_paid FROM public.invoices WHERE id=$1',[invoice])).rows[0].amount_paid).toBe('0.00');
    await db.exec('RESET ROLE');
    expect((await db.query('SELECT * FROM public.invoice_payment_operations')).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM public.audit_log')).rows).toHaveLength(0);
  });
  it('rolls back the invoice and audit if operation-key storage fails', async () => {
    await db.exec("RESET ROLE; ALTER TABLE public.invoice_payment_operations ADD CONSTRAINT reject_operation CHECK(amount <> 30.25); SET ROLE authenticated");
    await expect(pay()).rejects.toThrow();
    expect((await db.query<{amount_paid:string}>('SELECT amount_paid FROM public.invoices WHERE id=$1',[invoice])).rows[0].amount_paid).toBe('0.00');
    await db.exec('RESET ROLE');
    expect((await db.query('SELECT * FROM public.invoice_payment_operations')).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM public.audit_log')).rows).toHaveLength(0);
  });
  it('blocks old financial writes and pre-paid inserts while preserving reminder settings', async () => {
    await expect(db.query('UPDATE public.invoices SET amount_paid=10 WHERE id=$1',[invoice])).rejects.toThrow(/permission denied/);
    await expect(db.query("UPDATE public.invoices SET status='paid' WHERE id=$1",[invoice])).rejects.toThrow(/permission denied/);
    await expect(db.query('UPDATE public.invoices SET amount=200 WHERE id=$1',[invoice])).rejects.toThrow(/permission denied/);
    await expect(db.query("INSERT INTO public.invoices(id,invoice_number,amount,amount_paid,status) VALUES(gen_random_uuid(),'BAD',100,10,'partially_paid')")).rejects.toThrow(/must not contain/);
    await db.query('UPDATE public.invoices SET automatic_reminders_enabled=true WHERE id=$1',[invoice]);
    expect((await db.query<{automatic_reminders_enabled:boolean}>('SELECT automatic_reminders_enabled FROM public.invoices WHERE id=$1',[invoice])).rows[0].automatic_reminders_enabled).toBe(true);
  });
  it('rejects invalid, overpayment, closed invoices, supervisors and anonymous use', async () => {
    for (const value of ['0','-1','0.001','NaN','Infinity','1000000000000']) expect((await pay([request,invoice,value,100,0,'pending'])).outcome).toBe('invalid');
    expect((await pay([request,invoice,101,100,0,'pending'])).outcome).toBe('invalid_balance');
    await db.exec("RESET ROLE; UPDATE public.invoices SET status='cancelled' WHERE id='"+invoice+"'; SET ROLE authenticated;");
    expect((await pay([request,invoice,1,100,0,'cancelled'])).outcome).toBe('invalid_balance');
    await db.exec(`SELECT set_config('request.jwt.claim.sub','${supervisor}',false)`);
    await expect(pay()).rejects.toThrow(/Founder access/);
    await db.exec('RESET ROLE; SET ROLE anon');
    await expect(pay()).rejects.toThrow(/permission denied/);
  });
  it('keeps a completed operation id after an invoice is deleted', async () => {
    expect((await pay()).outcome).toBe('recorded');
    await db.query('DELETE FROM public.invoices WHERE id=$1',[invoice]);
    expect((await pay()).outcome).toBe('already_recorded');
  });
});
