-- SYNTHETIC TEST FIXTURE ONLY. Selected hosted-shaped column types,
-- constraints and foreign keys on finance paths; deliberately incomplete.
-- Applies to tests/helpers/pr103-fixture.ts only, on a disposable DB.
UPDATE public.users SET email=id::text||'@example.invalid';
ALTER TABLE public.users ALTER COLUMN email SET NOT NULL, ADD UNIQUE(email);
ALTER TABLE public.workers ALTER COLUMN name SET NOT NULL, ALTER COLUMN position SET NOT NULL,
 ALTER COLUMN contact_number SET NOT NULL, ALTER COLUMN active SET NOT NULL,
 ALTER COLUMN pay_rate TYPE numeric(10,2), ALTER COLUMN pay_rate SET NOT NULL,
 ALTER COLUMN pay_rate_type SET NOT NULL,
 ADD CHECK(pay_rate>=0), ADD CHECK(pay_rate_type IN ('daily','hourly'));
UPDATE public.attendance SET is_founder_override=false,submitted_at=now(),created_at=now();
ALTER TABLE public.attendance ALTER COLUMN worker_id SET NOT NULL, ALTER COLUMN project_id SET NOT NULL,
 ALTER COLUMN date SET NOT NULL, ALTER COLUMN status SET NOT NULL,
 ALTER COLUMN hours_worked TYPE numeric(4,2), ALTER COLUMN hours_worked SET NOT NULL,
 ALTER COLUMN is_founder_override SET DEFAULT false, ALTER COLUMN is_founder_override SET NOT NULL,
 ALTER COLUMN submitted_at SET DEFAULT now(), ALTER COLUMN submitted_at SET NOT NULL,
 ALTER COLUMN created_at SET DEFAULT now(), ALTER COLUMN created_at SET NOT NULL,
 ADD CHECK(status IN ('present','absent','half_day','leave')), ADD CHECK(hours_worked BETWEEN 0 AND 24),
 ADD UNIQUE(worker_id,project_id,date), ADD FOREIGN KEY(worker_id) REFERENCES public.workers(id) ON DELETE RESTRICT,
 ADD FOREIGN KEY(project_id) REFERENCES public.projects(id) ON DELETE RESTRICT,
 ADD FOREIGN KEY(recorded_by) REFERENCES public.users(id);
ALTER TABLE public.payroll ALTER COLUMN worker_id SET NOT NULL, ALTER COLUMN period_start SET NOT NULL,
 ALTER COLUMN period_end SET NOT NULL, ALTER COLUMN status SET NOT NULL,
 ALTER COLUMN gross_pay TYPE numeric(10,2), ALTER COLUMN gross_pay SET NOT NULL,
 ALTER COLUMN bale_deduction TYPE numeric(10,2), ALTER COLUMN bale_deduction SET DEFAULT 0, ALTER COLUMN bale_deduction SET NOT NULL,
 ALTER COLUMN other_deductions TYPE numeric(10,2), ALTER COLUMN other_deductions SET DEFAULT 0, ALTER COLUMN other_deductions SET NOT NULL,
 ALTER COLUMN net_pay TYPE numeric(10,2), ALTER COLUMN net_pay SET NOT NULL,
 ALTER COLUMN days_worked TYPE numeric(5,2), ALTER COLUMN hours_worked TYPE numeric(6,2),
 ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
 ADD CHECK(gross_pay>=0 AND bale_deduction>=0 AND other_deductions>=0 AND net_pay>=0),
 ADD CHECK(status IN ('draft','reviewed','approved','paid')),
 ADD FOREIGN KEY(worker_id) REFERENCES public.workers(id) ON DELETE RESTRICT;
ALTER TABLE public.advances ALTER COLUMN worker_id SET NOT NULL, ALTER COLUMN project_id SET NOT NULL,
 ALTER COLUMN date SET NOT NULL, ALTER COLUMN amount SET NOT NULL, ALTER COLUMN amount_deducted SET DEFAULT 0,
 ALTER COLUMN amount_deducted SET NOT NULL, ALTER COLUMN status SET NOT NULL, ALTER COLUMN reason SET NOT NULL,
 ALTER COLUMN created_at SET NOT NULL,
 ADD CHECK(amount>0 AND amount_deducted>=0), ADD CHECK(status IN ('active','partially_deducted','fully_deducted','cancelled')),
 ADD FOREIGN KEY(worker_id) REFERENCES public.workers(id) ON DELETE RESTRICT,
 ADD FOREIGN KEY(project_id) REFERENCES public.projects(id) ON DELETE RESTRICT;
ALTER TABLE public.advance_requests ALTER COLUMN worker_id SET NOT NULL, ALTER COLUMN project_id SET NOT NULL,
 ALTER COLUMN requested_amount SET NOT NULL, ALTER COLUMN submitted_by SET NOT NULL,
 ALTER COLUMN status SET NOT NULL, ALTER COLUMN created_at SET NOT NULL, ALTER COLUMN updated_at SET NOT NULL,
 ADD CHECK(requested_amount>0), ADD CHECK(status IN ('pending_approval','approved_pending_payment','rejected','issued')),
 ADD CONSTRAINT fixture_approval_fields CHECK(status<>'approved_pending_payment' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
 ADD CONSTRAINT fixture_issue_fields CHECK(status<>'issued' OR (issued_by IS NOT NULL AND issued_at IS NOT NULL AND issued_advance_id IS NOT NULL)),
 ADD FOREIGN KEY(worker_id) REFERENCES public.workers(id) ON DELETE RESTRICT,
 ADD FOREIGN KEY(project_id) REFERENCES public.projects(id) ON DELETE RESTRICT,
 ADD FOREIGN KEY(submitted_by) REFERENCES public.users(id) ON DELETE RESTRICT,
 ADD FOREIGN KEY(approved_by) REFERENCES public.users(id) ON DELETE SET NULL,
 ADD FOREIGN KEY(rejected_by) REFERENCES public.users(id) ON DELETE SET NULL,
 ADD FOREIGN KEY(issued_by) REFERENCES public.users(id) ON DELETE SET NULL,
 ADD FOREIGN KEY(issued_advance_id) REFERENCES public.advances(id) ON DELETE RESTRICT;
ALTER TABLE public.expenses ALTER COLUMN project_id SET NOT NULL, ALTER COLUMN description SET NOT NULL,
 ALTER COLUMN category SET NOT NULL, ALTER COLUMN amount SET NOT NULL, ALTER COLUMN expense_date SET NOT NULL,
 ADD CHECK(amount>0), ADD CHECK(category IN ('materials','labor','equipment','permits','transportation','other')),
 ADD FOREIGN KEY(project_id) REFERENCES public.projects(id) ON DELETE RESTRICT;
ALTER TABLE public.audit_log ADD COLUMN id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
 ALTER COLUMN action SET NOT NULL, ALTER COLUMN table_name SET NOT NULL;
