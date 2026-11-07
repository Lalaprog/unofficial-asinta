import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const c=id(1),other=id(2),i=id(3),i2=id(4),otherI=id(5),founder=id(6),a=id(7),b=id(8),d=id(9),e=id(10);
async function setup(){const db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;create schema app_private;
  create function app_private.lock_founder_guard() returns void language sql as $$ select $$;
  create table users(id uuid primary key,role text);insert into users values('${founder}','founder');
  create table clients(id uuid primary key,name text,email text,phone text);insert into clients values('${c}','Client','one@example.test','09171234567'),('${other}','Other','other@example.test','09171234568');
  create table invoices(id uuid primary key,client_id uuid,invoice_number text);insert into invoices values('${i}','${c}','INV-1'),('${i2}','${c}','INV-2'),('${otherI}','${other}','INV-3');
  create table email_logs(id uuid primary key default gen_random_uuid(),invoice_id uuid,status text,sent_at timestamptz,created_at timestamptz default now(),recipient text);
  create table sms_logs(id uuid primary key default gen_random_uuid(),invoice_id uuid,status text,simulated boolean,sent_at timestamptz,updated_at timestamptz,phone text);
  create table reminder_dispatches(id uuid primary key default gen_random_uuid(),invoice_id uuid,channel text,status text,sent_at timestamptz,created_at timestamptz default now());`);
 for(const f of ['20261107000005_reminder_delivery_coordination.sql','20261107000008_staged_reminder_slot_claims.sql','reminder_log_correlation.sql','20261107000009_staged_reminder_review.sql','20261107000010_staged_reminder_history.sql','20261107000011_staged_reminder_client_sms.sql','20261107000012_staged_reminder_review_list.sql'])await db.exec(readFileSync('supabase/staged/'+f,'utf8'));return db;}
async function call<T>(db:PGlite,name:string,values:unknown[]){return (await db.query<{v:T}>(`select public.${name}(${values.map((_,x)=>`$${x+1}`).join(',')}) v`,values)).rows[0].v;}
const reserve=(db:PGlite,inv:string,attempt:string)=>call<string>(db,'reserve_reminder_delivery',[inv,'sms','automatic',attempt]);
const clientReserve=(db:PGlite,client:string,attempt:string)=>call<string>(db,'reserve_client_sms_delivery',[client,attempt]);
const clientFinish=(db:PGlite,client:string,attempt:string,outcome:string)=>call<boolean>(db,'finish_client_sms_delivery',[client,attempt,outcome]);
const history=(db:PGlite,inv:string,own:string|null=null)=>call<{lastContactAt:string|null;unresolvedAttempt:boolean}>(db,'read_reminder_contact_history',[inv,'sms',own]);
describe('staged client-wide SMS coordination',()=>{
 it('serializes client-only and invoice sends while leaving other clients and email independent',async()=>{const db=await setup();try {
  expect(await clientReserve(db,c,a)).toBe('reserved');expect(await reserve(db,i,b)).toBe('busy');expect(await reserve(db,i2,b)).toBe('busy');
  expect(await reserve(db,otherI,b)).toBe('reserved');expect(await call(db,'reserve_reminder_delivery',[i,'email','manual',d])).toBe('reserved');
  expect(await clientFinish(db,c,a,'unconfirmed')).toBe(true);expect(await clientReserve(db,c,e)).toBe('busy');
  expect(await call(db,'review_client_sms_delivery',[founder,c,a,'accepted','Provider confirmed the exact message.',true])).toBe(true);
  expect(await reserve(db,i,e)).toBe('reserved');expect(await clientReserve(db,c,d)).toBe('busy');
  expect(await call(db,'finish_reminder_delivery',[i,'sms',e,'cancelled'])).toBe(true);
  expect(await clientReserve(db,c,a)).toBe('duplicate');
 } finally{await db.close();}});
 it('coordinates shared destinations across clients and invoices without merging email and SMS',async()=>{const db=await setup();try {
  await db.query("update clients set phone='+63 (917) 123-4567',email='ONE@example.test' where id=$1",[other]);
  expect(await reserve(db,i,a)).toBe('reserved');expect(await clientReserve(db,other,b)).toBe('busy');
  expect(await call(db,'reserve_reminder_delivery',[i,'email','manual',d])).toBe('reserved');expect(await call(db,'reserve_reminder_delivery',[otherI,'email','manual',e])).toBe('busy');
  expect(await call(db,'reminder_recipient_matches',[a,'sms','639171234567'])).toBe(true);expect(await call(db,'reminder_recipient_matches',[d,'email','One@example.test'])).toBe(true);
  expect(await call(db,'finish_reminder_delivery',[i,'sms',a,'unconfirmed'])).toBe(true);expect(await clientReserve(db,other,b)).toBe('busy');
  expect(await call(db,'review_reminder_delivery',[founder,i,'sms',a,'accepted','Provider accepted the recorded message.',true])).toBe(true);
  const h=await history(db,otherI);expect(h.unresolvedAttempt).toBe(false);expect(h.lastContactAt).toBeTruthy();
  expect(await call(db,'finish_reminder_delivery',[i,'email',d,'accepted'])).toBe(true);
  const eh=await call<{lastContactAt:string|null;unresolvedAttempt:boolean}>(db,'read_reminder_contact_history',[otherI,'email',null]);expect(eh.lastContactAt).toBeTruthy();
 }finally{await db.close();}});
 it('detects changed destinations and rejects invalid formats',async()=>{const db=await setup();try {
  expect(await reserve(db,i,a)).toBe('reserved');expect(await call(db,'reminder_recipient_matches',[a,'sms','09171234568'])).toBe(false);
  await db.query("update clients set phone='09171234568' where id=$1",[c]);expect(await call(db,'reminder_recipient_matches',[a,'sms','09171234567'])).toBe(false);
  expect(await call(db,'finish_reminder_delivery',[i,'sms',a,'cancelled'])).toBe(true);
  await db.query("update clients set email='bad@example' where id=$1",[c]);expect(await call(db,'reserve_reminder_delivery',[i,'email','manual',b])).toBe('invalid');
  await db.exec('set role service_role');await expect(call(db,'reserve_reminder_client_internal',[i,'sms','automatic',d])).rejects.toThrow(/permission denied/i);await expect(db.query('select * from public.reminder_recipient_locks')).rejects.toThrow(/permission denied/i);
 }finally{await db.close();}});
 it('includes legacy records for shared destinations and blocks unknown destinations conservatively',async()=>{const db=await setup();try {
  await db.query("update clients set phone='639171234567',email='one@example.test' where id=$1",[other]);
  await db.query("insert into email_logs(invoice_id,status,recipient,sent_at) values($1,'accepted','ONE@example.test',now())",[otherI]);
  expect((await call<{lastContactAt:string}>(db,'read_reminder_contact_history',[i,'email',null])).lastContactAt).toBeTruthy();
  await db.query("insert into sms_logs(invoice_id,status,phone,simulated,sent_at) values($1,'pending','+639171234567',false,now())",[otherI]);expect((await history(db,i)).unresolvedAttempt).toBe(true);
  await db.query("update sms_logs set status='sent',sent_at=now() where invoice_id=$1",[otherI]);expect((await history(db,i)).lastContactAt).toBeTruthy();
  await db.query("insert into email_logs(invoice_id,status,recipient) values($1,'failed',null)",[otherI]);expect((await call<{unresolvedAttempt:boolean}>(db,'read_reminder_contact_history',[i,'email',null])).unresolvedAttempt).toBe(true);
 }finally{await db.close();}});
 it('requires proper permissions and reviews both client and invoice locks together',async()=>{const db=await setup();try {
  await db.exec('set role authenticated');await expect(clientReserve(db,c,a)).rejects.toThrow(/permission denied/i);await db.exec('reset role;set role service_role');
  await expect(call(db,'reserve_reminder_invoice_internal',[i,'sms','manual',a])).rejects.toThrow(/permission denied/i);
  expect(await reserve(db,i,a)).toBe('reserved');expect(await call(db,'finish_reminder_delivery',[i,'sms',a,'unconfirmed'])).toBe(true);
  expect(await call(db,'review_reminder_delivery',[founder,i,'sms',a,'rejected','Provider confirmed no acceptance.',false])).toBe(false);
  expect(await clientReserve(db,c,b)).toBe('busy');expect(await call(db,'review_reminder_delivery',[founder,i,'sms',a,'rejected','Provider confirmed no acceptance.',true])).toBe(true);
  expect(await clientReserve(db,c,b)).toBe('reserved');
 }finally{await db.close();}});
 it('includes client-only history, other invoices and conservatively handles unlinked legacy rows',async()=>{const db=await setup();try {
  expect(await clientReserve(db,c,a)).toBe('reserved');await db.query("insert into sms_logs(invoice_id,client_id,reminder_attempt_id,status,simulated,sent_at,phone) values(null,$1,$2,'pending',false,now(),'09171234567')",[c,a]);
  expect((await history(db,i)).unresolvedAttempt).toBe(true);expect((await history(db,i,a)).unresolvedAttempt).toBe(false);
  expect(await clientFinish(db,c,a,'unconfirmed')).toBe(true);expect((await history(db,i,a)).unresolvedAttempt).toBe(true);
  expect(await call(db,'review_client_sms_delivery',[founder,c,a,'accepted','Provider accepted this particular message.',true])).toBe(true);
  expect((await history(db,i)).unresolvedAttempt).toBe(false);expect((await history(db,i)).lastContactAt).toBeTruthy();
  await db.query("insert into sms_logs(invoice_id,status,simulated,sent_at,phone) values($1,'failed',false,now(),'09171234567')",[i2]);expect((await history(db,i)).unresolvedAttempt).toBe(true);
  expect((await history(db,otherI)).unresolvedAttempt).toBe(false);
  await db.query("insert into sms_logs(invoice_id,status,simulated,sent_at) values(null,'pending',false,now())");expect((await history(db,otherI)).unresolvedAttempt).toBe(true);
 }finally{await db.close();}});
 it('lists only active coordinated attempts for a Founder',async()=>{const db=await setup();try {
  expect(await clientReserve(db,c,a)).toBe('reserved');expect(await reserve(db,otherI,b)).toBe('reserved');
  const rows=await call<{attempts:Array<{attemptId:string;invoiceNumber:string|null;clientName:string}>;hasMore:boolean}>(db,'list_reminder_delivery_reviews_needed',[founder]);
  expect(rows.hasMore).toBe(false);expect(rows.attempts).toHaveLength(2);expect(rows.attempts).toContainEqual(expect.objectContaining({attemptId:a,invoiceNumber:null,clientName:'Client'}));expect(rows.attempts).toContainEqual(expect.objectContaining({attemptId:b,invoiceNumber:'INV-3',clientName:'Other'}));
  expect(await call(db,'list_reminder_delivery_reviews_needed',[id(99)])).toBeNull();await db.exec('set role authenticated');await expect(call(db,'list_reminder_delivery_reviews_needed',[founder])).rejects.toThrow(/permission denied/i);
 }finally{await db.close();}});

 it('reviews legacy ambiguity without altering the original rows, and invalidates reviews when status changes',async()=>{const db=await setup();try{
  await db.query("insert into sms_logs(id,invoice_id,status,simulated,sent_at) values($1,null,'pending',false,now())",[a]);
  expect((await history(db,i)).unresolvedAttempt).toBe(true);expect((await history(db,otherI)).unresolvedAttempt).toBe(true);
  expect(await call(db,'list_legacy_reminder_reviews_needed',[founder])).toMatchObject({records:[{kind:'sms_log',recordId:a}],hasMore:false});
  const review=(actor:string,note:string,confirmed:boolean)=>call<boolean>(db,'review_legacy_reminder_record',[actor,'sms_log',a,'accepted',note,confirmed]);
  expect(await review(id(99),'Provider confirmed the message.',true)).toBe(false);expect(await review(founder,'short',true)).toBe(false);expect(await review(founder,'Provider confirmed the message.',false)).toBe(false);
  expect(await review(founder,'Provider confirmed the message.',true)).toBe(true);expect(await review(founder,'Provider confirmed the message.',true)).toBe(false);
  expect((await history(db,i)).unresolvedAttempt).toBe(false);expect((await history(db,otherI)).unresolvedAttempt).toBe(false);expect((await history(db,i)).lastContactAt).toBeTruthy();
  expect(await call(db,'list_legacy_reminder_reviews_needed',[founder])).toMatchObject({records:[]});
  expect((await db.query('select status from sms_logs where id=$1',[a])).rows).toEqual([{status:'pending'}]);
  await db.query("update sms_logs set status='failed' where id=$1",[a]);expect((await history(db,i)).unresolvedAttempt).toBe(true);
  expect(await call(db,'review_legacy_reminder_record',[founder,'sms_log',a,'rejected','Provider confirmed the updated status.',true])).toBe(true);expect((await history(db,i)).unresolvedAttempt).toBe(false);
  expect((await db.query('select count(*)::int n from reminder_legacy_reviews where record_id=$1',[a])).rows[0]).toEqual({n:2});
 }finally{await db.close();}});

 it('releases a slot only when cancellation is known to precede provider I/O',async()=>{const db=await setup();try{
  expect(await reserve(db,i,a)).toBe('reserved');expect(await call(db,'claim_automatic_reminder_slot',[i,'sms',a,'2026-11-02','due_today'])).toBe('claimed');
  expect(await call(db,'finish_reminder_delivery',[i,'sms',a,'cancelled'])).toBe(true);expect((await db.query('select * from reminder_delivery_slots')).rows).toHaveLength(0);
  expect(await reserve(db,i,b)).toBe('reserved');expect(await call(db,'claim_automatic_reminder_slot',[i,'sms',b,'2026-11-02','due_today'])).toBe('claimed');
  expect(await call(db,'finish_reminder_delivery',[i,'sms',b,'rejected'])).toBe(true);expect((await db.query('select * from reminder_delivery_slots')).rows).toHaveLength(1);
  expect(await reserve(db,i,d)).toBe('reserved');expect(await call(db,'claim_automatic_reminder_slot',[i,'sms',d,'2026-11-02','due_today'])).toBe('duplicate');
 }finally{await db.close();}});

 it('will not downgrade a recorded acceptance even when its timestamp is missing',async()=>{const db=await setup();try{
  await db.query("insert into email_logs(id,invoice_id,status,sent_at) values($1,$2,'accepted',null)",[a,i]);
  const readEmail=()=>call<{unresolvedAttempt:boolean;lastContactAt:string|null}>(db,'read_reminder_contact_history',[i,'email',null]);expect((await readEmail()).unresolvedAttempt).toBe(true);
  expect(await call(db,'review_legacy_reminder_record',[founder,'email_log',a,'rejected','Provider confirmed rejection of message.',true])).toBe(false);
  expect(await call(db,'review_legacy_reminder_record',[founder,'email_log',a,'accepted','Provider confirmed the exact message.',true])).toBe(true);
  expect((await readEmail()).unresolvedAttempt).toBe(false);expect((await readEmail()).lastContactAt).toBeTruthy();
 }finally{await db.close();}});

});
