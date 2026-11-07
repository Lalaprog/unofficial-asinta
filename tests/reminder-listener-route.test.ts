import { beforeEach,afterEach,describe,expect,it,vi } from 'vitest';
import { NextRequest } from 'next/server';
const m=vi.hoisted(()=>({founder:vi.fn(),scan:vi.fn()}));
vi.mock('@/lib/supabase/server',()=>({createServerSupabaseClient:()=>({})}));
vi.mock('@/lib/auth/serverRole',()=>({requireFounder:m.founder}));
vi.mock('@/lib/reminders/runCoordinatedScan',()=>({runCoordinatedReminderScan:m.scan}));
import { POST } from '@/app/api/reminders/listen/route';
const request=(headers:Record<string,string>={'Content-Type':'application/json','X-BALE-Reminder-Listener':'1'})=>new NextRequest('http://localhost/api/reminders/listen',{method:'POST',headers,body:'{}'});
beforeEach(()=>{vi.stubEnv('REMINDER_LISTENER_ENABLED','true');m.founder.mockReset().mockResolvedValue({ok:true});m.scan.mockReset().mockResolvedValue({body:{ran:false},status:200});});
afterEach(()=>vi.unstubAllEnvs());
describe('open-session reminder listener endpoint',()=>{
 it('is off by default and does not scan',async()=>{vi.stubEnv('REMINDER_LISTENER_ENABLED','');expect(await (await POST(request())).json()).toMatchObject({ran:false,reason:'listener_disabled'});expect(m.scan).not.toHaveBeenCalled();});
 it('requires a same-site, non-simple request',async()=>{expect((await POST(request({}))).status).toBe(403);expect((await POST(request({'Content-Type':'application/json','X-BALE-Reminder-Listener':'1','Sec-Fetch-Site':'cross-site'}))).status).toBe(403);expect(m.founder).not.toHaveBeenCalled();expect(m.scan).not.toHaveBeenCalled();});
 it('refuses signed-out, supervisor and insufficient-assurance sessions',async()=>{for(const status of [401,403,503]){m.founder.mockResolvedValueOnce({ok:false,status,error:'refused'});expect((await POST(request())).status).toBe(status);}expect(m.scan).not.toHaveBeenCalled();});
 it('passes an authorized Founder request to the existing guarded scan',async()=>{m.scan.mockResolvedValue({body:{ran:true,scanned:1,outcomes:{accepted:1}},status:200});const response=await POST(request());expect(response.status).toBe(200);expect(await response.json()).toMatchObject({scanned:1});expect(m.scan).toHaveBeenCalledOnce();});
 it('does not fall back to the old sender on error',async()=>{m.scan.mockRejectedValue(Error('unavailable'));expect((await POST(request())).status).toBe(503);});
});
