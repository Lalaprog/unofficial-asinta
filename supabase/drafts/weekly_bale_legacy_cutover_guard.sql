-- DRAFT ONLY. Not a standalone migration or hosted installation script.
-- This coordinated cutover guard blocks legacy direct Bale inserts and manual
-- deductions for newly scheduled weekly releases, including service/owner
-- maintenance paths. Existing historical records are not rewritten. Resolve
-- legacy open requests and outstanding advances before installing. A trusted
-- privileged owner can disable triggers or forge evidence; this is not a
-- protection against owner tampering, recovery jobs, or every legacy writer.
-- Requires reviewed weekly request, release, expiry, payroll and source guards.

-- Respect the weekly payroll writer's table order. Hold these until commit so
-- an old client cannot insert after the reconciliation check and before DDL.
LOCK TABLE public.advances,public.advance_requests,public.weekly_bale_requests,public.weekly_worker_draft_sources IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF to_regprocedure('public.record_weekly_bale_release(uuid)') IS NULL OR
    to_regprocedure('public.record_weekly_worker_payment(uuid,date,bigint)') IS NULL OR
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid='public.advance_requests'::regclass
      AND t.tgname='guard_weekly_bale_transition' AND NOT t.tgisinternal AND t.tgenabled='O'
      AND t.tgfoid=to_regprocedure('public.guard_weekly_bale_transition()')) THEN
  RAISE EXCEPTION 'Complete weekly Bale and payroll guards required'; END IF;
 IF EXISTS(SELECT 1 FROM public.advance_requests r LEFT JOIN public.weekly_bale_requests w ON w.request_id=r.id
   WHERE r.status IN ('pending_approval','approved_pending_payment') AND w.request_id IS NULL) OR
    EXISTS(SELECT 1 FROM public.advances a WHERE a.status IN ('active','partially_deducted') AND NOT EXISTS(
     SELECT 1 FROM public.advance_requests r JOIN public.weekly_bale_requests w ON w.request_id=r.id WHERE r.issued_advance_id=a.id)) THEN
  RAISE EXCEPTION 'Unresolved legacy open requests or outstanding Bale require reconciliation before cutover'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name)
  WHERE has_table_privilege(r.role_name,'public.weekly_bale_requests','INSERT,UPDATE,DELETE,TRUNCATE') OR
   has_table_privilege(r.role_name,'public.weekly_worker_draft_sources','INSERT,UPDATE,DELETE,TRUNCATE') OR
   EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid IN ('public.weekly_bale_requests'::regclass,'public.weekly_worker_draft_sources'::regclass)
    AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r.role_name,a.attrelid,a.attname,'INSERT,UPDATE'))) THEN
  RAISE EXCEPTION 'Weekly release or payroll evidence is writable through an API role'; END IF;
END $$;

-- The release function inserts an advance before linking it to the issued
-- request. Check the complete evidence at transaction end, not at INSERT.
CREATE FUNCTION public.require_weekly_bale_source_on_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.advance_requests r JOIN public.weekly_bale_requests w ON w.request_id=r.id
   WHERE r.issued_advance_id=NEW.id AND r.status='issued' AND r.worker_id=NEW.worker_id AND r.project_id=NEW.project_id
    AND r.requested_amount=NEW.amount AND NEW.date=w.period_start+3 AND NEW.amount_deducted=0 AND NEW.status='active'
    AND r.issued_by=w.release_actor AND w.release_actor IS NOT NULL AND w.release_xid IS NULL
    AND (r.issued_at AT TIME ZONE 'Asia/Manila')::date=NEW.date) THEN
  RAISE EXCEPTION 'Legacy Bale insertion blocked; use the controlled weekly release' USING ERRCODE='22023'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.require_weekly_bale_source_on_insert() FROM PUBLIC,anon,authenticated,service_role;
CREATE CONSTRAINT TRIGGER require_weekly_bale_source_on_insert AFTER INSERT ON public.advances
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_weekly_bale_source_on_insert();

-- Once issued, only the exact full deduction during its approved weekly
-- payment transaction may change a linked advance. Corrections cannot mutate
-- the original advance and require separate reconciliation.
CREATE FUNCTION public.guard_weekly_bale_balance_cutover() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.advance_requests r JOIN public.weekly_bale_requests w ON w.request_id=r.id
   WHERE r.issued_advance_id=OLD.id) THEN
  IF TG_OP='UPDATE' AND OLD.status='active' AND OLD.amount_deducted=0 AND NEW.status='fully_deducted'
   AND NEW.amount_deducted=OLD.amount AND (to_jsonb(NEW)-ARRAY['status','amount_deducted']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','amount_deducted'])
   AND auth.uid() IS NOT NULL AND EXISTS(SELECT 1 FROM public.weekly_worker_draft_sources s JOIN public.payroll p ON p.id=s.payroll_id
     WHERE s.worker_id=OLD.worker_id AND OLD.date BETWEEN s.period_start AND s.period_start+6 AND p.status='approved'
      AND s.payment_xid=txid_current() AND s.payment_actor=auth.uid()) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Weekly Bale is immutable outside its full source-bound payroll deduction' USING ERRCODE='22023';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_weekly_bale_balance_cutover() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_weekly_bale_balance_cutover BEFORE UPDATE OR DELETE ON public.advances
 FOR EACH ROW EXECUTE FUNCTION public.guard_weekly_bale_balance_cutover();
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name)
  WHERE has_function_privilege(r.role_name,'public.require_weekly_bale_source_on_insert()','EXECUTE')
   OR has_function_privilege(r.role_name,'public.guard_weekly_bale_balance_cutover()','EXECUTE')) THEN
  RAISE EXCEPTION 'Unexpected inherited weekly Bale cutover trigger privilege'; END IF;
END $$;
