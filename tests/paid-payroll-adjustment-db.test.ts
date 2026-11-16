import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
import {parsePaidReview} from '@/lib/payroll/paidReview';
import {snapshotFromReview} from '@/lib/payroll/paidAdjustments';

const founder='00000000-0000-0000-0000-000000000001';
const supervisor='00000000-0000-0000-0000-000000000002';
const voucher='00000000-0000-0000-0000-000000000003';
const case1='10000000-0000-0000-0000-000000000001';
const case2='10000000-0000-0000-0000-000000000002';
const sql=readFileSync('supabase/drafts/paid_payroll_adjustments.sql','utf8');

describe('separate paid-period adjustment cases (draft)',()=>{
 it('requires Founder assurance, locks in the reviewed voucher, and never changes payroll or Bale',async()=>{
  const db=new PGlite();try{
   await db.exec(baseFixture);await db.query("UPDATE public.payroll SET period_start='2019-12-30',period_end='2020-01-05' WHERE id=$1",[voucher]);await db.exec(sql);
   const snap=(await db.query<{snapshot:unknown}>('SELECT app_private.paid_adjustment_voucher_snapshot(p) snapshot FROM public.payroll p WHERE id=$1',[voucher])).rows[0].snapshot;
   const before=(await db.query<{data:unknown}>(`SELECT jsonb_build_object('payroll',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.payroll p),'advances',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.advances a),'attendance',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.attendance a)) data`)).rows[0].data;
   const open=(id=case1,expected=snap,difference='50.25',reason='Missed OT')=>db.query<{data:{id:string;status:string;replayed:boolean}}>('SELECT public.open_paid_payroll_adjustment($1,$2,$3,$4,$5) data',[id,voucher,expected,difference,reason]);
   const resolve=(id=case1,resolution='settled_external',date:string|null='2020-01-01',note='Settled separately')=>db.query<{data:{id:string;status:string;replayed:boolean}}>('SELECT public.resolve_paid_payroll_adjustment($1,$2,$3,$4) data',[id,resolution,date,note]);
   await db.exec(`SET test.uid='${supervisor}'; SET test.assurance='yes'; SET ROLE authenticated;`);
   await expect(open()).rejects.toThrow(/Founder access/);await expect(db.query('SELECT public.paid_payroll_adjustment_list($1)',[voucher])).rejects.toThrow(/Founder access/);
   await expect(db.query('SELECT * FROM public.paid_payroll_adjustment_cases')).rejects.toThrow(/permission denied/);
   await db.exec(`SET test.uid='${founder}'; SET test.assurance='no'`);await expect(open()).rejects.toThrow(/Founder access/);
   await db.exec(`SET test.assurance='yes'`);
   await expect(open(case1,snap,'0')).rejects.toThrow(/valid nonzero/);await expect(open(case1,snap,'1.001')).rejects.toThrow(/valid nonzero/);
   await expect(open(case1,{...snap as object,net_pay:'123.00'})).rejects.toThrow(/Voucher changed since review/);
   expect((await open()).rows[0].data).toEqual({id:case1,status:'pending',replayed:false});
   expect((await open()).rows[0].data).toEqual({id:case1,status:'pending',replayed:true});
   await expect(open(case1,snap,'60')).rejects.toThrow(/already used/);await expect(open(case2)).rejects.toThrow(/already has a pending/);
   await expect(resolve(case1,'settled_external','9998-01-01')).rejects.toThrow(/valid resolution/);
   await expect(resolve(case1,'settled_external','2019-12-01')).rejects.toThrow(/cannot precede/);
   await expect(resolve(case1,'no_transfer','2020-01-01')).rejects.toThrow(/valid resolution/);
   await db.exec('RESET ROLE');await db.query('UPDATE public.payroll SET net_pay=599.99 WHERE id=$1',[voucher]);await db.exec('SET ROLE authenticated');
   await expect(resolve()).rejects.toThrow(/Original voucher changed/);
   await db.exec('RESET ROLE');await db.query('UPDATE public.payroll SET net_pay=600 WHERE id=$1',[voucher]);await db.exec('SET ROLE authenticated');
   expect((await resolve()).rows[0].data).toEqual({id:case1,status:'settled_external',replayed:false});
   expect((await resolve()).rows[0].data).toEqual({id:case1,status:'settled_external',replayed:true});
   await expect(resolve(case1,'no_transfer',null,'Waived')).rejects.toThrow(/already resolved/);
   expect((await open(case2,snap,'-20.00','Overpayment review')).rows[0].data.status).toBe('pending');
   expect((await resolve(case2,'no_transfer',null,'No recovery required')).rows[0].data.status).toBe('no_transfer');
   const list=(await db.query<{data:{total:number;items:{payroll_id:string;status:string;settled_on:string|null;difference:string}[]}}>('SELECT public.paid_payroll_adjustment_list($1) data',[voucher])).rows[0].data;
   expect(list.total).toBe(2);expect(list.items).toEqual(expect.arrayContaining([expect.objectContaining({payroll_id:voucher,status:'settled_external',settled_on:'2020-01-01',difference:'50.25'}),expect.objectContaining({payroll_id:voucher,status:'no_transfer',settled_on:null,difference:'-20.00'})]));
   await db.exec('RESET ROLE');const after=(await db.query<{data:unknown}>(`SELECT jsonb_build_object('payroll',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.payroll p),'advances',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.advances a),'attendance',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.attendance a)) data`)).rows[0].data;
   expect(after).toEqual(before);
  }finally{await db.close();}
 },30000);
 it('enforces independent assurance and atomically preserves immutable case and event history',async()=>{
  const db=new PGlite();try{
   await db.exec(baseFixture);await db.exec(sql);const snap=(await db.query<{snapshot:unknown}>('SELECT app_private.paid_adjustment_voucher_snapshot(p) snapshot FROM public.payroll p WHERE id=$1',[voucher])).rows[0].snapshot;
   // Simulate a role helper that accidentally stops checking assurance.
   await db.exec("CREATE OR REPLACE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder') $$");
   const open=()=>db.query('SELECT public.open_paid_payroll_adjustment($1,$2,$3,$4,$5)',[case1,voucher,snap,'50.25','Missed OT']);
   const resolve=()=>db.query('SELECT public.resolve_paid_payroll_adjustment($1,$2,$3,$4)',[case1,'no_transfer',null,'Reviewed']);
   await db.exec(`SET test.uid='${founder}'; SET test.assurance='no'; SET ROLE authenticated`);await expect(open()).rejects.toThrow(/assurance/);await expect(db.query('SELECT public.paid_payroll_adjustment_list($1)',[voucher])).rejects.toThrow(/assurance/);
   await db.exec("SET test.assurance='yes'");await open();await open();await db.exec('RESET ROLE');
   expect((await db.query<{kind:string;actor:string}>("SELECT kind,actor FROM public.paid_payroll_adjustment_events ORDER BY kind")).rows).toEqual([{kind:'opened',actor:founder}]);
   await expect(db.query('DELETE FROM public.paid_payroll_adjustment_cases WHERE id=$1',[case1])).rejects.toThrow(/immutable/);await expect(db.query("UPDATE public.paid_payroll_adjustment_cases SET reason='Changed' WHERE id=$1",[case1])).rejects.toThrow(/controlled final/);await expect(db.query('DELETE FROM public.paid_payroll_adjustment_events WHERE case_id=$1',[case1])).rejects.toThrow(/immutable/);
   await db.exec("ALTER TABLE public.paid_payroll_adjustment_events ADD CONSTRAINT fail_resolution CHECK(kind<>'resolved') NOT VALID; SET ROLE authenticated");await expect(resolve()).rejects.toThrow(/fail_resolution/);await db.exec('RESET ROLE');expect((await db.query<{status:string}>('SELECT status FROM public.paid_payroll_adjustment_cases WHERE id=$1',[case1])).rows[0].status).toBe('pending');
   await db.exec('ALTER TABLE public.paid_payroll_adjustment_events DROP CONSTRAINT fail_resolution; SET ROLE authenticated');await resolve();await resolve();await db.exec('RESET ROLE');
   expect((await db.query<{kind:string;before_row:{status:string}|null;after_row:{status:string}}>('SELECT kind,before_row,after_row FROM public.paid_payroll_adjustment_events WHERE case_id=$1 ORDER BY kind',[case1])).rows).toMatchObject([{kind:'opened',before_row:null,after_row:{status:'pending'}},{kind:'resolved',before_row:{status:'pending'},after_row:{status:'no_transfer'}}]);
   await expect(db.query("UPDATE public.paid_payroll_adjustment_cases SET resolution_note='changed' WHERE id=$1",[case1])).rejects.toThrow(/controlled final/);
   await db.exec("SET test.assurance='no'; SET ROLE authenticated");await expect(resolve()).rejects.toThrow(/assurance/);await expect(db.query('SELECT public.paid_payroll_adjustment_list($1)',[voucher])).rejects.toThrow(/assurance/);
  }finally{await db.close();}
 },30000);
 it('accepts the exact snapshot assembled from the paid history review response',async()=>{
  const db=new PGlite();try{
   await db.exec(baseFixture);await db.exec(sql);await db.exec(readFileSync('supabase/migrations/20261114000002_paid_payroll_review.sql','utf8'));
   await db.exec(`SET test.uid='${founder}'; SET test.assurance='yes'; SET ROLE authenticated`);
   const review=(await db.query<{data:unknown}>("SELECT public.paid_payroll_review('2026-10-25','2026-10-31') data")).rows[0].data;
   const v=parsePaidReview(review,'2026-10-25','2026-10-31').vouchers[0];
   expect(v.id).toBe(voucher);
   const created=(await db.query<{data:{status:string}}>('SELECT public.open_paid_payroll_adjustment($1,$2,$3,$4,$5) data',[case1,voucher,snapshotFromReview(v),'1.25','Review original period'])).rows[0].data;
   expect(created.status).toBe('pending');
  }finally{await db.close();}
 },30000);
 it('rolls back installation when an inherited grant gives clients direct table access',async()=>{
  const db=new PGlite();try{
   await db.exec(baseFixture);
   await db.exec('CREATE ROLE inherited_finance; GRANT inherited_finance TO authenticated; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO inherited_finance;');
   await expect(db.exec(`BEGIN; ${sql} COMMIT;`)).rejects.toThrow(/Unexpected direct adjustment-table client privilege/);
   await db.exec('ROLLBACK');
   expect((await db.query<{missing:boolean}>("SELECT to_regclass('public.paid_payroll_adjustment_cases') IS NULL missing")).rows[0].missing).toBe(true);
  }finally{await db.close();}
 },30000);
});
