import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it,vi} from 'vitest';
import {runOneReminder} from '@/lib/reminders/runOne';
const sql=(path:string)=>readFileSync(path,'utf8');
const invoice='00000000-0000-4000-8000-000000000001',client='00000000-0000-4000-8000-000000000002',project='00000000-0000-4000-8000-000000000003';
function adapter(db:PGlite){
  function from(table:string){let mode:'select'|'insert'|'update'='select',columns='*',data:Record<string,unknown>={},predicates:string[]=[],args:unknown[]=[],order='',lim='';
    const api:any={select:(c:string)=>{columns=c;return api;},eq:(k:string,v:unknown)=>{args.push(v);predicates.push(`${k}=$${args.length}`);return api;},in:(k:string,v:unknown[])=>{args.push(v);predicates.push(`${k}=any($${args.length})`);return api;},order:(k:string,opts:{ascending:boolean})=>{order=` order by ${k} ${opts.ascending?'asc':'desc'}`;return api;},limit:(n:number)=>{lim=` limit ${n}`;return api;},insert:(v:Record<string,unknown>)=>{mode='insert';data=v;return api;},update:(v:Record<string,unknown>)=>{mode='update';data=v;return api;}};
    const execute=async()=>{try {let query:string,values:unknown[];
      if(mode==='insert'){values=Object.values(data);query=`insert into ${table} (${Object.keys(data).join(',')}) values (${values.map((_,i)=>`$${i+1}`).join(',')}) returning ${columns}`;}
      else if(mode==='update'){const updates=Object.entries(data);values=[...args,...updates.map(([,v])=>v)];query=`update ${table} set ${updates.map(([k],i)=>`${k}=$${args.length+i+1}`).join(',')} ${predicates.length?'where '+predicates.join(' and '):''} returning ${columns}`;}
      else {values=args;query=`select ${columns} from ${table} ${predicates.length?'where '+predicates.join(' and '):''}${order}${lim}`;}
      const result=await db.query(query,values);const row=result.rows[0];const json=row?Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value instanceof Date?(key==='due_date'||key==='issue_date'?value.toISOString().slice(0,10):value.toISOString()):value])):null;return {data:json,error:null};
    } catch(error){return {data:null,error};}};
    api.maybeSingle=execute;api.single=execute;return api;
  }
  const rpc=async(name:string,args:Record<string,unknown>)=>{try {const values=Object.values(args);const result=await db.query<{value:unknown}>(`select public.${name}(${values.map((_,i)=>`$${i+1}`).join(',')}) value`,values);return {data:result.rows[0].value,error:null};} catch(error){return {data:null,error};}};
  return {from,rpc};
}
describe('staged dispatcher against a disposable PostgreSQL database',()=>{
  it('coordinates real SQL reservations, claims and logs for both channels using mocked providers',async()=>{
    const pg=new PGlite();try {
      await pg.exec(`create role anon;create role authenticated;create role service_role;create schema app_private;create function app_private.lock_founder_guard() returns void language sql as $$ select $$;create table public.users(id uuid primary key,role text);
        create table public.clients(id uuid primary key,name text,contact_person text,email text,phone text);
        create table public.projects(id uuid primary key,name text);
        create table public.invoices(id uuid primary key,invoice_number text,client_id uuid,project_id uuid,amount numeric,amount_paid numeric,issue_date date,due_date date,status text,notes text,automatic_reminders_enabled boolean,reminders_paused_until timestamptz);
        create table public.email_templates(template_type text,subject_template text,body_template text,version int,active boolean);
        create table public.sms_template_settings(singleton boolean,message_template text);
        create table public.email_logs(id uuid primary key default gen_random_uuid(),invoice_id uuid,recipient text,subject text,body_text text,body_html text,template_type text,template_version int,status text,sent_by uuid,idempotency_key text unique,provider_message_id text,error_message text,sent_at timestamptz);
        create table public.sms_logs(id uuid primary key default gen_random_uuid(),invoice_id uuid,recipient text,phone text,message text,status text,simulated boolean,provider_status text,provider_message_id text,error_message text,sent_at timestamptz default now(),updated_at timestamptz);
        create table public.reminder_dispatches(id uuid primary key default gen_random_uuid(),invoice_id uuid,channel text,status text,sent_at timestamptz);
        create table public.reminder_settings(singleton boolean,master_enabled boolean,email_enabled boolean,sms_enabled boolean,revision int,email_effective_since timestamptz,sms_effective_since timestamptz);
        insert into clients values ('${client}','Client Co','Ana','ana@example.test','09171234567');insert into projects values ('${project}','Office');
        insert into invoices values ('${invoice}','I-001','${client}','${project}',1000,250,'2026-10-01','2026-11-02','pending',null,true,null);
        insert into reminder_settings values (true,true,true,true,1,'2026-10-01','2026-10-01');`);
      await pg.exec(sql('supabase/staged/20261107000005_reminder_delivery_coordination.sql'));
      await pg.exec(sql('supabase/staged/20261107000006_reminder_invoice_epochs.sql'));
      await pg.exec("alter table invoices disable trigger invoice_reminder_epochs;update invoices set reminder_invoice_effective_since='2026-10-01',reminder_schedule_effective_since='2026-10-01';alter table invoices enable trigger invoice_reminder_epochs;");
      await pg.exec(sql('supabase/staged/20261107000008_staged_reminder_slot_claims.sql'));
      await pg.exec(sql('supabase/staged/reminder_log_correlation.sql'));
      await pg.exec(sql('supabase/staged/20261107000009_staged_reminder_review.sql'));
      await pg.exec(sql('supabase/staged/20261107000010_staged_reminder_history.sql'));
      await pg.exec(sql('supabase/staged/20261107000011_staged_reminder_client_sms.sql'));
      const db=adapter(pg),sendEmail=vi.fn(async()=>({accepted:true,providerMessageId:'email-provider'})),sendSms=vi.fn(async()=>({success:true,messageId:'sms-provider'}));
      const run=(channel:'email'|'sms',attemptId:string)=>runOneReminder({db,invoiceId:invoice,channel,attemptId,now:()=>new Date('2026-11-02T01:00:00Z'),automationAllowed:()=>true,providerReady:()=>true,firmEmail:'office@example.test',firmContactNumber:'123',sendEmail,sendSms});
      const email=await run('email','10000000-0000-4000-8000-000000000001');expect(email.outcome).toBe('accepted');
      const sms=await run('sms','10000000-0000-4000-8000-000000000002');expect(sms.outcome).toBe('accepted');
      expect(sendEmail).toHaveBeenCalledOnce();expect(sendSms).toHaveBeenCalledOnce();
      expect((await pg.query('select channel,state from reminder_delivery_attempts order by channel')).rows).toEqual([{channel:'email',state:'accepted'},{channel:'sms',state:'accepted'}]);
      expect((await pg.query('select channel,scheduled_date::text from reminder_delivery_slots order by channel')).rows).toEqual([{channel:'email',scheduled_date:'2026-11-02'},{channel:'sms',scheduled_date:'2026-11-02'}]);
      expect((await pg.query('select status from email_logs')).rows).toEqual([{status:'accepted'}]);expect((await pg.query('select status from sms_logs')).rows).toEqual([{status:'sent'}]);
    } finally {await pg.close();}
  });
});
