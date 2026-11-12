import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

// Simplified isolated schemas, not a live Supabase or hosted-schema clone.
const founder='00000000-0000-0000-0000-000000000001',supervisor='00000000-0000-0000-0000-000000000002',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004',other='00000000-0000-0000-0000-000000000005';
const inbox='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',object=`${founder}/inbox/${inbox}.jpg`;
const names=['advance_requests','advances','audit_log','clients','email_logs','email_templates','expense_drafts','invoices','reminder_dispatches','sms_logs','tools','vendor_memory'];
const migrations=['20261112000000_guarded_single_project_worker.sql','20261112000001_payslip_batch_snapshot.sql','20261112000002_project_attendance_calendar.sql','20261112000003_project_expense_ledger.sql','20261112000004_receipt_photo_inbox.sql','20261112000005_attendance_history_calendar.sql','20261112000006_revoke_client_truncate.sql'];
const sql=(path:string)=>readFileSync(`supabase/migrations/${path}`,'utf8');

describe('PR 102 migration sequence',()=>{
 it('installs all seven together without losing rows, and keeps their features usable and scoped',async()=>{
  const db=new PGlite();
  try{
   await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth; CREATE SCHEMA storage; CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
    CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.assurance',true)='yes'$$;
    CREATE TABLE public.users(id uuid primary key,name text,role text);
    CREATE TABLE public.projects(id uuid primary key,name text);
    CREATE TABLE public.workers(id uuid primary key,name text,position text,contact_number text,pay_rate numeric,pay_rate_type text,active boolean);
    CREATE TABLE public.project_supervisors(project_id uuid,supervisor_id uuid,unique(project_id,supervisor_id));
    CREATE TABLE public.attendance(id uuid primary key,worker_id uuid,project_id uuid,date date,status text,hours_worked numeric,notes text,recorded_by uuid,is_founder_override boolean,submitted_at timestamptz,created_at timestamptz);
    CREATE TABLE public.payroll(id uuid primary key,worker_id uuid,period_start date,period_end date,status text,days_worked numeric,hours_worked numeric,gross_pay numeric,bale_deduction numeric,other_deductions numeric,net_pay numeric);
    CREATE TABLE public.expenses(id uuid primary key,project_id uuid,description text,category text,amount numeric(12,2),expense_date date,notes text);
    ${names.map(n=>`CREATE TABLE public.${n}(id uuid primary key); INSERT INTO public.${n} VALUES ('${worker}');`).join('\n')}
    CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT public.session_assurance_satisfied() AND EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder')$$;
    CREATE FUNCTION public.is_supervisor_assigned(proj_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT public.session_assurance_satisfied() AND EXISTS(SELECT 1 FROM public.project_supervisors WHERE supervisor_id=auth.uid() AND project_id=proj_id)$$;
    INSERT INTO public.users VALUES ('${founder}','Founder','founder'),('${supervisor}','Supervisor','supervisor');
    INSERT INTO public.projects VALUES ('${site}','Site One'),('${other}','Site Two');
    INSERT INTO public.project_supervisors VALUES ('${site}','${supervisor}');
    INSERT INTO public.workers VALUES ('${worker}','Test Worker','Mason','none',600,'daily',true);
    INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked) VALUES ('${worker}','${worker}','${site}','2026-10-25','present',8);
    INSERT INTO public.payroll VALUES ('${worker}','${worker}','2026-10-25','2026-10-31','paid',1,8,600,0,0,600);
    INSERT INTO public.expenses VALUES ('${worker}','${site}','Fixture','materials',12.35,'2026-10-25',null);
    CREATE TABLE storage.objects(bucket_id text,name text); ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    CREATE POLICY founder_storage ON storage.objects FOR SELECT TO authenticated USING (bucket_id='receipts' AND public.is_founder());
    ALTER TABLE public.users ENABLE ROW LEVEL SECURITY; ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY; ALTER TABLE public.workers ENABLE ROW LEVEL SECURITY; ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY; ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY; ALTER TABLE public.payroll ENABLE ROW LEVEL SECURITY;
    CREATE POLICY users_read ON public.users FOR SELECT TO authenticated USING (id=auth.uid() OR public.is_founder());
    CREATE POLICY projects_read ON public.projects FOR SELECT TO authenticated USING(public.is_founder() OR public.is_supervisor_assigned(id));
    CREATE POLICY workers_read ON public.workers FOR SELECT TO authenticated USING(public.is_founder() OR (auth.uid() IS NOT NULL AND active));
    CREATE POLICY attendance_read ON public.attendance FOR SELECT TO authenticated USING(public.is_founder() OR public.is_supervisor_assigned(project_id));
    CREATE POLICY expenses_read ON public.expenses FOR SELECT TO authenticated USING(public.is_founder());
    CREATE POLICY payroll_read ON public.payroll FOR SELECT TO authenticated USING(public.is_founder());
    GRANT USAGE ON SCHEMA public,auth,storage TO authenticated,anon,service_role;
    GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON ALL TABLES IN SCHEMA public TO authenticated,anon,service_role;
    GRANT SELECT ON storage.objects TO authenticated;`);
   await db.exec(sql('20261103000001_attendance_history.sql'));
   await db.exec(sql('20261107000002_project_worker_lists.sql'));
   for(const migration of migrations) await db.exec(sql(migration));
   await db.exec(sql('20261113000000_weekly_worker_preview.sql'));
   expect((await db.query<{n:number}>('SELECT count(*)::int AS n FROM public.attendance')).rows[0].n).toBe(1);
   expect((await db.query<{n:number}>('SELECT count(*)::int AS n FROM public.expenses')).rows[0].n).toBe(1);
   expect((await db.query<{n:number}>('SELECT count(*)::int AS n FROM public.payroll')).rows[0].n).toBe(1);
   const grants=await db.query<{auth:boolean;anon:boolean;service:boolean}>("SELECT has_table_privilege('authenticated','public.attendance','TRUNCATE') AS auth,has_table_privilege('anon','public.attendance','TRUNCATE') AS anon,has_table_privilege('service_role','public.attendance','TRUNCATE') AS service");
   expect(grants.rows[0]).toEqual({auth:false,anon:false,service:true});
   await db.exec(`SET ROLE service_role; SELECT public.set_project_worker_guarded('${founder}','${site}','${worker}',true); RESET ROLE; SET test.uid='${founder}'; SET test.assurance='yes'; SET ROLE authenticated;`);
   const value=async(query:string)=>(await db.query<{data:unknown}>(query)).rows[0].data;
   expect(await value("SELECT public.weekly_worker_preview_inputs('2026-10-25') AS data")).toMatchObject({start:'2026-10-25',end:'2026-10-31',workers:[{id:worker,pay_rate:'600',linked_supervisor:false}],attendance:[{worker_id:worker,hours_worked:'8'}],vouchers:[{worker_id:worker,status:'paid'}]});
   await expect(value("SELECT public.weekly_worker_preview_inputs('2026-10-26') AS data")).rejects.toThrow(/Sunday/);
   expect(await value("SELECT public.payslip_batch_snapshot('2026-10-25','2026-10-31') AS data")).toMatchObject([{worker_id:worker,gross_pay:600}]);
   expect(await value(`SELECT public.project_attendance_calendar('${site}','2026-10-01') AS data`)).toEqual([{date:'2026-10-25',count:1}]);
   expect(await value("SELECT public.attendance_history_calendar('2026-10-01',NULL,NULL,NULL) AS data")).toEqual([{date:'2026-10-25',count:1}]);
   expect(await value(`SELECT public.project_expense_totals(ARRAY['${site}'::uuid]) AS data`)).toEqual([{project_id:site,expense_count:1,total:'12.35'}]);
   await db.query('INSERT INTO public.receipt_photo_inbox(id,saved_by,object_path,file_name,mime_type,file_size,sha256) VALUES($1,$2,$3,$4,$5,$6,$7)',[inbox,founder,object,'fixture.jpg','image/jpeg',10,'a'.repeat(64)]);
   await db.exec(`RESET ROLE; INSERT INTO storage.objects VALUES ('receipts','${object}'); SET ROLE authenticated; UPDATE public.receipt_photo_inbox SET status='ready' WHERE id='${inbox}';`);
   expect(await value('SELECT public.receipt_photo_inbox_page() AS data')).toMatchObject({items:[{id:inbox,status:'ready'}]});
   await db.exec(`SET test.assurance='no';`);
   await expect(value("SELECT public.weekly_worker_preview_inputs('2026-10-25') AS data")).rejects.toThrow(/Founder/);
   await db.exec(`SET test.assurance='yes'; SET test.uid='${supervisor}';`);
   await expect(value("SELECT public.weekly_worker_preview_inputs('2026-10-25') AS data")).rejects.toThrow(/Founder/);
   await expect(value(`SELECT public.project_expense_totals(ARRAY['${site}'::uuid]) AS data`)).rejects.toThrow(/Founder/);
   await expect(value(`SELECT public.project_attendance_calendar('${other}','2026-10-01') AS data`)).rejects.toThrow(/Project access/);
   expect(await value('SELECT public.attendance_history_calendar(\'2026-10-01\',NULL,NULL,NULL) AS data')).toEqual([{date:'2026-10-25',count:1}]);
   await expect(value('SELECT public.receipt_photo_inbox_page() AS data')).rejects.toThrow(/Founder/);
  }finally{await db.close();}
 },30000);
});
