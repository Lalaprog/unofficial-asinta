import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const sql=readFileSync('supabase/preflight/legacy_finance_risk_summary.sql','utf8');
const fixture=`
 CREATE TABLE public.payroll(id int primary key,worker_id int,period_start date,period_end date,gross_pay numeric,bale_deduction numeric,other_deductions numeric,net_pay numeric,status text);
 CREATE TABLE public.advances(id int primary key,worker_id int,project_id int,amount numeric,amount_deducted numeric,status text);
 CREATE TABLE public.advance_requests(id int primary key,worker_id int,project_id int,requested_amount numeric,status text,issued_advance_id int);
`;
const read=async(db:PGlite)=>(await db.query<{finance_risk_summary:Record<string,number>}>(sql)).rows[0].finance_risk_summary;
describe('read-only aggregate legacy finance review',()=>{
 it('reports zero for empty tables without exposing records',async()=>{const db=new PGlite();try{await db.exec(fixture);const result=await read(db);expect(Object.keys(result)).toHaveLength(14);expect(Object.values(result).every(n=>n===0)).toBe(true);}finally{await db.close();}},30000);
 it('detects overlapping windows even when an earlier period contains a later one, while preserving source rows',async()=>{const db=new PGlite();try{
  await db.exec(`${fixture}
   INSERT INTO public.payroll VALUES
   (1,1,'2024-11-03','2024-11-30',500,100,0,400,'paid'),
   (2,1,'2024-11-10','2024-11-16',100,0,0,100,'draft'),
   (3,1,'2024-11-17','2024-11-23',100,0,0,100,'approved'),
   (4,2,'2024-11-03','2024-11-09',100,200,0,0,'paid'),
   (5,2,'2024-12-02','2024-12-01',100,0,0,100,'draft');
   INSERT INTO public.advances VALUES (1,1,1,100,100,'fully_deducted'),(2,2,2,50,51,'partially_deducted'),(3,3,3,10,1,'active'),(4,4,4,100,10,'cancelled');
   INSERT INTO public.advance_requests VALUES (1,1,1,100,'issued',1),(2,1,2,90,'issued',1),(3,2,2,50,'issued',99),(4,2,2,50,'pending_approval',2);
  `);
  const before=(await db.query('SELECT (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.payroll p) payroll,(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.advances a) advances,(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.advance_requests r) requests')).rows[0];
  expect(await read(db)).toEqual({payroll_rows:5,paid_payroll_rows:2,payroll_invalid_period_rows:1,payroll_rows_overlapping_earlier_period:2,payroll_non_sunday_saturday_period_rows:2,payroll_arithmetic_mismatch_rows:1,advance_rows:4,advance_deduction_exceeds_amount_rows:1,advance_status_balance_mismatch_rows:2,advance_request_rows:4,issued_request_missing_advance_rows:1,nonissued_request_with_advance_link_rows:1,issued_request_link_details_differ_rows:1,advance_ids_linked_by_multiple_requests:1});
  const after=(await db.query('SELECT (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.payroll p) payroll,(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.advances a) advances,(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.advance_requests r) requests')).rows[0];expect(after).toEqual(before);
 }finally{await db.close();}},30000);
});
