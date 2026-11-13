import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baleExpense,candidatePaths,confirmRental,fixture,founder,materialExpense,other,payroll,rentalExpense,roles,site,supervisor} from './helpers/project-cost-reconciliation-fixture';

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
