-- Founder-only, read-only payroll inputs from one database statement snapshot.
-- No voucher, attendance, advance or payment is changed by this migration.
-- The caller remains subject to existing RLS and table grants.
create or replace function public.payroll_input_snapshot(
  p_period_start date,
  p_period_end date,
  p_project_id uuid default null
) returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_count bigint;
  v_notes_bytes bigint;
  v_result jsonb;
begin
  if not coalesce(public.is_founder(), false) then
    raise exception 'Founder access is required.' using errcode = '42501';
  end if;
  if p_period_start is null or p_period_end is null or p_period_end < p_period_start then
    raise exception 'Invalid payroll period.' using errcode = '22023';
  end if;
  if p_project_id is not null and not exists(select 1 from public.projects where id = p_project_id) then
    raise exception 'The selected project is unavailable. Refresh and choose a valid site.' using errcode = '22023';
  end if;

  select count(*), coalesce(sum(octet_length(coalesce(notes,''))),0) into v_count, v_notes_bytes
  from public.attendance
  where date >= p_period_start and date <= p_period_end
    and (p_project_id is null or project_id = p_project_id);
  if v_count > 10000 or v_notes_bytes > 2097152 then
    raise exception 'Payroll inputs are too large to load safely. Choose a narrower period or site.' using errcode = '54000';
  end if;

  with candidates as (
    select distinct w.id from public.attendance a join public.workers w on w.id = a.worker_id
    where a.date >= p_period_start and a.date <= p_period_end
      and (p_project_id is null or a.project_id = p_project_id) and w.active
  )
  select count(*) into v_count from public.advances adv join candidates c on c.id = adv.worker_id
  where adv.status in ('active','partially_deducted') and (p_project_id is null or adv.project_id = p_project_id);
  if v_count > 10000 then
    raise exception 'Too many advance records to load safely. Choose a narrower site or review the ledger.' using errcode = '54000';
  end if;

  with candidates as (
    select distinct w.id from public.attendance a join public.workers w on w.id = a.worker_id
    where a.date >= p_period_start and a.date <= p_period_end
      and (p_project_id is null or a.project_id = p_project_id) and w.active
  )
  select count(*) into v_count from public.payroll pay join candidates c on c.id = pay.worker_id
  where pay.period_start = p_period_start and pay.period_end = p_period_end;
  if v_count > 10000 then
    raise exception 'Too many payroll vouchers to load safely. Review the ledger before generating.' using errcode = '54000';
  end if;
  if exists (
    select 1 from public.payroll pay
    where pay.period_start = p_period_start and pay.period_end = p_period_end
      and exists(select 1 from public.attendance a join public.workers w on w.id = a.worker_id
        where w.active and w.id = pay.worker_id and a.date >= p_period_start and a.date <= p_period_end
          and (p_project_id is null or a.project_id = p_project_id))
    group by pay.worker_id having count(*) > 1
  ) then
    raise exception 'Duplicate vouchers already exist for a worker and period. Review them before generating payroll.' using errcode = '23505';
  end if;

  with attendance_data as materialized (
    select * from public.attendance a
    where a.date >= p_period_start and a.date <= p_period_end
      and (p_project_id is null or a.project_id = p_project_id)
  ), candidates as materialized (
    select w.* from public.workers w
    where w.active and exists (select 1 from attendance_data a where a.worker_id = w.id)
  ), relevant_projects as (
    select p.id, p.name from public.projects p
    where p.id = p_project_id or exists (select 1 from attendance_data a where a.project_id = p.id)
  ), relevant_users as (
    select u.id, u.name, u.role from public.users u
    -- Return all supervisor identities: JS name normalization must not diverge
    -- from a database pre-filter and accidentally bypass verification.
    where u.role = 'supervisor'
  ), relevant_advances as (
    select adv.* from public.advances adv
    where adv.status in ('active','partially_deducted')
      and (p_project_id is null or adv.project_id = p_project_id)
      and exists(select 1 from candidates w where w.id = adv.worker_id)
  ), relevant_payroll as (
    select pay.* from public.payroll pay
    where pay.period_start = p_period_start and pay.period_end = p_period_end
      and exists(select 1 from candidates w where w.id = pay.worker_id)
  )
  select jsonb_build_object(
    'attendance', coalesce((select jsonb_agg(to_jsonb(x)) from attendance_data x),'[]'::jsonb),
    'workers', coalesce((select jsonb_agg(to_jsonb(x)) from candidates x),'[]'::jsonb),
    'projects', coalesce((select jsonb_agg(to_jsonb(x)) from relevant_projects x),'[]'::jsonb),
    'users', coalesce((select jsonb_agg(to_jsonb(x)) from relevant_users x),'[]'::jsonb),
    'advances', coalesce((select jsonb_agg(to_jsonb(x)) from relevant_advances x),'[]'::jsonb),
    'payroll', coalesce((select jsonb_agg(to_jsonb(x)) from relevant_payroll x),'[]'::jsonb)
  ) into v_result;
  if octet_length(v_result::text) > 8388608 then
    raise exception 'Payroll inputs exceed the safe response size. Choose a narrower period or site.' using errcode = '54000';
  end if;
  return v_result;
end;
$$;
revoke all on function public.payroll_input_snapshot(date,date,uuid) from public, anon;
grant execute on function public.payroll_input_snapshot(date,date,uuid) to authenticated;
