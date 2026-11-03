-- Founder-only, bounded, read-only matrix. No attendance or financial writes.
-- A site has no assigned crew table: scoped rows are workers with site logs.
create or replace function public.payroll_attendance_matrix(
  p_period_start date, p_period_end date, p_project_id uuid default null
) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_attendance_count bigint;
  v_worker_count bigint;
  v_payroll_count bigint;
  v_result jsonb;
begin
  if not coalesce(public.is_founder(), false) then
    raise exception 'Founder access is required.' using errcode = '42501';
  end if;
  if p_period_start is null or p_period_end is null or p_period_end < p_period_start then
    raise exception 'Invalid attendance period.' using errcode = '22023';
  end if;
  if p_period_end - p_period_start > 92 then
    raise exception 'Choose a period of at most 93 days for the matrix.' using errcode = '22023';
  end if;
  if p_project_id is not null and not exists(select 1 from public.projects where id = p_project_id) then
    raise exception 'Selected site is unavailable.' using errcode = '22023';
  end if;
  select count(*) into v_attendance_count from public.attendance a
  where a.date between p_period_start and p_period_end and (p_project_id is null or a.project_id = p_project_id);
  if v_attendance_count > 10000 then
    raise exception 'Too many attendance records for the matrix. Choose a narrower period or site.' using errcode = '54000';
  end if;
  with period_attendance as materialized (
    select a.worker_id from public.attendance a
    where a.date between p_period_start and p_period_end and (p_project_id is null or a.project_id = p_project_id)
  )
  select count(*) into v_worker_count from public.workers w
  where (p_project_id is null and w.active)
     or exists (select 1 from period_attendance a where a.worker_id = w.id);
  if v_worker_count > 10000 or v_worker_count * (p_period_end - p_period_start + 1) > 10000 then
    raise exception 'Matrix is too large to display safely. Choose a narrower period or site.' using errcode = '54000';
  end if;
  with period_attendance as materialized (
    select a.worker_id from public.attendance a
    where a.date between p_period_start and p_period_end and (p_project_id is null or a.project_id = p_project_id)
  ), candidates as materialized (
    select w.id from public.workers w where (p_project_id is null and w.active)
      or exists (select 1 from period_attendance a where a.worker_id = w.id)
  )
  select count(*) into v_payroll_count from public.payroll p
  join candidates w on w.id = p.worker_id
  where p.period_start = p_period_start and p.period_end = p_period_end;
  if v_payroll_count > 10000 then
    raise exception 'Too many period vouchers for the matrix. Choose a narrower site or review vouchers.' using errcode = '54000';
  end if;

  with period_attendance as materialized (
    select a.id,a.worker_id,a.project_id,a.date,a.status from public.attendance a
    where a.date between p_period_start and p_period_end and (p_project_id is null or a.project_id = p_project_id)
  ), candidates as materialized (
    select w.id,w.name,w.position,w.active,w.pay_rate,w.pay_rate_type from public.workers w
    where (p_project_id is null and w.active)
      or exists (select 1 from period_attendance a where a.worker_id = w.id)
  ), sites as materialized (
    select p.id,p.name from public.projects p where p.id = p_project_id
      or exists (select 1 from period_attendance a where a.project_id = p.id)
  ), vouchers as materialized (
    select p.id,p.worker_id,p.gross_pay,p.net_pay,p.status from public.payroll p
    where p.period_start = p_period_start and p.period_end = p_period_end
      and exists(select 1 from candidates w where w.id = p.worker_id)
  )
  select jsonb_build_object(
    'attendance',coalesce((select jsonb_agg(to_jsonb(a)) from period_attendance a),'[]'::jsonb),
    'workers',coalesce((select jsonb_agg(to_jsonb(w)) from candidates w),'[]'::jsonb),
    'projects',coalesce((select jsonb_agg(to_jsonb(p)) from sites p),'[]'::jsonb),
    'vouchers',coalesce((select jsonb_agg(to_jsonb(v)) from vouchers v),'[]'::jsonb)
  ) into v_result;
  if octet_length(v_result::text) > 8388608 then
    raise exception 'Matrix response is too large. Choose a narrower period or site.' using errcode = '54000';
  end if;
  return v_result;
end;
$$;
revoke all on function public.payroll_attendance_matrix(date,date,uuid) from public,anon;
grant execute on function public.payroll_attendance_matrix(date,date,uuid) to authenticated;
