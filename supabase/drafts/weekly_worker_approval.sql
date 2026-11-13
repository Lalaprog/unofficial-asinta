-- DRAFT ONLY: an approval candidate for source-bound weekly drafts. Requires
-- weekly_worker_generator.sql, its exact reviewed prerequisites and the existing
-- atomic status RPC. It deliberately leaves payment blocked: project posting,
-- late-edit protections, release policy and payment integration are unfinished.
-- Do not install this draft on a hosted database or treat it as a cutover script.

ALTER TABLE public.weekly_worker_draft_sources
 ADD COLUMN approved_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
 ADD COLUMN approved_at timestamptz,
 ADD COLUMN approval_xid bigint,
 ADD CONSTRAINT weekly_draft_approval_fields CHECK ((approved_by IS NULL)=(approved_at IS NULL));

-- The only permissible status transition is the narrow transition explicitly
-- authorized by the Founder-only function below in the CURRENT transaction.
-- Authenticated clients cannot write the source row or mint the marker.
CREATE OR REPLACE FUNCTION public.guard_weekly_worker_draft()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_source public.weekly_worker_draft_sources%ROWTYPE;
BEGIN
 SELECT * INTO v_source FROM public.weekly_worker_draft_sources WHERE payroll_id=OLD.id;
 IF FOUND THEN
  IF TG_OP='UPDATE' AND v_source.approval_xid=txid_current() AND v_source.approved_by=auth.uid()
    AND OLD.status='draft' AND NEW.status='approved'
    AND (to_jsonb(NEW)-'status') IS NOT DISTINCT FROM (to_jsonb(OLD)-'status') THEN
   RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Weekly source-bound voucher is frozen outside the reviewed approval workflow' USING ERRCODE='22023';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_weekly_worker_draft() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.approve_weekly_worker_draft(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_source public.weekly_worker_draft_sources%ROWTYPE; v_pay public.payroll%ROWTYPE;
 v_snapshot jsonb; v_worker jsonb; v_sources jsonb; v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Weekly approval requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_id IS NULL THEN RAISE EXCEPTION 'Choose a weekly draft' USING ERRCODE='22023'; END IF;
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 LOCK TABLE public.users,public.workers,public.attendance,public.attendance_time_details,
  public.worker_allowances,public.advances,public.advance_requests,public.payroll,
  public.weekly_worker_draft_sources IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO v_source FROM public.weekly_worker_draft_sources WHERE payroll_id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Weekly source-bound draft unavailable' USING ERRCODE='P0002'; END IF;
 SELECT * INTO v_pay FROM public.payroll WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR v_pay.worker_id<>v_source.worker_id OR v_pay.period_start<>v_source.period_start OR v_pay.period_end<>v_source.period_start+6 THEN
  RAISE EXCEPTION 'Weekly voucher changed; review' USING ERRCODE='40001'; END IF;
 -- A lost response may be retried, but an old-client approval or corrupted
 -- marker is never retroactively accepted as one of these approvals.
 IF v_pay.status='approved' AND v_source.approved_by IS NOT NULL AND v_source.approval_xid IS NULL THEN
  RETURN jsonb_build_object('outcome','already_approved','payroll',to_jsonb(v_pay));
 END IF;
 IF v_pay.status<>'draft' OR v_source.approved_by IS NOT NULL OR v_source.approval_xid IS NOT NULL THEN
  RAISE EXCEPTION 'Weekly voucher state requires review' USING ERRCODE='22023'; END IF;
 IF public.weekly_worker_source_has_future(v_source.source_snapshot,(statement_timestamp() AT TIME ZONE 'Asia/Manila')::date) THEN RAISE EXCEPTION 'Future-dated attendance, allowance or Bale requires review before approval' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.payroll p WHERE p.id<>p_id AND p.worker_id=v_pay.worker_id AND p.period_start<=v_pay.period_end AND p.period_end>=v_pay.period_start) THEN
  RAISE EXCEPTION 'Another overlapping voucher requires review' USING ERRCODE='22023'; END IF;
 IF v_pay.gross_pay IS DISTINCT FROM (v_source.calculation->>'gross')::numeric
  OR v_pay.bale_deduction IS DISTINCT FROM (v_source.calculation->>'bale')::numeric
  OR v_pay.other_deductions IS DISTINCT FROM 0::numeric
  OR v_pay.net_pay IS DISTINCT FROM (v_source.calculation->>'net')::numeric
  OR v_pay.days_worked IS DISTINCT FROM round((v_source.calculation->>'regular_hours')::numeric/8,2)
  OR v_pay.hours_worked IS DISTINCT FROM ((v_source.calculation->>'regular_hours')::numeric+(v_source.calculation->>'overtime_hours')::numeric) THEN
  RAISE EXCEPTION 'Weekly voucher totals changed; review' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM public.advances a WHERE a.worker_id=v_pay.worker_id AND a.date<v_pay.period_start AND a.status IN ('active','partially_deducted'))
  OR (v_pay.bale_deduction>0 AND EXISTS(SELECT 1 FROM public.advances a WHERE a.worker_id=v_pay.worker_id AND a.date>v_pay.period_end AND a.status IN ('active','partially_deducted'))) THEN
  RAISE EXCEPTION 'Outstanding Bale outside the period requires separate review' USING ERRCODE='22023'; END IF;
 v_snapshot:=public.weekly_worker_preview_inputs(v_pay.period_start);
 IF coalesce(jsonb_typeof(v_snapshot->'workers'),'')<>'array' THEN RAISE EXCEPTION 'Weekly source snapshot unavailable' USING ERRCODE='22023'; END IF;
 SELECT value INTO v_worker FROM jsonb_array_elements(v_snapshot->'workers') WHERE value->>'id'=v_pay.worker_id::text;
 v_sources:=jsonb_build_object('version',1,'worker',v_worker,'attendance',
  (SELECT coalesce(jsonb_agg(jsonb_build_object('record',to_jsonb(a),'latest_detail',d.detail) ORDER BY a.date,a.id),'[]'::jsonb)
   FROM public.attendance a LEFT JOIN LATERAL (SELECT to_jsonb(t) detail FROM public.attendance_time_details t WHERE t.attendance_id=a.id ORDER BY t.revision_id DESC LIMIT 1) d ON true
   WHERE a.worker_id=v_pay.worker_id AND a.date BETWEEN v_pay.period_start AND v_pay.period_end),
  'allowances',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM public.worker_allowances a WHERE a.worker_id=v_pay.worker_id AND a.attendance_date BETWEEN v_pay.period_start AND v_pay.period_end),
  'advances',(SELECT coalesce(jsonb_agg(jsonb_build_object('advance',to_jsonb(a),'request',to_jsonb(r)) ORDER BY a.id),'[]'::jsonb) FROM public.advances a LEFT JOIN public.advance_requests r ON r.issued_advance_id=a.id WHERE a.worker_id=v_pay.worker_id AND a.date BETWEEN v_pay.period_start AND v_pay.period_end));
 IF v_sources IS DISTINCT FROM v_source.source_snapshot THEN
  RAISE EXCEPTION 'Weekly source data changed since generation; review before approval' USING ERRCODE='40001'; END IF;
 UPDATE public.weekly_worker_draft_sources SET approved_by=auth.uid(),approved_at=clock_timestamp(),approval_xid=txid_current() WHERE payroll_id=p_id;
 v_result:=public.set_payroll_status_atomic(p_id,'approved');
 IF v_result->>'outcome' IS DISTINCT FROM 'updated' OR v_result->'payroll'->>'status' IS DISTINCT FROM 'approved' THEN
  RAISE EXCEPTION 'Weekly approval was not confirmed' USING ERRCODE='22023'; END IF;
 UPDATE public.weekly_worker_draft_sources SET approval_xid=NULL WHERE payroll_id=p_id;
 RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.approve_weekly_worker_draft(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.approve_weekly_worker_draft(uuid) TO authenticated;
