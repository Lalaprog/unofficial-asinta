import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
const founder='00000000-0000-0000-0000-000000000001',supervisor='00000000-0000-0000-0000-000000000002',site='00000000-0000-0000-0000-000000000003',other='00000000-0000-0000-0000-000000000004';
let db:PGlite;
beforeEach(async()=>{
 db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 CREATE TABLE public.users(id uuid,role text); INSERT INTO public.users VALUES ('${founder}','founder'),('${supervisor}','supervisor');
 CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT coalesce(current_setting('request.assurance',true),'')='yes' AND EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder')$$;
 CREATE TABLE public.projects(id uuid primary key); INSERT INTO public.projects VALUES ('${site}'),('${other}');
 CREATE TABLE public.expenses(id uuid primary key,project_id uuid,description text,category text,amount numeric(12,2),expense_date date,notes text);
 INSERT INTO public.expenses SELECT md5(g::text)::uuid,'${site}','Expense '||g,'materials',0.25,'2026-10-12',NULL FROM generate_series(1,1050) g;
 INSERT INTO public.expenses VALUES ('00000000-0000-0000-0000-000000000005','${site}','Old item','other',3.15,'2020-01-01','Original note'),('00000000-0000-0000-0000-000000000006','${other}','Other site','other',1,'2026-10-01',NULL);
 ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY; ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
 CREATE POLICY projects_founder ON public.projects FOR SELECT TO authenticated USING (public.is_founder());
 CREATE POLICY expenses_founder ON public.expenses FOR SELECT TO authenticated USING (public.is_founder());
 GRANT USAGE ON SCHEMA public,auth TO authenticated,anon; GRANT SELECT ON public.projects,public.expenses TO authenticated;`);
 await db.exec(readFileSync('supabase/migrations/20261112000003_project_expense_ledger.sql','utf8'));
 await db.exec(`SELECT set_config('request.jwt.claim.sub','${founder}',false),set_config('request.assurance','yes',false); SET ROLE authenticated`);
},30000);
afterEach(async()=>{await db.close()});
type Row={id:string;description:string;expense_date:string;amount:string};
type Page={items:Row[];has_more:boolean};
describe('Founder project expense SQL',()=>{
 it('totals more than 1000 rows with centavos and keyset-pages to old entries without crossing sites',async()=>{
  const total=await db.query<{data:{project_id:string;expense_count:number;total:string}[]}>('SELECT public.project_expense_totals($1) AS data',[[site,other]]);
  expect(total.rows[0].data).toEqual([{project_id:site,expense_count:1051,total:'265.65'},{project_id:other,expense_count:1,total:'1.00'}]);
  let cursor:Row|undefined;let count=0;let last:Row|undefined;
  for(let i=0;i<50;i++){
   const res=await db.query<{data:Page}>('SELECT public.project_expense_page($1,$2,$3,$4) AS data',[site,cursor?.expense_date??null,cursor?.id??null,25]);
   const page=res.rows[0].data;count+=page.items.length;last=page.items.at(-1);cursor=last;
   if(!page.has_more) break;
  }
  expect(count).toBe(1051);expect(last).toMatchObject({description:'Old item',amount:'3.15'});
 });
 it('rejects non-Founder, failed assurance, bad cursors and inaccessible project ids',async()=>{
  await expect(db.query('SELECT public.project_expense_page($1,$2,$3)',[site,'2026-10-01',null])).rejects.toThrow(/Invalid/);
  await expect(db.query('SELECT public.project_expense_totals($1)',[[site,site]])).rejects.toThrow(/Invalid/);
  await expect(db.query('SELECT public.project_expense_totals($1)',[['00000000-0000-0000-0000-000000000099']])).rejects.toThrow(/unavailable/);
  await db.exec(`SELECT set_config('request.jwt.claim.sub','${supervisor}',false)`);
  await expect(db.query('SELECT public.project_expense_page($1)',[site])).rejects.toThrow(/Founder/);
  await expect(db.query('SELECT public.project_expense_totals($1)',[[site]])).rejects.toThrow(/Founder/);
  await db.exec(`SELECT set_config('request.jwt.claim.sub','${founder}',false),set_config('request.assurance','no',false)`);
  await expect(db.query('SELECT public.project_expense_page($1)',[site])).rejects.toThrow(/Founder/);
  await db.exec('RESET ROLE; SET ROLE anon');await expect(db.query('SELECT public.project_expense_page($1)',[site])).rejects.toThrow(/permission denied/);
 });
});
