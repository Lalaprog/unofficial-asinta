import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSMSHistoryPage, parseSMSHistorySummary } from '@/lib/sms/history';

const sql = readFileSync('supabase/migrations/20261103000003_sms_history.sql','utf8');
const f='00000000-0000-0000-0000-000000000001', supervisor='00000000-0000-0000-0000-000000000002';
type Item={id:string;sent_at:string;invoice_number:string|null};
type Page={items:Item[];has_more:boolean};
describe('SMS history under RLS', () => {
  it('pages over 1,000 tied timestamps, filters literally and respects Founder and invoice RLS', async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        create role authenticated; create role anon; create schema auth;
        create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
        create function public.is_founder() returns boolean language sql stable as $$ select auth.uid()='${f}'::uuid $$;
        create table public.invoices(id uuid primary key, invoice_number text, visible boolean);
        create table public.sms_logs(id uuid primary key,invoice_id uuid,recipient text not null,phone text not null,message text not null,status text not null,simulated boolean not null,provider_message_id text,provider_status text,error_message text,updated_at timestamptz,sent_at timestamptz not null);
        grant usage on schema public,auth to authenticated,anon;
        grant select on public.sms_logs,public.invoices to authenticated;
        alter table public.sms_logs enable row level security; alter table public.invoices enable row level security;
        create policy sms_founder on public.sms_logs for select to authenticated using(public.is_founder());
        create policy invoice_visible on public.invoices for select to authenticated using(visible);
        insert into public.invoices values ('10000000-0000-0000-0000-000000000001','INV-%_123',true),('10000000-0000-0000-0000-000000000002','SECRET-INVOICE',false);
        insert into public.sms_logs select md5(n::text)::uuid,null,'Recipient','09123','ordinary','sent',false,null,null,null,null,'2026-11-03 00:00:00.123456+00'::timestamptz from generate_series(1,1005) n;
        insert into public.sms_logs values
          ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','Ada %_','099','literal test','delivered',false,null,null,null,null,'2026-11-02 16:00:00+00'),
          ('20000000-0000-0000-0000-000000000002',null,'Simulation','099','not sent','failed',true,null,null,null,null,'2026-11-02 15:59:59.999999+00'),
          ('20000000-0000-0000-0000-000000000003',null,'Sim delivered','099','historical anomaly','delivered',true,null,null,null,null,'2026-11-01 00:00+00'),
          ('20000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000002','Hidden invoice','099','no invoice leak','failed',false,null,null,null,null,'2026-10-31 00:00+00');
        ${sql}
        set role authenticated; select set_config('request.jwt.claim.sub','${f}',false);
      `);
      const fetchPage = async (cursor:Item|null=null) => (await db.query<{v:Page}>('select public.sms_history_page(null,null,null,null,$1,$2,50) as v',[cursor?.sent_at ?? null,cursor?.id ?? null])).rows[0].v;
      const ids=new Set<string>(); let page=await fetchPage();
      while (true) { for(const row of page.items) { expect(ids.has(row.id)).toBe(false); ids.add(row.id); } if(!page.has_more) break; page=await fetchPage(page.items.at(-1)!); }
      expect(ids.size).toBe(1009);
      const query = async (search:string|null,status:string|null,from:string|null=null,to:string|null=null) => (await db.query<{v:Page}>('select public.sms_history_page($1,$2,$3,$4,null,null,25) as v',[search,status,from,to])).rows[0].v;
      expect((await query('%_',null)).items).toHaveLength(1);
      expect((await query('INV-%_123',null)).items).toHaveLength(1);
      expect((await query('SECRET-INVOICE',null)).items).toHaveLength(0);
      expect((await query('Hidden invoice',null)).items[0].invoice_number).toBeNull();
      expect((await query(null,'simulated')).items).toHaveLength(2);
      expect((await query(null,'failed')).items).toHaveLength(1);
      expect((await query(null,'delivered')).items).toHaveLength(1);
      expect((await query('Ada',null,'2026-11-03','2026-11-03')).items).toHaveLength(1);
      expect((await query('Simulation',null,'2026-11-03','2026-11-03')).items).toHaveLength(0);
      const summary=(await db.query<{v:unknown}>('select public.sms_history_summary() as v')).rows[0].v;
      expect(summary).toEqual({total:1009,delivered:1}); expect(parseSMSHistorySummary(summary)).toEqual(summary);
      const valid=(await query('Ada',null)); expect(parseSMSHistoryPage(valid).items).toHaveLength(1);
      await expect(db.query("select public.sms_history_page(null,null,null,null,now(),null,25)")).rejects.toThrow(/cursor/i);
      await expect(db.query("select public.sms_history_page(null,'bad')")).rejects.toThrow(/status/i);
      await expect(db.query("select public.sms_history_page(null,null,'2026-11-04','2026-11-03')")).rejects.toThrow(/date/i);
      await expect(db.query("select public.sms_history_page(repeat('x',201))")).rejects.toThrow(/long/i);
      await expect(db.query("select public.sms_history_page(null,null,null,null,null,null,51)")).rejects.toThrow(/size/i);
      await db.exec(`select set_config('request.jwt.claim.sub','${supervisor}',false)`);
      await expect(db.query('select public.sms_history_page()')).rejects.toThrow(/Founder/i);
      await expect(db.query('select public.sms_history_summary()')).rejects.toThrow(/Founder/i);
      await db.exec('reset role; set role anon');
      await expect(db.query('select public.sms_history_page()')).rejects.toThrow(/permission denied/i);
      await expect(db.query('select public.sms_history_summary()')).rejects.toThrow(/permission denied/i);
    } finally { await db.close(); }
  },30000);
  it('rejects malformed summaries and paging responses', () => {
    expect(() => parseSMSHistoryPage({items:[],has_more:true})).toThrow();
    expect(() => parseSMSHistoryPage({items:[{id:'x'}],has_more:false})).toThrow();
    expect(() => parseSMSHistorySummary({total:1,delivered:2})).toThrow();
  });
});
