-- DRAFT ONLY: coordinated cutover candidate, NOT a migration to apply alone.
-- Prerequisite: guard_legacy_bale_payment.sql must be installed and reviewed,
-- and every client must use record_guarded_weekly_payment before this cutover.
-- The prerequisite string checks below are tripwires, not proof that installed
-- functions/triggers match the reviewed source; inspect the full catalog and
-- test the release sequence before any deployment.
-- Old clients attempting to mark paid are deliberately rejected. No transfer
-- is sent; this records the Founder's statement that an external payment occurred.
-- This does not implement weekly payroll generation, allocation, historical
-- payment-date annotation, or the Bale request/release schedule.

DO $$
DECLARE v_definition text;
BEGIN
  IF to_regprocedure('public.legacy_set_payroll_status_atomic_unchecked(uuid,text)') IS NULL
     OR to_regprocedure('public.guard_new_advance_finalized_payroll()') IS NULL
     OR to_regprocedure('public.set_payroll_status_atomic(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'The reviewed Bale payment guard is required before this draft';
  END IF;
  SELECT pg_get_functiondef('public.set_payroll_status_atomic(uuid,text)'::regprocedure) INTO v_definition;
  IF position('Voucher Bale deduction does not match all recorded releases' IN v_definition)=0
     OR position('Outstanding Bale outside this period' IN v_definition)=0 THEN
    RAISE EXCEPTION 'Expected guarded payroll transition not found';
  END IF;
END;
$$;

-- Never guess dates for existing paid vouchers; no backfill is performed.
CREATE TABLE public.payroll_payment_dates (
  payroll_id uuid PRIMARY KEY REFERENCES public.payroll(id) ON DELETE RESTRICT,
  payment_date date NOT NULL CHECK (payment_date >= DATE '1900-01-01'),
  recorded_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.payroll_payment_dates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_payment_dates FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.payroll_payment_dates TO authenticated;
CREATE POLICY founder_reads_payroll_payment_dates ON public.payroll_payment_dates
  FOR SELECT TO authenticated USING (coalesce(public.is_founder(),false));
DO $$
BEGIN
  IF has_table_privilege('anon','public.payroll_payment_dates','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('authenticated','public.payroll_payment_dates','INSERT,UPDATE,DELETE,TRUNCATE')
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.payroll_payment_dates'::regclass
       AND a.attnum>0 AND NOT a.attisdropped AND (
         has_column_privilege('anon',a.attrelid,a.attname,'SELECT,INSERT,UPDATE') OR
         has_column_privilege('authenticated',a.attrelid,a.attname,'INSERT,UPDATE'))) THEN
    RAISE EXCEPTION 'Unexpected inherited privileges on payroll payment dates';
  END IF;
END;
$$;

ALTER FUNCTION public.set_payroll_status_atomic(uuid,text) RENAME TO weekly_guarded_status_internal;
REVOKE ALL ON FUNCTION public.weekly_guarded_status_internal(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
DO $$
BEGIN
  IF has_function_privilege('anon','public.weekly_guarded_status_internal(uuid,text)','EXECUTE')
     OR has_function_privilege('authenticated','public.weekly_guarded_status_internal(uuid,text)','EXECUTE')
     OR has_function_privilege('service_role','public.weekly_guarded_status_internal(uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'Guarded internal transition remains callable through inherited privileges';
  END IF;
END;
$$;

-- Retain the old approval API; disallow its undated paid transition.
CREATE FUNCTION public.set_payroll_status_atomic(p_payroll_id uuid,p_status text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NOT coalesce(public.is_founder(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
  IF p_status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'Record payment with its actual date using the updated payment action; refresh the page and check the ledger before retrying' USING ERRCODE='22023';
  END IF;
  RETURN public.weekly_guarded_status_internal(p_payroll_id,p_status);
END;
$$;
REVOKE ALL ON FUNCTION public.set_payroll_status_atomic(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.set_payroll_status_atomic(uuid,text) TO authenticated;

CREATE FUNCTION public.record_guarded_weekly_payment(p_payroll_id uuid,p_payment_date date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_worker uuid; v_status text; v_start date; v_end date;
  v_existing public.payroll_payment_dates%ROWTYPE; v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false)
     OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
    RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Payment recording requires read committed isolation' USING ERRCODE='P1002';
  END IF;
  IF p_payment_date IS NULL OR p_payment_date < DATE '1900-01-01'
     OR p_payment_date > (statement_timestamp() AT TIME ZONE 'Asia/Manila')::date THEN
    RAISE EXCEPTION 'Enter the actual payment date, not a future date' USING ERRCODE='22023';
  END IF;
  SELECT worker_id INTO v_worker FROM public.payroll WHERE id=p_payroll_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll voucher not found' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM public.workers WHERE id=v_worker FOR UPDATE;
  SELECT status,period_start,period_end INTO v_status,v_start,v_end
    FROM public.payroll WHERE id=p_payroll_id AND worker_id=v_worker FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll voucher changed; refresh and retry' USING ERRCODE='40001'; END IF;
  IF v_end <> v_start+6 OR extract(dow FROM v_start) <> 0 THEN
    RAISE EXCEPTION 'Only Sunday–Saturday worker vouchers are supported by this payment action' USING ERRCODE='22023';
  END IF;
  -- Conservative existing-identity heuristic, not proof of worker identity.
  -- A coordinated release still needs a reliable Supervisor/worker link.
  IF EXISTS(SELECT 1 FROM public.workers w WHERE w.id=v_worker AND (
      strpos(lower(w.position),'supervisor')>0 OR EXISTS(SELECT 1 FROM public.users u WHERE u.role='supervisor'
        AND (u.id=w.id OR lower(btrim(u.name))=lower(btrim(w.name))))))
     OR EXISTS(SELECT 1 FROM public.attendance a WHERE a.worker_id=v_worker AND a.date BETWEEN v_start AND v_end
       AND (a.worker_id=a.recorded_by OR strpos(coalesce(a.notes,''),'Pending Founder Review')>0
         OR strpos(coalesce(a.notes,''),'Founder Review:')>0)) THEN
    RAISE EXCEPTION 'Possible Supervisor identity requires separate payroll review' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_existing FROM public.payroll_payment_dates WHERE payroll_id=p_payroll_id;
  IF FOUND THEN
    IF v_status <> 'paid' OR v_existing.payment_date <> p_payment_date THEN
      RAISE EXCEPTION 'Existing payment date or status differs; review before retrying' USING ERRCODE='22023';
    END IF;
    RETURN jsonb_build_object('outcome','already_recorded','payroll',
      (SELECT to_jsonb(p) FROM public.payroll p WHERE p.id=p_payroll_id),
      'advances','[]'::jsonb,'payment_date',v_existing.payment_date);
  END IF;
  IF v_status <> 'approved' THEN
    RAISE EXCEPTION 'Only an approved, not-yet-paid voucher can be recorded here; review historical payments separately' USING ERRCODE='22023';
  END IF;
  -- A deduction cannot represent repayment of money released after the claimed
  -- payment date. This is checked under the same worker lock as release/payment.
  IF EXISTS(SELECT 1 FROM public.advances a WHERE a.worker_id=v_worker
    AND a.date BETWEEN v_start AND v_end AND a.status<>'cancelled' AND a.date>p_payment_date) THEN
    RAISE EXCEPTION 'Payment date precedes a recorded Bale release; review both dates' USING ERRCODE='22023';
  END IF;
  -- The prerequisite guard checks same-period Bale, overlapping final vouchers,
  -- amounts, and prior deductions; its nested transition and this evidence
  -- insert commit or roll back as one transaction.
  v_result := public.weekly_guarded_status_internal(p_payroll_id,'paid');
  IF v_result->>'outcome' IS DISTINCT FROM 'updated' THEN
    RAISE EXCEPTION 'Payment transition was not confirmed' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.payroll_payment_dates(payroll_id,payment_date,recorded_by)
    VALUES(p_payroll_id,p_payment_date,auth.uid());
  RETURN v_result || jsonb_build_object('payment_date',p_payment_date);
END;
$$;
REVOKE ALL ON FUNCTION public.record_guarded_weekly_payment(uuid,date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_guarded_weekly_payment(uuid,date) TO authenticated;
