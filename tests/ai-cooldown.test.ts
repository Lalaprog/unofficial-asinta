import { describe, expect, it, vi, afterEach } from 'vitest';
import { parseRetryAfterHeader, validRetryAfter, formatRetryWait } from '@/lib/ai/cooldown';
import { readReceiptImage } from '@/lib/ai/receiptVision';
import { analyzeExpenseWithAI } from '@/lib/ai/groq';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('AI rate limit messages', () => {
  it('accepts only reasonable positive seconds and never shortens a duration', () => {
    expect(parseRetryAfterHeader(' 1.2 ')).toBe(2);
    for (const invalid of [null, '', '-2', '0', 'NaN', 'Infinity', 'Wed, 21 Oct 2015 07:28:00 GMT', '604801']) expect(parseRetryAfterHeader(invalid)).toBeUndefined();
    expect(validRetryAfter('30')).toBeUndefined();
    expect(formatRetryWait(61)).toBe('2 minutes');
    expect(formatRetryWait(7200)).toBe('2 hours');
  });
  it('returns a safe advisory retry time for a receipt without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ok:false,status:429,headers:new Headers({'Retry-After':'13'}),text:async()=>'private secret'});
    vi.stubGlobal('fetch', fetchMock); vi.spyOn(console,'warn').mockImplementation(()=>{});
    const reading = await readReceiptImage({mediaType:'image/jpeg',base64:'YWJj'}, {apiKey:'fake'});
    expect(reading).toMatchObject({ok:false,rateLimited:true,retryAfterSeconds:13});
    expect(JSON.stringify(reading)).not.toContain('private secret');expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('uses no invented cooldown when the header is absent or malformed', async () => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:429,headers:new Headers({'Retry-After':'-2'})}));vi.spyOn(console,'warn').mockImplementation(()=>{});
    expect(await readReceiptImage({mediaType:'image/jpeg',base64:'YWJj'},{apiKey:'fake'})).toMatchObject({ok:false,rateLimited:true,retryAfterSeconds:undefined});
  });
  it('keeps text rules usable and does not leak provider responses', async () => {
    vi.stubEnv('GROQ_API_KEY','fake');vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:429,headers:new Headers({'Retry-After':'25'}),text:async()=>'customer details'}));vi.spyOn(console,'warn').mockImplementation(()=>{});
    const result=await analyzeExpenseWithAI('cement for site');
    expect(result.source).toBe('rules');expect(result.degradedReason).toContain('25 seconds');expect(result.degradedReason).not.toContain('customer details');
  });
});
