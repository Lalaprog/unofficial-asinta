-- DRAFT ONLY, NOT A RELEASE MIGRATION. Read-only support for the experimental
-- weekly workflow. Requires the exact uninstalled generator, approval, payment
-- and allocation drafts. This does not install or enable the workflow.
CREATE FUNCTION public.weekly_worker_draft_details(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 SELECT jsonb_build_object(
  'payroll_id',p.id,'worker_id',p.worker_id,'period_start',p.period_start,'period_end',p.period_end,
  'status',p.status,'calculation',s.calculation,
  'gross',p.gross_pay::numeric(10,2)::text,'bale',p.bale_deduction::numeric(10,2)::text,
  'other',p.other_deductions::numeric(10,2)::text,'net',p.net_pay::numeric(10,2)::text,
  'payment_date',d.payment_date,'approved',s.approved_by IS NOT NULL,
  'allocations',(SELECT coalesce(jsonb_agg(jsonb_build_object('project_id',a.project_id,
    'hours',a.hours::text,'wage',a.wage::text,'allowance',a.allowance::text,'gross',a.gross::text)
    ORDER BY a.project_id),'[]'::jsonb) FROM public.weekly_worker_paid_allocations a WHERE a.payroll_id=p.id))
 INTO v_result FROM public.weekly_worker_draft_sources s JOIN public.payroll p ON p.id=s.payroll_id
 LEFT JOIN public.payroll_payment_dates d ON d.payroll_id=p.id WHERE s.payroll_id=p_id;
 IF v_result IS NULL THEN RAISE EXCEPTION 'Source-bound weekly voucher unavailable; review legacy history separately' USING ERRCODE='P0002'; END IF;
 RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.weekly_worker_draft_details(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.weekly_worker_draft_details(uuid) TO authenticated;
DO $$ BEGIN
 IF has_function_privilege('anon','public.weekly_worker_draft_details(uuid)','EXECUTE')
 OR has_function_privilege('service_role','public.weekly_worker_draft_details(uuid)','EXECUTE') THEN
  RAISE EXCEPTION 'Unexpected inherited privilege on weekly voucher details'; END IF;
END $$;
