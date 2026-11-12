-- Read-only weekly planning inputs. This is not a payroll voucher or payment.
-- No historical attendance is changed or treated as absent.
CREATE FUNCTION public.weekly_worker_preview_inputs(p_start date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_count bigint; v_result jsonb;
BEGIN
  IF NOT coalesce(public.is_founder(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
  IF p_start IS NULL OR p_start < '1900-01-01'::date OR p_start > '9998-12-24'::date OR extract(dow FROM p_start) <> 0 THEN
    RAISE EXCEPTION 'Choose a Sunday for the weekly preview' USING ERRCODE='22023';
  END IF;
  SELECT count(*) INTO v_count FROM public.attendance WHERE date BETWEEN p_start AND p_start+6;
  IF v_count > 10000 THEN RAISE EXCEPTION 'Too many attendance entries for the weekly preview' USING ERRCODE='54000'; END IF;
  SELECT count(*) INTO v_count FROM public.workers w
  WHERE w.active OR EXISTS(SELECT 1 FROM public.attendance a WHERE a.worker_id=w.id AND a.date BETWEEN p_start AND p_start+6);
  IF v_count > 2000 THEN RAISE EXCEPTION 'Too many workers for the weekly preview' USING ERRCODE='54000'; END IF;
  SELECT count(*) INTO v_count FROM public.payroll p WHERE p.period_start=p_start AND p.period_end=p_start+6;
  IF v_count > 10000 THEN RAISE EXCEPTION 'Too many vouchers for the weekly preview' USING ERRCODE='54000'; END IF;
  WITH entries AS MATERIALIZED (
    SELECT a.id,a.worker_id,a.project_id,a.date,a.status,a.hours_worked::text AS hours_worked
    FROM public.attendance a WHERE a.date BETWEEN p_start AND p_start+6
  ), candidates AS MATERIALIZED (
    SELECT w.id,w.name,w.position,w.active,w.pay_rate::text AS pay_rate,w.pay_rate_type,
      EXISTS(SELECT 1 FROM public.users u WHERE u.id=w.id AND u.role='supervisor') AS linked_supervisor,
      (strpos(lower(coalesce(w.position,'')),'supervisor')>0 OR EXISTS(
        SELECT 1 FROM public.users u WHERE u.role='supervisor' AND lower(btrim(u.name))=lower(btrim(w.name))
      )) AS possible_supervisor
    FROM public.workers w WHERE w.active OR EXISTS(SELECT 1 FROM entries a WHERE a.worker_id=w.id)
  ), vouchers AS MATERIALIZED (
    SELECT p.id,p.worker_id,p.status FROM public.payroll p
    WHERE p.period_start=p_start AND p.period_end=p_start+6 AND EXISTS(SELECT 1 FROM candidates w WHERE w.id=p.worker_id)
  )
  SELECT jsonb_build_object(
    'start',p_start,'end',p_start+6,
    'workers',coalesce((SELECT jsonb_agg(to_jsonb(w) ORDER BY w.name,w.id) FROM candidates w),'[]'::jsonb),
    'attendance',coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.date,a.id) FROM entries a),'[]'::jsonb),
    'vouchers',coalesce((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM vouchers v),'[]'::jsonb)
  ) INTO v_result;
  IF octet_length(v_result::text)>8388608 THEN RAISE EXCEPTION 'Weekly preview response too large' USING ERRCODE='54000'; END IF;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.weekly_worker_preview_inputs(date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.weekly_worker_preview_inputs(date) TO authenticated;
