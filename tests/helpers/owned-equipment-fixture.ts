// Isolated synthetic schema, not a copy of hosted Supabase.
export const founder='00000000-0000-0000-0000-000000000001',supervisor='00000000-0000-0000-0000-000000000002',tool='00000000-0000-0000-0000-000000000003',siteA='00000000-0000-0000-0000-000000000004',siteB='00000000-0000-0000-0000-000000000005';
export const roles=`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;`;
export const fixture=`${roles}
 ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role;
 ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;
 CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
 CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.assurance',true)='yes'$$;
 CREATE TABLE public.users(id uuid primary key,role text);
 CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder')$$;
 CREATE TABLE public.projects(id uuid primary key,name text NOT NULL);
 CREATE TABLE public.tools(id uuid primary key,name text NOT NULL,quantity integer NOT NULL CHECK(quantity>=0),condition text NOT NULL,project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL);
 INSERT INTO public.users VALUES('${founder}','founder'),('${supervisor}','supervisor');
 INSERT INTO public.projects VALUES('${siteA}','Site A'),('${siteB}','Site B');
 INSERT INTO public.tools VALUES('${tool}','Drill',5,'good',NULL);
 ALTER TABLE public.tools ENABLE ROW LEVEL SECURITY;
 CREATE POLICY founder_tools ON public.tools FOR ALL TO authenticated USING (public.is_founder() AND public.session_assurance_satisfied()) WITH CHECK (public.is_founder() AND public.session_assurance_satisfied());
 GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
 GRANT SELECT,INSERT,UPDATE,DELETE ON public.tools TO authenticated;
`;
