import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ sendMail: vi.fn(), close: vi.fn() }));
vi.mock('nodemailer', () => ({default:{createTransport:()=>({sendMail:mock.sendMail,close:mock.close})}}));
import { sendEmail } from '@/lib/email/mailer';
const message={to:'a@example.test',subject:'Test',text:'Hello',html:'<p>Hello</p>'};
beforeEach(()=>{ for(const [key,value] of Object.entries({SMTP_HOST:'smtp.example.test',SMTP_PORT:'587',SMTP_USER:'u',SMTP_PASS:'p',EMAIL_FROM_ADDRESS:'firm@example.test'})) vi.stubEnv(key,value); });
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
describe('SMTP provider outcomes',()=>{
 it('reports accepted only when the server accepted a recipient',async()=>{
  mock.sendMail.mockResolvedValueOnce({messageId:'id',accepted:['a@example.test']});
  expect(await sendEmail(message)).toMatchObject({accepted:true,providerMessageId:'id'});
  mock.sendMail.mockResolvedValueOnce({messageId:'id',accepted:[]});
  expect(await sendEmail(message)).toMatchObject({accepted:false,uncertain:true});
 });
 it('treats timeouts as unconfirmed and explicit authentication rejection as failed',async()=>{
  mock.sendMail.mockRejectedValueOnce({code:'ETIMEDOUT'});
  expect(await sendEmail(message)).toMatchObject({accepted:false,uncertain:true});
  mock.sendMail.mockRejectedValueOnce({code:'EAUTH',responseCode:535});
  expect(await sendEmail(message)).toMatchObject({accepted:false,uncertain:false});
 });
});
