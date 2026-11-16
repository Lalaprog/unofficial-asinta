-- UNINSTALLED, READ-ONLY EXPERIMENT. One bounded, statement-consistent
-- snapshot for a Founder to manually review project expenses against paid
-- worker allocation and linked rental evidence. No classifications, totals,
-- allocations, expenses, payments, or other records are written. Not a complete
-- accounting report: legacy/external pay, correction allocation and duplicates
-- can be missing. Worker-voucher adjustment cases are comparison signals only,
-- never site cost or proof of settlement. Install only in an isolated test
-- database until coordinated review.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF to_regclass('public.projects') IS NULL OR to_regclass('public.expenses') IS NULL OR to_regclass('public.confirmed_rental_expenses') IS NULL OR to_regclass('public.paid_payroll_adjustment_cases') IS NULL OR to_regprocedure('public.project_paid_worker_evidence(uuid,date,uuid,integer)') IS NULL OR to_regprocedure('public.project_confirmed_rentals(uuid)') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Project reconciliation prerequisites missing'; END IF;
 IF to_regprocedure('public.project_cost_reconciliation_preview(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'Project reconciliation function already exists'; END IF;
END;
$preflight$;
CREATE FUNCTION public.project_cost_reconciliation_preview(p_project uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_count bigint;v_bad boolean;v_expenses jsonb;v_rentals jsonb;v_page jsonb;v_paid jsonb:='[]'::jsonb;v_adjustments jsonb;v_cursor_week date;v_cursor_id uuid;v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='42501'; END IF;
 SELECT count(*) INTO v_count FROM public.expenses WHERE project_id=p_project;
 IF v_count>200 THEN RAISE EXCEPTION 'More than 200 expenses; separate reconciliation required' USING ERRCODE='54000'; END IF;
 -- A rental is an annotation on exactly one existing expense, not an extra
 -- amount. Refuse stale, cross-site or missing financial source fields.
 SELECT EXISTS(SELECT 1 FROM public.confirmed_rental_expenses r LEFT JOIN public.expenses e ON e.id=r.expense_id
  WHERE (r.project_id=p_project OR e.project_id=p_project) AND (e.id IS NULL OR (e.project_id,e.amount,e.expense_date,e.description,e.category,coalesce(e.ai_bale_detection,false)) IS DISTINCT FROM (r.project_id,r.expense_amount,r.expense_date,r.expense_description,'equipment'::text,false))) INTO v_bad;
 IF v_bad THEN RAISE EXCEPTION 'Confirmed rental and linked expense differ; investigate' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'project_id',e.project_id,'description',e.description,'category',e.category,'amount',e.amount::text,'expense_date',e.expense_date,'ai_bale_detection',coalesce(e.ai_bale_detection,false)) ORDER BY e.expense_date DESC,e.id DESC),'[]'::jsonb) INTO v_expenses FROM public.expenses e WHERE e.project_id=p_project;
 v_rentals:=public.project_confirmed_rentals(p_project);
 -- The existing evidence function validates each lookahead and all site sums.
 -- Each call here belongs to this single STABLE statement snapshot; cap total.
 LOOP
  v_page:=public.project_paid_worker_evidence(p_project,v_cursor_week,v_cursor_id,25);
  v_paid:=v_paid||(v_page->'items');
  IF jsonb_array_length(v_paid)>500 OR (jsonb_array_length(v_paid)=500 AND (v_page->>'has_more')::boolean) THEN RAISE EXCEPTION 'More than 500 paid allocations; separate reconciliation required' USING ERRCODE='54000'; END IF;
  EXIT WHEN NOT (v_page->>'has_more')::boolean;
  v_cursor_week:=(v_paid->-1->>'period_start')::date;v_cursor_id:=(v_paid->-1->>'payroll_id')::uuid;
 END LOOP;
 -- Show the whole voucher's Bale as comparison evidence only, never a site
 -- allocation or another cost. Validate recorded math and saved calculation.
 SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(v_paid) a LEFT JOIN public.payroll p ON p.id=(a->>'payroll_id')::uuid LEFT JOIN public.weekly_worker_draft_sources s ON s.payroll_id=p.id
  WHERE p.id IS NULL OR NOT coalesce(p.gross_pay>=0 AND p.bale_deduction>=0 AND p.other_deductions>=0 AND p.net_pay>=0 AND p.gross_pay<10000000000 AND p.bale_deduction<10000000000 AND p.other_deductions<10000000000 AND p.net_pay<10000000000
   AND p.gross_pay=round(p.gross_pay,2) AND p.bale_deduction=round(p.bale_deduction,2) AND p.other_deductions=round(p.other_deductions,2) AND p.net_pay=round(p.net_pay,2)
   AND p.gross_pay-p.bale_deduction-p.other_deductions=p.net_pay AND p.gross_pay=(s.calculation->>'gross')::numeric AND p.bale_deduction=(s.calculation->>'bale')::numeric AND p.net_pay=(s.calculation->>'net')::numeric,false)) INTO v_bad;
 IF v_bad THEN RAISE EXCEPTION 'Paid voucher deduction evidence is inconsistent; investigate' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(a.value||jsonb_build_object('voucher_gross',p.gross_pay::numeric(12,2)::text,'voucher_bale',p.bale_deduction::numeric(12,2)::text,'voucher_other',p.other_deductions::numeric(12,2)::text,'voucher_net',p.net_pay::numeric(12,2)::text) ORDER BY a.ordinality),'[]'::jsonb) INTO v_paid
 FROM jsonb_array_elements(v_paid) WITH ORDINALITY a(value,ordinality) JOIN public.payroll p ON p.id=(a.value->>'payroll_id')::uuid;
 -- Whole-voucher cases are evidence to investigate, not site allocations.
 -- Include all case fields that can change the review, within the same
 -- statement snapshot. A case can appear at several sites for one voucher.
 SELECT count(*) INTO v_count FROM public.paid_payroll_adjustment_cases c
 WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(v_paid) a WHERE (a->>'payroll_id')::uuid=c.payroll_id);
 IF v_count>500 THEN RAISE EXCEPTION 'More than 500 adjustment cases; separate reconciliation required' USING ERRCODE='54000'; END IF;
 SELECT EXISTS(SELECT 1 FROM public.paid_payroll_adjustment_cases c JOIN public.payroll p ON p.id=c.payroll_id
 WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(v_paid) a WHERE (a->>'payroll_id')::uuid=c.payroll_id)
 AND (c.worker_id IS DISTINCT FROM p.worker_id OR c.difference='NaN'::numeric OR c.difference=0 OR abs(c.difference)>=10000000000 OR c.difference<>round(c.difference,2))) INTO v_bad;
 IF v_bad THEN RAISE EXCEPTION 'Adjustment case evidence is inconsistent; investigate' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('case_id',c.id,'payroll_id',c.payroll_id,'worker_id',c.worker_id,'difference',c.difference::numeric(12,2)::text,'reason',c.reason,'status',c.status,'created_by',c.created_by,'created_at',c.created_at,'resolved_by',c.resolved_by,'resolved_at',c.resolved_at,'settled_on',c.settled_on,'resolution_note',c.resolution_note) ORDER BY c.created_at DESC,c.id DESC),'[]'::jsonb) INTO v_adjustments
 FROM public.paid_payroll_adjustment_cases c WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(v_paid) a WHERE (a->>'payroll_id')::uuid=c.payroll_id);
 v_result:=jsonb_build_object('project_id',p_project,'captured_at',statement_timestamp(),'expenses',v_expenses,'rentals',v_rentals->'items','paid_allocations',v_paid,'adjustment_cases',v_adjustments);
 IF octet_length(v_result::text)>1048576 THEN RAISE EXCEPTION 'Project reconciliation snapshot too large' USING ERRCODE='54000'; END IF;
 RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.project_cost_reconciliation_preview(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_reconciliation_preview(uuid) TO authenticated;
DO $postflight$
BEGIN
 IF has_function_privilege('anon','public.project_cost_reconciliation_preview(uuid)','EXECUTE') OR has_function_privilege('service_role','public.project_cost_reconciliation_preview(uuid)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_reconciliation_preview(uuid)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected project reconciliation function privileges'; END IF;
END;
$postflight$;
