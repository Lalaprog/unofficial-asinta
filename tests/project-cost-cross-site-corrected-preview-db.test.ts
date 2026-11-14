import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const founder='00000000-0000-0000-0000-000000000001',supervisor='00000000-0000-0000-0000-000000000002',site='00000000-0000-0000-0000-000000000004';
const caseId='98000000-0000-4000-8000-000000000001',key=`voucher:${caseId}`;
const correction={source_kind:'voucher',case_id:caseId,case:{status:'no_transfer'},attribution:{gross_change:'0.00'}};
const context=()=>({destination:site,source_kind:'voucher',case_id:caseId,source_evidence:{correction},illustration:{sites:[{project_id:site,original_gross:'0.00',gross_change:'100.25',corrected_gross:'100.25'}]},original_site_reviews:[{project_id:'98000000-0000-4000-8000-000000000002',revision:1}],incomplete:true});
const snapshot=()=>({project_id:site,corrections:[{kind:'voucher',case_id:caseId,source_in_snapshot:false,site_gross_change:'100.25',evidence:correction}]});
const choices=()=>({expenses:{},historical:{},corrections:{[key]:{decision:'include',reason:'Reviewed'}}});
async function setup(){const db=new PGlite();await db.exec(baseFixture);await db.exec(`CREATE TABLE public.test_cross_context(value jsonb);
 CREATE FUNCTION public.project_cost_cross_site_review_context(uuid,text,uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT value FROM public.test_cross_context$$;
 CREATE FUNCTION public.project_cost_corrected_preview(p uuid,s jsonb,c jsonb,a boolean) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$BEGIN
 IF c->'corrections'->'${key}'->>'decision' IS DISTINCT FROM 'exclude' OR c->'corrections'->'${key}'->>'reason' IS DISTINCT FROM 'Reviewed' THEN RAISE EXCEPTION 'Base choices invalid'; END IF;
 RETURN jsonb_build_object('project_id',p,'correction_gross','-20.00','incomplete_total','500.00','excluded_cases',1,'incomplete',true);END$$;`);
 await db.query('INSERT INTO public.test_cross_context VALUES($1::jsonb)',[JSON.stringify(context())]);await db.exec(`BEGIN;${readFileSync('supabase/drafts/project_cost_cross_site_corrected_preview.sql','utf8')} COMMIT;SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);return db;}
async function preview(db:PGlite,s:unknown=snapshot(),c:unknown=choices(),x:unknown={[key]:context()},ack=true){return (await db.query<{v:unknown}>('SELECT public.project_cost_cross_site_corrected_preview($1,$2::jsonb,$3::jsonb,$4::jsonb,$5) v',[site,JSON.stringify(s),JSON.stringify(c),JSON.stringify(x),ack])).rows[0].v;}
describe('incoming cross-site corrected project preview, synthetic',()=>{
 it('adds only the bound positive incoming effect to the existing incomplete result',async()=>{const db=await setup();try{
  expect(await preview(db)).toMatchObject({project_id:site,correction_gross:'80.25',incomplete_total:'600.25',excluded_cases:0,cross_site_gross:'100.25',cross_site_cases:1,incomplete:true});
  await db.exec('RESET ROLE');expect((await db.query('SELECT count(*)::int n FROM public.advances')).rows[0]).toEqual({n:0});
 }finally{await db.close();}},30000);
 it('permits explicit exclusion but rejects missing or unexpected source evidence',async()=>{const db=await setup();try{
  const c=choices();c.corrections[key].decision='exclude';expect(await preview(db,snapshot(),c,{})).toMatchObject({correction_gross:'-20.00',excluded_cases:1,cross_site_cases:0});
  await expect(preview(db,snapshot(),choices(),{})).rejects.toThrow(/original-site review evidence required/);await expect(preview(db,snapshot(),c,{[key]:context()})).rejects.toThrow(/Unexpected or missing/);
 }finally{await db.close();}},30000);
 it('rejects stale source reviews, changed correction evidence and bad amounts',async()=>{const db=await setup();try{
  const stale=context();stale.original_site_reviews[0].revision=2;await expect(preview(db,snapshot(),choices(),{[key]:stale})).rejects.toThrow(/evidence changed/);
  const different=snapshot();different.corrections[0].evidence={...correction,case_id:'different'};await expect(preview(db,different)).rejects.toThrow(/evidence differs/);
  const invalid=snapshot();invalid.corrections[0].site_gross_change='999.00';await expect(preview(db,invalid)).rejects.toThrow(/amount differs/);
  await expect(preview(db,snapshot(),choices(),{[key]:context()},false)).rejects.toThrow(/Invalid cross-site/);
 }finally{await db.close();}},30000);
 it('denies other roles and missing assurance',async()=>{const db=await setup();try{await db.exec(`SET test.uid='${supervisor}'`);await expect(preview(db)).rejects.toThrow(/Founder/);await db.exec(`SET test.uid='${founder}';SET test.assurance='no'`);await expect(preview(db)).rejects.toThrow(/Founder/);for(const role of ['anon','service_role']){await db.exec(`RESET ROLE;SET ROLE ${role}`);await expect(preview(db)).rejects.toThrow(/permission denied/);}}finally{await db.close();}},30000);
});
