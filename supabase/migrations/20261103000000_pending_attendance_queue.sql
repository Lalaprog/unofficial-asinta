-- Founder review queue: do not rely on the shared client's capped attendance load.
-- Read-only and SECURITY INVOKER: existing RLS/grants remain in force. Deploy
-- this migration before the client using it; no existing attendance is changed.
create index if not exists attendance_pending_review_order_idx
  on public.attendance (date desc, id desc)
  where is_founder_override = false and status in ('present', 'half_day');

create or replace function public.pending_attendance_approvals(
  p_cursor_date date default null,
  p_cursor_id uuid default null,
  p_limit integer default 3
) returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not coalesce(public.is_founder(), false) then
    raise exception 'Only Founders may view the supervisor approval queue' using errcode = '42501';
  end if;
  if (p_cursor_date is null) <> (p_cursor_id is null) then
    raise exception 'Both cursor values are required' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'Invalid page size' using errcode = '22023';
  end if;

  with pending as materialized (
    select a.*, w.name as worker_name, w.position as worker_position, p.name as project_name
    from public.attendance a
    left join public.workers w on w.id = a.worker_id
    left join public.projects p on p.id = a.project_id
    where a.is_founder_override = false
      and a.status in ('present', 'half_day')
      and (
        a.worker_id = a.recorded_by
        or strpos(coalesce(a.notes, ''), 'Pending Founder Review') > 0
        or strpos(coalesce(a.notes, ''), 'Founder Review:') > 0
        or strpos(lower(coalesce(w.position, '')), 'supervisor') > 0
        or exists (
          select 1 from public.users u
          where u.role = 'supervisor'
            and (u.id = w.id or lower(btrim(u.name)) = lower(btrim(w.name)))
        )
      )
  ), page as materialized (
    select * from pending
    where p_cursor_date is null or (date, id) < (p_cursor_date, p_cursor_id)
    order by date desc, id desc
    limit p_limit + 1
  ), visible as (
    select * from page order by date desc, id desc limit p_limit
  )
  select jsonb_build_object(
    'total', (select count(*) from pending),
    'has_more', (select count(*) > p_limit from page),
    'items', coalesce((select jsonb_agg(to_jsonb(visible) order by date desc, id desc) from visible), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke all on function public.pending_attendance_approvals(date, uuid, integer) from public, anon;
grant execute on function public.pending_attendance_approvals(date, uuid, integer) to authenticated;
