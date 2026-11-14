import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const founder='00000000-0000-0000-0000-000000000001',supervisor='00000000-0000-0000-0000-000000000002',site='00000000-0000-0000-0000-000000000004',other='00000000-0000-0000-0000-000000000005';
const id=(n:number)=>`96000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const source=id(1),caseId=id(2),destination=id(3);
const current={id:caseId,status:'no_transfer',related_cases:[{id:caseId,status:'no_transfer'}]};
const original=()=>({source_kind:'voucher',case_id:caseId,source_id:source,original_gross:'600.00',case_snapshot:current,sites:[{project_id:site,gross:'400.00'},{project_id:other,gross:'200.00'}]});
const correction=()=>({source_kind:'voucher',case_id:caseId,case:current,attribution:{case_changed:false,case_snapshot:current,gross_change:'0.00',split:[{project_id:site,gross_change:'-100.00'},{project_id:destination,gross_change:'100.00'}]}});
async function setup(){const db=new PGlite();await db.exec(baseFixture);await db.exec(`CREATE TABLE public.test_cross_original(value jsonb);CREATE TABLE public.test_cross_correction(value jsonb);
 CREATE FUNCTION public.project_cost_correction_original_context(text,uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT value FROM public.test_cross_original$$;
 CREATE FUNCTION public.project_cost_correction_attribution(text,uuid,integer) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT value FROM public.test_cross_correction$$;`);
 await db.query('INSERT INTO public.test_cross_original VALUES($1::jsonb)',[JSON.stringify(original())]);await db.query('INSERT INTO public.test_cross_correction VALUES($1::jsonb)',[JSON.stringify(correction())]);
 await db.exec(`BEGIN;${readFileSync('supabase/drafts/project_cost_cross_site_preview.sql','utf8')} COMMIT; SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);return db;}
async function evidence(db:PGlite){return (await db.query<{v:unknown}>('SELECT public.project_cost_cross_site_evidence($1,$2) v',['voucher',caseId])).rows[0].v;}
async function preview(db:PGlite,s:unknown,ack=true){return (await db.query<{v:unknown}>('SELECT public.project_cost_cross_site_preview($1,$2,$3::jsonb,$4) v',['voucher',caseId,JSON.stringify(s),ack])).rows[0].v;}
async function change(db:PGlite,table:string,value:unknown){if(!['test_cross_original','test_cross_correction'].includes(table))throw Error('Invalid fixture');await db.exec('RESET ROLE');await db.query(`UPDATE public.${table} SET value=$1::jsonb`,[JSON.stringify(value)]);await db.exec('SET ROLE authenticated');}
describe('cross-site gross illustration, synthetic and read only',()=>{
 it('balances a full reallocation into a new site with no original there',async()=>{const db=await setup();try{
  const s=await evidence(db);expect(await preview(db,s)).toEqual({source_kind:'voucher',case_id:caseId,source_id:source,original_gross:'600.00',gross_change:'0.00',corrected_gross:'600.00',incomplete:true,sites:[{project_id:site,original_gross:'400.00',gross_change:'-100.00',corrected_gross:'300.00'},{project_id:other,original_gross:'200.00',gross_change:'0.00',corrected_gross:'200.00'},{project_id:destination,original_gross:'0.00',gross_change:'100.00',corrected_gross:'100.00'}]});
  await db.exec('RESET ROLE');expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.advances')).rows[0].n).toBe(0);expect((await db.query<{status:string}>('SELECT status FROM public.payroll')).rows[0].status).toBe('paid');
 }finally{await db.close();}},30000);
 it('requires the exact current evidence and explicit whole-site acknowledgement',async()=>{const db=await setup();try{
  const s=await evidence(db);await expect(preview(db,s,false)).rejects.toThrow(/Invalid cross-site review/);const newer=correction();newer.attribution.split[0].gross_change='-50.00';newer.attribution.split[1].gross_change='50.00';await change(db,'test_cross_correction',newer);await expect(preview(db,s)).rejects.toThrow(/evidence changed/);
  const mismatch=original();mismatch.case_snapshot={...current,status:'settled_external'};await change(db,'test_cross_original',mismatch);await expect(evidence(db)).rejects.toThrow(/evidence differs/);
 }finally{await db.close();}},30000);
 it('blocks missing attribution, stale cases and more than one sibling case',async()=>{const db=await setup();try{
  for(const mutation of ['missing','stale','sibling']){const v=correction();if(mutation==='missing')(v as {attribution:unknown}).attribution=null;if(mutation==='stale')v.attribution.case_changed=true;if(mutation==='sibling'){const c={...current,related_cases:[...current.related_cases,{id:id(9),status:'no_transfer'}]};v.case=c;v.attribution.case_snapshot=c;const o=original();o.case_snapshot=c;await change(db,'test_cross_original',o);}await change(db,'test_cross_correction',v);await expect(preview(db,await evidence(db))).rejects.toThrow(/resolved correction|exactly one/);}
 }finally{await db.close();}},30000);
 it('rejects overdrawn sites, missing values and unbalanced splits',async()=>{const db=await setup();try{
  for(const [split,total] of [
   [[{project_id:site,gross_change:'-401.00'},{project_id:destination,gross_change:'401.00'}],'0.00'],
   [[{project_id:destination,gross_change:'-1.00'}],'-1.00'],
   [[{project_id:destination}],'0.00'],
   [[{project_id:destination,gross_change:'100.00'}],'0.00'],
   [[{project_id:destination,gross_change:'100.00'},{project_id:destination,gross_change:'-100.00'}],'0.00'],
  ] as const){const c=correction();(c.attribution as {split:unknown;gross_change:string}).split=split;c.attribution.gross_change=total;await change(db,'test_cross_correction',c);await expect(preview(db,await evidence(db))).rejects.toThrow();}
 }finally{await db.close();}},30000);
 it('never treats an incomplete original-site row as zero or accepts a duplicated site',async()=>{const db=await setup();try{
  const missing=original();(missing.sites as unknown[])=[{project_id:site},{project_id:other,gross:'200.00'}];await change(db,'test_cross_original',missing);await expect(preview(db,await evidence(db))).rejects.toThrow(/Invalid cross-site/);
  const duplicate=original();duplicate.sites.push({project_id:site,gross:'0.00'});await change(db,'test_cross_original',duplicate);await expect(preview(db,await evidence(db))).rejects.toThrow(/Duplicate/);
 }finally{await db.close();}},30000);
 it('requires Founder assurance and denies anonymous and service RPC access',async()=>{const db=await setup();try{
  const s=await evidence(db);await db.exec(`SET test.uid='${supervisor}'`);await expect(preview(db,s)).rejects.toThrow(/Founder/);await db.exec(`SET test.uid='${founder}';SET test.assurance='no'`);await expect(evidence(db)).rejects.toThrow(/Founder/);
  for(const role of ['anon','service_role']){await db.exec(`RESET ROLE;SET ROLE ${role}`);await expect(evidence(db)).rejects.toThrow(/permission denied/);await expect(preview(db,s)).rejects.toThrow(/permission denied/);}
 }finally{await db.close();}},30000);
});
