-- Read-only historical risk signals, not a payment/correction workflow.
-- Existing vouchers, advances, requests and attendance remain unchanged.
-- Founder + MFA and the caller's table RLS apply; no row-level writes occur.
CREATE FUNCTION public.paid_payroll_review(p_start date,p_end date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_count bigint; v_result jsonb;
BEGIN
  IF NOT coalesce(public.is_founder(),false) THEN
    RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_start<'1900-01-01'::date OR p_end>'9998-12-31'::date
     OR p_start>p_end OR p_end-p_start>92 THEN
    RAISE EXCEPTION 'Choose a valid review range of at most 93 calendar days' USING ERRCODE='22023';
  END IF;
  SELECT count(*) INTO v_count FROM public.payroll p
    WHERE p.status='paid' AND p.period_start<=p_end AND p.period_end>=p_start;
  IF v_count>500 THEN RAISE EXCEPTION 'Too many paid vouchers; choose a shorter range' USING ERRCODE='54000'; END IF;
  SELECT count(*) INTO v_count FROM public.advances a WHERE a.status<>'cancelled' AND EXISTS(
    SELECT 1 FROM public.payroll p WHERE p.status='paid' AND p.period_start<=p_end AND p.period_end>=p_start
      AND a.worker_id=p.worker_id AND a.date BETWEEN p.period_start AND p.period_end
  );
  IF v_count>10000 THEN RAISE EXCEPTION 'Too many Bale records; choose a shorter range' USING ERRCODE='54000'; END IF;
  WITH paid AS MATERIALIZED (
    SELECT p.id,p.worker_id,p.period_start,p.period_end,p.gross_pay,p.bale_deduction,p.other_deductions,p.net_pay
    FROM public.payroll p WHERE p.status='paid' AND p.period_start<=p_end AND p.period_end>=p_start
  ), items AS (
    SELECT p.period_start,p.id,jsonb_build_object(
      'id',p.id,'worker_id',p.worker_id,'worker_name',w.name,
      'period_start',p.period_start,'period_end',p.period_end,
      'gross_pay',p.gross_pay::text,'bale_deduction',p.bale_deduction::text,
      'other_deductions',p.other_deductions::text,'net_pay',p.net_pay::text,
      'overlapping_paid',EXISTS(SELECT 1 FROM public.payroll other
        WHERE other.id<>p.id AND other.worker_id=p.worker_id AND other.status='paid'
          AND other.period_start<=p.period_end AND other.period_end>=p.period_start),
      'period_bale_total',b.total::text,'period_bale_count',b.records,
      'unlinked_period_bale_count',b.unlinked
    ) AS item
    FROM paid p LEFT JOIN public.workers w ON w.id=p.worker_id
    CROSS JOIN LATERAL (
      SELECT coalesce(sum(a.amount),0) total,count(*) records,
        count(*) FILTER (WHERE NOT EXISTS(SELECT 1 FROM public.advance_requests r
          WHERE r.issued_advance_id=a.id AND r.status='issued' AND r.worker_id=a.worker_id)) unlinked
      FROM public.advances a WHERE a.worker_id=p.worker_id AND a.status<>'cancelled'
        AND a.date BETWEEN p.period_start AND p.period_end
    ) b
  )
  SELECT jsonb_build_object('start',p_start,'end',p_end,
    'vouchers',coalesce((SELECT jsonb_agg(i.item ORDER BY i.period_start DESC,i.id) FROM items i),'[]'::jsonb)) INTO v_result;
  IF octet_length(v_result::text)>1048576 THEN RAISE EXCEPTION 'Review response too large; choose a shorter range' USING ERRCODE='54000'; END IF;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.paid_payroll_review(date,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.paid_payroll_review(date,date) TO authenticated;
