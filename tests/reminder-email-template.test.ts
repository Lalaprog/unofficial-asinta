import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createFakeDb, type FakeDb } from './helpers/fakeDb';
import { DEFAULT_REMINDER_BODY, DEFAULT_REMINDER_SUBJECT, renderEmail, SAMPLE_TEMPLATE_DATA, validateReminderEmailTemplate } from '@/lib/email/templates';
const mocks=vi.hoisted(()=>({db:{} as unknown,founder:true}));
vi.mock('@/lib/supabase/server',()=>({createServerSupabaseClient:()=>mocks.db}));
vi.mock('@/lib/auth/serverRole',()=>({requireFounder:async()=>mocks.founder?{ok:true,userId:'founder'}:{ok:false,status:403,error:'Forbidden'}}));
import { GET, PUT } from '@/app/api/email/reminder-template/route';
const req=(body:unknown)=>new NextRequest('http://localhost/api/email/reminder-template',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
let db:FakeDb;
beforeEach(()=>{db=createFakeDb({email_templates:[{template_type:'initial_request',subject_template:'Untouched',body_template:'Initial',version:5}]});mocks.db=db;mocks.founder=true;});
describe('reminder email template',()=>{
 it('is Founder-only and previews neutral default data without any delivery',async()=>{
  mocks.founder=false;expect((await GET()).status).toBe(403);expect((await PUT(req({version:0}))).status).toBe(403);
  mocks.founder=true;const res=await GET();const data=await res.json();expect(data.template.version).toBe(0);expect(db.tables.email_templates).toHaveLength(1);
  const rendered=renderEmail(data.template.subject_template,data.template.body_template,SAMPLE_TEMPLATE_DATA);
  expect(rendered.subject).toContain('ASINTA-2026-001');expect(rendered.bodyText).toContain('Outstanding Balance');expect(rendered.bodyText).not.toMatch(/overdue|previously sent/i);
 });
 it('saves separately from initial request, checks revision and restores only the reminder',async()=>{
  const one=await PUT(req({version:0,subject_template:'Reminder {{invoice_number}}',body_template:'Balance {{outstanding_balance}}'}));expect(one.status).toBe(200);
  expect(db.tables.email_templates[0].subject_template).toBe('Untouched');expect(db.tables.email_templates[1].version).toBe(1);
  expect((await PUT(req({version:0,subject_template:'Concurrent',body_template:'Body'}))).status).toBe(409);
  expect((await PUT(req({version:1,subject_template:'New',body_template:'Body'}))).status).toBe(200);
  expect((await PUT(req({version:1,subject_template:'Stale',body_template:'Body'}))).status).toBe(409);
  expect((await PUT(req({version:2,restore_default:true}))).status).toBe(200);
  expect(db.tables.email_templates[1]).toMatchObject({subject_template:DEFAULT_REMINDER_SUBJECT,body_template:DEFAULT_REMINDER_BODY,version:3});
 });
 it('rejects unknown, malformed, empty, oversized or multiline subjects',async()=>{
  for(const [subject,body] of [['{{unknown}}','body'],['hello {{due_date','body'],['hello',''],['line\nbreak','body'],['x'.repeat(501),'body']]) {
    expect(validateReminderEmailTemplate(subject,body).valid).toBe(false);
    expect((await PUT(req({version:0,subject_template:subject,body_template:body}))).status).toBe(422);
  }
  expect(db.tables.email_templates).toHaveLength(1);
 });
 it('does not silently show a default if the saved data cannot be read',async()=>{
  mocks.db={from:()=>{throw new Error('offline')}};expect((await GET()).status).toBe(503);
 });
});
