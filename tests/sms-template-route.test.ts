import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createFakeDb, type FakeDb } from './helpers/fakeDb';
const mocks=vi.hoisted(()=>({db: {} as unknown, founder: true}));
vi.mock('@/lib/supabase/server',()=>({createServerSupabaseClient:()=>mocks.db}));
vi.mock('@/lib/auth/serverRole',()=>({requireFounder:async()=>mocks.founder?{ok:true,userId:'founder'}:{ok:false,status:403,error:'Forbidden'}}));
import { GET, PUT } from '@/app/api/sms/template/route';
const req=(body:unknown)=>new NextRequest('http://localhost/api/sms/template',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
let db:FakeDb;
beforeEach(()=>{db=createFakeDb({sms_template_settings:[]});mocks.db=db;mocks.founder=true;});
describe('SMS template endpoint',()=>{
 it('is Founder-only and defaults without writing a row',async()=>{mocks.founder=false;expect((await GET()).status).toBe(403);expect((await PUT(req({template:'Hi',revision:0}))).status).toBe(403);expect(db.tables.sms_template_settings).toHaveLength(0);mocks.founder=true;const response=await GET();expect(response.status).toBe(200);expect((await response.json()).revision).toBe(0);expect(db.tables.sms_template_settings).toHaveLength(0);});
 it('saves and conditionally updates without overwriting a newer version',async()=>{expect((await PUT(req({template:'Hello {{invoice_number}}',revision:0}))).status).toBe(200);let result=await GET();expect((await result.json()).template).toBe('Hello {{invoice_number}}');expect((await PUT(req({template:'Updated',revision:1}))).status).toBe(200);expect((await PUT(req({template:'Old',revision:1}))).status).toBe(409);expect(db.tables.sms_template_settings[0].message_template).toBe('Updated');});
 it('rejects invalid fields and handles read failure without substituting a default',async()=>{expect((await PUT(req({template:'{{unknown}}',revision:0}))).status).toBe(422);expect(db.tables.sms_template_settings).toHaveLength(0);mocks.db={from:()=>{throw Error('offline')}};expect((await GET()).status).toBe(503);});
});
