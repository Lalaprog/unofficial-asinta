-- DRAFT ONLY, NOT A DEPLOYABLE MIGRATION. Requires the exact, reviewed weekly
-- generator, approval, legacy Bale guard and dated-payment candidates. This
-- experimental integration intentionally disables the standalone dated-payment
-- RPC, including for legacy vouchers, until a coordinated client cutover exists.
-- It records an external payment; it does not transfer money. Project entries
-- are gross payroll attribution, NOT a combined project expense total. Legacy
-- expenses may already include Bale; adding these entries to expense totals
-- without explicit reconciliation can double-count. Do not install on a host.

CREATE TABLE public.weekly_worker_paid_allocations (
 payroll_id uuid NOT NULL REFERENCES public.payroll(id) ON DELETE RESTRICT,
 project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 hours numeric(8,2) NOT NULL CHECK (hours>0),
 wage numeric(10,2) NOT NULL CHECK (wage>=0),
 allowance numeric(10,2) NOT NULL CHECK (allowance>=0),
 gross numeric(10,2) NOT NULL CHECK (gross=wage+allowance),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(payroll_id,project_id)
);
ALTER TABLE public.weekly_worker_paid_allocations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.weekly_worker_paid_allocations FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.weekly_worker_paid_allocations TO authenticated;
CREATE POLICY founder_reads_weekly_paid_allocations ON public.weekly_worker_paid_allocations
 FOR SELECT TO authenticated USING (coalesce(public.is_founder(),false) AND coalesce(public.session_assurance_satisfied(),false));
DO $$ BEGIN
 IF has_table_privilege('anon','public.weekly_worker_paid_allocations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 OR has_table_privilege('authenticated','public.weekly_worker_paid_allocations','INSERT,UPDATE,DELETE,TRUNCATE')
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.weekly_worker_paid_allocations'::regclass AND a.attnum>0 AND NOT a.attisdropped AND
  (has_column_privilege('anon',a.attrelid,a.attname,'SELECT,INSERT,UPDATE') OR has_column_privilege('authenticated',a.attrelid,a.attname,'INSERT,UPDATE'))) THEN
  RAISE EXCEPTION 'Unexpected inherited privileges on weekly paid allocations'; END IF;
END $$;
CREATE FUNCTION public.guard_weekly_paid_allocation_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Paid allocation is immutable; review a separate correction' USING ERRCODE='22023'; END;
$$;
REVOKE ALL ON FUNCTION public.guard_weekly_paid_allocation_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_weekly_paid_allocation_immutable BEFORE UPDATE OR DELETE ON public.weekly_worker_paid_allocations
 FOR EACH ROW EXECUTE FUNCTION public.guard_weekly_paid_allocation_immutable();

ALTER TABLE public.weekly_worker_draft_sources
 ADD COLUMN payment_xid bigint,
 ADD COLUMN payment_actor uuid REFERENCES public.users(id) ON DELETE RESTRICT;

-- Keep the dated-payment routine internal: otherwise older clients could pay a
-- voucher without creating project allocations. The function's existing guard
-- and audit semantics still apply; only the integrated action may invoke it.
ALTER FUNCTION public.record_guarded_weekly_payment(uuid,date) RENAME TO weekly_payment_date_internal;
REVOKE ALL ON FUNCTION public.weekly_payment_date_internal(uuid,date) FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN
 IF has_function_privilege('anon','public.weekly_payment_date_internal(uuid,date)','EXECUTE')
 OR has_function_privilege('authenticated','public.weekly_payment_date_internal(uuid,date)','EXECUTE')
 OR has_function_privilege('service_role','public.weekly_payment_date_internal(uuid,date)','EXECUTE') THEN
  RAISE EXCEPTION 'Internal payment remains callable through inherited privileges'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.guard_weekly_worker_draft()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_source public.weekly_worker_draft_sources%ROWTYPE;
BEGIN
 SELECT * INTO v_source FROM public.weekly_worker_draft_sources WHERE payroll_id=OLD.id;
 IF FOUND THEN
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'status') IS NOT DISTINCT FROM (to_jsonb(OLD)-'status') AND (
     (v_source.approval_xid=txid_current() AND v_source.approved_by=auth.uid() AND OLD.status='draft' AND NEW.status='approved') OR
     (v_source.payment_xid=txid_current() AND v_source.payment_actor=auth.uid() AND OLD.status='approved' AND NEW.status='paid')) THEN
   RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Weekly source-bound voucher is frozen outside the reviewed workflow' USING ERRCODE='22023';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_weekly_worker_draft() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.record_weekly_worker_payment(p_id uuid,p_payment_date date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_source public.weekly_worker_draft_sources%ROWTYPE; v_pay public.payroll%ROWTYPE;
 v_snapshot jsonb; v_worker jsonb; v_sources jsonb; v_result jsonb;
 v_wage numeric; v_allowance numeric; v_hours numeric; v_alloc_wage numeric; v_alloc_allowance numeric; v_alloc_gross numeric; v_alloc_hours numeric; v_count bigint;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Weekly payment requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_id IS NULL THEN RAISE EXCEPTION 'Choose a weekly voucher' USING ERRCODE='22023'; END IF;
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 LOCK TABLE public.users,public.workers,public.projects,public.attendance,public.attendance_time_details,
  public.worker_allowances,public.advances,public.advance_requests,public.payroll,
  public.weekly_worker_draft_sources,public.payroll_payment_dates,public.weekly_worker_paid_allocations IN SHARE ROW EXCLUSIVE MODE;
 -- The actor's role may have changed while this statement waited for locks.
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_source FROM public.weekly_worker_draft_sources WHERE payroll_id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Source-bound weekly voucher unavailable; review older vouchers separately' USING ERRCODE='P0002'; END IF;
 SELECT * INTO v_pay FROM public.payroll WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR v_pay.worker_id<>v_source.worker_id OR v_pay.period_start<>v_source.period_start OR v_pay.period_end<>v_source.period_start+6 THEN
  RAISE EXCEPTION 'Weekly voucher changed; review' USING ERRCODE='40001'; END IF;
 v_wage:=(v_source.calculation->>'wage')::numeric;
 v_allowance:=(v_source.calculation->>'allowance')::numeric;
 v_hours:=(v_source.calculation->>'regular_hours')::numeric+(v_source.calculation->>'overtime_hours')::numeric;
 IF v_wage IS NULL OR v_allowance IS NULL OR v_hours IS NULL OR v_wage<0 OR v_allowance<0 OR v_hours<0
  OR v_pay.gross_pay IS DISTINCT FROM v_wage+v_allowance
  OR v_pay.gross_pay IS DISTINCT FROM (v_source.calculation->>'gross')::numeric
  OR v_pay.bale_deduction IS DISTINCT FROM (v_source.calculation->>'bale')::numeric
  OR v_pay.other_deductions IS DISTINCT FROM 0::numeric OR v_pay.net_pay IS DISTINCT FROM (v_source.calculation->>'net')::numeric
  OR v_pay.days_worked IS DISTINCT FROM round((v_source.calculation->>'regular_hours')::numeric/8,2)
  OR v_pay.hours_worked IS DISTINCT FROM v_hours THEN
  RAISE EXCEPTION 'Weekly voucher totals changed; review' USING ERRCODE='40001'; END IF;
 SELECT count(*),coalesce(sum(wage),0),coalesce(sum(allowance),0),coalesce(sum(gross),0),coalesce(sum(hours),0)
  INTO v_count,v_alloc_wage,v_alloc_allowance,v_alloc_gross,v_alloc_hours FROM public.weekly_worker_paid_allocations WHERE payroll_id=p_id;
 IF v_pay.status='paid' THEN
  IF v_source.approved_by IS NULL OR v_source.approved_at IS NULL OR v_source.approval_xid IS NOT NULL OR v_source.payment_actor IS NULL OR v_source.payment_xid IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM public.payroll_payment_dates d WHERE d.payroll_id=p_id AND d.recorded_by=v_source.payment_actor)
   OR (v_hours>0 AND v_count=0) OR (v_hours=0 AND v_count<>0)
   OR (v_alloc_wage,v_alloc_allowance,v_alloc_gross,v_alloc_hours) IS DISTINCT FROM (v_wage,v_allowance,v_pay.gross_pay,v_hours) THEN
   RAISE EXCEPTION 'Recorded payment allocation is incomplete; review before retrying' USING ERRCODE='22023'; END IF;
  RETURN public.weekly_payment_date_internal(p_id,p_payment_date);
 END IF;
 IF v_pay.status<>'approved' OR v_source.approved_by IS NULL OR v_source.approved_at IS NULL OR v_source.approval_xid IS NOT NULL
  OR v_source.payment_actor IS NOT NULL OR v_source.payment_xid IS NOT NULL OR v_count<>0
  OR EXISTS(SELECT 1 FROM public.payroll_payment_dates WHERE payroll_id=p_id) THEN
  RAISE EXCEPTION 'Weekly payment state requires review' USING ERRCODE='22023'; END IF;
 IF public.weekly_worker_source_has_future(v_source.source_snapshot,(statement_timestamp() AT TIME ZONE 'Asia/Manila')::date) THEN RAISE EXCEPTION 'Future-dated attendance, allowance or Bale requires review before payment recording' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.payroll p WHERE p.id<>p_id AND p.worker_id=v_pay.worker_id AND p.period_start<=v_pay.period_end AND p.period_end>=v_pay.period_start) THEN
  RAISE EXCEPTION 'Another overlapping voucher requires review' USING ERRCODE='22023'; END IF;
 -- Legacy Roll Call can still edit attendance after approval. Do not pay a
 -- silently changed snapshot: the change needs original-period review instead.
 v_snapshot:=public.weekly_worker_preview_inputs(v_pay.period_start);
 IF coalesce(jsonb_typeof(v_snapshot->'workers'),'')<>'array' THEN RAISE EXCEPTION 'Weekly source snapshot unavailable' USING ERRCODE='22023'; END IF;
 SELECT value INTO v_worker FROM jsonb_array_elements(v_snapshot->'workers') WHERE value->>'id'=v_pay.worker_id::text;
 v_sources:=jsonb_build_object('version',1,'worker',v_worker,'attendance',
  (SELECT coalesce(jsonb_agg(jsonb_build_object('record',to_jsonb(a),'latest_detail',d.detail) ORDER BY a.date,a.id),'[]'::jsonb)
   FROM public.attendance a LEFT JOIN LATERAL (SELECT to_jsonb(t) detail FROM public.attendance_time_details t WHERE t.attendance_id=a.id ORDER BY t.revision_id DESC LIMIT 1) d ON true
   WHERE a.worker_id=v_pay.worker_id AND a.date BETWEEN v_pay.period_start AND v_pay.period_end),
  'allowances',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM public.worker_allowances a WHERE a.worker_id=v_pay.worker_id AND a.attendance_date BETWEEN v_pay.period_start AND v_pay.period_end),
  'advances',(SELECT coalesce(jsonb_agg(jsonb_build_object('advance',to_jsonb(a),'request',to_jsonb(r)) ORDER BY a.id),'[]'::jsonb) FROM public.advances a LEFT JOIN public.advance_requests r ON r.issued_advance_id=a.id WHERE a.worker_id=v_pay.worker_id AND a.date BETWEEN v_pay.period_start AND v_pay.period_end));
 IF v_sources IS DISTINCT FROM v_source.source_snapshot THEN RAISE EXCEPTION 'Weekly source data changed since approval; review before recording payment' USING ERRCODE='40001'; END IF;
 IF v_hours=0 AND (v_wage<>0 OR v_allowance<>0) THEN RAISE EXCEPTION 'No worked hours for a positive allocation' USING ERRCODE='22023'; END IF;
 -- Compute site shares from the approved source, not from current assignments.
 -- Wages are first rounded for the worker, then split into whole centavos by
 -- largest remainder; deterministic UUID order breaks ties. Allowances stay at
 -- their recorded site. Bale is not added or subtracted from gross attribution.
 WITH worked AS (
  SELECT (x->'record'->>'project_id')::uuid AS project_id,
   sum(CASE WHEN jsonb_typeof(x->'latest_detail')='object'
     THEN (x->'latest_detail'->>'regular_hours')::numeric+(x->'latest_detail'->>'overtime_hours')::numeric
     ELSE (x->'record'->>'hours_worked')::numeric END) AS hours
  FROM jsonb_array_elements(v_source.source_snapshot->'attendance') x
  WHERE x->'record'->>'status' IN ('present','half_day') GROUP BY 1
 ), allowances AS (
  SELECT (x->>'project_id')::uuid AS project_id,sum((x->>'amount')::numeric) AS amount
  FROM jsonb_array_elements(v_source.source_snapshot->'allowances') x WHERE x->>'status'='approved' GROUP BY 1
 ), weighted AS (
  SELECT w.project_id,w.hours,coalesce(a.amount,0) AS allowance,
   floor(v_wage*100*w.hours/NULLIF(v_hours,0)) AS base_cents,
   mod(v_wage*100*w.hours,NULLIF(v_hours,0)) AS remainder
  FROM worked w LEFT JOIN allowances a ON a.project_id=w.project_id
 ), ranked AS (
  SELECT *,row_number() OVER(ORDER BY remainder DESC,project_id) AS position,
   v_wage*100-sum(base_cents) OVER() AS remainder_cents FROM weighted
 )
 INSERT INTO public.weekly_worker_paid_allocations(payroll_id,project_id,hours,wage,allowance,gross)
 SELECT p_id,project_id,hours,(base_cents+CASE WHEN position<=remainder_cents THEN 1 ELSE 0 END)/100,allowance,
   (base_cents+CASE WHEN position<=remainder_cents THEN 1 ELSE 0 END)/100+allowance
 FROM ranked ORDER BY project_id;
 SELECT count(*),coalesce(sum(wage),0),coalesce(sum(allowance),0),coalesce(sum(gross),0),coalesce(sum(hours),0)
  INTO v_count,v_alloc_wage,v_alloc_allowance,v_alloc_gross,v_hours FROM public.weekly_worker_paid_allocations WHERE payroll_id=p_id;
 IF (v_pay.hours_worked>0 AND v_count=0) OR (v_pay.hours_worked=0 AND v_count<>0)
  OR (v_alloc_wage,v_alloc_allowance,v_alloc_gross,v_hours) IS DISTINCT FROM
   (v_wage,v_allowance,v_pay.gross_pay,v_pay.hours_worked) THEN
  RAISE EXCEPTION 'Project allocation does not reconcile with the approved voucher' USING ERRCODE='22023'; END IF;
 UPDATE public.weekly_worker_draft_sources SET payment_xid=txid_current(),payment_actor=auth.uid() WHERE payroll_id=p_id;
 v_result:=public.weekly_payment_date_internal(p_id,p_payment_date);
 IF v_result->>'outcome' IS DISTINCT FROM 'updated' OR v_result->'payroll'->>'status' IS DISTINCT FROM 'paid' THEN
  RAISE EXCEPTION 'Weekly payment was not confirmed' USING ERRCODE='22023'; END IF;
 UPDATE public.weekly_worker_draft_sources SET payment_xid=NULL WHERE payroll_id=p_id;
 RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.record_weekly_worker_payment(uuid,date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_weekly_worker_payment(uuid,date) TO authenticated;
