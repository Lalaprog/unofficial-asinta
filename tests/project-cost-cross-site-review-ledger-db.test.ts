import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const founder='00000000-0000-0000-0000-000000000001',supervisor='00000000-0000-0000-0000-000000000002',site='00000000-0000-0000-0000-000000000004';
const id=(n:number)=>`99000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const snapshot=()=>({project_id:site,historical_review:{base:{captured_at:'2026-01-01T00:00:00Z',amount:'100.00'}},corrections:[]});
const choices=()=>({expenses:{},historical:{},corrections:{}}),cross=()=>({source:{revision:1}});
async function setup(){const db=new PGlite();await db.exec(baseFixture);await db.exec(`CREATE TABLE public.test_inventory(value jsonb);CREATE TABLE public.test_sources(value jsonb);
 CREATE FUNCTION public.project_cost_correction_inventory(uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT value FROM public.test_inventory$$;
 CREATE FUNCTION public.project_cost_cross_site_corrected_preview(uuid,jsonb,jsonb,jsonb,boolean) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$BEGIN IF $4 IS DISTINCT FROM (SELECT value FROM public.test_sources) THEN RAISE EXCEPTION 'Source changed' USING ERRCODE='40001';END IF;RETURN jsonb_build_object('project_id',$1,'incomplete',true,'incomplete_total','100.00','cross_site_cases',1);END$$;`);
 await db.query('INSERT INTO public.test_inventory VALUES($1::jsonb)',[JSON.stringify(snapshot())]);await db.query('INSERT INTO public.test_sources VALUES($1::jsonb)',[JSON.stringify(cross())]);await db.exec(`BEGIN;${readFileSync('supabase/drafts/project_cost_cross_site_review_ledger.sql','utf8')} COMMIT;SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);return db;}
async function record(db:PGlite,req=id(1),revision=0,s=snapshot(),c=choices(),x=cross(),note='Reviewed'){return (await db.query<{v:unknown}>('SELECT public.record_project_cost_cross_site_review($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,true) v',[req,site,revision,JSON.stringify(s),JSON.stringify(c),JSON.stringify(x),note])).rows[0].v;}
async function read(db:PGlite){return (await db.query<{v:unknown}>('SELECT public.project_cost_cross_site_review($1,NULL) v',[site])).rows[0].v;}
describe('cross-site review ledger, synthetic',()=>{
 it('saves immutable evidence and supports exact retries without changing source data',async()=>{const db=await setup();try{
  expect(await read(db)).toEqual({project_id:site,found:false,latest_revision:0});expect(await record(db)).toMatchObject({revision:1,replayed:false});expect(await record(db)).toMatchObject({revision:1,replayed:true});expect(await read(db)).toMatchObject({found:true,revision:1,cross_sites:cross(),freshness:'matches',result:{incomplete:true}});
  await expect(record(db,id(1),0,snapshot(),choices(),cross(),'Different')).rejects.toThrow(/already used/);await expect(record(db,id(2))).rejects.toThrow(/changed/);
  await db.exec('RESET ROLE');await expect(db.exec('UPDATE public.project_cost_cross_site_reviews SET note=\'Changed\'')).rejects.toThrow(/immutable/);expect((await db.query('SELECT status FROM public.payroll')).rows[0]).toEqual({status:'paid'});
 }finally{await db.close();}},30000);
 it('flags source decisions and destination inventory changes after saving',async()=>{const db=await setup();try{
  await record(db);await db.exec('RESET ROLE');await db.query('UPDATE public.test_sources SET value=$1::jsonb',[JSON.stringify({source:{revision:2}})]);await db.exec('SET ROLE authenticated');expect(await read(db)).toMatchObject({freshness:'changed'});
  await db.exec('RESET ROLE');await db.query('UPDATE public.test_inventory SET value=$1::jsonb',[JSON.stringify({...snapshot(),corrections:[{changed:true}]})]);await db.exec('SET ROLE authenticated');expect(await read(db)).toMatchObject({freshness:'changed'});
 }finally{await db.close();}},30000);
 it('denies direct access and requires Founder assurance',async()=>{const db=await setup();try{
  await expect(db.query('SELECT * FROM public.project_cost_cross_site_reviews')).rejects.toThrow(/permission denied/);await db.exec(`SET test.uid='${supervisor}'`);await expect(record(db)).rejects.toThrow(/Founder/);await db.exec(`SET test.uid='${founder}';SET test.assurance='no'`);await expect(read(db)).rejects.toThrow(/Founder/);
  for(const role of ['anon','service_role']){await db.exec(`RESET ROLE;SET ROLE ${role}`);await expect(read(db)).rejects.toThrow(/permission denied/);await expect(record(db)).rejects.toThrow(/permission denied/);}
 }finally{await db.close();}},30000);
});
