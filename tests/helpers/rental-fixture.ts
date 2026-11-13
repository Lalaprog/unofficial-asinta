// Synthetic isolated schema, not a hosted clone.
export const founder='00000000-0000-0000-0000-000000000001', supervisor='00000000-0000-0000-0000-000000000002', site='00000000-0000-0000-0000-000000000003',otherSite='00000000-0000-0000-0000-000000000004',expense='00000000-0000-0000-0000-000000000005';
export const roles='CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;';
export const fixture=`${roles}
 ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role;
 ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;
 CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid',true),'')::uuid $$;
 CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('test.assurance',true)='yes' $$;
 CREATE TABLE public.users(id uuid primary key,role text NOT NULL);
 CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder') $$;
 CREATE TABLE public.projects(id uuid primary key,name text NOT NULL);
 CREATE TABLE public.expenses(id uuid primary key,project_id uuid NOT NULL REFERENCES public.projects(id),description text NOT NULL,category text NOT NULL,amount numeric(12,2) NOT NULL,expense_date date NOT NULL,receipt_url text,ai_bale_detection boolean default false);
 INSERT INTO public.users VALUES('${founder}','founder'),('${supervisor}','supervisor'); INSERT INTO public.projects VALUES('${site}','Site A'),('${otherSite}','Site B');
 INSERT INTO public.expenses VALUES('${expense}','${site}','Excavator hire','equipment',1234.50,'2026-10-14',NULL,false);
 ALTER TABLE public.expenses ADD COLUMN revision bigint NOT NULL DEFAULT 0;
 CREATE FUNCTION public.bump_expense_revision() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN NEW.revision:=OLD.revision+1; RETURN NEW; END $$;
 CREATE TRIGGER bump_expense_revision BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION public.bump_expense_revision();
 ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
 CREATE POLICY founder_expenses ON public.expenses TO authenticated USING(public.is_founder() AND public.session_assurance_satisfied()) WITH CHECK(public.is_founder() AND public.session_assurance_satisfied());
 GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
 GRANT SELECT,UPDATE,DELETE ON public.expenses TO authenticated;
`;
export const args=(id:string,exp=expense,project=site)=>[id,exp,project,'1234.50','2026-10-14','Excavator hire','Excavator','Supplier',1,'2026-10-10','2026-10-14'];
export const call='SELECT public.confirm_rental_expense($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) v';
