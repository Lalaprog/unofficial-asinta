import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mock=vi.hoisted(()=>({read:vi.fn(),founder:vi.fn()}));
vi.mock('@/lib/supabase/server',()=>({createServerSupabaseClient:()=>({})}));
vi.mock('@/lib/auth/serverRole',()=>({requireFounder:()=>mock.founder()}));
vi.mock('@/lib/api/rateLimitGuard',()=>({enforceRateLimit:()=>null}));
vi.mock('@/lib/ai/draftData',()=>({loadDraftData:async()=>({context:{projects:[],vendorMemory:[],todayISO:'2026-11-03'},errors:[]})}));
vi.mock('@/lib/ai/receiptVision',async(importOriginal)=>({...await importOriginal<typeof import('@/lib/ai/receiptVision')>(),readReceiptImage:mock.read}));
import {POST} from '@/app/api/ai/receipt-draft/route';
const request=()=>new NextRequest('http://localhost/api/ai/receipt-draft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mediaType:'image/jpeg',base64:'YWJj'})});
beforeEach(()=>{mock.founder.mockResolvedValue({ok:true,userId:'f'});mock.read.mockReset()});
describe('receipt draft route',()=>{
  it('returns the concise editable excerpt separately from the complete reading',async()=>{const text='SHOP\nCEMENT\nTOTAL 300';mock.read.mockResolvedValue({ok:true,text,fields:{description:'CEMENT',amount:300,amount_quote:'TOTAL 300'},model:'mock'});const res=await POST(request());const data=await res.json();expect(res.status).toBe(200);expect(data.draft.description).toBe('CEMENT');expect(data.read.extractedText).toBe(text);expect(data.draft.amount).toBe(300);expect(res.headers.get('cache-control')).toBe('no-store');});
  it('does not promote raw OCR when no safe description was provided',async()=>{mock.read.mockResolvedValue({ok:true,text:'SHOP\nTOTAL 300',fields:{amount:null},model:'mock'});const data=await (await POST(request())).json();expect(data.draft.description).toBe('');expect(data.draft.amount).toBeNull();expect(data.read.extractedText).toBe('SHOP\nTOTAL 300');});
  it('denies non-founders before calling the model and reports read failures',async()=>{mock.founder.mockResolvedValueOnce({ok:false,error:'Forbidden',status:403});expect((await POST(request())).status).toBe(403);expect(mock.read).not.toHaveBeenCalled();mock.read.mockResolvedValue({ok:false,reason:'Cannot read'});expect((await POST(request())).status).toBe(502);});
  it('propagates only the confirmed wait on a provider rate limit',async()=>{
    mock.read.mockResolvedValue({ok:false,rateLimited:true,retryAfterSeconds:45,reason:'Try later'});const res=await POST(request());expect(res.status).toBe(429);expect(res.headers.get('retry-after')).toBe('45');expect(res.headers.get('cache-control')).toBe('no-store');expect(await res.json()).toMatchObject({manualEntryAvailable:true,rateLimited:true,retryAfterSeconds:45});
    mock.read.mockResolvedValue({ok:false,rateLimited:true,reason:'Try later'});const unknown=await POST(request());expect(unknown.status).toBe(429);expect((await unknown.json()).retryAfterSeconds).toBeUndefined();
  });

});
