import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const founder='00000000-0000-0000-0000-000000000001',supervisor='00000000-0000-0000-0000-000000000002',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004';
const sql=readFileSync('supabase/drafts/project_cost_historical_review.sql','utf8');
async function setup(){const db=new PGlite();await db.exec(baseFixture);await db.exec(`CREATE FUNCTION public.project_cost_reconciliation_preview(uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('project_id',$1,'captured_at',statement_timestamp(),'expenses','[]'::jsonb,'rentals','[]'::jsonb,'paid_allocations','[]'::jsonb,'adjustment_cases','[]'::jsonb)$$;
 CREATE FUNCTION public.project_historical_worker_attributions(uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('project_id',$1,'items',jsonb_build_array(jsonb_build_object('worker_id','${worker}','period_start','2024-11-03','period_end','2024-11-09','case_count',1)))$$;
 BEGIN;${sql} COMMIT; SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'`);return db;}
describe('combined historical cost SQL candidate',()=>{
 it('combines both sources in one statement and detects overlapping vouchers at any status',async()=>{const db=await setup();try{
  const load=()=>db.query<{v:{project_id:string;base:{project_id:string};historical:{case_count:number;overlapping_vouchers:number}[]}}>('SELECT public.project_cost_historical_review($1) v',[site]);
  let r=(await load()).rows[0].v;expect(r.project_id).toBe(site);expect(r.base.project_id).toBe(site);expect(r.historical).toEqual([expect.objectContaining({case_count:1,overlapping_vouchers:0})]);
  await db.exec('RESET ROLE');await db.query("INSERT INTO public.payroll(id,worker_id,period_start,period_end,status) VALUES($1,$2,'2024-11-01','2024-11-07','draft')",['81000000-0000-4000-8000-000000000001',worker]);await db.exec('SET ROLE authenticated');r=(await load()).rows[0].v;expect(r.historical[0].overlapping_vouchers).toBe(1);
  await db.exec('RESET ROLE');expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.expenses')).rows[0].n).toBe(1);expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.advances')).rows[0].n).toBe(0);
 }finally{await db.close();}},30000);
 it('requires Founder assurance, denies other API roles, and propagates source errors',async()=>{const db=await setup();try{
  await db.exec(`SET test.uid='${supervisor}'`);await expect(db.query('SELECT public.project_cost_historical_review($1)',[site])).rejects.toThrow(/Founder/);
  await db.exec(`SET test.uid='${founder}'; SET test.assurance='no'`);await expect(db.query('SELECT public.project_cost_historical_review($1)',[site])).rejects.toThrow(/Founder/);
  await db.exec("RESET ROLE; SET ROLE anon");await expect(db.query('SELECT public.project_cost_historical_review($1)',[site])).rejects.toThrow(/permission denied/);
  await db.exec("RESET ROLE; SET ROLE service_role");await expect(db.query('SELECT public.project_cost_historical_review($1)',[site])).rejects.toThrow(/permission denied/);
  await db.exec("RESET ROLE; CREATE OR REPLACE FUNCTION public.project_historical_worker_attributions(uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$BEGIN RAISE EXCEPTION 'synthetic unavailable'; END$$; SET ROLE authenticated; SET test.assurance='yes'");await expect(db.query('SELECT public.project_cost_historical_review($1)',[site])).rejects.toThrow(/synthetic unavailable/);
 }finally{await db.close();}},30000);
 it('fails installation without dependencies or when the function name collides',async()=>{const db=new PGlite();try{await db.exec(baseFixture);await expect(db.exec(`BEGIN;${sql} COMMIT`)).rejects.toThrow(/prerequisites missing/);await db.exec('ROLLBACK');expect((await db.query("SELECT to_regprocedure('public.project_cost_historical_review(uuid)') IS NULL absent")).rows[0]).toEqual({absent:true});await db.exec("CREATE FUNCTION public.project_cost_reconciliation_preview(uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$; CREATE FUNCTION public.project_historical_worker_attributions(uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$; CREATE FUNCTION public.project_cost_historical_review(uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$;");await expect(db.exec(`BEGIN;${sql} COMMIT`)).rejects.toThrow(/already exists/);await db.exec('ROLLBACK');}finally{await db.close();}},30000);
});
