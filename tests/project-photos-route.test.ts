import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const s = vi.hoisted(() => ({role:'founder', loggedIn:true, assurance:true, visible:true, dbError:false, storageError:false, ambiguousUpdate:false, serviceCalls:0, row:null as null | {project_id:string;object_path:string;version:string}, objects:new Map<string,{bytes:Uint8Array;mime:string}>(), deletes:[] as string[]}));
const project='11111111-1111-4111-8111-111111111111';
vi.mock('@/lib/auth/serverRole',()=>({requireFounder:async()=>s.loggedIn && s.role==='founder' && s.assurance?{ok:true,userId:'founder'}:{ok:false,status:403,error:'Forbidden'}}));
vi.mock('@/lib/auth/session-assurance',()=>({requireSessionAssurance:async()=>s.assurance?{ok:true}:{ok:false,status:403,error:'Verify your authenticator'}}));
vi.mock('@/lib/supabase/server',()=>({createServerSupabaseClient:()=>({
 auth:{getUser:async()=>({data:{user:s.loggedIn?{id:'user'}:null},error:null})},
 rpc:()=>({eq:()=>({maybeSingle:async()=>({data:s.visible?{id:project}:null,error:s.dbError?{message:'offline'}:null})})})
})}));
vi.mock('@/lib/supabase/admin',()=>({isServiceRoleConfigured:()=>true,createServiceRoleClient:()=>{s.serviceCalls++;return {
 from:()=>{
  let op='select', values:any, filters:Record<string,string>={};
  const api:any={select:()=>api,eq:(k:string,v:string)=>{filters[k]=v;return api},update:(v:any)=>{op='update';values=v;return api},delete:()=>{op='delete';return api},insert:async(v:any)=>{if(s.row)return {error:{code:'23505'}};s.row=v;return {error:null}},maybeSingle:async()=>{
   if(s.dbError)return {data:null,error:{message:'offline'}};
   if(!s.row || (filters.project_id && filters.project_id!==s.row.project_id) || (filters.version && filters.version!==s.row.version))return {data:null,error:null};
   if(op==='update'){s.row={...s.row,...values};return s.ambiguousUpdate?{data:null,error:{message:'timeout'}}:{data:{version:s.row!.version},error:null};}
   if(op==='delete'){const row=s.row;s.row=null;return {data:row,error:null};}
   return {data:{...s.row},error:null};
  }};return api;
 },storage:{from:()=>({upload:async(path:string,bytes:Uint8Array,options:{contentType:string})=>{if(s.storageError)return {error:{message:'offline'}};s.objects.set(path,{bytes,mime:options.contentType});return {error:null}},download:async(path:string)=>{const o=s.objects.get(path);return {data:o?new Blob([o.bytes as BlobPart],{type:o.mime}):null,error:o?null:{message:'missing'}}},remove:async(paths:string[])=>{s.deletes.push(...paths);paths.forEach(path=>s.objects.delete(path));return {error:null}}})}
}}}));
import { GET, PUT, DELETE } from '@/app/api/projects/[id]/photo/route';
const ctx={params:{id:project}};
const url=`http://localhost/api/projects/${project}/photo`;
const get=(suffix='')=>GET(new NextRequest(url+suffix),ctx);
function put(version:string, bytes=new Uint8Array([255,216,255,1,2]), type='image/jpeg') {
 const form=new FormData();form.set('version',version);form.set('photo',new File([bytes as BlobPart],'unsafe-filename.jpg',{type}));
 return PUT(new NextRequest(url,{method:'PUT',body:form}),ctx);
}
function remove(version:string){return DELETE(new NextRequest(url,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({version})}),ctx);}
beforeEach(()=>{s.role='founder';s.loggedIn=true;s.assurance=true;s.visible=true;s.dbError=false;s.storageError=false;s.ambiguousUpdate=false;s.serviceCalls=0;s.row=null;s.objects.clear();s.deletes=[];});
describe('private project photo route',()=>{
 it('checks authentication, assurance, assignment and Founder writes before touching service role',async()=>{
  s.loggedIn=false;expect((await get()).status).toBe(401);s.loggedIn=true;s.assurance=false;expect((await get()).status).toBe(403);
  s.assurance=true;s.visible=false;expect((await get()).status).toBe(404);s.visible=true;s.role='supervisor';expect((await put('')).status).toBe(403);
  expect(s.serviceCalls).toBe(0);
  expect((await get('?info=1')).status).toBe(200);expect(s.serviceCalls).toBe(1);
 });
 it('saves, serves privately, replaces, rejects stale edits and removes',async()=>{
  expect(await (await get('?info=1')).json()).toEqual({hasPhoto:false,version:null});
  const first=await put('');expect(first.status).toBe(200);const a=await first.json();const old=s.row!.object_path;
  const image=await get();expect(image.status).toBe(200);expect(image.headers.get('cache-control')).toBe('private, no-store');expect(image.headers.get('content-type')).toBe('image/jpeg');
  const second=await put(a.version);expect(second.status).toBe(200);const b=await second.json();expect(s.deletes).toContain(old);expect(s.objects.size).toBe(1);
  expect((await put(a.version)).status).toBe(409);expect((await remove(a.version)).status).toBe(409);expect(s.row!.version).toBe(b.version);
  expect((await remove(b.version)).status).toBe(200);expect(s.row).toBeNull();expect(s.objects.size).toBe(0);expect((await get()).status).toBe(404);
  const third=await put('');expect((await third.json()).version).not.toBe(a.version);
 });
 it('rejects fake image data and leaves possibly referenced new objects intact on ambiguous database writes',async()=>{
  expect((await put('',new Uint8Array([1,2,3]))).status).toBe(422);expect(s.objects.size).toBe(0);
  const initial=await (await put('')).json();s.ambiguousUpdate=true;
  expect((await put(initial.version)).status).toBe(503);expect(s.objects.has(s.row!.object_path)).toBe(true);expect(s.objects.size).toBe(2);
 });
});
