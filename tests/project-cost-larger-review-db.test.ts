import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {estimateProjectCost,parseCostSnapshot} from '@/lib/projects/projectCostReconciliation';
import {calculateCorrected,parseCorrectedInventory,parseCorrectedSaved} from '@/lib/projects/correctedCostReview';
import {parseStoredCorrectedAttempt,savedMatchesCorrectedAttempt,serializeCorrectedAttempt} from '@/lib/projects/correctedReviewAttempt';
import {baleExpense,candidatePaths,confirmRental,fixture,founder,materialExpense,payroll,rentalExpense,roles,site,worker} from './helpers/project-cost-reconciliation-fixture';
const sql=(name:string)=>readFileSync(`supabase/drafts/${name}.sql`,'utf8');
const request='90000000-0000-4000-8000-000000000001';
async function setup(){
 const db=new PGlite();await db.exec(`${roles} ${fixture}`);for(const path of candidatePaths)await db.exec(readFileSync(path,'utf8'));
 await db.exec(`BEGIN;${sql('project_cost_larger_review')} COMMIT;
 CREATE FUNCTION public.project_cost_correction_inventory(p uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$SELECT jsonb_build_object('project_id',p,'historical_review',jsonb_build_object('project_id',p,'base',public.project_cost_reconciliation_preview(p),'historical','[]'::jsonb),'corrections','[]'::jsonb)$$;
 BEGIN;${sql('project_cost_corrected_preview')} COMMIT; BEGIN;${sql('project_cost_corrected_review_ledger')} COMMIT;
 SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes';${confirmRental}`);return db;
}
async function base(db:PGlite){return (await db.query<{v:unknown}>('SELECT public.project_cost_reconciliation_preview($1) v',[site])).rows[0].v;}
async function inventory(db:PGlite){return (await db.query<{v:unknown}>('SELECT public.project_cost_correction_inventory($1) v',[site])).rows[0].v;}
describe('held larger bounded project review',()=>{
 it('captures 1000 expenses, 1000 paid allocations and 201 linked rentals, saves reviewed totals, and fails closed at the boundary',async()=>{const db=await setup();try{
  await db.exec(`RESET ROLE;
   INSERT INTO public.expenses(id,project_id,description,category,amount,expense_date)
   SELECT md5(('expense'||g)::text)::uuid,'${site}','Rental '||g,'equipment',1,'2024-11-04' FROM generate_series(1,997) g;
   INSERT INTO public.confirmed_rental_expenses(id,expense_id,project_id,expense_amount,expense_date,expense_description,item_name,supplier,quantity,rental_start,rental_end,confirmed_by)
   SELECT md5(('rental'||g)::text)::uuid,md5(('expense'||g)::text)::uuid,'${site}',1,'2024-11-04','Rental '||g,'Tool','Supplier',1,'2024-11-01','2024-11-02','${founder}' FROM generate_series(1,200) g;
   INSERT INTO public.payroll SELECT md5(('largepay'||g)::text)::uuid,'${worker}','2024-11-03','2024-11-09','paid',100,0,0,100,8 FROM generate_series(1,999) g;
   INSERT INTO public.weekly_worker_draft_sources SELECT id,worker_id,period_start,'${founder}',now(),NULL,'${founder}',NULL,'{"wage":"100.00","allowance":"0.00","gross":"100.00","bale":"0.00","net":"100.00"}'::jsonb FROM public.payroll WHERE id<>'${payroll}';
   INSERT INTO public.payroll_payment_dates SELECT id,'2024-11-09','${founder}' FROM public.payroll WHERE id<>'${payroll}';
   INSERT INTO public.weekly_worker_paid_allocations SELECT id,'${site}',8,100,0,100 FROM public.payroll WHERE id<>'${payroll}';SET ROLE authenticated`);
  const snapshot=parseCostSnapshot(await base(db),site);expect(snapshot.expenses).toHaveLength(1000);expect(snapshot.paid).toHaveLength(1000);expect(snapshot.expenses.filter(e=>e.rental)).toHaveLength(201);expect(new Set(snapshot.paid.map(p=>p.payrollId)).size).toBe(1000);
  const decisions:Record<string,'include'|'exclude'>=Object.fromEntries(snapshot.expenses.map(e=>[e.id,e.id===baleExpense?'exclude':'include']));expect(estimateProjectCost(snapshot,decisions).total).toBe(10254700n);
  const raw=await inventory(db),parsed=parseCorrectedInventory(raw,site),choices={expenses:Object.fromEntries(snapshot.expenses.map(e=>[e.id,e.id===baleExpense?{decision:'exclude',reason:'Synthetic duplicate checked'}:{decision:'include',reason:null}])),historical:{},corrections:{}};
  const calculated=calculateCorrected(parsed,choices);expect(calculated.totals.total).toBe(10254700n);
  const attempt={marker:{requestId:request,projectId:site,actorId:founder,expectedRevision:0},raw,choices:calculated.choices,note:'Synthetic review'};
  const stored=serializeCorrectedAttempt(attempt,site,founder);expect(parseStoredCorrectedAttempt(stored,site,founder).attempt).toBeTruthy();
  const preview=await db.query<{v:{incomplete_total:string}}>('SELECT public.project_cost_corrected_preview($1,$2::jsonb,$3::jsonb,true) v',[site,JSON.stringify(raw),JSON.stringify(choices)]);expect(preview.rows[0].v.incomplete_total).toBe('102547.00');
  const result=await db.query<{v:{revision:number}}>('SELECT public.record_project_cost_corrected_review($1,$2,0,$3::jsonb,$4::jsonb,$5,true) v',[request,site,JSON.stringify(raw),JSON.stringify(choices),'Synthetic review']);expect(result.rows[0].v.revision).toBe(1);
  const saved=(await db.query<{v:unknown}>('SELECT public.project_cost_corrected_review($1,NULL) v',[site])).rows[0].v;const checked=parseCorrectedSaved(saved,site);expect(checked).toMatchObject({found:true,freshness:'matches'});if(!checked.found)throw Error('Saved review missing');expect(savedMatchesCorrectedAttempt(checked,attempt)).toBe(true);
  await db.exec(`RESET ROLE; UPDATE public.expenses SET amount=51 WHERE id='${materialExpense}';SET ROLE authenticated`);
  const stale=(await db.query<{v:unknown}>('SELECT public.project_cost_corrected_review($1,NULL) v',[site])).rows[0].v;expect(parseCorrectedSaved(stale,site)).toMatchObject({found:true,freshness:'changed'});
  await db.exec(`RESET ROLE;INSERT INTO public.expenses(id,project_id,description,category,amount,expense_date) VALUES(md5('overlimitexpense')::uuid,'${site}','Extra','other',1,'2024-11-04');SET ROLE authenticated`);await expect(base(db)).rejects.toMatchObject({code:'54000'});
  await db.exec(`RESET ROLE;DELETE FROM public.expenses WHERE id=md5('overlimitexpense')::uuid;
   INSERT INTO public.payroll VALUES(md5('overlimitpay')::uuid,'${worker}','2024-11-03','2024-11-09','paid',100,0,0,100,8);
   INSERT INTO public.weekly_worker_draft_sources VALUES(md5('overlimitpay')::uuid,'${worker}','2024-11-03','${founder}',now(),NULL,'${founder}',NULL,'{"wage":"100.00","allowance":"0.00","gross":"100.00","bale":"0.00","net":"100.00"}');
   INSERT INTO public.payroll_payment_dates VALUES(md5('overlimitpay')::uuid,'2024-11-09','${founder}');INSERT INTO public.weekly_worker_paid_allocations VALUES(md5('overlimitpay')::uuid,'${site}',8,100,0,100);SET ROLE authenticated`);
  await expect(base(db)).rejects.toMatchObject({code:'54000'});
  await db.exec('RESET ROLE');expect((await db.query<{amount:string}>('SELECT amount::text amount FROM public.expenses WHERE id=$1',[rentalExpense])).rows[0].amount).toBe('1000.00');
 }finally{await db.close();}},120000);
 it('returns 1000 confirmed rentals and fails closed on rental 1001',async()=>{const db=await setup();try{
  await db.exec(`RESET ROLE;
   INSERT INTO public.expenses(id,project_id,description,category,amount,expense_date)
   SELECT md5(('rental-boundary-expense'||g)::text)::uuid,'${site}','Rental boundary '||g,'equipment',1,'2024-11-04' FROM generate_series(1,1000) g;
   INSERT INTO public.confirmed_rental_expenses(id,expense_id,project_id,expense_amount,expense_date,expense_description,item_name,supplier,quantity,rental_start,rental_end,confirmed_by)
   SELECT md5(('rental-boundary'||g)::text)::uuid,md5(('rental-boundary-expense'||g)::text)::uuid,'${site}',1,'2024-11-04','Rental boundary '||g,'Tool','Supplier',1,'2024-11-01','2024-11-02','${founder}' FROM generate_series(1,999) g;SET ROLE authenticated`);
  const atLimit=await db.query<{v:{items:unknown[]}}>('SELECT public.project_confirmed_rentals($1) v',[site]);expect(atLimit.rows[0].v.items).toHaveLength(1000);
  await db.exec(`RESET ROLE; INSERT INTO public.confirmed_rental_expenses(id,expense_id,project_id,expense_amount,expense_date,expense_description,item_name,supplier,quantity,rental_start,rental_end,confirmed_by) VALUES(md5('rental-boundary1000')::uuid,md5('rental-boundary-expense1000')::uuid,'${site}',1,'2024-11-04','Rental boundary 1000','Tool','Supplier',1,'2024-11-01','2024-11-02','${founder}');SET ROLE authenticated`);
  await expect(db.query('SELECT public.project_confirmed_rentals($1)',[site])).rejects.toMatchObject({code:'54000'});
 }finally{await db.close();}},60000);
 it('refuses a changed function body before any upgrade',async()=>{const db=new PGlite();try{await db.exec(`${roles} ${fixture}`);for(const path of candidatePaths)await db.exec(readFileSync(path,'utf8'));await db.exec(`CREATE OR REPLACE FUNCTION public.project_confirmed_rentals(p_project uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$SELECT '{}'::jsonb$$`);
  await expect(db.exec(`BEGIN;${sql('project_cost_larger_review')} COMMIT`)).rejects.toThrow(/dependency changed/);await db.exec('ROLLBACK');
 }finally{await db.close();}},30000);
});
