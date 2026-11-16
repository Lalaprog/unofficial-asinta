import {describe,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';

const m=vi.hoisted(()=>({create:vi.fn(),update:vi.fn(),admin:vi.fn()}));
vi.mock('@/lib/supabase/server',()=>({createServerSupabaseClient:()=>({})}));
vi.mock('@/lib/auth/serverRole',()=>({requireFounder:async()=>({ok:true,userId:'founder'})}));
vi.mock('@/lib/supabase/admin',()=>({createServiceRoleClient:m.admin,isServiceRoleConfigured:()=>true}));
vi.mock('@/lib/email/mailer',()=>({isSmtpConfigured:()=>false,sendEmail:vi.fn()}));
vi.mock('@/lib/users/admin',()=>({createTeamAccount:m.create,updateTeamAccount:m.update,deleteTeamAccount:vi.fn()}));
import {PATCH,POST} from '@/app/api/users/route';

describe('team account JSON input',()=>{
 it.each(['null','[]','42','"text"','{'])('rejects non-object or invalid input %s before account operations',async body=>{
  m.create.mockClear();m.update.mockClear();m.admin.mockClear();
  for(const [method,handler] of [['POST',POST],['PATCH',PATCH]] as const){
   const response=await handler(new NextRequest('http://localhost/api/users',{method,body}));
   expect(response.status).toBe(400);expect((await response.json()).error).toMatch(/Invalid JSON/);
  }
  expect(m.create).not.toHaveBeenCalled();expect(m.update).not.toHaveBeenCalled();expect(m.admin).not.toHaveBeenCalled();
 });
});
