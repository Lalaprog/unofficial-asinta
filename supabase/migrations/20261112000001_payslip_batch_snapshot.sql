-- A read-only, Founder-scoped print snapshot. It neither generates vouchers nor
-- changes attendance, payment or advances. Use one statement snapshot rather
-- than the browser's possibly truncated shared store.
CREATE OR REPLACE FUNCTION public.payslip_batch_snapshot(p_start date, p_end date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_count bigint; v_result jsonb;
BEGIN
  IF NOT coalesce(public.is_founder(), false) THEN
    RAISE EXCEPTION 'Founder access is required' USING ERRCODE='42501';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start OR p_end - p_start > 366 THEN
    RAISE EXCEPTION 'Choose a valid period of at most 367 days' USING ERRCODE='22023';
  END IF;
  SELECT count(*) INTO v_count FROM public.payroll p WHERE p.period_start=p_start AND p.period_end=p_end;
  IF v_count > 2000 THEN RAISE EXCEPTION 'Too many vouchers to print safely' USING ERRCODE='54000'; END IF;
  -- Avoid silently including or excluding ambiguous legacy Supervisor profiles.
  IF EXISTS (
    SELECT 1 FROM public.payroll p JOIN public.workers w ON w.id=p.worker_id
    WHERE p.period_start=p_start AND p.period_end=p_end
      AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id=w.id AND u.role='supervisor')
      AND (strpos(lower(coalesce(w.position,'')), 'supervisor') > 0 OR EXISTS (
        SELECT 1 FROM public.users u WHERE u.role='supervisor' AND lower(btrim(u.name))=lower(btrim(w.name))
      ))
  ) THEN RAISE EXCEPTION 'A worker may be an unlinked Supervisor. Review their identity before printing a batch.' USING ERRCODE='P1004'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.payroll p WHERE p.period_start=p_start AND p.period_end=p_end
    AND NOT EXISTS (SELECT 1 FROM public.workers w WHERE w.id=p.worker_id)
  ) THEN RAISE EXCEPTION 'A worker profile is unavailable. Review the vouchers before printing.' USING ERRCODE='P1004'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.payroll p WHERE p.period_start=p_start AND p.period_end=p_end
    GROUP BY p.worker_id HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'Duplicate vouchers exist for this period. Review them before printing.' USING ERRCODE='P1004'; END IF;

  WITH eligible AS (
    SELECT p.*, w.name AS worker_name, w.position AS worker_position
    FROM public.payroll p JOIN public.workers w ON w.id=p.worker_id
    WHERE p.period_start=p_start AND p.period_end=p_end
      AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id=w.id AND u.role='supervisor')
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'worker_id', p.worker_id, 'worker_name', p.worker_name, 'worker_position', p.worker_position,
    'period_start', p.period_start, 'period_end', p.period_end, 'status', p.status,
    'days_worked', p.days_worked, 'hours_worked', p.hours_worked,
    'gross_pay', p.gross_pay, 'bale_deduction', p.bale_deduction,
    'other_deductions', p.other_deductions, 'net_pay', p.net_pay
  ) ORDER BY p.worker_name, p.worker_id, p.id),'[]'::jsonb) INTO v_result FROM eligible p;
  IF octet_length(v_result::text) > 4194304 THEN RAISE EXCEPTION 'Payslip data is too large to print safely' USING ERRCODE='54000'; END IF;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.payslip_batch_snapshot(date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.payslip_batch_snapshot(date,date) TO authenticated;
