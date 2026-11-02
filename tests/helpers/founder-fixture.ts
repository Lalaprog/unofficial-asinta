export const founderFixture = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE public.users (id uuid primary key, name text not null, email text not null, role text not null, created_at timestamptz default now());
  CREATE TABLE public.workers (id uuid primary key, active boolean not null default true);
  CREATE TABLE public.attendance (id uuid primary key, recorded_by uuid references public.users(id));
  CREATE TABLE public.expenses (id uuid primary key, created_by uuid references public.users(id));
  CREATE TABLE public.email_templates (id uuid primary key, updated_by uuid references public.users(id));
  CREATE TABLE public.email_logs (id uuid primary key, sent_by uuid references public.users(id));
  CREATE TABLE public.project_supervisors (id uuid primary key, supervisor_id uuid references public.users(id));
  CREATE TABLE public.audit_log (actor_id uuid, actor_email text, action text, table_name text, record_id uuid, before_row jsonb, after_row jsonb);
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  GRANT SELECT, UPDATE, DELETE, TRUNCATE ON public.users TO service_role;
  INSERT INTO public.users (id, name, email, role) VALUES
    ('00000000-0000-0000-0000-000000000001', 'Founder One', 'one@example.test', 'founder'),
    ('00000000-0000-0000-0000-000000000002', 'Founder Two', 'two@example.test', 'founder'),
    ('00000000-0000-0000-0000-000000000003', 'Supervisor', 'sup@example.test', 'supervisor');
  INSERT INTO public.workers (id, active) VALUES ('00000000-0000-0000-0000-000000000003', true);
  INSERT INTO public.attendance VALUES ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003');
  INSERT INTO public.expenses VALUES ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003');
  INSERT INTO public.project_supervisors VALUES ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000003');
`;
export const founderOne = '00000000-0000-0000-0000-000000000001';
export const founderTwo = '00000000-0000-0000-0000-000000000002';
export const supervisor = '00000000-0000-0000-0000-000000000003';
