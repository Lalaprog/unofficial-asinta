import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createServiceRoleClient, isServiceRoleConfigured } from '@/lib/supabase/admin';
import { requireSessionAssurance } from '@/lib/auth/session-assurance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (message: string, status: number) => NextResponse.json({ error: message }, { status, headers });
type Context = { params: { id: string } };

async function authorize(projectId: string) {
  if (!uuid.test(projectId)) return { error: fail('Project not found.', 404) };
  const db = createServerSupabaseClient();
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) return { error: fail('Please sign in again.', 401) };
  const assurance = await requireSessionAssurance(db);
  if (!assurance.ok) return { error: fail(assurance.error, assurance.status) };
  const { data: project, error: projectError } = await db.rpc('visible_projects').eq('id', projectId).maybeSingle();
  if (projectError) return { error: fail('Could not verify access to this project.', 503) };
  if (!project) return { error: fail('Project not found.', 404) };
  return { db, userId: data.user.id };
}

export async function GET(req: NextRequest, { params }: Context) {
  try {
    const auth = await authorize(params.id);
    if (auth.error || !auth.db) return auth.error!;
    if (req.nextUrl.searchParams.get('view') === 'available') {
      // Available workers are requested only by the explicit add-worker flow,
      // never included in the ordinary Roll Call/team response.
      if (!isServiceRoleConfigured()) return fail('Could not load available workers.', 503);
      const admin = createServiceRoleClient();
      const available = await admin.rpc('available_project_workers_guarded', { p_actor: auth.userId, p_project: params.id });
      if (available.error || !Array.isArray(available.data) || available.data.some((worker: unknown) => {
        if (!worker || typeof worker !== 'object') return true;
        const row = worker as Record<string, unknown>;
        return typeof row.id !== 'string' || !uuid.test(row.id) || typeof row.name !== 'string' || typeof row.position !== 'string' || typeof row.contact_number !== 'string';
      })) return fail('Could not load available workers.', 503);
      return NextResponse.json({ availableWorkers: available.data }, { headers });
    }
    // RLS checks the project scope again during this read; no service-role read.
    const { data, error, count } = await auth.db.from('project_worker_assignments')
      .select('worker_id', { count: 'exact' }).eq('project_id', params.id).eq('active', true);
    // PostgREST may truncate a successful select at its configured row limit.
    if (error || !Array.isArray(data) || count === null || count !== data.length) return fail('Could not load the complete project team.', 503);
    const workerIds: string[] = data.map((row: {worker_id:string}) => row.worker_id);
    if (workerIds.some((id) => typeof id !== 'string' || !uuid.test(id)) || new Set(workerIds).size !== workerIds.length) return fail('Could not load the complete project team.', 503);
    if (req.nextUrl.searchParams.get('view') === 'bale') {
      // Read only fields needed for the picker under the caller's RLS. A bounded
      // batch avoids URL size limits and silently truncated PostgREST responses.
      if (workerIds.length > 1000) return fail('This site team is too large to load safely.', 503);
      const team: { id: string; name: string; position: string }[] = [];
      for (let offset = 0; offset < workerIds.length; offset += 100) {
        const batch = workerIds.slice(offset, offset + 100);
        const result = await auth.db.from('workers').select('id,name,position', { count: 'exact' }).in('id', batch).eq('active', true);
        if (result.error || !Array.isArray(result.data) || result.count === null || result.count !== result.data.length) return fail('Could not load worker details for the site.', 503);
        for (const worker of result.data) {
          if (!worker || typeof worker.id !== 'string' || !batch.includes(worker.id) || typeof worker.name !== 'string' || typeof worker.position !== 'string') return fail('Could not load worker details for the site.', 503);
          team.push({ id: worker.id, name: worker.name, position: worker.position });
        }
      }
      if (new Set(team.map((worker) => worker.id)).size !== team.length) return fail('Could not load worker details for the site.', 503);
      // An invisible ID may be inactive or hidden by RLS; do not infer why.
      return NextResponse.json({ workers: team, someDetailsUnavailable: team.length !== workerIds.length }, { headers });
    }
    return NextResponse.json({ workerIds }, { headers });
  } catch { return fail('Could not load the project team.', 503); }
}

export async function POST(req: NextRequest, { params }: Context) {
  try {
    const auth = await authorize(params.id);
    if (auth.error || !auth.userId) return auth.error!;
    const payload = await req.json().catch(() => null);
    if (!payload || !isServiceRoleConfigured()) return fail('Could not save the project team.', 503);
    const admin = createServiceRoleClient();
    if (payload.action === 'assign' || payload.action === 'remove') {
      if (typeof payload.workerId !== 'string' || !uuid.test(payload.workerId)) return fail('Choose a valid worker.', 422);
      const { data, error } = await admin.rpc('set_project_worker_guarded', {
        p_actor: auth.userId, p_project: params.id, p_worker: payload.workerId, p_active: payload.action === 'assign',
      });
      if (error?.code === 'P1003') return fail('This worker is already assigned to another project. Refresh and choose an available worker.', 409);
      if (error || !data || data.worker_id !== payload.workerId || data.active !== (payload.action === 'assign')) {
        return fail('Change not confirmed. Refresh the project team before trying again.', error?.code === '42501' ? 403 : 503);
      }
      return NextResponse.json({ ok: true }, { headers });
    }
    if (payload.action === 'create') {
      const name = typeof payload.name === 'string' ? payload.name.trim() : '';
      const position = typeof payload.position === 'string' ? payload.position.trim() : '';
      const contact = typeof payload.contact === 'string' ? payload.contact.trim() : '';
      const rate = typeof payload.rate === 'string' ? payload.rate.trim() : '';
      if (typeof payload.requestId !== 'string' || !uuid.test(payload.requestId) || name.length < 2 || name.length > 120 || !position || position.length > 120 || contact.length > 100 || !/^\d{1,8}(?:\.\d{1,2})?$/.test(rate) || Number(rate) > 99999999.99 || !['daily','hourly'].includes(payload.rateType)) {
        return fail('Check the worker details and pay rate.', 422);
      }
      const { data, error } = await admin.rpc('create_project_worker_guarded', {
        p_actor: auth.userId, p_project: params.id, p_request: payload.requestId,
        p_name: name, p_position: position, p_contact: contact, p_rate: rate, p_rate_type: payload.rateType,
      });
      if (error || !data || data.worker_id !== payload.requestId) return fail('Registration not confirmed. Refresh and check for this worker before trying again.', error?.code === '42501' ? 403 : 503);
      return NextResponse.json({ ok: true, workerId: data.worker_id }, { headers });
    }
    return fail('Choose an action.', 422);
  } catch { return fail('Change not confirmed. Refresh the project team before trying again.', 503); }
}
