-- DRAFT ONLY, NOT A DEPLOYABLE MIGRATION. This candidate annotates an existing
-- paid voucher whose real external payment date was not recorded. It does not
-- create a voucher, issue money, change Bale balances or establish project cost.
-- Never infer payment from a status or this Founder's statement. Requires the
-- exact reviewed payroll/payment-date schema and coordinated cutover. Evidence
-- here is deliberately separate from payroll_payment_dates, whose rows imply a
-- different payment workflow. Old clients do not display this annotation.

CREATE TABLE public.historical_paid_date_annotations (
 request_id uuid PRIMARY KEY,
 payroll_id uuid NOT NULL UNIQUE REFERENCES public.payroll(id) ON DELETE RESTRICT,
 recorded_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 payment_date date NOT NULL CHECK(payment_date>=DATE '1900-01-01'),
 evidence_note text NOT NULL CHECK(length(evidence_note) BETWEEN 1 AND 500),
 voucher_snapshot jsonb NOT NULL
);
ALTER TABLE public.historical_paid_date_annotations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.historical_paid_date_annotations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.historical_paid_date_annotations TO authenticated;
CREATE POLICY founder_reads_historical_paid_dates ON public.historical_paid_date_annotations
 FOR SELECT TO authenticated USING (coalesce(public.is_founder(),false) AND coalesce(public.session_assurance_satisfied(),false));
DO $$ BEGIN
 IF has_table_privilege('anon','public.historical_paid_date_annotations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 OR has_table_privilege('authenticated','public.historical_paid_date_annotations','INSERT,UPDATE,DELETE,TRUNCATE')
 OR has_table_privilege('service_role','public.historical_paid_date_annotations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.historical_paid_date_annotations'::regclass AND a.attnum>0 AND NOT a.attisdropped AND
  (has_column_privilege('anon',a.attrelid,a.attname,'SELECT,INSERT,UPDATE') OR has_column_privilege('authenticated',a.attrelid,a.attname,'INSERT,UPDATE') OR has_column_privilege('service_role',a.attrelid,a.attname,'SELECT,INSERT,UPDATE'))) THEN
  RAISE EXCEPTION 'Unexpected inherited historical date privileges'; END IF;
END $$;
CREATE FUNCTION public.guard_historical_paid_date_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Historical date evidence is immutable; use a separate reviewed correction' USING ERRCODE='22023'; END;
$$;
REVOKE ALL ON FUNCTION public.guard_historical_paid_date_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_historical_paid_date_immutable BEFORE UPDATE OR DELETE ON public.historical_paid_date_annotations
 FOR EACH ROW EXECUTE FUNCTION public.guard_historical_paid_date_immutable();

-- Compact, exact version explicitly reviewed by the Founder. Text monetary
-- values avoid JS float coercion; this is a database snapshot, not a receipt.
CREATE FUNCTION public.historical_paid_voucher_snapshot(p public.payroll) RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT jsonb_build_object('id',p.id,'worker_id',p.worker_id,'period_start',p.period_start,'period_end',p.period_end,'status',p.status,
 'gross_pay',p.gross_pay::text,'bale_deduction',p.bale_deduction::text,'other_deductions',p.other_deductions::text,'net_pay',p.net_pay::text)
$$;
REVOKE ALL ON FUNCTION public.historical_paid_voucher_snapshot(public.payroll) FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name) WHERE has_function_privilege(r.role_name,'public.historical_paid_voucher_snapshot(public.payroll)','EXECUTE')) THEN RAISE EXCEPTION 'Unexpected inherited historical snapshot privilege'; END IF; END $$;

CREATE FUNCTION public.annotate_historical_paid_date(p_request uuid,p_payroll uuid,p_expected jsonb,p_date date,p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_previous public.historical_paid_date_annotations%ROWTYPE; v_pay public.payroll%ROWTYPE; v_note text; v_email text;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Historical annotation requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_payroll IS NULL OR p_expected IS NULL OR p_date IS NULL OR NOT isfinite(p_date) OR p_date<DATE '1900-01-01'
  OR p_date>(statement_timestamp() AT TIME ZONE 'Asia/Manila')::date OR p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 500 THEN
  RAISE EXCEPTION 'Provide a valid actual date and evidence note' USING ERRCODE='22023'; END IF;
 v_note:=btrim(p_note);PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 -- Same lock ordering as the weekly payment candidate; broad locks and all
 -- existing trigger interactions must be reviewed before any deployment.
 LOCK TABLE public.users,public.workers,public.projects,public.attendance,public.attendance_time_details,public.worker_allowances,
  public.advances,public.advance_requests,public.payroll,public.weekly_worker_draft_sources,
  public.payroll_payment_dates,public.weekly_worker_paid_allocations,public.historical_paid_date_annotations IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO v_previous FROM public.historical_paid_date_annotations WHERE request_id=p_request;
 IF FOUND THEN
  IF (v_previous.payroll_id,v_previous.recorded_by,v_previous.voucher_snapshot,v_previous.payment_date,v_previous.evidence_note)
   IS DISTINCT FROM (p_payroll,auth.uid(),p_expected,p_date,v_note) THEN RAISE EXCEPTION 'Request ID used for different evidence' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('replayed',true,'request_id',p_request,'payroll_id',p_payroll,'payment_date',v_previous.payment_date);
 END IF;
 SELECT * INTO v_pay FROM public.payroll WHERE id=p_payroll FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Paid voucher unavailable' USING ERRCODE='P0002'; END IF;
 IF v_pay.status<>'paid' THEN RAISE EXCEPTION 'Only an existing paid voucher can receive historical evidence' USING ERRCODE='22023'; END IF;
 IF p_date<v_pay.period_start THEN RAISE EXCEPTION 'Payment date cannot precede the period start' USING ERRCODE='22023'; END IF;
 IF public.historical_paid_voucher_snapshot(v_pay) IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Voucher changed since review' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM public.historical_paid_date_annotations WHERE payroll_id=p_payroll) OR EXISTS(SELECT 1 FROM public.payroll_payment_dates WHERE payroll_id=p_payroll) THEN
  RAISE EXCEPTION 'Existing payment-date evidence requires separate review' USING ERRCODE='22023'; END IF;
 INSERT INTO public.historical_paid_date_annotations(request_id,payroll_id,recorded_by,payment_date,evidence_note,voucher_snapshot)
 VALUES(p_request,p_payroll,auth.uid(),p_date,v_note,p_expected);
 SELECT email INTO v_email FROM public.users WHERE id=auth.uid();
 INSERT INTO public.audit_log(actor_id,actor_email,action,table_name,record_id,before_row,after_row)
 VALUES(auth.uid(),v_email,'insert','historical_paid_date_annotations',p_request,NULL,jsonb_build_object('payroll_id',p_payroll,'payment_date',p_date,'evidence_note',v_note,'voucher_snapshot',p_expected));
 RETURN jsonb_build_object('replayed',false,'request_id',p_request,'payroll_id',p_payroll,'payment_date',p_date);
END;
$$;
REVOKE ALL ON FUNCTION public.annotate_historical_paid_date(uuid,uuid,jsonb,date,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.annotate_historical_paid_date(uuid,uuid,jsonb,date,text) TO authenticated;
DO $$ BEGIN IF has_function_privilege('anon','public.annotate_historical_paid_date(uuid,uuid,jsonb,date,text)','EXECUTE') OR has_function_privilege('service_role','public.annotate_historical_paid_date(uuid,uuid,jsonb,date,text)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected inherited historical annotation privilege'; END IF; END $$;
