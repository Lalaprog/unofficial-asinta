// @vitest-environment jsdom
// UI + actual candidate SQL on an isolated synthetic PGlite database only.
import React from 'react';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const mock=vi.hoisted(()=>({rpc:vi.fn()}));vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
import {HistoricalWorkerAttribution} from '@/components/payroll/HistoricalWorkerAttribution';
import type {ExternalRow} from '@/lib/payroll/historicalExternalWorker';
const founder='00000000-0000-0000-0000-000000000001',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004',other='00000000-0000-0000-0000-000000000005';
const id=(n:number)=>`81000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
afterEach(()=>{cleanup();sessionStorage.clear();vi.restoreAllMocks();});
describe('historical attribution candidate UI → synthetic SQL',()=>{
 it('reviews a case, records an exact split once after a lost response, and posts no finance transaction',async()=>{
  const db=new PGlite();try{
   await db.exec(baseFixture);for(const name of ['supervisor_table_foundation','supervisor_rpc_rollout','supervisor_payroll_preview','historical_external_worker_payroll','supervisor_payroll_ledger','paid_period_assertion_adjustments','historical_worker_project_attribution'])await db.exec(`BEGIN;${readFileSync(`supabase/drafts/${name}.sql`,'utf8')} COMMIT;`);
   await db.exec(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);
   const w=(await db.query<{v:{worker:unknown}}>("SELECT public.historical_external_worker_review($1,'2024-11-03') v",[worker])).rows[0].v.worker;
   await db.query("SELECT public.record_historical_external_worker_payroll($1,$2,'2024-11-03','2024-11-09',600,100,0,500,'Old ledger',$3,true)",[id(1),worker,JSON.stringify(w)]);
   const source=(await db.query<{v:ExternalRow}>('SELECT public.historical_external_worker_lookup($1) v',[id(1)])).rows[0].v;
   const snap=(await db.query<{v:{snapshot:unknown}}>("SELECT public.paid_period_assertion_case_list('external_worker',$1) v",[id(1)])).rows[0].v.snapshot;
   await db.query("SELECT public.open_paid_period_assertion_case($1,'external_worker',$2,$3::jsonb,-30,'Correct old ledger')",[id(2),id(1),JSON.stringify(snap)]);
   let lose=true;mock.rpc.mockReset().mockImplementation(async(name:string,args:Record<string,unknown>={})=>{try{
    const calls:Record<string,{sql:string;params:unknown[]}>={historical_worker_attribution_projects:{sql:'SELECT public.historical_worker_attribution_projects() v',params:[]},historical_external_worker_lookup:{sql:'SELECT public.historical_external_worker_lookup($1) v',params:[args.p_request]},paid_period_assertion_case_list:{sql:'SELECT public.paid_period_assertion_case_list($1,$2) v',params:[args.p_kind,args.p_source]},historical_worker_attribution:{sql:'SELECT public.historical_worker_attribution($1) v',params:[args.p_source]},record_historical_worker_attribution:{sql:'SELECT public.record_historical_worker_attribution($1,$2,$3::jsonb,$4::jsonb,$5,$6) v',params:[args.p_request,args.p_source,JSON.stringify(args.p_expected),JSON.stringify(args.p_split),args.p_note,args.p_ack]}};
    const call=calls[name];if(!call)throw Error('unexpected RPC');const data=(await db.query<{v:unknown}>(call.sql,call.params)).rows[0].v;if(name==='record_historical_worker_attribution'&&lose){lose=false;return {data:null,error:Error('lost after commit')};}return {data,error:null};
   }catch(error){return {data:null,error};}});vi.spyOn(crypto,'randomUUID').mockReturnValue(id(3));
   render(React.createElement(HistoricalWorkerAttribution,{actor:founder,source}));fireEvent.click(screen.getByRole('button',{name:'Project attribution for this external week'}));fireEvent.click(screen.getByRole('button',{name:'Load attribution review'}));await screen.findByLabelText('Attribution project 1');expect(screen.getByText(/Original-period cases: 1/)).toBeTruthy();expect(screen.getByText(/Correct old ledger/)).toBeTruthy();
   fireEvent.change(screen.getByLabelText('Attribution project 1'),{target:{value:site}});fireEvent.change(screen.getByLabelText('Project gross 1 (₱)'),{target:{value:'400.25'}});fireEvent.click(screen.getByRole('button',{name:'Add another project'}));fireEvent.change(screen.getByLabelText('Attribution project 2'),{target:{value:other}});fireEvent.change(screen.getByLabelText('Project gross 2 (₱)'),{target:{value:'199.75'}});fireEvent.change(screen.getByLabelText('Attribution evidence note'),{target:{value:'Reviewed ledger'}});fireEvent.click(screen.getByRole('button',{name:'Review project attribution'}));const dialog=screen.getByRole('dialog');fireEvent.click(within(dialog).getByRole('checkbox'));fireEvent.click(within(dialog).getByRole('button',{name:'Record attribution evidence'}));
   await screen.findByText(/Outcome not verified/);expect(sessionStorage.length).toBe(1);fireEvent.click(screen.getByRole('button',{name:'Retry exact attribution'}));await screen.findByText(/Attribution evidence recorded/);expect(sessionStorage.length).toBe(0);const writes=mock.rpc.mock.calls.filter(([name])=>name==='record_historical_worker_attribution');expect(writes).toHaveLength(2);expect(writes[0][1]).toEqual(writes[1][1]);
   const evidence=(await db.query<{v:{items:unknown[]}}>('SELECT public.project_historical_worker_attributions($1) v',[site])).rows[0].v;expect(evidence.items).toEqual([expect.objectContaining({source_id:id(1),site_gross:'400.25',case_count:1})]);
   await db.exec('RESET ROLE');expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.historical_worker_attributions')).rows[0].n).toBe(1);expect((await db.query<{n:number}>("SELECT count(*)::int n FROM public.payroll WHERE period_start='2024-11-03'")).rows[0].n).toBe(0);expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.advances')).rows[0].n).toBe(0);expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.expenses')).rows[0].n).toBe(1);
  }finally{cleanup();await db.close();}
 },30000);
});
