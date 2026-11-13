import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {parseSavedReview} from '@/lib/projects/projectCostReview';
import {baleExpense,candidatePaths,confirmRental,fixture,founder,materialExpense,rentalExpense,roles,site,supervisor} from './helpers/project-cost-reconciliation-fixture';
const h='81000000-0000-4000-8000-000000000002', source='81000000-0000-4000-8000-000000000001', worker='81000000-0000-4000-8000-000000000003';
const id=(n:number)=>`82000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const decisions={expenses:{[materialExpense]:{decision:'include',reason:null},[rentalExpense]:{decision:'include',reason:null},[baleExpense]:{decision:'exclude',reason:'Already in gross'}},historical:{[h]:{decision:'include',reason:null}}};
async function setup(){const db=new PGlite();await db.exec(`${roles} ${fixture}`);for(const p of candidatePaths)await db.exec(readFileSync(p,'utf8'));
 await db.exec(`CREATE TABLE public.test_history (case_count int NOT NULL, site_gross text NOT NULL);INSERT INTO public.test_history VALUES(0,'400.25');
 CREATE FUNCTION public.project_historical_worker_attributions(p_project uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('project_id',p_project,'items',jsonb_build_array(jsonb_build_object('request_id','${h}','source_id','${source}','worker_id','${worker}','worker_name','Old Worker','period_start','2024-10-27','period_end','2024-11-02','paid_on','2024-11-02','original_gross','600.00','site_gross',site_gross,'note','Original record','recorded_by','${founder}','recorded_at','2024-11-10T00:00:00Z','case_count',case_count))) FROM public.test_history$$;
 BEGIN;${readFileSync('supabase/drafts/project_cost_historical_review.sql','utf8')} COMMIT;${readFileSync('supabase/drafts/project_cost_review_ledger.sql','utf8')}
 SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes';${confirmRental}`);return db;}
async function snap(db:PGlite){return (await db.query<{v:unknown}>('SELECT public.project_cost_historical_review($1) v',[site])).rows[0].v;}
async function record(db:PGlite,n:number,rev:number,s:unknown,c:unknown=decisions){return (await db.query<{v:Record<string,unknown>}>('SELECT public.record_project_cost_review($1,$2,$3,$4::jsonb,$5::jsonb,$6) v',[id(n),site,rev,JSON.stringify(s),JSON.stringify(c),'Reviewed historical costs'])).rows[0].v;}
async function review(db:PGlite){return (await db.query<{v:Record<string,unknown>}>('SELECT public.project_cost_review($1,NULL) v',[site])).rows[0].v;}
describe('experimental historical saved review',()=>{
 it('saves explicit evidence, supports exact retry and fails closed on stale or tampered evidence',async()=>{const db=await setup();try{
  const first=await snap(db);expect(await record(db,1,0,first)).toMatchObject({revision:1,replayed:false});expect(await record(db,1,0,first)).toMatchObject({revision:1,replayed:true});
  const saved=await review(db);expect(saved).toMatchObject({review_kind:'historical',historical_gross:'400.25',excluded_historical:'0.00',incomplete_total:'2050.25',freshness:'matches'});
  const parsed=parseSavedReview(saved,site);expect(parsed.found&&parsed.total).toBe(205025n);
  expect(()=>parseSavedReview({...saved,historical_gross:'400.24'},site)).toThrow(/total/);
  expect(()=>parseSavedReview({...saved,choices:{...decisions,historical:{[h]:{decision:'exclude',reason:''}}}},site)).toThrow();
  await expect(record(db,1,0,first,{...decisions,historical:{[h]:{decision:'exclude',reason:'Duplicate'}}})).rejects.toThrow(/different details/);
  await db.exec("RESET ROLE; UPDATE public.test_history SET site_gross='399.25'; SET ROLE authenticated");expect(await review(db)).toMatchObject({freshness:'changed',incomplete_total:'2050.25'});await expect(record(db,2,1,first)).rejects.toThrow(/evidence changed/);
  expect(await record(db,1,0,first)).toMatchObject({replayed:true});
  const next=await snap(db);const exclude={...decisions,historical:{[h]:{decision:'exclude',reason:'Potential duplicate'}}};await record(db,2,1,next,exclude);expect(await review(db)).toMatchObject({historical_gross:'0.00',excluded_historical:'399.25',incomplete_total:'1650.00',freshness:'matches'});expect(parseSavedReview(await review(db),site).found).toBe(true);
  await db.exec('RESET ROLE');await expect(db.exec("UPDATE public.project_cost_reviews SET note='change'")).rejects.toThrow(/immutable/);
 }finally{await db.close();}},30000);
 it('rejects missing reasons and flagged inclusions on the server; allows explicit exclusion',async()=>{const db=await setup();try{
  const s=await snap(db);for(const c of [{...decisions,historical:{}},{...decisions,historical:{[h]:{decision:'exclude',reason:''}}},{...decisions,historical:{[h]:{decision:'include',reason:'not null'}}}])await expect(record(db,1,0,s,c)).rejects.toThrow(/historical/);
  await db.exec('RESET ROLE;UPDATE public.test_history SET case_count=1;SET ROLE authenticated');const flagged=await snap(db);await expect(record(db,1,0,flagged)).rejects.toThrow(/case or overlap/);await record(db,1,0,flagged,{...decisions,historical:{[h]:{decision:'exclude',reason:'Case needs investigation'}}});
  await db.exec(`RESET ROLE; UPDATE public.test_history SET case_count=0;INSERT INTO public.workers(id,name) VALUES('${worker}','Old Worker');INSERT INTO public.payroll VALUES('${id(90)}','${worker}','2024-10-27','2024-11-02','draft',0,0,0,0,0);SET ROLE authenticated`);
  const overlap=await snap(db);await expect(record(db,2,1,overlap)).rejects.toThrow(/case or overlap/);await record(db,2,1,overlap,{...decisions,historical:{[h]:{decision:'exclude',reason:'Overlapping draft'}}});
  await db.exec(`SET test.uid='${supervisor}'`);await expect(review(db)).rejects.toThrow(/Founder/);await expect(record(db,3,2,overlap)).rejects.toThrow(/Founder/);
  await db.exec(`SET test.uid='${founder}';SET test.assurance='no'`);await expect(review(db)).rejects.toThrow(/assurance/);
  for(const role of ['anon','service_role']){await db.exec(`RESET ROLE;SET ROLE ${role}`);await expect(review(db)).rejects.toThrow(/permission denied/);}
 }finally{await db.close();}},30000);
});
