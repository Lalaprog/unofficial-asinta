import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';

const mock = vi.hoisted(() => ({ client: null as unknown, requests: [] as {url: string; method: string; prefer: string | null}[], count: 1, postgrestError: false }));
vi.mock('@/lib/supabase/server', () => ({ createServerSupabaseClient: () => mock.client }));
vi.mock('@/lib/supabase/admin', () => ({ isServiceRoleConfigured: () => false, createServiceRoleClient: () => { throw new Error('Unexpected service client'); } }));
import { GET } from '@/app/api/projects/[id]/workers/route';

const project = '10000000-0000-0000-0000-000000000001';
const worker = '20000000-0000-0000-0000-000000000001';
beforeEach(() => {
  mock.requests = []; mock.count = 1; mock.postgrestError = false;
  const client = createClient('https://example.invalid', 'synthetic-publishable-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      mock.requests.push({ url: url.toString(), method: init?.method ?? 'GET', prefer: headers.get('prefer') });
      if (url.pathname.endsWith('/rpc/session_assurance_satisfied')) return new Response('true', { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.pathname.endsWith('/rpc/visible_projects')) return new Response(JSON.stringify([{ id: project }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.pathname.endsWith('/project_worker_assignments')) {
        if (mock.postgrestError) return new Response(JSON.stringify({ code: 'PGRST200', message: 'Relationship not found' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify([{ worker_id: worker, worker: { id: worker, name: 'Sample', position: 'Mason', active: true } }]), { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': `0-0/${mock.count}` } });
      }
      throw new Error('Unexpected request');
    } },
  });
  vi.spyOn(client.auth, 'getUser').mockResolvedValue({ data: { user: { id: '30000000-0000-0000-0000-000000000001' } }, error: null } as Awaited<ReturnType<typeof client.auth.getUser>>);
  mock.client = client;
});

describe('site picker with real Supabase query builder and mocked HTTP', () => {
  it('sends the site filter, active filter, named relationship and exact-count preference in one read', async () => {
    const response = await GET(new NextRequest('http://localhost/?view=bale'), { params: { id: project } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workers: [{ id: worker, name: 'Sample', position: 'Mason' }], someDetailsUnavailable: false });
    const reads = mock.requests.filter(r => new URL(r.url).pathname.endsWith('/project_worker_assignments'));
    expect(reads).toHaveLength(1);
    const params = new URL(reads[0].url).searchParams;
    expect(reads[0].method).toBe('GET');
    expect(reads[0].prefer).toContain('count=exact');
    expect(params.get('project_id')).toBe(`eq.${project}`);
    expect(params.get('active')).toBe('eq.true');
    expect(params.get('select')).toBe('worker_id,worker:workers!project_worker_assignments_worker_id_fkey(id,name,position,active)');
  });
  it('does not present a truncated result or a missing relationship as an empty team', async () => {
    mock.count = 2;
    expect((await GET(new NextRequest('http://localhost/?view=bale'), { params: { id: project } })).status).toBe(503);
    mock.postgrestError = true;
    expect((await GET(new NextRequest('http://localhost/?view=bale'), { params: { id: project } })).status).toBe(503);
  });
});
