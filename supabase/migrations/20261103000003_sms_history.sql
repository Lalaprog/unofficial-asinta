-- Read-only Founder history. Functions run as the caller and retain table RLS.
-- Index creation can briefly block inserts: schedule on a quiet database.
create index if not exists sms_logs_history_order_idx on public.sms_logs (sent_at desc, id desc);

create or replace function public.sms_history_summary() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare result jsonb;
begin
  if not coalesce(public.is_founder(), false) then
    raise exception 'Founder access required' using errcode = '42501';
  end if;
  select jsonb_build_object('total', count(*), 'delivered', count(*) filter (where status = 'delivered' and not simulated))
    into result from public.sms_logs;
  return result;
end;
$$;

create or replace function public.sms_history_page(
  p_search text default null, p_status text default null,
  p_from date default null, p_to date default null,
  p_cursor_sent_at timestamptz default null, p_cursor_id uuid default null,
  p_limit integer default 25
) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare result jsonb;
begin
  if not coalesce(public.is_founder(), false) then
    raise exception 'Founder access required' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'Invalid page size' using errcode = '22023';
  end if;
  if length(coalesce(p_search, '')) > 200 then
    raise exception 'Search is too long' using errcode = '22023';
  end if;
  if p_status is not null and p_status not in ('sent','delivered','failed','pending','simulated') then
    raise exception 'Invalid status' using errcode = '22023';
  end if;
  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'Invalid date range' using errcode = '22023';
  end if;
  if (p_cursor_sent_at is null) <> (p_cursor_id is null) then
    raise exception 'Invalid cursor' using errcode = '22023';
  end if;
  with matches as (
    select s.id,s.invoice_id,s.recipient,s.phone,s.message,s.status,s.simulated,
      s.provider_message_id,s.provider_status,s.error_message,s.updated_at,s.sent_at,
      i.invoice_number
    from public.sms_logs s
    left join public.invoices i on i.id = s.invoice_id
    where (p_status is null or (p_status = 'simulated' and s.simulated)
      or (p_status <> 'simulated' and not s.simulated and s.status = p_status))
      and (p_from is null or s.sent_at >= (p_from::timestamp at time zone 'Asia/Manila'))
      and (p_to is null or s.sent_at < ((p_to + 1)::timestamp at time zone 'Asia/Manila'))
      and (p_cursor_sent_at is null or (s.sent_at,s.id) < (p_cursor_sent_at,p_cursor_id))
      and (nullif(btrim(p_search), '') is null
        or strpos(lower(s.recipient),lower(btrim(p_search))) > 0
        or strpos(lower(s.phone),lower(btrim(p_search))) > 0
        or strpos(lower(s.message),lower(btrim(p_search))) > 0
        or strpos(lower(coalesce(i.invoice_number,'')),lower(btrim(p_search))) > 0)
    order by s.sent_at desc,s.id desc limit p_limit + 1
  ), visible as (select * from matches order by sent_at desc,id desc limit p_limit)
  select jsonb_build_object('has_more',(select count(*) > p_limit from matches),
    'items',coalesce((select jsonb_agg(to_jsonb(v) order by v.sent_at desc,v.id desc) from visible v),'[]'::jsonb)) into result;
  return result;
end;
$$;
revoke all on function public.sms_history_summary() from public, anon;
revoke all on function public.sms_history_page(text,text,date,date,timestamptz,uuid,integer) from public, anon;
grant execute on function public.sms_history_summary() to authenticated;
grant execute on function public.sms_history_page(text,text,date,date,timestamptz,uuid,integer) to authenticated;
