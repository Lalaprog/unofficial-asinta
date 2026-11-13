// @vitest-environment jsdom
// Synthetic UI → actual current-cost and combined SQL, with a historical RPC fixture.
import React from 'react';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn()}));vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
import {HistoricalCostReview} from '@/components/projects/HistoricalCostReview';
import {baleExpense,candidatePaths,confirmRental,fixture,founder,materialExpense,rentalExpense,roles,site} from './helpers/project-cost-reconciliation-fixture';
const request='81000000-0000-4000-8000-000000000002',source='81000000-0000-4000-8000-000000000001',oldWorker='81000000-0000-4000-8000-000000000003';
afterEach(()=>{cleanup();vi.restoreAllMocks();});
describe('combined historical review UI → synthetic SQL',()=>{
 it('includes reviewed historical site gross once and excludes Bale/rental duplicates',async()=>{
  const db=new PGlite();try{
   await db.exec(`${roles} ${fixture}`);for(const p of candidatePaths)await db.exec(readFileSync(p,'utf8'));
   await db.exec(`CREATE FUNCTION public.project_historical_worker_attributions(p_project uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('project_id',p_project,'items',jsonb_build_array(jsonb_build_object('request_id','${request}','source_id','${source}','worker_id','${oldWorker}','worker_name','Old Worker','period_start','2024-10-27','period_end','2024-11-02','paid_on','2024-11-02','original_gross','600.00','site_gross','400.25','note','Original record','recorded_by','${founder}','recorded_at','2024-11-10T00:00:00Z','case_count',0)))$$; BEGIN;${readFileSync('supabase/drafts/project_cost_historical_review.sql','utf8')} COMMIT; SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes';${confirmRental}`);
   mock.rpc.mockReset().mockImplementation(async(name:string,args:Record<string,unknown>)=>{try{if(name!=='project_cost_historical_review')throw Error('unexpected call');return {data:(await db.query<{v:unknown}>('SELECT public.project_cost_historical_review($1) v',[args.p_project])).rows[0].v,error:null};}catch(error){return {data:null,error};}});
   render(React.createElement(HistoricalCostReview,{projectId:site,userId:founder}));fireEvent.click(screen.getByRole('button',{name:'Review costs with historical worker evidence'}));fireEvent.click(screen.getByRole('button',{name:'Load combined snapshot'}));await screen.findByText(/Snapshot captured/);
   for(const [id,label] of [[materialExpense,'Include expense'],[baleExpense,'Exclude expense'],[rentalExpense,'Include expense']])fireEvent.click(within(screen.getByRole('group',{name:`Combined expense ${id}`})).getByLabelText(label));
   fireEvent.click(screen.getByLabelText('Include historical site gross'));fireEvent.click(screen.getByRole('checkbox'));expect(screen.getByText('Combined incomplete, unsaved estimate: ₱2,050.25')).toBeTruthy();
   await db.exec('RESET ROLE');expect((await db.query<{gross:string;net:string}>("SELECT gross_pay::text gross,net_pay::text net FROM public.payroll WHERE status='paid'")).rows[0]).toEqual({gross:'750.00',net:'650.00'});expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.expenses')).rows[0].n).toBe(4);expect(mock.rpc).toHaveBeenCalledTimes(1);
  }finally{cleanup();await db.close();}
 },30000);
});
