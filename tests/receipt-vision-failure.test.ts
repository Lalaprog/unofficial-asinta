import { afterEach, describe, expect, it, vi } from 'vitest';
import { readReceiptImage } from '@/lib/ai/receiptVision';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('receipt reader failures', () => {
  it.each([[429,'usage limit'],[404,'model is unavailable'],[401,'not authorized'],[500,'temporarily unavailable']])('reports HTTP %i without leaking provider text or retrying an obsolete model', async (status, message) => {
    const fetchMock=vi.fn().mockResolvedValue({ok:false,status,text:async()=>'{"error":"private receipt or key gsk_secret"}'});
    vi.stubGlobal('fetch',fetchMock); vi.spyOn(console,'warn').mockImplementation(()=>{});
    const result=await readReceiptImage({mediaType:'image/jpeg',base64:'YWJj'},{apiKey:'test'});
    expect(result.ok).toBe(false);expect(result.reason).toContain(message);expect(result.reason).not.toMatch(/secret|receipt or key|HTTP/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('does not claim a blank or unreadable receipt was read', async () => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({choices:[{message:{content:'{"receipt_text":""}'}}]})}));
    vi.spyOn(console,'warn').mockImplementation(()=>{});
    const result=await readReceiptImage({mediaType:'image/jpeg',base64:'YWJj'},{apiKey:'test'});
    expect(result.ok).toBe(false);expect(result.reason).toContain('could not produce a usable reading');
  });
});
