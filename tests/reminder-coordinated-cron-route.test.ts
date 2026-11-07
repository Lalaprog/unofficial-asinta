import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';import {NextRequest} from 'next/server';
const m=vi.hoisted(()=>({master:false,next:vi.fn(),run:vi.fn(),service:vi.fn()}));
vi.mock('@/lib/supabase/admin',()=>({isServiceRoleConfigured:()=>true,createServiceRoleClient:()=>{m.service();return {from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{master_enabled:m.master,email_enabled:true,sms_enabled:true,revision:1},error:null})})})}),rpc:m.next};}}));
vi.mock('@/lib/reminders/runOne',()=>({runOneReminder:m.run}));
vi.mock('@/lib/email/mailer',()=>({isSmtpConfigured:()=>true,sendEmail:vi.fn(),getFirmEmailIdentity:()=>({fromAddress:'office@example.test',firmContactNumber:'123'})}));
vi.mock('@/lib/sms/philsms',()=>({sendPhilSMS:vi.fn()}));
import {GET} from '@/app/api/cron/reminders/route';
const request=()=>new NextRequest('http://localhost/api/cron/reminders',{headers:{authorization:'Bearer secret'}});
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-02T01:00:00Z'));vi.stubEnv('CRON_SECRET','secret');vi.stubEnv('REMINDER_COORDINATION_ENABLED','true');vi.stubEnv('AUTOMATIC_REMINDERS_ENABLED','true');m.master=false;vi.clearAllMocks();});afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
describe('coordinated cron route',()=>{
 it('does not invoke a provider or scan while the Founder master is off',async()=>{const response=await GET(request());expect(response.status).toBe(200);expect(await response.json()).toMatchObject({ran:false,reason:'founder_reminders_disabled'});expect(m.next).not.toHaveBeenCalled();expect(m.run).not.toHaveBeenCalled();});
 it('never falls back to legacy delivery when a coordinated scan fails',async()=>{m.master=true;m.next.mockResolvedValue({data:null,error:{message:'missing'}});const response=await GET(request());expect(response.status).toBe(503);expect(await response.json()).toMatchObject({reason:'scan_unavailable'});expect(m.run).not.toHaveBeenCalled();});
 it('processes both channels through the coordinated dispatcher when all mocked gates are on',async()=>{m.master=true;m.next.mockResolvedValueOnce({data:'invoice',error:null}).mockResolvedValueOnce({data:null,error:null});m.run.mockResolvedValue({outcome:'accepted'});const response=await GET(request());expect(await response.json()).toMatchObject({scanned:1,outcomes:{accepted:2}});expect(m.run).toHaveBeenCalledTimes(2);expect(m.run.mock.calls.map(call=>call[0].channel)).toEqual(['email','sms']);});
 it('stops before creating an admin client outside Manila hours',async()=>{vi.setSystemTime(new Date('2026-11-01T01:00:00Z'));expect(await (await GET(request())).json()).toMatchObject({ran:false,reason:'outside_sending_hours'});expect(m.service).not.toHaveBeenCalled();});
});
