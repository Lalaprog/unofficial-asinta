import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const founder='00000000-0000-0000-0000-000000000001',supervisor='00000000-0000-0000-0000-000000000002',site='00000000-0000-0000-0000-000000000004';
const id=(n:number)=>`93000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const voucherCase=id(1),externalCase=id(2),voucher=id(3),source=id(4),expense=id(5),history=id(6);
const choice=(decision:'include'|'exclude',reason:string|null)=>({decision,reason});
const decisions=()=>({expenses:{[expense]:choice('include',null)},historical:{[history]:choice('include',null)},corrections:{[`voucher:${voucherCase}`]:choice('include','Reviewed voucher original'),[`external_worker:${externalCase}`]:choice('include','Reviewed historical original')}});
const item=(kind:string,cid:string,sourceId:string,effect:string|null)=>({kind,case_id:cid,source_in_snapshot:true,site_gross_change:effect,evidence:{case:{status:'settled_external',related_cases:[{status:'settled_external'}],...(kind==='voucher'?{payroll_id:sourceId}:{external_worker_id:sourceId})},attribution:effect===null?null:{case_changed:false}}});
const snapshot=()=>({project_id:site,historical_review:{project_id:site,base:{captured_at:'2026-11-14T00:00:00Z',expenses:[{id:expense,amount:'100.00'}],paid_allocations:[{payroll_id:voucher,gross:'600.00'}],adjustment_cases:[{case_id:voucherCase}]},historical:[{request_id:history,source_id:source,site_gross:'400.00',case_count:1,overlapping_vouchers:0}]},corrections:[item('voucher',voucherCase,voucher,'25.00'),item('external_worker',externalCase,source,'-20.00')]});
async function setup(){const db=new PGlite();await db.exec(baseFixture);await db.exec(`CREATE TABLE public.test_inventory(value jsonb NOT NULL); CREATE FUNCTION public.project_cost_correction_inventory(uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$SELECT value FROM public.test_inventory WHERE value->>'project_id'=$1::text$$; BEGIN;${readFileSync('supabase/drafts/project_cost_corrected_preview.sql','utf8')} COMMIT; BEGIN;${readFileSync('supabase/drafts/project_cost_corrected_review_ledger.sql','utf8')} COMMIT;`);await db.query('INSERT INTO public.test_inventory VALUES($1::jsonb)',[JSON.stringify(snapshot())]);await db.exec(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);return db;}
async function setSnapshot(db:PGlite,value:unknown){await db.exec('RESET ROLE');await db.query('UPDATE public.test_inventory SET value=$1::jsonb',[JSON.stringify(value)]);await db.exec('SET ROLE authenticated');}
async function calculate(db:PGlite,s:unknown=snapshot(),c:unknown=decisions(),ack=true){return (await db.query<{v:Record<string,unknown>}>('SELECT public.project_cost_corrected_preview($1,$2::jsonb,$3::jsonb,$4) v',[site,JSON.stringify(s),JSON.stringify(c),ack])).rows[0].v;}
describe('corrected project cost preview (synthetic, read-only candidate)',()=>{
 it('adds reviewed signed gross exactly once and keeps exclusions explicit',async()=>{const db=await setup();try{
  expect(await calculate(db)).toMatchObject({included_expenses:'100.00',paid_gross:'600.00',historical_gross:'400.00',correction_gross:'5.00',excluded_cases:0,incomplete_total:'1105.00',incomplete:true});
  const d=decisions();d.expenses[expense]=choice('exclude','Possible Bale duplicate');d.historical[history]=choice('exclude','Original not included');d.corrections[`external_worker:${externalCase}`]=choice('exclude','Exclude with original');
  expect(await calculate(db,snapshot(),d)).toMatchObject({excluded_expenses:'100.00',excluded_historical:'400.00',correction_gross:'25.00',excluded_cases:1,incomplete_total:'625.00'});
  d.corrections[`external_worker:${externalCase}`]=choice('include','Reviewed');await expect(calculate(db,snapshot(),d)).rejects.toThrow(/original is not included/);
  await db.exec('RESET ROLE');expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.advances')).rows[0].n).toBe(0);expect((await db.query<{gross:string}>('SELECT gross_pay::text gross FROM public.payroll')).rows[0].gross).toBe('600');
 }finally{await db.close();}},30000);
 it('requires complete decisions, acknowledgement, reasons and the current exact snapshot',async()=>{const db=await setup();try{
  await expect(calculate(db,snapshot(),decisions(),false)).rejects.toThrow(/Invalid corrected review/);
  const d=decisions();delete (d.corrections as Record<string,unknown>)[`voucher:${voucherCase}`];await expect(calculate(db,snapshot(),d)).rejects.toThrow(/Review every corrections/);
  const missingReason=decisions();missingReason.corrections[`voucher:${voucherCase}`]=choice('include',null);await expect(calculate(db,snapshot(),missingReason)).rejects.toThrow(/decision or reason/);
  const wrong=decisions();wrong.expenses[expense]=choice('exclude','  ');await expect(calculate(db,snapshot(),wrong)).rejects.toThrow(/decision or reason/);
  const changed=snapshot();changed.historical_review.base.expenses[0].amount='99.00';await setSnapshot(db,changed);await expect(calculate(db)).rejects.toThrow(/evidence changed/);expect((await calculate(db,changed)).incomplete_total).toBe('1104.00');
 }finally{await db.close();}},30000);
 it('fails closed on missing, stale, pending, unlinked or excessive corrections and missing case signals',async()=>{const db=await setup();try{
  for(const kind of ['missing','stale','pending','unlinked','excessive','missing-signal']){
   const s=snapshot(),row=s.corrections[0];
   if(kind==='missing'){row.evidence.attribution=null;row.site_gross_change=null;}
   if(kind==='stale')row.evidence.attribution!.case_changed=true;
   if(kind==='pending')row.evidence.case.related_cases.push({status:'pending'});
   if(kind==='unlinked')row.source_in_snapshot=false;
   if(kind==='excessive')row.site_gross_change='-600.01';
   if(kind==='missing-signal')s.historical_review.historical[0].case_count=2;
   await setSnapshot(db,s);await expect(calculate(db,s)).rejects.toThrow(/evidence|invalidates|signal differs/);
  }
  const excluded=decisions();excluded.corrections[`voucher:${voucherCase}`]=choice('exclude','Evidence unavailable');const missing=snapshot();missing.corrections[0].evidence.attribution=null;missing.corrections[0].site_gross_change=null;await setSnapshot(db,missing);expect(await calculate(db,missing,excluded)).toMatchObject({correction_gross:'-20.00',excluded_cases:1,incomplete:true});
 }finally{await db.close();}},30000);
 it('requires an exact distinct-effects assertion for multiple cases and bounds their combined effect',async()=>{const db=await setup();try{
  const overlap=snapshot();overlap.historical_review.historical[0].overlapping_vouchers=1;await setSnapshot(db,overlap);await expect(calculate(db,overlap)).rejects.toThrow(/overlap/);
  const multiple=snapshot();multiple.corrections.push(item('voucher',id(7),voucher,'10.00'));multiple.historical_review.base.adjustment_cases.push({case_id:id(7)});await setSnapshot(db,multiple);
  const d=decisions();d.corrections[`voucher:${id(7)}`]=choice('include','Another case');await expect(calculate(db,multiple,d)).rejects.toThrow(/distinct-effects review/);
  const review={case_ids:[`voucher:${voucherCase}`,`voucher:${id(7)}`].sort(),note:'Independent original documents checked',non_overlapping:true};
  const combined={...d,source_reviews:{[`voucher:${voucher}`]:review}};
  expect(await calculate(db,multiple,combined)).toMatchObject({correction_gross:'15.00',incomplete_total:'1115.00',excluded_cases:0});
  for(const altered of [{...review,case_ids:[review.case_ids[0]]},{...review,case_ids:[...review.case_ids].reverse()},{...review,note:' '},{...review,non_overlapping:false}])await expect(calculate(db,multiple,{...d,source_reviews:{[`voucher:${voucher}`]:altered}})).rejects.toThrow(/distinct-effects review/);
  await expect(calculate(db,multiple,{...combined,source_reviews:{...combined.source_reviews,'voucher:unexpected':review}})).rejects.toThrow(/source review/);
  multiple.corrections[0].site_gross_change='-400.00';multiple.corrections[2].site_gross_change='-201.00';await setSnapshot(db,multiple);await expect(calculate(db,multiple,combined)).rejects.toThrow(/invalidates original site cost/);
  d.corrections[`voucher:${id(7)}`]=choice('exclude','Duplicate under investigation');multiple.corrections[0].site_gross_change='25.00';await setSnapshot(db,multiple);expect(await calculate(db,multiple,d)).toMatchObject({correction_gross:'5.00',excluded_cases:1});
 }finally{await db.close();}},30000);
 it('does not treat a missing inventory as an empty zero-cost snapshot',async()=>{const db=await setup();try{
  const invalid={project_id:site,historical_review:{project_id:site,base:{captured_at:'2026-11-14T00:00:00Z'}},corrections:[]};await setSnapshot(db,invalid);
  await expect(calculate(db,invalid,{expenses:{},historical:{},corrections:{}})).rejects.toThrow(/incomplete or unavailable/);
 }finally{await db.close();}},30000);
 it('denies unauthorized roles and assurance',async()=>{const db=await setup();try{
  await db.exec(`SET test.uid='${supervisor}'`);await expect(calculate(db)).rejects.toThrow(/Founder/);await db.exec(`SET test.uid='${founder}';SET test.assurance='no'`);await expect(calculate(db)).rejects.toThrow(/Founder/);
  for(const role of ['anon','service_role']){await db.exec(`RESET ROLE;SET ROLE ${role}`);await expect(calculate(db)).rejects.toThrow(/permission denied/);}
 }finally{await db.close();}},30000);
});

describe('separate corrected review ledger (synthetic candidate)',()=>{
 const record=async(db:PGlite,request:string,rev:number,s:unknown=snapshot(),c:unknown=decisions(),note='Reviewed incomplete costs',ack=true)=>(await db.query<{v:Record<string,unknown>}>('SELECT public.record_project_cost_corrected_review($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7) v',[request,site,rev,JSON.stringify(s),JSON.stringify(c),note,ack])).rows[0].v;
 const read=async(db:PGlite,rev:number|null=null)=>(await db.query<{v:Record<string,unknown>}>('SELECT public.project_cost_corrected_review($1,$2) v',[site,rev])).rows[0].v;
 it('stores server evidence, replays exact requests, preserves revisions and detects source changes',async()=>{const db=await setup();try{
  expect(await read(db)).toMatchObject({found:false,latest_revision:0});
  const sent=snapshot();sent.historical_review.base.captured_at='1900-01-01T00:00:00Z';expect(await record(db,id(20),0,sent)).toMatchObject({revision:1,replayed:false});expect(await record(db,id(20),0,sent)).toMatchObject({revision:1,replayed:true});
  let saved=await read(db);expect(saved).toMatchObject({revision:1,freshness:'matches',result:{incomplete_total:'1105.00',incomplete:true},snapshot:{historical_review:{base:{captured_at:'2026-11-14T00:00:00Z'}}}});
  await expect(record(db,id(20),0,sent,decisions(),'Changed note')).rejects.toThrow(/different details/);await expect(record(db,id(21),0,sent)).rejects.toThrow(/changed; reload/);
  const changed=snapshot();changed.historical_review.base.expenses[0].amount='90.00';await setSnapshot(db,changed);saved=await read(db);expect(saved).toMatchObject({freshness:'changed',result:{incomplete_total:'1105.00'}});await expect(record(db,id(21),1,sent)).rejects.toThrow(/evidence changed/);expect(await record(db,id(20),0,sent)).toMatchObject({replayed:true});
  expect(await record(db,id(21),1,changed)).toMatchObject({revision:2,replayed:false});expect(await read(db)).toMatchObject({revision:2,freshness:'matches',result:{incomplete_total:'1095.00'}});expect(await read(db,1)).toMatchObject({revision:1,freshness:'changed'});
  await db.exec('RESET ROLE');await expect(db.query("UPDATE public.project_cost_corrected_reviews SET note='tamper'")).rejects.toThrow(/immutable/);await expect(db.query('DELETE FROM public.project_cost_corrected_reviews')).rejects.toThrow(/immutable/);
 }finally{await db.close();}},30000);
 it('retains exact multi-case assertions in immutable revisions and retries',async()=>{const db=await setup();try{
  const s=snapshot();s.corrections.push(item('voucher',id(7),voucher,'10.00'));s.historical_review.base.adjustment_cases.push({case_id:id(7)});await setSnapshot(db,s);
  const d=decisions();d.corrections[`voucher:${id(7)}`]=choice('include','Separate case');
  const review={case_ids:[`voucher:${voucherCase}`,`voucher:${id(7)}`].sort(),note:'Separate source evidence checked',non_overlapping:true};
  const combined={...d,source_reviews:{[`voucher:${voucher}`]:review}};
  expect(await record(db,id(40),0,s,combined)).toMatchObject({revision:1,replayed:false});
  expect(await record(db,id(40),0,s,combined)).toMatchObject({revision:1,replayed:true});
  expect(await read(db)).toMatchObject({revision:1,choices:{source_reviews:combined.source_reviews},result:{incomplete_total:'1115.00'}});
  const changed={...combined,source_reviews:{[`voucher:${voucher}`]:{...review,note:'Changed assertion'}}};await expect(record(db,id(40),0,s,changed)).rejects.toThrow(/different details/);
 }finally{await db.close();}},30000);
 it('requires permissions, acknowledgement, current evidence and read committed',async()=>{const db=await setup();try{
  await expect(record(db,id(30),0,snapshot(),decisions(),'Reviewed',false)).rejects.toThrow(/Invalid corrected review/);
  await db.exec('BEGIN ISOLATION LEVEL REPEATABLE READ');await expect(record(db,id(30),0)).rejects.toThrow(/read committed/);await db.exec('ROLLBACK');
  await db.exec(`SET test.uid='${supervisor}'`);await expect(record(db,id(30),0)).rejects.toThrow(/Founder/);await expect(read(db)).rejects.toThrow(/Founder/);
  await db.exec(`SET test.uid='${founder}'; SET test.assurance='no'`);await expect(record(db,id(30),0)).rejects.toThrow(/Founder/);
  for(const role of ['anon','service_role']){await db.exec(`RESET ROLE;SET ROLE ${role}`);await expect(read(db)).rejects.toThrow(/permission denied/);await expect(record(db,id(30),0)).rejects.toThrow(/permission denied/);}
  await db.exec('RESET ROLE;SET ROLE authenticated;SET test.assurance=\'yes\'');await expect(db.query('SELECT * FROM public.project_cost_corrected_reviews')).rejects.toThrow(/permission denied/);
 }finally{await db.close();}},30000);
});
