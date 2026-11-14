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
async function setup(){const db=new PGlite();await db.exec(baseFixture);await db.exec(`CREATE TABLE public.test_inventory(value jsonb NOT NULL); CREATE FUNCTION public.project_cost_correction_inventory(uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$SELECT value FROM public.test_inventory WHERE value->>'project_id'=$1::text$$; BEGIN;${readFileSync('supabase/drafts/project_cost_corrected_preview.sql','utf8')} COMMIT;`);await db.query('INSERT INTO public.test_inventory VALUES($1::jsonb)',[JSON.stringify(snapshot())]);await db.exec(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);return db;}
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
 it('blocks overlaps and duplicate included source cases, but allows a documented exclusion',async()=>{const db=await setup();try{
  const overlap=snapshot();overlap.historical_review.historical[0].overlapping_vouchers=1;await setSnapshot(db,overlap);await expect(calculate(db,overlap)).rejects.toThrow(/overlap/);
  const duplicate=snapshot();duplicate.corrections.push(item('voucher',id(7),voucher,'10.00'));duplicate.historical_review.base.adjustment_cases.push({case_id:id(7)});await setSnapshot(db,duplicate);
  const d=decisions();d.corrections[`voucher:${id(7)}`]=choice('include','Another case');await expect(calculate(db,duplicate,d)).rejects.toThrow(/Multiple included corrections/);
  d.corrections[`voucher:${id(7)}`]=choice('exclude','Duplicate under investigation');expect(await calculate(db,duplicate,d)).toMatchObject({correction_gross:'5.00',excluded_cases:1});
 }finally{await db.close();}},30000);
 it('denies unauthorized roles and assurance',async()=>{const db=await setup();try{
  await db.exec(`SET test.uid='${supervisor}'`);await expect(calculate(db)).rejects.toThrow(/Founder/);await db.exec(`SET test.uid='${founder}';SET test.assurance='no'`);await expect(calculate(db)).rejects.toThrow(/Founder/);
  for(const role of ['anon','service_role']){await db.exec(`RESET ROLE;SET ROLE ${role}`);await expect(calculate(db)).rejects.toThrow(/permission denied/);}
 }finally{await db.close();}},30000);
});
