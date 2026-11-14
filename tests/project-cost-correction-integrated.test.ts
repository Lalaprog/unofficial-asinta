// @vitest-environment jsdom
// UI + real draft SQL against disposable synthetic data, never hosted business data.
import React from 'react';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
import {parseAdjustmentList} from '@/lib/payroll/paidAdjustments';
const m=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:m.rpc})}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:'00000000-0000-0000-0000-000000000001'},isFounder:true,assurance:'ready'})}));
import {ProjectCostCorrectionPanel} from '@/components/payroll/ProjectCostCorrectionPanel';
import {ProjectCorrectionEvidence} from '@/components/projects/ProjectCorrectionEvidence';
const actor='00000000-0000-0000-0000-000000000001',voucher='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004';
const id=(n:number)=>`92000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
afterEach(()=>{cleanup();sessionStorage.clear();vi.restoreAllMocks();});
describe('correction evidence UI → synthetic SQL',()=>{
 it('records one signed revision, replays after lost response and leaves financial sources unchanged',async()=>{
  const db=new PGlite();try{
   await db.exec(baseFixture);for(const name of ['supervisor_table_foundation','supervisor_rpc_rollout','supervisor_payroll_preview','historical_external_worker_payroll','supervisor_payroll_ledger','paid_period_assertion_adjustments','historical_worker_project_attribution','paid_payroll_adjustments','project_cost_correction_attribution'])await db.exec(`BEGIN;${readFileSync(`supabase/drafts/${name}.sql`,'utf8')} COMMIT;`);
   const snapshot=(await db.query<{v:unknown}>('SELECT app_private.paid_adjustment_voucher_snapshot(p) v FROM public.payroll p WHERE id=$1',[voucher])).rows[0].v;
   await db.exec(`SET ROLE authenticated;SET test.uid='${actor}';SET test.assurance='yes'`);
   await db.query("SELECT public.open_paid_payroll_adjustment($1,$2,$3::jsonb,-30,'Review')",[id(1),voucher,JSON.stringify(snapshot)]);await db.query("SELECT public.resolve_paid_payroll_adjustment($1,'no_transfer',NULL,'Reviewed')",[id(1)]);
   const caseList=(await db.query<{v:unknown}>('SELECT public.paid_payroll_adjustment_list($1,0) v',[voucher])).rows[0].v;const item=parseAdjustmentList(caseList,voucher,0).items[0];
   let lose=true;m.rpc.mockReset().mockImplementation(async(name:string,a:Record<string,unknown>={})=>{try{
    let result;if(name==='historical_worker_attribution_projects')result=await db.query<{v:unknown}>('SELECT public.historical_worker_attribution_projects() v');
    else if(name==='project_cost_correction_attribution')result=await db.query<{v:unknown}>('SELECT public.project_cost_correction_attribution($1,$2,$3) v',[a.p_kind,a.p_case,a.p_revision]);
    else if(name==='project_cost_correction_attribution_sites')result=await db.query<{v:unknown}>('SELECT public.project_cost_correction_attribution_sites($1) v',[a.p_project]);
    else if(name==='record_project_cost_correction_attribution'){
     result=await db.query<{v:unknown}>('SELECT public.record_project_cost_correction_attribution($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9) v',[a.p_request,a.p_kind,a.p_case,a.p_expected_revision,JSON.stringify(a.p_expected_case),a.p_gross_change,JSON.stringify(a.p_split),a.p_note,a.p_ack]);
     if(lose){lose=false;return {data:null,error:Error('response lost after commit')};}
    }else throw Error('Unexpected RPC');return {data:result.rows[0].v,error:null};
   }catch(error){return {data:null,error};}});vi.spyOn(crypto,'randomUUID').mockReturnValue(id(2));
   render(React.createElement(ProjectCostCorrectionPanel,{actor,kind:'voucher',item}));fireEvent.click(screen.getByRole('button',{name:'Project-cost correction evidence'}));fireEvent.click(screen.getByRole('button',{name:'Load correction evidence'}));await screen.findByText(/No correction site evidence/);
   fireEvent.change(screen.getByLabelText('Total signed gross change (₱)'),{target:{value:'-12.50'}});fireEvent.click(screen.getByRole('button',{name:'Add correction site'}));fireEvent.change(screen.getByLabelText('Correction site 1'),{target:{value:site}});fireEvent.change(screen.getByLabelText('Signed site change 1 (₱)'),{target:{value:'-12.50'}});fireEvent.change(screen.getByLabelText('Correction evidence note'),{target:{value:'Original records checked'}});fireEvent.click(screen.getByRole('button',{name:'Review correction evidence'}));const dialog=screen.getByRole('dialog');fireEvent.click(within(dialog).getByRole('checkbox'));fireEvent.click(within(dialog).getByRole('button',{name:'Record correction evidence'}));
   await screen.findByText(/Outcome not confirmed/);fireEvent.click(screen.getByRole('button',{name:'Retry exact correction evidence'}));await screen.findByText(/Evidence recorded/);expect(sessionStorage.length).toBe(0);
   const writes=m.rpc.mock.calls.filter(([name])=>name==='record_project_cost_correction_attribution');expect(writes).toHaveLength(2);expect(writes[0][1]).toEqual(writes[1][1]);
   fireEvent.click(screen.getByRole('button',{name:'Load correction evidence'}));await screen.findByText(/Latest full replacement · revision 1/);expect(screen.getByText(/Site One · ₱-12.50/)).toBeTruthy();
   render(React.createElement(ProjectCorrectionEvidence,{projectId:site,userId:actor}));fireEvent.click(screen.getByRole('button',{name:'Load correction evidence for this site'}));await screen.findByText(/This site gross change ₱-12.50/);expect(screen.getByText(/Latest recorded site splits only, not included/)).toBeTruthy();
   await db.exec('RESET ROLE');expect((await db.query('SELECT count(*)::int n FROM public.project_cost_correction_attributions')).rows[0]).toEqual({n:1});expect((await db.query('SELECT status,gross_pay::text gross,net_pay::text net FROM public.payroll WHERE id=$1',[voucher])).rows[0]).toEqual({status:'paid',gross:'600',net:'600'});expect((await db.query('SELECT count(*)::int n FROM public.advances')).rows[0]).toEqual({n:0});
  }finally{cleanup();await db.close();}
 },30000);
});
