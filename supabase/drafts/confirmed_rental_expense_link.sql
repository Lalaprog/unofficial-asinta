-- UNINSTALLED DRAFT ONLY. Must be reviewed with expense/receipt clients,
-- catalog, audit, recovery and finance cutover. No existing data is converted.
-- A confirmation attaches rental details to ONE existing equipment expense;
-- it never creates or adds another expense. It is not proof of a payment.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $$ BEGIN
 IF to_regclass('public.expenses') IS NULL OR to_regclass('public.projects') IS NULL OR to_regclass('public.users') IS NULL OR to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL THEN RAISE EXCEPTION 'Rental prerequisites missing'; END IF;
 IF to_regclass('public.confirmed_rental_expenses') IS NOT NULL OR to_regprocedure('public.confirm_rental_expense(uuid,uuid,uuid,numeric,date,text,text,text,integer,date,date)') IS NOT NULL OR to_regprocedure('public.project_confirmed_rentals(uuid)') IS NOT NULL OR to_regprocedure('public.guard_confirmed_rental_expense()') IS NOT NULL OR to_regprocedure('public.guard_confirmed_rental_immutable()') IS NOT NULL THEN RAISE EXCEPTION 'Rental objects already exist'; END IF;
 LOCK TABLE public.expenses IN SHARE MODE;
END $$;

CREATE TABLE public.confirmed_rental_expenses (
 id uuid PRIMARY KEY,
 expense_id uuid NOT NULL UNIQUE REFERENCES public.expenses(id) ON DELETE RESTRICT,
 project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 expense_amount numeric(12,2) NOT NULL CHECK(expense_amount>0),
 expense_date date NOT NULL,
 expense_description text NOT NULL,
 item_name text NOT NULL CHECK(length(item_name) BETWEEN 1 AND 160),
 supplier text NOT NULL CHECK(length(supplier) BETWEEN 1 AND 160),
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 100000),
 rental_start date NOT NULL,
 rental_end date NOT NULL CHECK(rental_end>=rental_start),
 confirmed_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX confirmed_rental_project_idx ON public.confirmed_rental_expenses(project_id,rental_start DESC,id DESC);
ALTER TABLE public.confirmed_rental_expenses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.confirmed_rental_expenses FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name) WHERE has_table_privilege(r.role_name,'public.confirmed_rental_expenses','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.confirmed_rental_expenses'::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r.role_name,a.attrelid,a.attname,'SELECT,INSERT,UPDATE'))) THEN RAISE EXCEPTION 'Unexpected inherited rental privileges'; END IF;
END $$;
CREATE FUNCTION public.guard_confirmed_rental_expense() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.confirmed_rental_expenses WHERE expense_id=OLD.id) THEN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Linked expense updates require read committed isolation' USING ERRCODE='P1002'; END IF;
  IF (NEW.project_id,NEW.amount,NEW.expense_date,NEW.description,NEW.category,NEW.ai_bale_detection) IS DISTINCT FROM (OLD.project_id,OLD.amount,OLD.expense_date,OLD.description,OLD.category,OLD.ai_bale_detection) THEN RAISE EXCEPTION 'Confirmed rental expense financial details are locked; review a correction' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_confirmed_rental_expense() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_confirmed_rental_expense BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION public.guard_confirmed_rental_expense();
CREATE FUNCTION public.guard_confirmed_rental_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN RAISE EXCEPTION 'Confirmed rental is immutable; review a correction' USING ERRCODE='23514'; END $$;
REVOKE ALL ON FUNCTION public.guard_confirmed_rental_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_confirmed_rental_immutable BEFORE UPDATE OR DELETE ON public.confirmed_rental_expenses FOR EACH ROW EXECUTE FUNCTION public.guard_confirmed_rental_immutable();

CREATE FUNCTION public.confirm_rental_expense(p_id uuid,p_expense uuid,p_project uuid,p_expected_amount numeric,p_expected_date date,p_expected_description text,p_item text,p_supplier text,p_quantity integer,p_start date,p_end date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_prev public.confirmed_rental_expenses%ROWTYPE; v_exp public.expenses%ROWTYPE;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Rental confirmation requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_id IS NULL OR p_expense IS NULL OR p_project IS NULL OR p_expected_amount IS NULL OR p_expected_amount<=0 OR p_expected_amount>9999999999.99 OR p_expected_amount<>round(p_expected_amount,2) OR p_expected_date IS NULL OR NOT isfinite(p_expected_date) OR p_expected_description IS NULL OR p_item IS NULL OR p_item<>btrim(p_item) OR length(p_item) NOT BETWEEN 1 AND 160 OR p_supplier IS NULL OR p_supplier<>btrim(p_supplier) OR length(p_supplier) NOT BETWEEN 1 AND 160 OR p_quantity IS NULL OR p_quantity NOT BETWEEN 1 AND 100000 OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_end<p_start THEN RAISE EXCEPTION 'Invalid rental confirmation' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM public.users WHERE id=auth.uid() AND role='founder' FOR SHARE;
 IF NOT FOUND OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rental-confirmation:'||p_id::text,0));
 SELECT * INTO v_prev FROM public.confirmed_rental_expenses WHERE id=p_id;
 IF FOUND THEN
  IF (v_prev.confirmed_by,v_prev.expense_id,v_prev.project_id,v_prev.expense_amount,v_prev.expense_date,v_prev.expense_description,v_prev.item_name,v_prev.supplier,v_prev.quantity,v_prev.rental_start,v_prev.rental_end) IS DISTINCT FROM (auth.uid(),p_expense,p_project,p_expected_amount,p_expected_date,p_expected_description,p_item,p_supplier,p_quantity,p_start,p_end) THEN RAISE EXCEPTION 'Confirmation ID already used for different details' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('id',p_id,'expense_id',p_expense,'replayed',true);
 END IF;
 SELECT * INTO v_exp FROM public.expenses WHERE id=p_expense FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Expense unavailable' USING ERRCODE='P0002'; END IF;
 IF (v_exp.project_id,v_exp.amount,v_exp.expense_date,v_exp.description) IS DISTINCT FROM (p_project,p_expected_amount,p_expected_date,p_expected_description) THEN RAISE EXCEPTION 'Expense changed; refresh before confirming' USING ERRCODE='40001'; END IF;
 IF v_exp.category<>'equipment' OR coalesce(v_exp.ai_bale_detection,false) THEN RAISE EXCEPTION 'Only an equipment expense without a Bale flag can be linked' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.confirmed_rental_expenses WHERE expense_id=p_expense) THEN RAISE EXCEPTION 'Expense already linked to a confirmed rental' USING ERRCODE='23505'; END IF;
 -- Parent version prevents a repeatable-read legacy writer whose snapshot
 -- predates the link from silently overwriting protected fields.
 UPDATE public.expenses SET amount=amount WHERE id=p_expense;
 INSERT INTO public.confirmed_rental_expenses(id,expense_id,project_id,expense_amount,expense_date,expense_description,item_name,supplier,quantity,rental_start,rental_end,confirmed_by)
 VALUES(p_id,p_expense,p_project,p_expected_amount,p_expected_date,p_expected_description,p_item,p_supplier,p_quantity,p_start,p_end,auth.uid());
 RETURN jsonb_build_object('id',p_id,'expense_id',p_expense,'replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.confirm_rental_expense(uuid,uuid,uuid,numeric,date,text,text,text,integer,date,date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.confirm_rental_expense(uuid,uuid,uuid,numeric,date,text,text,text,integer,date,date) TO authenticated;

CREATE FUNCTION public.project_confirmed_rentals(p_project uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_count bigint;v_items jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='42501'; END IF;
 SELECT count(*) INTO v_count FROM public.confirmed_rental_expenses WHERE project_id=p_project;
 IF v_count>200 THEN RAISE EXCEPTION 'Too many rentals to show safely; pagination required' USING ERRCODE='54000'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'expense_id',expense_id,'project_id',project_id,'expense_amount',expense_amount::text,'expense_date',expense_date,'expense_description',expense_description,'item_name',item_name,'supplier',supplier,'quantity',quantity,'rental_start',rental_start,'rental_end',rental_end,'confirmed_at',confirmed_at) ORDER BY rental_start DESC,id DESC),'[]'::jsonb) INTO v_items FROM public.confirmed_rental_expenses WHERE project_id=p_project;
 IF octet_length(v_items::text)>1048576 THEN RAISE EXCEPTION 'Rental list too large' USING ERRCODE='54000'; END IF;
 RETURN jsonb_build_object('project_id',p_project,'items',v_items);
END $$;
REVOKE ALL ON FUNCTION public.project_confirmed_rentals(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_confirmed_rentals(uuid) TO authenticated;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','service_role']) r(role_name) WHERE has_function_privilege(r.role_name,'public.confirm_rental_expense(uuid,uuid,uuid,numeric,date,text,text,text,integer,date,date)','EXECUTE') OR has_function_privilege(r.role_name,'public.project_confirmed_rentals(uuid)','EXECUTE')) THEN RAISE EXCEPTION 'Unexpected inherited rental function privileges'; END IF;
END $$;
