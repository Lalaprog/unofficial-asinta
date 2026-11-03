-- Server-side attendance history. Both functions run as the caller: existing
-- attendance, worker, project and user RLS/grants still apply. No rows changed.
create index if not exists attendance_history_sheet_order_idx
  on public.attendance (date desc, project_id asc, id asc);

create or replace function public.attendance_history_matching(
  p_project_id uuid default null,
  p_status text default null,
  p_date date default null,
  p_search text default null
) returns table (
  id uuid, worker_id uuid, project_id uuid, date date, status text,
  hours_worked numeric, notes text, recorded_by uuid, is_founder_override boolean,
  submitted_at timestamptz, created_at timestamptz,
  worker_name text, worker_position text, project_name text, is_supervisor boolean
)
language sql stable security invoker set search_path = ''
as $$
  select a.id, a.worker_id, a.project_id, a.date, a.status, a.hours_worked,
    a.notes, a.recorded_by, a.is_founder_override, a.submitted_at, a.created_at,
    w.name, w.position, p.name,
    coalesce(a.worker_id = a.recorded_by, false)
      or strpos(coalesce(a.notes, ''), 'Pending Founder Review') > 0
      or strpos(coalesce(a.notes, ''), 'Founder Review:') > 0
      or strpos(lower(coalesce(w.position, '')), 'supervisor') > 0
      or exists (select 1 from public.users u where u.role = 'supervisor'
        and (u.id = w.id or lower(btrim(u.name)) = lower(btrim(w.name))))
  from public.attendance a
  left join public.workers w on w.id = a.worker_id
  left join public.projects p on p.id = a.project_id
  where (p_project_id is null or a.project_id = p_project_id)
    and (p_status is null or a.status = p_status)
    and (p_date is null or a.date = p_date)
    and (nullif(btrim(p_search), '') is null
      or strpos(lower(coalesce(w.name, '')), lower(btrim(p_search))) > 0
      or strpos(lower(coalesce(w.position, '')), lower(btrim(p_search))) > 0
      or strpos(lower(coalesce(p.name, '')), lower(btrim(p_search))) > 0
      or strpos(lower(coalesce(a.notes, '')), lower(btrim(p_search))) > 0)
$$;

-- A page contains at most p_limit groups or records. The extra row is only
-- used for has_more, so the PostgREST response limit cannot silently truncate it.
create or replace function public.attendance_history_page(
  p_mode text,
  p_project_id uuid default null,
  p_status text default null,
  p_date date default null,
  p_search text default null,
  p_cursor_date date default null,
  p_cursor_project_id uuid default null,
  p_cursor_id uuid default null,
  p_limit integer default 10
) returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare result jsonb;
begin
  if p_mode is null or p_mode not in ('sheets', 'records') then
    raise exception 'Invalid history page mode' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'Invalid history page size' using errcode = '22023';
  end if;
  if p_status is not null and p_status not in ('present','half_day','absent','leave') then
    raise exception 'Invalid attendance status' using errcode = '22023';
  end if;
  if length(coalesce(p_search, '')) > 200 then
    raise exception 'Search is too long' using errcode = '22023';
  end if;
  if p_mode = 'sheets' then
    if (p_cursor_date is null) <> (p_cursor_project_id is null) or p_cursor_id is not null then
      raise exception 'Invalid sheet cursor' using errcode = '22023';
    end if;
    with grouped as (
      select h.date, h.project_id, max(h.project_name) as project_name,
        count(*) as record_count,
        count(*) filter (where h.status = 'present') as present_count,
        count(*) filter (where h.status = 'half_day') as half_day_count,
        count(*) filter (where h.status = 'absent') as absent_count,
        count(*) filter (where h.status = 'leave') as leave_count,
        count(*) filter (where h.is_supervisor and not h.is_founder_override and h.status in ('present','half_day')) as pending_count
      from public.attendance_history_matching(p_project_id,p_status,p_date,p_search) h
      where p_cursor_date is null or h.date < p_cursor_date
        or (h.date = p_cursor_date and h.project_id > p_cursor_project_id)
      group by h.date,h.project_id
      order by h.date desc,h.project_id asc
      limit p_limit + 1
    ), visible as (
      select * from grouped order by date desc, project_id asc limit p_limit
    )
    select jsonb_build_object('has_more', (select count(*) > p_limit from grouped),
      'items', coalesce((select jsonb_agg(to_jsonb(v) order by v.date desc,v.project_id asc) from visible v), '[]'::jsonb)) into result;
  else
    if p_project_id is null or p_date is null or p_cursor_date is not null or p_cursor_project_id is not null then
      raise exception 'Record pages require a site and date' using errcode = '22023';
    end if;
    with records as (
      select h.* from public.attendance_history_matching(p_project_id,p_status,p_date,p_search) h
      where p_cursor_id is null or h.id > p_cursor_id
      order by h.id asc limit p_limit + 1
    ), visible as (
      select * from records order by id asc limit p_limit
    )
    select jsonb_build_object('has_more', (select count(*) > p_limit from records),
      'items', coalesce((select jsonb_agg(to_jsonb(v) order by v.id asc) from visible v), '[]'::jsonb)) into result;
  end if;
  return result;
end;
$$;

revoke all on function public.attendance_history_matching(uuid,text,date,text) from public, anon;
revoke all on function public.attendance_history_page(text,uuid,text,date,text,date,uuid,uuid,integer) from public, anon;
grant execute on function public.attendance_history_matching(uuid,text,date,text) to authenticated;
grant execute on function public.attendance_history_page(text,uuid,text,date,text,date,uuid,uuid,integer) to authenticated;
