import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {estimateProjectCost,parseCostSnapshot} from '@/lib/projects/projectCostReconciliation';
import {baleExpense,candidatePaths,confirmRental,fixture,founder,materialExpense,other,payroll,rentalExpense,roles,site,supervisor,worker} from './helpers/project-cost-reconciliation-fixture';

const request='20000000-0000-0000-0000-000000000001';
const request2='20000000-0000-0000-0000-000000000002';
const choices={ [materialExpense]:{decision:'include',reason:null},[rentalExpense]:{decision:'include',reason:null},[baleExpense]:{decision:'exclude',reason:'Already represented by worker gross pay'} };
async function setup(){
 const db=new PGlite(); await db.exec(`${roles} ${fixture}`);
 for(const path of [...candidatePaths,'supabase/drafts/project_cost_review_ledger.sql'])await db.exec(readFileSync(path,'utf8'));
 await db.exec(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'; ${confirmRental}`);return db;
}
async function snapshot(db:PGlite){return (await db.query<{v:unknown}>('SELECT public.project_cost_reconciliation_preview($1) v',[site])).rows[0].v;}
async function record(db:PGlite,id:string,rev:number,snap:unknown,c:unknown=choices,note='Manual review of recorded sources'){
 return (await db.query<{v:Record<string,unknown>}>('SELECT public.record_project_cost_review($1,$2,$3,$4::jsonb,$5::jsonb,$6) v',[id,site,rev,JSON.stringify(snap),JSON.stringify(c),note])).rows[0].v;
}
async function review(db:PGlite,revision:number|null=null){return (await db.query<{v:Record<string,unknown>}>('SELECT public.project_cost_review($1,$2) v',[site,revision])).rows[0].v;}

describe('uninstalled durable incomplete project-cost review',()=>{
 it('records exact choices and gross once, replays safely, detects changes, and preserves finance',async()=>{const db=await setup();try{
  await db.exec('RESET ROLE');const before=(await db.query(`SELECT (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.expenses e) expenses,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.payroll p) payroll,(SELECT jsonb_agg(to_jsonb(a) ORDER BY project_id) FROM public.weekly_worker_paid_allocations a) allocations`)).rows[0];await db.exec('SET ROLE authenticated');
  expect(await review(db)).toMatchObject({found:false,latest_revision:0});const s=await snapshot(db);
  expect(await record(db,request,0,s)).toMatchObject({revision:1,replayed:false});
  expect(await record(db,request,0,s)).toMatchObject({revision:1,replayed:true});
  await expect(record(db,request,0,s,choices,'Different note')).rejects.toThrow(/different details/);
  expect(await review(db)).toMatchObject({found:true,revision:1,latest_revision:1,included_expenses:'1050.00',excluded_expenses:'100.00',paid_gross:'600.00',incomplete_total:'1650.00',freshness:'matches',choices});
  await db.exec('RESET ROLE');const after=(await db.query(`SELECT (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.expenses e) expenses,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.payroll p) payroll,(SELECT jsonb_agg(to_jsonb(a) ORDER BY project_id) FROM public.weekly_worker_paid_allocations a) allocations`)).rows[0];expect(after).toEqual(before);
  await expect(db.exec(`UPDATE public.project_cost_reviews SET note='altered'`)).rejects.toThrow(/immutable/);
  await db.query('UPDATE public.expenses SET amount=51 WHERE id=$1',[materialExpense]);await db.exec('SET ROLE authenticated');
  expect(await review(db)).toMatchObject({freshness:'changed',incomplete_total:'1650.00'});
  await expect(record(db,request2,1,s)).rejects.toThrow(/evidence changed/);
  await expect(record(db,request2,0,await snapshot(db))).rejects.toThrow(/review changed/);
  expect(await record(db,request2,1,await snapshot(db))).toMatchObject({revision:2,replayed:false});
  expect(await review(db,1)).toMatchObject({revision:1,latest_revision:2,freshness:'changed'});
  expect(await review(db)).toMatchObject({revision:2,incomplete_total:'1651.00',freshness:'matches'});
  await db.exec('RESET ROLE');await db.query('UPDATE public.payroll SET net_pay=1 WHERE id=$1',[payroll]);await db.exec('SET ROLE authenticated');
  expect(await review(db)).toMatchObject({freshness:'unavailable',incomplete_total:'1651.00'});
 }finally{await db.close();}},30000);
 it('surfaces original-voucher corrections without inventing a site allocation and invalidates old reviews',async()=>{const db=await setup();try{
  const first=await snapshot(db);await record(db,request,0,first);
  await db.exec('RESET ROLE');const voucherSnapshot=(await db.query<{v:unknown}>('SELECT app_private.paid_adjustment_voucher_snapshot(p) v FROM public.payroll p WHERE id=$1',[payroll])).rows[0].v;await db.exec('SET ROLE authenticated');
  const caseId='30000000-0000-0000-0000-000000000001';
  await db.query("SELECT public.open_paid_payroll_adjustment($1,$2,$3,25.50,'Missed overtime')",[caseId,payroll,voucherSnapshot]);
  expect(await review(db)).toMatchObject({freshness:'changed',incomplete_total:'1650.00'});
  const pending=await snapshot(db),parsed=parseCostSnapshot(pending,site);expect(parsed.adjustments).toMatchObject([{id:caseId,payrollId:payroll,status:'pending',difference:'25.50',reason:'Missed overtime'}]);
  expect(estimateProjectCost(parsed,{[materialExpense]:'include',[baleExpense]:'exclude',[rentalExpense]:'include'}).total).toBe(165000n);
  const secondSite=parseCostSnapshot((await db.query<{v:unknown}>('SELECT public.project_cost_reconciliation_preview($1) v',[other])).rows[0].v,other);expect(secondSite.adjustments).toMatchObject([{id:caseId,payrollId:payroll,difference:'25.50'}]);
  await record(db,request2,1,pending);expect(await review(db)).toMatchObject({freshness:'matches',incomplete_total:'1650.00'});
  await db.query("SELECT public.resolve_paid_payroll_adjustment($1,'settled_external','2024-11-10','Settled separately')",[caseId]);
  expect(await review(db)).toMatchObject({freshness:'changed',incomplete_total:'1650.00'});
  await expect(record(db,'20000000-0000-0000-0000-000000000003',2,pending)).rejects.toThrow(/evidence changed/);
  const settled=parseCostSnapshot(await snapshot(db),site);expect(settled.adjustments).toMatchObject([{id:caseId,status:'settled_external',settledOn:'2024-11-10',resolutionNote:'Settled separately'}]);
  await db.exec('RESET ROLE');expect((await db.query<{gross:string;net:string}>('SELECT gross_pay::text gross,net_pay::text net FROM public.payroll WHERE id=$1',[payroll])).rows[0]).toEqual({gross:'750.00',net:'650.00'});
 }finally{await db.close();}},30000);
 it('does not surface cases for vouchers with no paid allocation at the selected site',async()=>{const db=await setup();try{
  const voucher2='40000000-0000-0000-0000-000000000001',case2='40000000-0000-0000-0000-000000000002';await db.exec('RESET ROLE');
  await db.query(`INSERT INTO public.payroll VALUES($1,$2,'2024-11-10','2024-11-16','paid',100,0,0,100,8)`,[voucher2,worker]);
  await db.query(`INSERT INTO public.weekly_worker_draft_sources VALUES($1,$2,'2024-11-10',$3,now(),NULL,$3,NULL,'{"wage":"100.00","allowance":"0.00","gross":"100.00","bale":"0.00","net":"100.00"}')`,[voucher2,worker,founder]);
  await db.query(`INSERT INTO public.payroll_payment_dates VALUES($1,'2024-11-16',$2);`,[voucher2,founder]);await db.query('INSERT INTO public.weekly_worker_paid_allocations VALUES($1,$2,8,100,0,100)',[voucher2,other]);
  const v=(await db.query<{v:unknown}>('SELECT app_private.paid_adjustment_voucher_snapshot(p) v FROM public.payroll p WHERE id=$1',[voucher2])).rows[0].v;await db.exec('SET ROLE authenticated');await db.query("SELECT public.open_paid_payroll_adjustment($1,$2,$3,-5.00,'Possible overpayment')",[case2,voucher2,v]);
  expect(parseCostSnapshot(await snapshot(db),site).adjustments).toEqual([]);
  expect(parseCostSnapshot((await db.query<{v:unknown}>('SELECT public.project_cost_reconciliation_preview($1) v',[other])).rows[0].v,other).adjustments).toMatchObject([{id:case2,payrollId:voucher2,difference:'-5.00'}]);
 }finally{await db.close();}},30000);
 it('fails closed on a mismatched case identity instead of attributing it to the worker',async()=>{const db=await setup();try{
  await db.exec('RESET ROLE');await db.query('INSERT INTO public.workers(id,name) VALUES($1,$2)',[founder,'Other worker']);
  await db.query(`INSERT INTO public.paid_payroll_adjustment_cases(id,payroll_id,worker_id,original_voucher,difference,reason,created_by) VALUES('50000000-0000-0000-0000-000000000001',$1,$2,'{}',1,'Synthetic corrupt data',$2)`,[payroll,founder]);
  await db.exec('SET ROLE authenticated');await expect(snapshot(db)).rejects.toThrow(/Adjustment case evidence is inconsistent/);
 }finally{await db.close();}},30000);
 it('rejects missing, extra, malformed or unexplained decisions without inserting anything',async()=>{const db=await setup();try{
  const s=await snapshot(db);const cases=[{}, {...choices,[other]:{decision:'exclude',reason:'extra'}}, {...choices,[baleExpense]:{decision:'exclude',reason:''}}, {...choices,[baleExpense]:{decision:'exclude',reason:123}}, {...choices,[baleExpense]:{decision:'include',reason:'not allowed'}}, {...choices,[baleExpense]:{decision:'include'}}, {...choices,[baleExpense]:null}];
  for(const c of cases)await expect(record(db,request,0,s,c)).rejects.toThrow(/expense|decisions/);
  await expect(record(db,request,0,s,choices,' ')).rejects.toThrow(/Invalid project review/);
  expect(await review(db)).toMatchObject({found:false,latest_revision:0});
 }finally{await db.close();}},30000);
 it('enforces Founder assurance and denies direct or privileged-client access',async()=>{const db=await setup();try{
  const s=await snapshot(db);await expect(db.query('SELECT * FROM public.project_cost_reviews')).rejects.toThrow(/permission denied/);
  await db.exec(`SET test.uid='${supervisor}'`);await expect(record(db,request,0,s)).rejects.toThrow(/Founder/);await expect(review(db)).rejects.toThrow(/Founder/);
  await db.exec(`SET test.uid='${founder}';SET test.assurance='no'`);await expect(record(db,request,0,s)).rejects.toThrow(/assurance/);await expect(review(db)).rejects.toThrow(/assurance/);
  for(const role of ['anon','service_role']){await db.exec(`RESET ROLE; SET ROLE ${role}; SET test.assurance='yes'`);await expect(review(db)).rejects.toThrow(/permission denied/);}
 }finally{await db.close();}},30000);
});
