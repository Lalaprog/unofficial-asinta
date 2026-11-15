// Synthetic in-memory schema and records only; no hosted finance data.
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {candidatePaths,fixture,founder,other,payroll,roles,site,supervisor} from './helpers/project-cost-reconciliation-fixture';
import {parsePaidPayrollSummary} from '@/lib/projects/paidPayrollSummary';

async function setup(){const db=new PGlite();await db.exec(`${roles} ${fixture}`);for(const p of candidatePaths)await db.exec(readFileSync(p,'utf8'));await db.exec(readFileSync('supabase/drafts/project_paid_payroll_summary.sql','utf8'));await db.exec(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);return db;}
async function read(db:PGlite,project=site){return (await db.query<{v:unknown}>('SELECT public.project_paid_payroll_summary($1) v',[project])).rows[0].v;}
describe('independent paid payroll snapshot',()=>{
 it('retains verified site payroll despite an over-limit expense ledger and never writes business rows',async()=>{const db=await setup();try{
  await db.exec(`RESET ROLE; INSERT INTO public.expenses(id,project_id,description,category,amount,expense_date) SELECT md5('extra'||g)::uuid,'${site}','Extra','other',1,'2024-11-04' FROM generate_series(1,198) g; SET ROLE authenticated`);
  await expect(db.query('SELECT public.project_cost_reconciliation_preview($1)',[site])).rejects.toThrow(/More than 200 expenses/);
  const a=parsePaidPayrollSummary(await read(db),site);expect(a.paid).toHaveLength(1);expect(a.paid[0].gross).toBe('600.00');expect(a.adjustments).toHaveLength(0);
  expect(parsePaidPayrollSummary(await read(db,other),other).paid[0].gross).toBe('150.00');
  await db.exec('RESET ROLE');expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.expenses')).rows[0].n).toBe(202);expect((await db.query<{status:string}>('SELECT status FROM public.payroll WHERE id=$1',[payroll])).rows[0].status).toBe('paid');
 }finally{await db.close();}},30000);
 it('fails closed for incomplete allocations and inconsistent whole-voucher deductions',async()=>{const db=await setup();try{
  await db.exec('RESET ROLE;BEGIN');await db.query('UPDATE public.payroll SET net_pay=net_pay+1 WHERE id=$1',[payroll]);await db.exec('SET LOCAL ROLE authenticated');await expect(read(db)).rejects.toThrow(/deduction evidence is inconsistent/);await db.exec('ROLLBACK');
  await db.exec('BEGIN');await db.query('UPDATE public.weekly_worker_paid_allocations SET gross=gross+1 WHERE payroll_id=$1 AND project_id=$2',[payroll,other]);await db.exec('SET LOCAL ROLE authenticated');await expect(read(db)).rejects.toThrow(/inconsistent/);await db.exec('ROLLBACK');
 }finally{await db.close();}},30000);
 it('reads multiple pages within one statement and checks each voucher',async()=>{const db=await setup();try{
  await db.exec(`RESET ROLE;
   INSERT INTO public.payroll SELECT md5('pay'||g)::uuid,p.worker_id,p.period_start,p.period_end,p.status,p.gross_pay,p.bale_deduction,p.other_deductions,p.net_pay,p.hours_worked FROM public.payroll p CROSS JOIN generate_series(1,29) g WHERE p.id='${payroll}';
   INSERT INTO public.weekly_worker_draft_sources SELECT p.id,s.worker_id,s.period_start,s.approved_by,s.approved_at,s.approval_xid,s.payment_actor,s.payment_xid,s.calculation FROM public.payroll p CROSS JOIN public.weekly_worker_draft_sources s WHERE p.id<>'${payroll}' AND s.payroll_id='${payroll}';
   INSERT INTO public.payroll_payment_dates SELECT id,'2024-11-09','${founder}' FROM public.payroll WHERE id<>'${payroll}';
   INSERT INTO public.weekly_worker_paid_allocations SELECT p.id,a.project_id,a.hours,a.wage,a.allowance,a.gross FROM public.payroll p CROSS JOIN public.weekly_worker_paid_allocations a WHERE p.id<>'${payroll}' AND a.payroll_id='${payroll}';
   SET ROLE authenticated`);
  const result=parsePaidPayrollSummary(await read(db),site);expect(result.paid).toHaveLength(30);expect(result.paid.reduce((n,p)=>n+Number(p.gross),0)).toBe(18000);
 }finally{await db.close();}},30000);
 it('requires Founder assurance and denies anonymous and service RPC execution',async()=>{const db=await setup();try{
  await db.exec(`SET test.uid='${supervisor}'`);await expect(read(db)).rejects.toThrow(/Founder/);
  await db.exec(`SET test.uid='${founder}';SET test.assurance='no'`);await expect(read(db)).rejects.toThrow(/Founder/);
  for(const role of ['anon','service_role']){await db.exec(`RESET ROLE; SET ROLE ${role}`);await expect(read(db)).rejects.toThrow(/permission denied/);}
 }finally{await db.close();}},30000);
});
