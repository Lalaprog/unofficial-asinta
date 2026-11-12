-- Bounded, Founder-only read context for the planning preview. The source
-- records remain unchanged; a linked request is evidence, not proof of payment.
ALTER FUNCTION public.weekly_worker_preview_inputs(date) RENAME TO weekly_worker_time_preview_inputs;
CREATE FUNCTION public.weekly_worker_preview_inputs(p_start date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_base jsonb; v_workers jsonb; v_vouchers jsonb; v_allowances jsonb; v_advances jsonb; v_older jsonb; v_result jsonb; v_count bigint;
BEGIN
  -- Existing function enforces Founder, valid Sunday, limits and caller RLS.
  v_base:=public.weekly_worker_time_preview_inputs(p_start);
  SELECT count(*) INTO v_count FROM public.worker_allowances WHERE attendance_date BETWEEN p_start AND p_start+6;
  IF v_count>10000 THEN RAISE EXCEPTION 'Too many worker allowances for this preview' USING ERRCODE='54000'; END IF;
  SELECT count(*) INTO v_count FROM public.advances WHERE date BETWEEN p_start AND p_start+6;
  IF v_count>10000 THEN RAISE EXCEPTION 'Too many Bale records for this preview' USING ERRCODE='54000'; END IF;
  SELECT count(*) INTO v_count FROM public.advances WHERE date<p_start AND status IN ('active','partially_deducted');
  IF v_count>10000 THEN RAISE EXCEPTION 'Too many older Bale records for this preview' USING ERRCODE='54000'; END IF;
  SELECT count(*) INTO v_count FROM public.payroll WHERE period_start<=p_start+6 AND period_end>=p_start;
  IF v_count>10000 THEN RAISE EXCEPTION 'Too many overlapping vouchers for this preview' USING ERRCODE='54000'; END IF;

  WITH existing AS MATERIALIZED (SELECT x.value AS w FROM jsonb_array_elements(v_base->'workers') AS x),
  missing AS MATERIALIZED (
    SELECT w.id,w.name,w.position,w.active,w.pay_rate::text AS pay_rate,w.pay_rate_type,
      EXISTS(SELECT 1 FROM public.users u WHERE u.id=w.id AND u.role='supervisor') AS linked_supervisor,
      (strpos(lower(coalesce(w.position,'')),'supervisor')>0 OR EXISTS(SELECT 1 FROM public.users u WHERE u.role='supervisor' AND lower(btrim(u.name))=lower(btrim(w.name)))) AS possible_supervisor
    FROM public.workers w WHERE NOT EXISTS(SELECT 1 FROM existing e WHERE e.w->>'id'=w.id::text)
      AND (EXISTS(SELECT 1 FROM public.worker_allowances a WHERE a.worker_id=w.id AND a.attendance_date BETWEEN p_start AND p_start+6)
        OR EXISTS(SELECT 1 FROM public.advances a WHERE a.worker_id=w.id AND (a.date BETWEEN p_start AND p_start+6 OR (a.date<p_start AND a.status IN ('active','partially_deducted'))))
        OR EXISTS(SELECT 1 FROM public.payroll p WHERE p.worker_id=w.id AND p.period_start<=p_start+6 AND p.period_end>=p_start))
  ), all_workers AS (
    SELECT e.w AS value FROM existing e UNION ALL SELECT to_jsonb(m) FROM missing m
  ) SELECT coalesce(jsonb_agg(value ORDER BY value->>'name',value->>'id'),'[]'::jsonb) INTO v_workers FROM all_workers;
  IF jsonb_array_length(v_workers)>2000 THEN RAISE EXCEPTION 'Too many workers for this preview' USING ERRCODE='54000'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.id,'worker_id',p.worker_id,'status',p.status,'period_start',p.period_start,'period_end',p.period_end) ORDER BY p.id),'[]'::jsonb)
    INTO v_vouchers FROM public.payroll p WHERE p.period_start<=p_start+6 AND p.period_end>=p_start;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',w.id,'worker_id',w.worker_id,'project_id',w.project_id,'description',w.description,'amount',w.amount::text,'status',w.status,'date',w.attendance_date,
    'stale',(w.worker_id,w.project_id,w.attendance_date,w.attendance_status,w.attendance_hours,w.attendance_submitted_at)
      IS DISTINCT FROM (a.worker_id,a.project_id,a.date,a.status,a.hours_worked,a.submitted_at)) ORDER BY w.id),'[]'::jsonb)
    INTO v_allowances FROM public.worker_allowances w JOIN public.attendance a ON a.id=w.attendance_id
    WHERE w.attendance_date BETWEEN p_start AND p_start+6;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'worker_id',a.worker_id,'project_id',a.project_id,'date',a.date,'amount',a.amount::text,
    'deducted',a.amount_deducted::text,'status',a.status,
    'linked_release',coalesce(r.status='issued' AND r.worker_id=a.worker_id AND r.project_id=a.project_id
      AND r.requested_amount=a.amount AND (r.issued_at AT TIME ZONE 'Asia/Manila')::date=a.date,false)) ORDER BY a.date,a.id),'[]'::jsonb)
    INTO v_advances FROM public.advances a LEFT JOIN public.advance_requests r ON r.issued_advance_id=a.id
    WHERE a.date BETWEEN p_start AND p_start+6;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'worker_id',a.worker_id,'amount',a.amount::text,'deducted',a.amount_deducted::text,'status',a.status) ORDER BY a.date,a.id),'[]'::jsonb)
    INTO v_older FROM public.advances a WHERE a.date<p_start AND a.status IN ('active','partially_deducted');
  IF jsonb_array_length(v_allowances)<>(SELECT count(*) FROM public.worker_allowances WHERE attendance_date BETWEEN p_start AND p_start+6)
    OR jsonb_array_length(v_advances)<>(SELECT count(*) FROM public.advances WHERE date BETWEEN p_start AND p_start+6) THEN
    RAISE EXCEPTION 'Weekly financial context is incomplete' USING ERRCODE='42501'; END IF;
  v_result:=v_base || jsonb_build_object('workers',v_workers,'vouchers',v_vouchers,'allowances',v_allowances,'advances',v_advances,'older_advances',v_older);
  IF octet_length(v_result::text)>8388608 THEN RAISE EXCEPTION 'Weekly preview response too large' USING ERRCODE='54000'; END IF;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.weekly_worker_preview_inputs(date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.weekly_worker_preview_inputs(date) TO authenticated;
