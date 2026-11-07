import { afterEach,describe,expect,it,vi } from 'vitest';
import { NextRequest } from 'next/server';
const m=vi.hoisted(()=>({send:vi.fn()}));
vi.mock('@/lib/supabase/server',()=>({createServerSupabaseClient:()=>({})}));
vi.mock('@/lib/auth/serverRole',()=>({requireFounder:async()=>({ok:true,userId:'founder'})}));
vi.mock('@/lib/api/rateLimitGuard',()=>({enforceRateLimit:()=>null}));
vi.mock('@/lib/email/mailer',()=>({getFirmEmailIdentity:()=>({}),isSmtpConfigured:()=>true,sendEmail:vi.fn()}));
vi.mock('@/lib/email/service',()=>({sendRequestForPayment:m.send}));
import { POST } from '@/app/api/email/request-payment/route';
afterEach(()=>{vi.unstubAllEnvs();m.send.mockReset();});
describe('original manual request-for-payment route',()=>{
 it('uses the original sender and preserves the one-time message edits',async()=>{
  vi.stubEnv('REMINDER_COORDINATION_ENABLED','true');
  m.send.mockResolvedValue({ok:true,status:'accepted',logId:'log'});
  const request=new NextRequest('http://localhost/api/email/request-payment',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({invoiceId:'invoice',subjectTemplate:'edited subject',bodyTemplate:'edited body',idempotencyKey:'unique-id',previewFingerprint:'preview'})});
  expect((await POST(request)).status).toBe(200);
  expect(m.send).toHaveBeenCalledWith(expect.any(Object),expect.objectContaining({invoiceId:'invoice',subjectTemplate:'edited subject',bodyTemplate:'edited body',idempotencyKey:'unique-id',previewFingerprint:'preview'}));
  expect(m.send.mock.calls[0][1]).not.toHaveProperty('reminderAttemptId');
 });
});
