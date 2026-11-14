import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const founder='00000000-0000-0000-0000-000000000001',supervisor='00000000-0000-0000-0000-000000000002',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004',other='00000000-0000-0000-0000-000000000005';
const id=(n:number)=>`95000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const voucher=id(1),historical=id(2),voucherCase=id(3),historicalCase=id(4),attribution=id(5);
const original={id:voucher,worker_id:worker,period_start:'2026-10-25',period_end:'2026-10-31',status:'paid',gross_pay:'600.00'};
const old={kind:'external_worker',id:historical,person_id:worker,start:'2026-10-25',end:'2026-10-31',paid_on:'2026-10-31',gross:'600.00'};
const empty=(project:string)=>({project_id:project,base:{paid_allocations:[] as unknown[]},historical:[] as unknown[]});
const paid=(gross:string)=>({payroll_id:voucher,worker_id:worker,period_start:original.period_start,period_end:original.period_end,voucher_gross:'600.00',gross});
const history=(gross:string)=>({source_id:historical,worker_id:worker,period_start:old.start,period_end:old.end,paid_on:old.paid_on,original_gross:'600.00',site_gross:gross,overlapping_vouchers:0});
async function setup(){
 const db=new PGlite();await db.exec(baseFixture);await db.exec(`CREATE TABLE public.weekly_worker_paid_allocations(payroll_id uuid,project_id uuid);
 CREATE TABLE public.historical_worker_attributions(request_id uuid,source_id uuid);CREATE TABLE public.historical_worker_attribution_sites(attribution_id uuid,project_id uuid);
 CREATE TABLE public.test_original_cases(kind text,case_id uuid,value jsonb);CREATE TABLE public.test_original_sites(project_id uuid,value jsonb);
 CREATE FUNCTION app_private.project_cost_correction_case(k text,c uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT value FROM public.test_original_cases WHERE kind=k AND case_id=c$$;
 CREATE FUNCTION public.project_cost_historical_review(p uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT value FROM public.test_original_sites WHERE project_id=p$$;
 INSERT INTO public.weekly_worker_paid_allocations VALUES('${voucher}','${site}'),('${voucher}','${other}');
 INSERT INTO public.historical_worker_attributions VALUES('${attribution}','${historical}'); INSERT INTO public.historical_worker_attribution_sites VALUES('${attribution}','${site}'),('${attribution}','${other}');`);
 const first=empty(site),second=empty(other);first.base.paid_allocations.push(paid('400.00'));second.base.paid_allocations.push(paid('200.00'));first.historical.push(history('400.00'));second.historical.push(history('200.00'));
 await db.query('INSERT INTO public.test_original_sites VALUES($1,$2::jsonb),($3,$4::jsonb)',[site,JSON.stringify(first),other,JSON.stringify(second)]);
 await db.query('INSERT INTO public.test_original_cases VALUES($1,$2,$3::jsonb),($4,$5,$6::jsonb)',['voucher',voucherCase,JSON.stringify({payroll_id:voucher,worker_id:worker,original_voucher:original,related_cases:[] }),'external_worker',historicalCase,JSON.stringify({source_kind:'external_worker',external_worker_id:historical,original_snapshot:old,related_cases:[]})]);
 await db.exec(`BEGIN;${readFileSync('supabase/drafts/project_cost_correction_original_context.sql','utf8')} COMMIT;SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);return db;
}
async function get(db:PGlite,kind:string,cid:string){return (await db.query<{v:unknown}>('SELECT public.project_cost_correction_original_context($1,$2) v',[kind,cid])).rows[0].v;}
describe('original-site context for later cross-site review (synthetic candidate)',()=>{
 it('returns all validated original sites in deterministic order, without posting anything',async()=>{const db=await setup();try{
  for(const [kind,cid,source] of [['voucher',voucherCase,voucher],['external_worker',historicalCase,historical]])expect(await get(db,kind,cid)).toEqual({source_kind:kind,case_id:cid,source_id:source,worker_id:worker,period_start:'2026-10-25',period_end:'2026-10-31',original_gross:'600.00',case_fingerprint:expect.stringMatching(/^[0-9a-f]{64}$/),sites:[{project_id:site,gross:'400.00'},{project_id:other,gross:'200.00'}]});
  await db.exec('RESET ROLE');expect((await db.query('SELECT status,gross_pay::text gross FROM public.payroll WHERE id=$1',[worker])).rows).toEqual([{status:'paid',gross:'600'}]);expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.advances')).rows[0].n).toBe(0);
 }finally{await db.close();}},30000);
 it('changes its source fingerprint when sibling case evidence changes even if gross is unchanged',async()=>{const db=await setup();try{
  const before=await get(db,'voucher',voucherCase) as {case_fingerprint:string;sites:unknown};
  await db.exec(`RESET ROLE;UPDATE public.test_original_cases SET value=jsonb_set(value,'{related_cases}',$$[{"status":"pending"}]$$::jsonb) WHERE case_id='${voucherCase}';SET ROLE authenticated`);
  const after=await get(db,'voucher',voucherCase) as typeof before;expect(after.sites).toEqual(before.sites);expect(after.case_fingerprint).not.toBe(before.case_fingerprint);
 }finally{await db.close();}},30000);
 it('refuses missing, duplicated, changed or incomplete site evidence',async()=>{const db=await setup();try{
  await db.exec(`RESET ROLE;UPDATE public.test_original_sites SET value=jsonb_set(value,'{base,paid_allocations}','[]'::jsonb) WHERE project_id='${other}';SET ROLE authenticated`);await expect(get(db,'voucher',voucherCase)).rejects.toThrow(/missing or ambiguous/);
  await db.exec(`RESET ROLE;UPDATE public.test_original_sites SET value=jsonb_set(value,'{base,paid_allocations}',$$[${JSON.stringify(paid('199.00'))}]$$::jsonb) WHERE project_id='${other}';SET ROLE authenticated`);await expect(get(db,'voucher',voucherCase)).rejects.toThrow(/total differs/);
  await db.exec(`RESET ROLE;UPDATE public.test_original_sites SET value=jsonb_set(value,'{base,paid_allocations}',$$[${JSON.stringify(paid('200.00'))},${JSON.stringify(paid('200.00'))}]$$::jsonb) WHERE project_id='${other}';SET ROLE authenticated`);await expect(get(db,'voucher',voucherCase)).rejects.toThrow(/missing or ambiguous/);
  await db.exec(`RESET ROLE;DELETE FROM public.weekly_worker_paid_allocations;SET ROLE authenticated`);await expect(get(db,'voucher',voucherCase)).rejects.toThrow(/allocation unavailable/);
 }finally{await db.close();}},30000);
 it('refuses duplicate or oversized source-site lists instead of a partial result',async()=>{const db=await setup();try{
  await db.exec(`RESET ROLE;INSERT INTO public.weekly_worker_paid_allocations VALUES('${voucher}','${site}');SET ROLE authenticated`);await expect(get(db,'voucher',voucherCase)).rejects.toThrow(/duplicated/);
  await db.exec(`RESET ROLE;DELETE FROM public.weekly_worker_paid_allocations;INSERT INTO public.weekly_worker_paid_allocations SELECT '${voucher}',md5(n::text)::uuid FROM generate_series(1,51) n;SET ROLE authenticated`);await expect(get(db,'voucher',voucherCase)).rejects.toThrow(/exceeds 50/);
 }finally{await db.close();}},30000);
 it('blocks historical voucher overlap and source identity mismatches',async()=>{const db=await setup();try{
  await db.exec(`RESET ROLE;UPDATE public.test_original_sites SET value=jsonb_set(value,'{historical,0,overlapping_vouchers}','1'::jsonb) WHERE project_id='${site}';SET ROLE authenticated`);await expect(get(db,'external_worker',historicalCase)).rejects.toThrow(/overlap/);
  await db.exec(`RESET ROLE;UPDATE public.test_original_cases SET value=jsonb_set(value,'{original_snapshot,person_id}',to_jsonb('${supervisor}'::text)) WHERE case_id='${historicalCase}';UPDATE public.test_original_sites SET value=jsonb_set(value,'{historical,0,overlapping_vouchers}','0'::jsonb) WHERE project_id='${site}';SET ROLE authenticated`);await expect(get(db,'external_worker',historicalCase)).rejects.toThrow(/identity differs/);
 }finally{await db.close();}},30000);
 it('denies other roles, missing assurance, and unrecognized source',async()=>{const db=await setup();try{
  await db.exec(`SET test.uid='${supervisor}'`);await expect(get(db,'voucher',voucherCase)).rejects.toThrow(/Founder/);await db.exec(`SET test.uid='${founder}';SET test.assurance='no'`);await expect(get(db,'voucher',voucherCase)).rejects.toThrow(/Founder/);await db.exec("SET test.assurance='yes'");await expect(get(db,'supervisor',voucherCase)).rejects.toThrow(/Invalid/);
  for(const role of ['anon','service_role']){await db.exec(`RESET ROLE;SET ROLE ${role}`);await expect(get(db,'voucher',voucherCase)).rejects.toThrow(/permission denied/);}
 }finally{await db.close();}},30000);
});
