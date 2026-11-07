import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createFakeDb, type FakeDb } from './helpers/fakeDb';
const mock=vi.hoisted(()=>({db:{} as any,founder:true}));
vi.mock('@/lib/supabase/server',()=>({createServerSupabaseClient:()=>mock.db}));
vi.mock('@/lib/auth/serverRole',()=>({requireFounder:async()=>mock.founder?{ok:true,userId:'founder'}:{ok:false,status:403,error:'Forbidden'}}));
import { GET, PUT } from '@/app/api/email/templates/route';
const get = () => new NextRequest('http://localhost/api/email/templates?type=initial_request');
const put = (extra:Record<string,unknown> = {}) => new NextRequest('http://localhost/api/email/templates',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({template_type:'initial_request',subject_template:'Updated',body_template:'Updated message',...extra})});
let db: FakeDb;
beforeEach(()=>{db=createFakeDb({email_templates:[{id:'template',template_type:'initial_request',subject_template:'Saved subject',body_template:'Saved body',version:2,active:true}]});mock.db=db;mock.founder=true;});
describe('initial email template safety',()=>{
  it('rejects unauthenticated roles and prevents caching of saved templates',async()=>{
    mock.founder=false;expect((await GET(get())).status).toBe(403);expect((await PUT(put())).status).toBe(403);
    mock.founder=true;const result=await GET(get());expect(result.status).toBe(200);expect(result.headers.get('cache-control')).toContain('no-store');
    expect((await result.json()).template.subject_template).toBe('Saved subject');
  });
  it('returns an error rather than a default when reading the saved template fails',async()=>{
    const from=db.from;db.from=(table:string)=>{const query=from(table);if(table==='email_templates')query.maybeSingle=async()=>({data:null,error:{message:'offline'}});return query;};
    expect((await GET(get())).status).toBe(503);expect((await PUT(put())).status).toBe(503);
    expect(db.tables.email_templates[0]).toMatchObject({subject_template:'Saved subject',version:2});
  });
  it('returns a default only after a successful empty read',async()=>{
    db.tables.email_templates.length=0;const response=await GET(get());expect(response.status).toBe(200);
    const body=await response.json();expect(body.isSystemDefault).toBe(true);expect(body.template.version).toBe(1);
  });
  it('protects newer editors against stale rows and stale unsaved defaults',async()=>{
    expect((await PUT(put({expectedVersion:1,expectedTemplateId:'template'}))).status).toBe(409);
    expect((await PUT(put({expectedVersion:1,expectedTemplateId:null}))).status).toBe(409);
    expect((await PUT(put({expectedVersion:2,expectedTemplateId:'other'}))).status).toBe(409);
    expect(db.tables.email_templates[0]).toMatchObject({subject_template:'Saved subject',version:2});
    expect((await PUT(put({expectedVersion:2,expectedTemplateId:'template'}))).status).toBe(200);
    expect(db.tables.email_templates[0]).toMatchObject({subject_template:'Updated',version:3});
  });
  it('allows an editor to create a row from an unsaved default only if no row exists',async()=>{
    db.tables.email_templates.length=0;
    expect((await PUT(put({expectedVersion:1,expectedTemplateId:null}))).status).toBe(200);
    expect(db.tables.email_templates).toHaveLength(1);
    expect((await PUT(put({expectedVersion:1,expectedTemplateId:null}))).status).toBe(409);
  });
  it('does not overwrite a concurrent save made between its read and update',async()=>{
    const from=db.from;db.from=(table:string)=>{const query=from(table);if(table==='email_templates'){
      const maybeSingle=query.maybeSingle;query.maybeSingle=async()=>{const result=await maybeSingle();return {...result,data:result.data && {...result.data}};};
      const update=query.update;query.update=(patch:any)=>{db.tables.email_templates[0].version=3;db.tables.email_templates[0].subject_template='Other save';return update(patch);};
    }return query;};
    const response=await PUT(put());expect(response.status).toBe(409);
    expect(db.tables.email_templates[0]).toMatchObject({subject_template:'Other save',version:3});
  });
  it('reports an unconfirmed save when the final version response is malformed',async()=>{
    const from=db.from;db.from=(table:string)=>{const query=from(table);if(table==='email_templates'){
      const update=query.update;query.update=(patch:any)=>{update(patch);const maybeSingle=query.maybeSingle;query.maybeSingle=async()=>{await maybeSingle();return {data:{version:null},error:null};};return query;};
    }return query;};
    expect((await PUT(put())).status).toBe(503);
    expect(db.tables.email_templates[0]).toMatchObject({subject_template:'Updated',version:3});
  });
  it('fails closed if stored template details are malformed',async()=>{
    db.tables.email_templates[0].version=null;expect((await GET(get())).status).toBe(503);expect((await PUT(put())).status).toBe(503);
  });
});
