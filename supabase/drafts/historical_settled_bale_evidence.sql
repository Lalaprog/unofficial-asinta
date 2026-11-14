-- DRAFT ONLY; NOT A DEPLOYABLE MIGRATION. Requires the exact weekly payment
-- candidates, guarded legacy Bale writer and historical paid-date annotation.
-- Records a Founder's assertion about ONE already-released Bale, fully deducted
-- in ONE already-paid weekly voucher. It NEVER creates an advance, request,
-- payment, expense or allocation, and never changes a balance. Evidence is not
-- proof; never use it to infer an outstanding balance or to send money. Multiple
-- releases, unknown dates, missing paid vouchers and ambiguous histories require
-- separate manual review; this deliberately fails closed instead of guessing.

CREATE TABLE public.historical_settled_bale_evidence (
 request_id uuid PRIMARY KEY,
 payroll_id uuid NOT NULL UNIQUE REFERENCES public.payroll(id) ON DELETE RESTRICT,
 worker_id uuid NOT NULL REFERENCES public.workers(id) ON DELETE RESTRICT,
 project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 recorded_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 release_date date NOT NULL,
 amount numeric(10,2) NOT NULL CHECK(amount>0),
 payment_date date NOT NULL,
 payment_date_source text NOT NULL CHECK(payment_date_source IN ('recorded_payment','historical_annotation')),
 evidence_note text NOT NULL CHECK(length(evidence_note) BETWEEN 1 AND 500),
 voucher_snapshot jsonb NOT NULL
);
ALTER TABLE public.historical_settled_bale_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.historical_settled_bale_evidence FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.historical_settled_bale_evidence TO authenticated;
CREATE POLICY founder_reads_historical_settled_bale ON public.historical_settled_bale_evidence
 FOR SELECT TO authenticated USING (coalesce(public.is_founder(),false) AND coalesce(public.session_assurance_satisfied(),false));
DO $$ BEGIN
 IF has_table_privilege('anon','public.historical_settled_bale_evidence','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 OR has_table_privilege('authenticated','public.historical_settled_bale_evidence','INSERT,UPDATE,DELETE,TRUNCATE')
 OR has_table_privilege('service_role','public.historical_settled_bale_evidence','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.historical_settled_bale_evidence'::regclass AND a.attnum>0 AND NOT a.attisdropped AND
  (has_column_privilege('anon',a.attrelid,a.attname,'SELECT,INSERT,UPDATE') OR has_column_privilege('authenticated',a.attrelid,a.attname,'INSERT,UPDATE') OR has_column_privilege('service_role',a.attrelid,a.attname,'SELECT,INSERT,UPDATE'))) THEN RAISE EXCEPTION 'Unexpected inherited historical Bale privileges'; END IF;
END $$;
CREATE FUNCTION public.guard_historical_settled_bale_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Historical Bale evidence is immutable; use separate reviewed correction' USING ERRCODE='22023'; END;
$$;
REVOKE ALL ON FUNCTION public.guard_historical_settled_bale_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_historical_settled_bale_immutable BEFORE UPDATE OR DELETE ON public.historical_settled_bale_evidence
 FOR EACH ROW EXECUTE FUNCTION public.guard_historical_settled_bale_immutable();

CREATE FUNCTION public.record_historical_settled_bale(p_request uuid,p_payroll uuid,p_expected jsonb,p_project uuid,p_release_date date,p_amount numeric,p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_prev public.historical_settled_bale_evidence%ROWTYPE; v_pay public.payroll%ROWTYPE; v_note text;v_email text;v_payment date;v_source text;v_count integer;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Historical Bale evidence requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_payroll IS NULL OR p_expected IS NULL OR p_project IS NULL OR p_release_date IS NULL OR NOT isfinite(p_release_date)
  OR p_release_date<DATE '1900-01-01' OR p_release_date>(statement_timestamp() AT TIME ZONE 'Asia/Manila')::date
  OR p_amount IS NULL OR p_amount='NaN'::numeric OR p_amount<=0 OR p_amount>=100000000 OR p_amount<>round(p_amount,2)
  OR p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Provide valid release date, amount and evidence note' USING ERRCODE='22023'; END IF;
 v_note:=btrim(p_note);PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 -- Same conservative table order as the payment and historical-date candidates.
 LOCK TABLE public.users,public.workers,public.projects,public.attendance,public.attendance_time_details,public.worker_allowances,
  public.advances,public.advance_requests,public.payroll,public.weekly_worker_draft_sources,public.payroll_payment_dates,
  public.weekly_worker_paid_allocations,public.historical_paid_date_annotations,public.historical_settled_bale_evidence IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO v_prev FROM public.historical_settled_bale_evidence WHERE request_id=p_request;
 IF FOUND THEN
  IF (v_prev.payroll_id,v_prev.recorded_by,v_prev.voucher_snapshot,v_prev.project_id,v_prev.release_date,v_prev.amount,v_prev.evidence_note)
   IS DISTINCT FROM (p_payroll,auth.uid(),p_expected,p_project,p_release_date,p_amount,v_note) THEN RAISE EXCEPTION 'Request ID used for different Bale evidence' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('replayed',true,'request_id',p_request,'payroll_id',p_payroll);
 END IF;
 SELECT * INTO v_pay FROM public.payroll WHERE id=p_payroll FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Paid voucher unavailable' USING ERRCODE='P0002'; END IF;
 IF v_pay.status<>'paid' OR v_pay.period_end<>v_pay.period_start+6 OR extract(dow FROM v_pay.period_start)<>0 THEN RAISE EXCEPTION 'Only an existing paid Sunday–Saturday worker voucher is supported' USING ERRCODE='22023'; END IF;
 IF public.historical_paid_voucher_snapshot(v_pay) IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Voucher changed since review' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM public.workers w WHERE w.id=v_pay.worker_id AND (
  strpos(lower(w.position),'supervisor')>0 OR EXISTS(SELECT 1 FROM public.users u WHERE u.role='supervisor' AND (u.id=w.id OR lower(btrim(u.name))=lower(btrim(w.name))))))
  OR EXISTS(SELECT 1 FROM public.attendance a WHERE a.worker_id=v_pay.worker_id AND a.date BETWEEN v_pay.period_start AND v_pay.period_end
   AND (a.worker_id=a.recorded_by OR strpos(coalesce(a.notes,''),'Pending Founder Review')>0 OR strpos(coalesce(a.notes,''),'Founder Review:')>0)) THEN
  RAISE EXCEPTION 'Possible Supervisor identity requires separate review' USING ERRCODE='22023'; END IF;
 IF v_pay.bale_deduction IS DISTINCT FROM p_amount OR v_pay.gross_pay IS NULL OR v_pay.other_deductions IS NULL OR v_pay.net_pay IS NULL
  OR v_pay.gross_pay-v_pay.bale_deduction-v_pay.other_deductions IS DISTINCT FROM v_pay.net_pay THEN RAISE EXCEPTION 'Voucher totals or full Bale deduction require separate reconciliation' USING ERRCODE='22023'; END IF;
 IF p_release_date NOT BETWEEN v_pay.period_start AND v_pay.period_end THEN RAISE EXCEPTION 'Release date is outside original week' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.payroll p WHERE p.id<>p_payroll AND p.worker_id=v_pay.worker_id AND p.period_start<=v_pay.period_end AND p.period_end>=v_pay.period_start)
  OR EXISTS(SELECT 1 FROM public.advances a WHERE a.worker_id=v_pay.worker_id AND a.date BETWEEN v_pay.period_start AND v_pay.period_end)
  OR EXISTS(SELECT 1 FROM public.historical_settled_bale_evidence WHERE payroll_id=p_payroll) THEN
  RAISE EXCEPTION 'Overlapping voucher, Bale or evidence requires separate reconciliation' USING ERRCODE='22023'; END IF;
 SELECT count(*),min(d),min(src) INTO v_count,v_payment,v_source FROM (
  SELECT payment_date d,'recorded_payment'::text src FROM public.payroll_payment_dates WHERE payroll_id=p_payroll
  UNION ALL SELECT payment_date,'historical_annotation' FROM public.historical_paid_date_annotations WHERE payroll_id=p_payroll AND voucher_snapshot=p_expected
 ) dates;
 IF v_count<>1 OR v_payment IS NULL OR NOT isfinite(v_payment) OR v_payment<p_release_date OR v_payment<v_pay.period_start
  OR v_payment>(statement_timestamp() AT TIME ZONE 'Asia/Manila')::date THEN RAISE EXCEPTION 'A single recorded payment-date assertion on or after release is required' USING ERRCODE='22023'; END IF;
 INSERT INTO public.historical_settled_bale_evidence(request_id,payroll_id,worker_id,project_id,recorded_by,release_date,amount,payment_date,payment_date_source,evidence_note,voucher_snapshot)
 VALUES(p_request,p_payroll,v_pay.worker_id,p_project,auth.uid(),p_release_date,p_amount,v_payment,v_source,v_note,p_expected);
 SELECT email INTO v_email FROM public.users WHERE id=auth.uid();
 INSERT INTO public.audit_log(actor_id,actor_email,action,table_name,record_id,before_row,after_row)
 VALUES(auth.uid(),v_email,'insert','historical_settled_bale_evidence',p_request,NULL,jsonb_build_object('payroll_id',p_payroll,'worker_id',v_pay.worker_id,'project_id',p_project,'release_date',p_release_date,'amount',p_amount,'payment_date',v_payment,'payment_date_source',v_source,'evidence_note',v_note,'voucher_snapshot',p_expected));
 RETURN jsonb_build_object('replayed',false,'request_id',p_request,'payroll_id',p_payroll);
END;
$$;
REVOKE ALL ON FUNCTION public.record_historical_settled_bale(uuid,uuid,jsonb,uuid,date,numeric,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_historical_settled_bale(uuid,uuid,jsonb,uuid,date,numeric,text) TO authenticated;
DO $$ BEGIN IF has_function_privilege('anon','public.record_historical_settled_bale(uuid,uuid,jsonb,uuid,date,numeric,text)','EXECUTE') OR has_function_privilege('service_role','public.record_historical_settled_bale(uuid,uuid,jsonb,uuid,date,numeric,text)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected inherited historical Bale action privilege'; END IF; END $$;
