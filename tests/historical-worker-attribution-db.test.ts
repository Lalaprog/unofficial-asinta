import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const founder='00000000-0000-0000-0000-000000000001',supervisor='00000000-0000-0000-0000-000000000002',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004',other='00000000-0000-0000-0000-000000000005';
const id=(n:number)=>`81000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sql=(name:string)=>readFileSync(`supabase/drafts/${name}.sql`,'utf8');
const record='SELECT public.record_historical_worker_attribution($1,$2,$3::jsonb,$4::jsonb,$5,$6) v';
async function setup(){
 const db=new PGlite();await db.exec(baseFixture);await db.exec(`BEGIN;${sql('historical_external_worker_payroll')} COMMIT; CREATE TABLE public.paid_period_assertion_cases(id uuid PRIMARY KEY,external_worker_id uuid); BEGIN;${sql('historical_worker_project_attribution')} COMMIT; SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);
 const review=(await db.query<{v:{worker:unknown}}>("SELECT public.historical_external_worker_review($1,'2024-11-03') v",[worker])).rows[0].v;
 await db.query("SELECT public.record_historical_external_worker_payroll($1,$2,'2024-11-03','2024-11-09',600,100,0,500,'Synthetic ledger',$3,true)",[id(1),worker,JSON.stringify(review.worker)]);
 const source=(await db.query<{v:unknown}>('SELECT public.historical_external_worker_lookup($1) v',[id(1)])).rows[0].v;
 const split=[{project_id:site,gross:'400.25'},{project_id:other,gross:'199.75'}];return {db,source,split};
}
const save=(db:PGlite,request:string,source:unknown,split:unknown,note='Evidence checked',ack=true)=>db.query<{v:{request_id:string;source_id:string;replayed:boolean}}>(record,[request,id(1),JSON.stringify(source),JSON.stringify(split),note,ack]);
describe('historical worker project attribution (uninstalled)',()=>{
 it('records a complete explicit split once without creating finance transactions and flags cases',async()=>{
  const {db,source,split}=await setup();try{
   expect((await db.query<{v:{projects:{id:string;name:string}[]}}>('SELECT public.historical_worker_attribution_projects() v')).rows[0].v.projects).toEqual([{id:site,name:'Site One'},{id:other,name:'Site Two'}]);
   expect((await db.query<{v:{found:boolean}}>('SELECT public.historical_worker_attribution($1) v',[id(1)])).rows[0].v.found).toBe(false);
   expect((await save(db,id(2),source,split)).rows[0].v).toEqual({request_id:id(2),source_id:id(1),replayed:false});
   expect((await save(db,id(2),source,[...split].reverse())).rows[0].v.replayed).toBe(true);
   await expect(save(db,id(2),source,split,'Different note')).rejects.toThrow(/different details/);
   await expect(save(db,id(3),source,split)).rejects.toThrow(/already attributed/);
   const a=(await db.query<{v:{items:unknown[]}}>('SELECT public.project_historical_worker_attributions($1) v',[site])).rows[0].v;
   const b=(await db.query<{v:{items:unknown[]}}>('SELECT public.project_historical_worker_attributions($1) v',[other])).rows[0].v;
   expect(a.items).toEqual([expect.objectContaining({source_id:id(1),worker_id:worker,original_gross:'600.00',site_gross:'400.25',case_count:0})]);
   expect(b.items).toEqual([expect.objectContaining({source_id:id(1),site_gross:'199.75',case_count:0})]);
   await db.exec('RESET ROLE');await db.query('INSERT INTO public.paid_period_assertion_cases VALUES($1,$2)',[id(4),id(1)]);await db.exec('SET ROLE authenticated');
   expect((await db.query<{v:{case_count:number;source_changed:boolean}}>('SELECT public.historical_worker_attribution($1) v',[id(1)])).rows[0].v).toMatchObject({case_count:1,source_changed:false});
   expect((await db.query<{v:{items:{case_count:number}[]}}>('SELECT public.project_historical_worker_attributions($1) v',[site])).rows[0].v.items[0].case_count).toBe(1);
   await db.exec('RESET ROLE');
   expect((await db.query<{n:number}>("SELECT count(*)::int n FROM public.payroll WHERE period_start='2024-11-03'")).rows[0].n).toBe(0);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.advances')).rows[0].n).toBe(0);
   await expect(db.query('DELETE FROM public.historical_worker_attribution_sites')).rejects.toThrow(/immutable/);
  }finally{await db.close();}
 },30000);
 it('fails closed on stale evidence, incomplete/duplicate/invalid splits and insufficient access',async()=>{
  const {db,source,split}=await setup();try{
   await expect(save(db,id(5),{},split)).rejects.toThrow(/changed/);
   await expect(save(db,id(5),source,[split[0]])).rejects.toThrow(/full positive original gross/);
   await expect(save(db,id(5),source,[split[0],split[0]])).rejects.toThrow(/Duplicate project/);
   await expect(save(db,id(5),source,[{project_id:site,gross:'NaN'}])).rejects.toThrow(/Invalid attribution/);
   await expect(save(db,id(5),source,[{project_id:id(99),gross:'600.00'}])).rejects.toThrow(/project unavailable/);
   await expect(save(db,id(5),source,split,'Evidence',false)).rejects.toThrow(/Invalid attribution/);
   await db.exec(`SET test.uid='${supervisor}'`);await expect(db.query('SELECT public.historical_worker_attribution_projects()')).rejects.toThrow(/Founder/);await expect(save(db,id(5),source,split)).rejects.toThrow(/Founder/);await expect(db.query('SELECT public.project_historical_worker_attributions($1)',[site])).rejects.toThrow(/Founder/);
   await db.exec(`SET test.uid='${founder}'; SET test.assurance='no'`);await expect(db.query('SELECT public.historical_worker_attribution_projects()')).rejects.toThrow(/Founder/);await expect(save(db,id(5),source,split)).rejects.toThrow(/Founder/);
   await db.exec('RESET ROLE; SET ROLE service_role');await expect(db.query('SELECT public.historical_worker_attribution_projects()')).rejects.toThrow(/permission denied/);await expect(db.query('SELECT * FROM public.historical_worker_attributions')).rejects.toThrow(/permission denied/);await expect(save(db,id(5),source,split)).rejects.toThrow(/permission denied/);
   await db.exec('RESET ROLE');expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.historical_worker_attributions')).rows[0].n).toBe(0);
  }finally{await db.close();}
 },30000);
 it('rejects inherited service grants rather than trusting RLS',async()=>{
  const db=new PGlite();try{
   await db.exec(baseFixture);await db.exec(`BEGIN;${sql('historical_external_worker_payroll')} COMMIT; CREATE TABLE public.paid_period_assertion_cases(id uuid PRIMARY KEY,external_worker_id uuid); CREATE ROLE attribution_inherited; GRANT attribution_inherited TO service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO attribution_inherited`);
   await expect(db.exec(`BEGIN;${sql('historical_worker_project_attribution')} COMMIT;`)).rejects.toThrow(/Unexpected historical attribution table privilege/);await db.exec('ROLLBACK');
   expect((await db.query("SELECT to_regclass('public.historical_worker_attributions') IS NULL absent")).rows[0]).toEqual({absent:true});
  }finally{await db.close();}
 },30000);
 it('rejects a tampered site split instead of presenting it as verified',async()=>{
  const {db,source,split}=await setup();try{
   await save(db,id(7),source,split);await db.exec('RESET ROLE; ALTER TABLE public.historical_worker_attribution_sites DISABLE TRIGGER historical_worker_attribution_sites_immutable');
   await db.query('UPDATE public.historical_worker_attribution_sites SET gross=1 WHERE attribution_id=$1 AND project_id=$2',[id(7),site]);await db.exec('SET ROLE authenticated');
   await expect(db.query('SELECT public.historical_worker_attribution($1)',[id(1)])).rejects.toThrow(/split differs/);
   await expect(save(db,id(7),source,split)).rejects.toThrow(/evidence differs/);
   await expect(db.query('SELECT public.project_historical_worker_attributions($1)',[site])).rejects.toThrow(/evidence differs/);
  }finally{await db.close();}
 },30000);
 it('rolls back all evidence on site insertion failure and detects privileged source drift',async()=>{
  const {db,source,split}=await setup();try{
   await db.exec("RESET ROLE; ALTER TABLE public.historical_worker_attribution_sites ADD CONSTRAINT fail_test_site CHECK(gross<>199.75) NOT VALID; SET ROLE authenticated");
   await expect(save(db,id(6),source,split)).rejects.toThrow(/fail_test_site/);await db.exec('RESET ROLE');
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.historical_worker_attributions')).rows[0].n).toBe(0);
   await db.exec('ALTER TABLE public.historical_worker_attribution_sites DROP CONSTRAINT fail_test_site; SET ROLE authenticated');await save(db,id(6),source,split);
   await db.exec('RESET ROLE; ALTER TABLE public.historical_external_worker_payroll DISABLE TRIGGER historical_external_worker_immutable');
   await db.query("UPDATE public.historical_external_worker_payroll SET evidence_note='Privileged change' WHERE request_id=$1",[id(1)]);
   await db.exec('SET ROLE authenticated');expect((await db.query<{v:{source_changed:boolean}}>('SELECT public.historical_worker_attribution($1) v',[id(1)])).rows[0].v.source_changed).toBe(true);
   await expect(save(db,id(6),source,split)).rejects.toThrow(/evidence differs/);
   await expect(db.query('SELECT public.project_historical_worker_attributions($1)',[site])).rejects.toThrow(/evidence differs/);
  }finally{await db.close();}
 },30000);
});
