import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const founder='00000000-0000-0000-0000-000000000001',dest='00000000-0000-0000-0000-000000000004',source='00000000-0000-0000-0000-000000000005';
const id=(n:number)=>`93000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const file=(name:string)=>readFileSync(`supabase/drafts/${name}.sql`,'utf8');
const snap=(site:string)=>({project_id:site,historical_review:{base:{captured_at:'2026-01-01T00:00:00Z'}}});
const choices={expenses:{},historical:{},corrections:{}};
const contexts=(revision=1)=>({case:{original_site_reviews:[{project_id:source}],revision}});
async function setup(){const db=new PGlite();await db.exec(baseFixture);await db.exec(`CREATE FUNCTION public.project_cost_correction_inventory(p uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('project_id',p,'historical_review',jsonb_build_object('base',jsonb_build_object('captured_at','2026-01-01T00:00:00Z')))$$;
 CREATE FUNCTION public.project_cost_corrected_preview(p uuid,s jsonb,c jsonb,a boolean) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('incomplete',true)$$;
 CREATE FUNCTION public.project_cost_cross_site_corrected_preview(p uuid,s jsonb,c jsonb,x jsonb,a boolean) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('incomplete',true)$$;`);
 for(const name of ['project_cost_corrected_review_ledger','project_cost_cross_site_review_ledger'])await db.exec(`BEGIN;${file(name)} COMMIT;`);return db;}
async function apply(db:PGlite){await db.exec(`BEGIN;SET LOCAL app.cross_site_source_lock_reviewed='yes';${file('project_cost_cross_site_source_review_serialization')} COMMIT;`);}
async function call(db:PGlite,ctx:unknown,request=id(1)){return db.query('SELECT public.record_project_cost_cross_site_review($1,$2,0,$3::jsonb,$4::jsonb,$5::jsonb,$6,true)',[request,dest,JSON.stringify(snap(dest)),JSON.stringify(choices),JSON.stringify(ctx),'Checked']);}
describe('narrow cross-site source review serialization candidate',()=>{
 it('holds by default, pins both function bodies, and preserves grants and replay',async()=>{const db=await setup();try{
  await expect(db.exec(`BEGIN;${file('project_cost_cross_site_source_review_serialization')} COMMIT;`)).rejects.toThrow(/held pending/);await db.exec('ROLLBACK');await apply(db);
  await db.exec(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);
  expect((await call(db,contexts())).rows).toHaveLength(1);expect((await call(db,contexts())).rows[0]).toMatchObject({record_project_cost_cross_site_review:{replayed:true}});
  await expect(call(db,contexts(2))).rejects.toThrow(/different details/);await db.exec('RESET ROLE');expect((await db.query('SELECT count(*)::int n FROM public.project_cost_cross_site_reviews')).rows[0]).toEqual({n:1});
 }finally{await db.close();}},30000);
 it('rejects malformed and oversized source reference lists before writing',async()=>{const db=await setup();try{await apply(db);await db.exec(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);
  for(const ctx of [{case:{}},{case:{original_site_reviews:[{project_id:'invalid'}]}},{case:{original_site_reviews:Array.from({length:51},()=>({project_id:source}))}},{a:{original_site_reviews:Array.from({length:50},()=>({project_id:source}))},b:{original_site_reviews:Array.from({length:50},()=>({project_id:source}))},c:{original_site_reviews:[{project_id:source}]}}])await expect(call(db,ctx,id(2))).rejects.toThrow(/Invalid original-site review references/);
  await db.exec('RESET ROLE');expect((await db.query('SELECT count(*)::int n FROM public.project_cost_cross_site_reviews')).rows[0]).toEqual({n:0});
 }finally{await db.close();}},30000);
 it('rejects direct source-review write grants or a disabled immutable trigger',async()=>{
  for(const change of ['grant','trigger']){const db=await setup();try{if(change==='grant')await db.exec('GRANT UPDATE(note) ON public.project_cost_corrected_reviews TO authenticated');else await db.exec('ALTER TABLE public.project_cost_corrected_reviews DISABLE TRIGGER guard_project_cost_corrected_review_immutable');await expect(apply(db)).rejects.toThrow(/direct write access changed|immutable trigger changed/);await db.exec('ROLLBACK');}finally{await db.close();}}
 },30000);
 it('rejects a changed corrected-review writer without replacing the destination writer',async()=>{const db=await setup();try{
  await db.exec(`CREATE OR REPLACE FUNCTION public.record_project_cost_corrected_review(p_request uuid,p_project uuid,p_expected_revision integer,p_snapshot jsonb,p_choices jsonb,p_note text,p_ack boolean) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$BEGIN RETURN '{}'::jsonb; END$$;`);
  await expect(apply(db)).rejects.toThrow(/dependency changed/);await db.exec('ROLLBACK');
  const r=await db.query<{hash:string}>("SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') hash FROM pg_proc WHERE oid='public.record_project_cost_cross_site_review(uuid,uuid,integer,jsonb,jsonb,jsonb,text,boolean)'::regprocedure");expect(r.rows[0].hash).toBe('e053007527ae9eebad4188d9f3ff119bd9210155eb7948798d5ec978e27915b5');
 }finally{await db.close();}},30000);
});
