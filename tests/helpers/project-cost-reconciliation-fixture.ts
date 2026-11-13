// Synthetic disposable finance schema; not a hosted Supabase clone.
export const founder='00000000-0000-0000-0000-000000000001',supervisor='00000000-0000-0000-0000-000000000002',site='00000000-0000-0000-0000-000000000003',other='00000000-0000-0000-0000-000000000004',worker='00000000-0000-0000-0000-000000000005';
export const payroll='10000000-0000-0000-0000-000000000001',rentalExpense='10000000-0000-0000-0000-000000000002',baleExpense='10000000-0000-0000-0000-000000000003',materialExpense='10000000-0000-0000-0000-000000000004',rentalId='10000000-0000-0000-0000-000000000005';
export const roles='CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;';
export const fixture=`
 ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role;
 ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;
 CREATE SCHEMA auth;CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
 CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.assurance',true)='yes'$$;
 CREATE TABLE public.users(id uuid primary key,role text NOT NULL);INSERT INTO public.users VALUES('${founder}','founder'),('${supervisor}','supervisor');
 CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder')$$;
 CREATE TABLE public.projects(id uuid primary key,name text NOT NULL);INSERT INTO public.projects VALUES('${site}','Site A'),('${other}','Site B');
 CREATE TABLE public.workers(id uuid primary key,name text NOT NULL);INSERT INTO public.workers VALUES('${worker}','Worker A');
 CREATE TABLE public.expenses(id uuid primary key,project_id uuid NOT NULL REFERENCES public.projects(id),description text NOT NULL,category text NOT NULL,amount numeric(12,2) NOT NULL,expense_date date NOT NULL,ai_bale_detection boolean DEFAULT false,revision bigint NOT NULL DEFAULT 0);
 CREATE FUNCTION public.bump_expense_revision() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$BEGIN NEW.revision:=OLD.revision+1;RETURN NEW;END$$;
 CREATE TRIGGER bump_expense_revision BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION public.bump_expense_revision();
 INSERT INTO public.expenses(id,project_id,description,category,amount,expense_date,ai_bale_detection) VALUES
 ('${rentalExpense}','${site}','Excavator hire','equipment',1000,'2024-11-02',false),('${baleExpense}','${site}','Bale given','other',100,'2024-11-03',true),('${materialExpense}','${site}','Sand','materials',50,'2024-11-04',false),('10000000-0000-0000-0000-000000000006','${other}','Other site','other',999,'2024-11-04',false);
 CREATE TABLE public.payroll(id uuid primary key,worker_id uuid,period_start date,period_end date,status text,gross_pay numeric(10,2),bale_deduction numeric(10,2),other_deductions numeric(10,2),net_pay numeric(10,2),hours_worked numeric(8,2));
 CREATE TABLE public.weekly_worker_draft_sources(payroll_id uuid primary key,worker_id uuid,period_start date,approved_by uuid,approved_at timestamptz,approval_xid bigint,payment_actor uuid,payment_xid bigint,calculation jsonb);
 CREATE TABLE public.payroll_payment_dates(payroll_id uuid primary key,payment_date date,recorded_by uuid);
 CREATE TABLE public.weekly_worker_paid_allocations(payroll_id uuid,project_id uuid,hours numeric(8,2),wage numeric(10,2),allowance numeric(10,2),gross numeric(10,2),primary key(payroll_id,project_id));
 INSERT INTO public.payroll VALUES('${payroll}','${worker}','2024-11-03','2024-11-09','paid',750,100,0,650,10);
 INSERT INTO public.weekly_worker_draft_sources VALUES('${payroll}','${worker}','2024-11-03','${founder}',now(),NULL,'${founder}',NULL,'{"wage":"700.00","allowance":"50.00","gross":"750.00","bale":"100.00","net":"650.00"}');
 INSERT INTO public.payroll_payment_dates VALUES('${payroll}','2024-11-09','${founder}');
 INSERT INTO public.weekly_worker_paid_allocations VALUES('${payroll}','${site}',8,550,50,600),('${payroll}','${other}',2,150,0,150);
 ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
 CREATE POLICY founder_expenses ON public.expenses TO authenticated USING(public.is_founder() AND public.session_assurance_satisfied()) WITH CHECK(public.is_founder() AND public.session_assurance_satisfied());
 GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
 GRANT SELECT,UPDATE,DELETE ON public.expenses TO authenticated;`;
export const candidatePaths=['supabase/drafts/project_paid_payroll_evidence.sql','supabase/drafts/confirmed_rental_expense_link.sql','supabase/drafts/project_cost_reconciliation_preview.sql'];
export const confirmRental=`SELECT public.confirm_rental_expense('${rentalId}','${rentalExpense}','${site}',1000,'2024-11-02','Excavator hire','Excavator','Supplier',1,'2024-11-01','2024-11-02')`;
