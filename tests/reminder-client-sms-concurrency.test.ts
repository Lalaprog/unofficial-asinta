// Opt-in: use only an empty local disposable asinta_test_* PostgreSQL database.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
const url=process.env.REMINDER_CLIENT_TEST_DATABASE_URL,suite=url?describe:describe.skip;
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const client=id(1),invoice=id(2),otherInvoice=id(3),a=id(4),b=id(5),founder=id(6);
let admin:Client,first:Client,second:Client;
suite('client SMS locking in PostgreSQL',()=>{
 beforeAll(async()=>{const u=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||!u.pathname.slice(1).startsWith('asinta_test_'))throw Error('Use an empty local disposable database');admin=new Client({connectionString:url});first=new Client({connectionString:url});second=new Client({connectionString:url});await Promise.all([admin.connect(),first.connect(),second.connect()]);
 if((await admin.query("select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m','S') limit 1")).rowCount)throw Error('Database not empty');
 await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END $$;
 create schema app_private;create table app_private.guard(id int);insert into app_private.guard values(1);create function app_private.lock_founder_guard() returns void language plpgsql as $$ begin perform id from app_private.guard for update; end $$;
 create table users(id uuid primary key,role text);insert into users values('${founder}','founder');create table clients(id uuid primary key,email text,phone text);insert into clients values('${client}','a@example.test','09171234567');
 insert into clients values('${id(9)}','A@example.test','+63 (917) 123-4567'); create table invoices(id uuid primary key,client_id uuid references clients(id));insert into invoices values('${invoice}','${client}'),('${otherInvoice}','${client}'),('${id(10)}','${id(9)}');
 create table email_logs(id uuid primary key default gen_random_uuid(),invoice_id uuid,status text,sent_at timestamptz,recipient text);create table sms_logs(id uuid primary key default gen_random_uuid(),invoice_id uuid,status text,simulated boolean,sent_at timestamptz,updated_at timestamptz,phone text);
 create table reminder_dispatches(id uuid primary key default gen_random_uuid(),invoice_id uuid,channel text,status text,sent_at timestamptz);`);
 for(const f of ['20261107000005_reminder_delivery_coordination.sql','20261107000008_staged_reminder_slot_claims.sql','reminder_log_correlation.sql','20261107000009_staged_reminder_review.sql','20261107000010_staged_reminder_history.sql','20261107000011_staged_reminder_client_sms.sql'])await admin.query(readFileSync('supabase/staged/'+f,'utf8'));
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),first?.end(),second?.end()]);});
 it('makes a competing invoice send wait and refuse after a client-only reservation commits',async()=>{
  await first.query('begin');await second.query('begin');expect((await first.query('select public.reserve_client_sms_delivery($1,$2) r',[client,a])).rows[0].r).toBe('reserved');let done=false;
  const competing=second.query("select public.reserve_reminder_delivery($1,'sms','automatic',$2) r",[invoice,b]).finally(()=>{done=true;});await new Promise(r=>setTimeout(r,200));expect(done).toBe(false);await first.query('commit');expect((await competing).rows[0].r).toBe('busy');await second.query('commit');
  expect((await admin.query("select public.finish_client_sms_delivery($1,$2,'accepted') r",[client,a])).rows[0].r).toBe(true);
 });
 it('makes a competing client-only send wait and refuse after an invoice reservation commits',async()=>{
  const aa=id(7),bb=id(8);await first.query('begin');await second.query('begin');expect((await first.query("select public.reserve_reminder_delivery($1,'sms','automatic',$2) r",[otherInvoice,aa])).rows[0].r).toBe('reserved');let done=false;
  const competing=second.query('select public.reserve_client_sms_delivery($1,$2) r',[client,bb]).finally(()=>{done=true;});await new Promise(r=>setTimeout(r,200));expect(done).toBe(false);await first.query('commit');expect((await competing).rows[0].r).toBe('busy');await second.query('commit');
  expect((await admin.query("select public.finish_reminder_delivery($1,'sms',$2,'unconfirmed') r",[otherInvoice,aa])).rows[0].r).toBe(true);expect((await admin.query("select public.review_reminder_delivery($1,$2,'sms',$3,'rejected','Provider confirmed the request was rejected.',true) r",[founder,otherInvoice,aa])).rows[0].r).toBe(true);
  expect((await admin.query('select public.reserve_client_sms_delivery($1,$2) r',[client,bb])).rows[0].r).toBe('reserved');
 });
 it('serializes separate clients sharing the same normalized phone',async()=>{
  const aa=id(11),bb=id(12);await first.query('begin');await second.query('begin');
  // The earlier test leaves client 1 reserved; use an independent shared pair.
  await admin.query("insert into clients values($1,'z@example.test','09185556666'),($2,'y@example.test','+63 918 555 6666')",[id(13),id(14)]);
  expect((await first.query('select public.reserve_client_sms_delivery($1,$2) r',[id(13),aa])).rows[0].r).toBe('reserved');let done=false;
  const competing=second.query('select public.reserve_client_sms_delivery($1,$2) r',[id(14),bb]).finally(()=>{done=true;});await new Promise(r=>setTimeout(r,200));expect(done).toBe(false);await first.query('commit');expect((await competing).rows[0].r).toBe('busy');await second.query('commit');
  expect((await admin.query("select public.finish_client_sms_delivery($1,$2,'accepted') r",[id(13),aa])).rows[0].r).toBe(true);
  const h=(await admin.query('select public.read_client_sms_history($1,null) h',[id(14)])).rows[0].h;expect(h.lastContactAt).toBeTruthy();
 });
 it('serializes separate invoices sharing the same email, regardless of casing',async()=>{
  const aa=id(15),bb=id(16);await first.query('begin');await second.query('begin');
  expect((await first.query("select public.reserve_reminder_delivery($1,'email','automatic',$2) r",[invoice,aa])).rows[0].r).toBe('reserved');let done=false;
  const competing=second.query("select public.reserve_reminder_delivery($1,'email','automatic',$2) r",[id(10),bb]).finally(()=>{done=true;});await new Promise(r=>setTimeout(r,200));expect(done).toBe(false);await first.query('commit');expect((await competing).rows[0].r).toBe('busy');await second.query('commit');
  expect((await admin.query("select public.finish_reminder_delivery($1,'email',$2,'unconfirmed') r",[invoice,aa])).rows[0].r).toBe(true);
  expect((await admin.query("select public.reserve_reminder_delivery($1,'email','automatic',$2) r",[id(10),bb])).rows[0].r).toBe('busy');
 });
});
