// @vitest-environment jsdom
import React from 'react';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
const {rpc}=vi.hoisted(()=>({rpc:vi.fn()}));vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc})}));
import {ProjectCostReconciliation} from '@/components/projects/ProjectCostReconciliation';
import {baleExpense,candidatePaths,confirmRental,fixture,founder,materialExpense,rentalExpense,roles,site} from './helpers/project-cost-reconciliation-fixture';
afterEach(()=>{cleanup();sessionStorage.clear();vi.unstubAllEnvs();});
describe('saved cost review UI and synthetic database',()=>{
 it('retries a committed review after losing the first response without repeating it',async()=>{
  vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_PROJECT_COST_RECONCILIATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_PROJECT_COST_REVIEW_LEDGER_PREVIEW','true');
  const db=new PGlite();try{
   await db.exec(`${roles} ${fixture}`);for(const p of [...candidatePaths,'supabase/drafts/project_cost_review_ledger.sql'])await db.exec(readFileSync(p,'utf8'));
   await db.exec(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes';${confirmRental}`);
   let first=true;rpc.mockReset();rpc.mockImplementation(async(name:string,a:Record<string,unknown>)=>{
    try{
     let result;
     if(name==='project_cost_reconciliation_preview')result=await db.query<{v:unknown}>('SELECT public.project_cost_reconciliation_preview($1) v',[a.p_project]);
     else if(name==='project_cost_review')result=await db.query<{v:unknown}>('SELECT public.project_cost_review($1,$2) v',[a.p_project,a.p_revision]);
     else if(name==='record_project_cost_review'){
      result=await db.query<{v:unknown}>('SELECT public.record_project_cost_review($1,$2,$3,$4::jsonb,$5::jsonb,$6) v',[a.p_request,a.p_project,a.p_expected_revision,JSON.stringify(a.p_snapshot),JSON.stringify(a.p_choices),a.p_note]);
      if(first){first=false;return {data:null,error:Error('lost response after commit')};}
     }else throw Error('unexpected RPC');
     return {data:result.rows[0].v,error:null};
    }catch(error){return {data:null,error};}
   });
   render(React.createElement(ProjectCostReconciliation,{projectId:site,userId:founder}));fireEvent.click(screen.getByRole('button',{name:'Load review snapshot'}));await screen.findByText(/Snapshot captured/);
   for(const [id,label] of [[materialExpense,'Include expense'],[baleExpense,'Exclude from this preview'],[rentalExpense,'Include expense']])fireEvent.click(within(screen.getByRole('group',{name:`Expense ${id}`})).getByLabelText(label));
   fireEvent.change(screen.getByLabelText('Reason for excluding Bale given'),{target:{value:'Already represented in payroll gross'}});fireEvent.click(screen.getByRole('button',{name:'Load saved review'}));await screen.findByText(/No saved review was returned/);
   fireEvent.change(screen.getByLabelText(/Review note/),{target:{value:'Synthetic review'}});fireEvent.click(screen.getByRole('checkbox',{name:/I reviewed these decisions/}));fireEvent.click(screen.getByRole('button',{name:'Save incomplete review'}));
   await screen.findByText(/outcome is unconfirmed/i);fireEvent.click(screen.getByRole('button',{name:'Retry same review'}));await screen.findByText(/Review recorded and verified/);expect(screen.getByText(/Incomplete reviewed estimate: ₱1,650.00/)).toBeTruthy();
   const sends=rpc.mock.calls.filter(c=>c[0]==='record_project_cost_review');expect(sends).toHaveLength(2);expect(sends[0][1]).toEqual(sends[1][1]);
   await db.exec('RESET ROLE');expect((await db.query('SELECT count(*)::int n FROM public.project_cost_reviews')).rows[0]).toEqual({n:1});expect((await db.query('SELECT gross_pay::text gross,net_pay::text net FROM public.payroll WHERE id=$1',["10000000-0000-0000-0000-000000000001"])).rows[0]).toEqual({gross:'750.00',net:'650.00'});
   // Another writer changes a source after the on-screen snapshot. The server
   // rejects it and the UI does not claim success or assume the result failed.
   await db.query('UPDATE public.expenses SET amount=51 WHERE id=$1',[materialExpense]);await db.exec('SET ROLE authenticated');
   fireEvent.change(screen.getByLabelText(/Review note/),{target:{value:'Second synthetic review'}});fireEvent.click(screen.getByRole('checkbox',{name:/I reviewed these decisions/}));fireEvent.click(screen.getByRole('button',{name:'Save incomplete review'}));await screen.findByText(/outcome is unconfirmed/i);
   await db.exec('RESET ROLE');expect((await db.query('SELECT count(*)::int n FROM public.project_cost_reviews')).rows[0]).toEqual({n:1});await db.exec('SET ROLE authenticated');
   fireEvent.click(screen.getByText('Resolve an unconfirmed request'));fireEvent.click(screen.getByRole('checkbox',{name:/request may still complete/}));fireEvent.click(screen.getByRole('button',{name:'Clear marker after investigation'}));
   fireEvent.click(screen.getByRole('button',{name:'Load saved review'}));await screen.findByText(/Saved revision 1/);fireEvent.click(screen.getByRole('button',{name:'Reload review snapshot'}));await screen.findByText('Sand · ₱51.00');
   for(const [id,label] of [[materialExpense,'Include expense'],[baleExpense,'Exclude from this preview'],[rentalExpense,'Include expense']])fireEvent.click(within(screen.getByRole('group',{name:`Expense ${id}`})).getByLabelText(label));
   fireEvent.change(screen.getByLabelText('Reason for excluding Bale given'),{target:{value:'Already represented in payroll gross'}});fireEvent.click(screen.getByRole('checkbox',{name:/I reviewed these decisions/}));fireEvent.click(screen.getByRole('button',{name:'Save incomplete review'}));await screen.findByText(/Review recorded and verified/);expect(screen.getByText(/Incomplete reviewed estimate: ₱1,651.00/)).toBeTruthy();
   await db.exec('RESET ROLE');expect((await db.query('SELECT count(*)::int n FROM public.project_cost_reviews')).rows[0]).toEqual({n:2});
  }finally{cleanup();await db.close();}
 },30000);
});
