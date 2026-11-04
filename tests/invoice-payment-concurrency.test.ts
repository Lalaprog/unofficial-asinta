// Opt-in SQL semantics test; requires an EMPTY local disposable database.
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
const url = process.env.INVOICE_PAYMENT_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
let admin:Client, first:Client, second:Client;
const id='00000000-0000-0000-0000-000000000003';
// Equivalent to the app's PostgREST UPDATE and four equality filters.
const update = `UPDATE public.invoices SET amount_paid=$1, status=$2
  WHERE id=$3 AND amount=$4 AND amount_paid=$5 AND status=$6 RETURNING *`;
suite('real PostgreSQL conditional invoice updates',()=>{
  beforeAll(async()=>{
    const parsed=new URL(url!);
    if (!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname) || !parsed.pathname.slice(1).startsWith('asinta_test_')) throw new Error('Use an empty local disposable database named asinta_test_*.');
    admin=new Client({connectionString:url});first=new Client({connectionString:url});second=new Client({connectionString:url});
    await Promise.all([admin.connect(),first.connect(),second.connect()]);
    const existing=await admin.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')");
    if(existing.rows[0].n!==0) throw new Error('Test database public schema must be empty.');
    await admin.query('CREATE TABLE public.invoices(id uuid PRIMARY KEY, amount numeric(14,2), amount_paid numeric(14,2), status text, automatic_reminders_enabled boolean DEFAULT false)');
    await admin.query("INSERT INTO public.invoices(id,amount,amount_paid,status) VALUES($1,100,0,'pending')",[id]);
  },30000);
  beforeEach(async()=>{await admin.query("UPDATE public.invoices SET amount=100,amount_paid=0,status='pending',automatic_reminders_enabled=false WHERE id=$1",[id])});
  afterAll(async()=>{await Promise.all([first?.end(),second?.end(),admin?.end()])});
  it('does not overwrite a competing payment from the same reviewed snapshot',async()=>{
    await first.query('BEGIN');await second.query('BEGIN');
    expect((await first.query(update,[30,'partially_paid',id,100,0,'pending'])).rowCount).toBe(1);
    let settled=false;
    const pending=second.query(update,[40,'partially_paid',id,100,0,'pending']).finally(()=>{settled=true});
    await new Promise(resolve=>setTimeout(resolve,150));expect(settled).toBe(false);
    await first.query('COMMIT');expect((await pending).rowCount).toBe(0);await second.query('COMMIT');
    expect((await admin.query('SELECT amount_paid,status FROM public.invoices WHERE id=$1',[id])).rows[0]).toEqual({amount_paid:'30.00',status:'partially_paid'});
  },10000);
  it('does not let a reminder-only update revert a payment status',async()=>{
    await first.query('BEGIN');await second.query('BEGIN');
    await first.query(update,[100,'paid',id,100,0,'pending']);
    let settled=false;const pending=second.query('UPDATE public.invoices SET automatic_reminders_enabled=true WHERE id=$1',[id]).finally(()=>{settled=true});
    await new Promise(resolve=>setTimeout(resolve,150));expect(settled).toBe(false);
    await first.query('COMMIT');await pending;await second.query('COMMIT');
    expect((await admin.query('SELECT amount_paid,status,automatic_reminders_enabled FROM public.invoices WHERE id=$1',[id])).rows[0]).toEqual({amount_paid:'100.00',status:'paid',automatic_reminders_enabled:true});
  },10000);
});
