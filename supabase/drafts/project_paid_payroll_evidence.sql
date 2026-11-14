-- DRAFT ONLY, not a migration. Requires the exact reviewed weekly generator,
-- approval, payment-date and paid-allocation drafts. Read-only evidence, NOT a
-- reconciled project cost total. Legacy payroll and later adjustments excluded.
-- Install only as part of a tested cutover and catalog/permission review.
CREATE INDEX weekly_paid_allocations_project_payroll_idx ON public.weekly_worker_paid_allocations(project_id,payroll_id);
CREATE FUNCTION public.project_paid_worker_evidence(p_project uuid,p_cursor_week date DEFAULT NULL,p_cursor_payroll uuid DEFAULT NULL,p_limit integer DEFAULT 25)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_result jsonb;v_bad boolean;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR (p_cursor_week IS NULL)<>(p_cursor_payroll IS NULL) OR (p_cursor_week IS NOT NULL AND (NOT isfinite(p_cursor_week) OR extract(dow FROM p_cursor_week)<>0)) THEN RAISE EXCEPTION 'Invalid project or cursor' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='42501'; END IF;
 -- Validate every row on this page, including the lookahead, before displaying
 -- anything. Joins are deliberately left joins so missing evidence fails closed.
 WITH candidate AS MATERIALIZED (
  SELECT a.*,p.worker_id,p.status,p.period_start,p.period_end,p.gross_pay,p.hours_worked,
   s.worker_id source_worker,s.period_start source_week,s.approved_by,s.approved_at,s.approval_xid,s.payment_actor,s.payment_xid,s.calculation,
   d.payment_date,d.recorded_by,w.name worker_name,
   (SELECT sum(x.wage) FROM public.weekly_worker_paid_allocations x WHERE x.payroll_id=a.payroll_id) total_wage,
   (SELECT sum(x.allowance) FROM public.weekly_worker_paid_allocations x WHERE x.payroll_id=a.payroll_id) total_allowance,
   (SELECT sum(x.gross) FROM public.weekly_worker_paid_allocations x WHERE x.payroll_id=a.payroll_id) total_gross,
   (SELECT sum(x.hours) FROM public.weekly_worker_paid_allocations x WHERE x.payroll_id=a.payroll_id) total_hours
  FROM public.weekly_worker_paid_allocations a LEFT JOIN public.payroll p ON p.id=a.payroll_id
  LEFT JOIN public.weekly_worker_draft_sources s ON s.payroll_id=a.payroll_id
  LEFT JOIN public.payroll_payment_dates d ON d.payroll_id=a.payroll_id
  LEFT JOIN public.workers w ON w.id=p.worker_id
  WHERE a.project_id=p_project AND (p_cursor_week IS NULL OR (p.period_start,a.payroll_id)<(p_cursor_week,p_cursor_payroll))
  ORDER BY p.period_start DESC NULLS FIRST,a.payroll_id DESC LIMIT p_limit+1
 ), checked AS MATERIALIZED (
  SELECT *,coalesce(status='paid' AND worker_id=source_worker AND period_start=source_week
   AND extract(dow FROM period_start)=0 AND period_end=period_start+6
   AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND approval_xid IS NULL
   AND payment_actor IS NOT NULL AND payment_xid IS NULL AND payment_date IS NOT NULL AND recorded_by=payment_actor
   AND worker_name IS NOT NULL AND hours>0 AND wage>=0 AND allowance>=0 AND gross=wage+allowance
   AND total_hours=hours_worked AND total_gross=gross_pay AND total_wage=(calculation->>'wage')::numeric
   AND total_allowance=(calculation->>'allowance')::numeric AND total_gross=(calculation->>'gross')::numeric,false) valid
  FROM candidate
 )
 SELECT coalesce(bool_or(NOT valid),false),jsonb_build_object('project_id',p_project,'has_more',count(*)>p_limit,
  'items',coalesce((SELECT jsonb_agg(jsonb_build_object('payroll_id',payroll_id,'worker_id',worker_id,'worker_name',worker_name,
    'period_start',period_start,'period_end',period_end,'payment_date',payment_date,'hours',hours::text,'wage',wage::text,'allowance',allowance::text,'gross',gross::text)
    ORDER BY period_start DESC,payroll_id DESC) FROM (SELECT * FROM checked ORDER BY period_start DESC NULLS FIRST,payroll_id DESC LIMIT p_limit) page),'[]'::jsonb))
 INTO v_bad,v_result FROM checked;
 IF v_bad THEN RAISE EXCEPTION 'Paid project allocation evidence is inconsistent; review' USING ERRCODE='22023'; END IF;
 IF octet_length(v_result::text)>1048576 THEN RAISE EXCEPTION 'Project payroll page too large' USING ERRCODE='54000'; END IF;
 RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.project_paid_worker_evidence(uuid,date,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_paid_worker_evidence(uuid,date,uuid,integer) TO authenticated;
DO $$ BEGIN
 IF has_function_privilege('anon','public.project_paid_worker_evidence(uuid,date,uuid,integer)','EXECUTE') OR has_function_privilege('service_role','public.project_paid_worker_evidence(uuid,date,uuid,integer)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected inherited project payroll function privileges'; END IF;
END $$;
