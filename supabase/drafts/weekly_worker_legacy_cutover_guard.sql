-- DRAFT ONLY: not an installer. Execute only as part of a coordinated,
-- reviewed transaction on an isolated test database. This deliberately breaks
-- legacy payroll writers, including unauthenticated owner/service imports.
-- It does not make old clients safe, reconcile historical pay, enforce Bale
-- scheduling, guard privileged trigger disabling, or transfer money.
-- Requires the exact reviewed weekly generator, approval, allocation, return
-- and their enabled source-bound UPDATE/DELETE guard. Before a real cutover,
-- reconcile ALL unpaid or unrecognized legacy vouchers and identify every writer.
-- Existing paid vouchers are left untouched; new historical externally-paid
-- assertions must use a separate reviewed evidence path, not payroll INSERT.

-- Lock before the preflight so a concurrent legacy writer cannot slip an
-- unresolved voucher in between the check and trigger installation.
LOCK TABLE public.payroll, public.weekly_worker_draft_sources IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
 IF to_regprocedure('public.create_weekly_worker_draft(uuid,uuid,date)') IS NULL OR
    to_regprocedure('public.approve_weekly_worker_draft(uuid,bigint)') IS NULL OR
    to_regprocedure('public.record_weekly_worker_payment(uuid,date,bigint)') IS NULL OR
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid='public.payroll'::regclass
      AND t.tgname='guard_weekly_worker_draft' AND NOT t.tgisinternal AND t.tgenabled='O'
      AND t.tgfoid=to_regprocedure('public.guard_weekly_worker_draft()')) THEN
  RAISE EXCEPTION 'Complete source-bound weekly workflow and enabled voucher guard required'; END IF;
 IF EXISTS(SELECT 1 FROM public.payroll p LEFT JOIN public.weekly_worker_draft_sources s ON s.payroll_id=p.id
   WHERE p.status IS DISTINCT FROM 'paid' AND s.payroll_id IS NULL) THEN
  RAISE EXCEPTION 'Unresolved legacy unpaid or unrecognized payroll requires reconciliation before cutover'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name)
   WHERE has_table_privilege(r.role_name,'public.weekly_worker_draft_sources','INSERT,UPDATE,DELETE,TRUNCATE')
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.weekly_worker_draft_sources'::regclass
      AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r.role_name,a.attrelid,a.attname,'INSERT,UPDATE'))) THEN
  RAISE EXCEPTION 'Weekly source evidence is writable through an API role'; END IF;
END $$;

-- Generator inserts the payroll row first, then its protected source evidence.
-- A deferred check allows that atomic pair but rejects old/manual INSERTs at
-- transaction commit. It is not a substitute for a trusted generator, source
-- table permissions, existing immutability guard or review of privileged roles.
CREATE FUNCTION public.require_weekly_worker_source_on_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.weekly_worker_draft_sources s WHERE s.payroll_id=NEW.id
   AND s.worker_id=NEW.worker_id AND s.period_start=NEW.period_start AND NEW.period_end=NEW.period_start+6) THEN
  RAISE EXCEPTION 'Legacy payroll insertion blocked; use the source-bound weekly workflow' USING ERRCODE='22023'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.require_weekly_worker_source_on_insert() FROM PUBLIC,anon,authenticated,service_role;
CREATE CONSTRAINT TRIGGER require_weekly_worker_source_on_insert AFTER INSERT ON public.payroll
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_weekly_worker_source_on_insert();

-- Reject direct paid/approved inserts before the deferred source check. Also
-- prevent finalizing any pre-existing, unsourced legacy voucher after cutover.
-- Existing paid history is not modified; an already-approved legacy voucher
-- must be reconciled before installation rather than paid through an old client.
CREATE FUNCTION public.guard_weekly_worker_legacy_finalization() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'New payroll must start as a source-bound weekly draft' USING ERRCODE='22023'; END IF;
 ELSIF OLD.status='paid' AND NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS(
  SELECT 1 FROM public.weekly_worker_draft_sources s WHERE s.payroll_id=OLD.id) THEN
  RAISE EXCEPTION 'Legacy paid payroll status is preserved; reconcile separately' USING ERRCODE='22023';
 ELSIF NEW.status IN ('approved','paid') AND NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS(
  SELECT 1 FROM public.weekly_worker_draft_sources s WHERE s.payroll_id=NEW.id AND s.worker_id=NEW.worker_id
   AND s.period_start=NEW.period_start AND NEW.period_end=NEW.period_start+6) THEN
  RAISE EXCEPTION 'Legacy payroll finalization blocked; reconcile the original voucher' USING ERRCODE='22023';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_weekly_worker_legacy_finalization() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_weekly_worker_legacy_finalization BEFORE INSERT OR UPDATE ON public.payroll
 FOR EACH ROW EXECUTE FUNCTION public.guard_weekly_worker_legacy_finalization();
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name)
  WHERE has_function_privilege(r.role_name,'public.require_weekly_worker_source_on_insert()','EXECUTE')
   OR has_function_privilege(r.role_name,'public.guard_weekly_worker_legacy_finalization()','EXECUTE')) THEN
  RAISE EXCEPTION 'Unexpected inherited weekly cutover trigger privilege'; END IF;
END $$;
