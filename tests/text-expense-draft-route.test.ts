import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mock = vi.hoisted(() => ({ founder: vi.fn(), context: vi.fn(), extract: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServerSupabaseClient: () => ({}) }));
vi.mock('@/lib/auth/serverRole', () => ({ requireFounder: () => mock.founder() }));
vi.mock('@/lib/api/rateLimitGuard', () => ({ enforceRateLimit: () => null }));
vi.mock('@/lib/ai/draftData', () => ({ loadDraftData: mock.context }));
vi.mock('@/lib/ai/draft', () => ({ extractExpenseDraft: mock.extract }));
import { POST } from '@/app/api/ai/draft/route';

function request(text: string) {
  return new NextRequest('http://localhost/api/ai/draft', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
}
beforeEach(() => {
  mock.founder.mockReset().mockResolvedValue({ ok: true, userId: 'founder' });
  mock.context.mockReset().mockResolvedValue({ context: {}, errors: [] });
  mock.extract.mockReset().mockResolvedValue({ description: 'cement', amount: 1000 });
});
describe('typed expense draft route', () => {
  it('rejects obvious off-topic prompts before loading context or calling AI', async () => {
    const res = await POST(request('What is 2 + 2?'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/expense descriptions/i);
    expect(mock.context).not.toHaveBeenCalled();
    expect(mock.extract).not.toHaveBeenCalled();
  });
  it('accepts expense notes and only returns a draft', async () => {
    const res = await POST(request('5 bags cement @ 200 each'));
    expect(res.status).toBe(200);
    expect((await res.json()).draft.amount).toBe(1000);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
  it('denies non-founders and does not call the model', async () => {
    mock.founder.mockResolvedValue({ ok: false, status: 403, error: 'Forbidden' });
    expect((await POST(request('5 bags cement @ 200 each'))).status).toBe(403);
    expect(mock.extract).not.toHaveBeenCalled();
  });
});
