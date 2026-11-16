// @vitest-environment jsdom
// Synthetic in-memory fixture only; no hosted data or money is touched.
import React from 'react';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {cleanup,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn()}));vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
import {ProjectPaidPayrollSummary} from '@/components/projects/ProjectPaidPayrollSummary';
import {candidatePaths,fixture,founder,other,roles,site,worker} from './helpers/project-cost-reconciliation-fixture';
afterEach(()=>{cleanup();vi.unstubAllEnvs();});
describe('project paid payroll overview to synthetic SQL',()=>{
 it('shows only the paid site allocation and never writes the ledger',async()=>{
  vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_PROJECT_COST_RECONCILIATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_INDEPENDENT_PAID_PAYROLL_SUMMARY','true');
  const db=new PGlite();try{
   await db.exec(`${roles} ${fixture}`);for(const path of candidatePaths)await db.exec(readFileSync(path,'utf8'));await db.exec(readFileSync('supabase/drafts/project_paid_payroll_summary.sql','utf8'));
   await db.exec(`INSERT INTO public.payroll VALUES ('10000000-0000-0000-0000-000000000011','${worker}','2024-11-10','2024-11-16','approved',300,0,0,300,8),('10000000-0000-0000-0000-000000000012','${worker}','2024-11-17','2024-11-23','draft',200,0,0,200,8)`);
   const before=(await db.query('SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) v FROM public.payroll p')).rows[0];
   await db.exec(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);
   mock.rpc.mockReset();mock.rpc.mockImplementation(async(name:string,args:{p_project:string})=>{try{if(name!=='project_paid_payroll_summary')throw Error('Unexpected RPC');return {data:(await db.query<{v:unknown}>('SELECT public.project_paid_payroll_summary($1) v',[args.p_project])).rows[0].v,error:null};}catch(error){return {data:null,error};}});
   const view=render(React.createElement(ProjectPaidPayrollSummary,{projectId:site,userId:founder,onReview:()=>{}}));await screen.findByText(/Recorded site payroll gross: ₱600.00/);expect(screen.getByText(/1 paid allocation/)).toBeTruthy();
   view.rerender(React.createElement(ProjectPaidPayrollSummary,{projectId:other,userId:founder,onReview:()=>{}}));await screen.findByText(/Recorded site payroll gross: ₱150.00/);
   await db.exec('RESET ROLE');expect((await db.query('SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) v FROM public.payroll p')).rows[0]).toEqual(before);expect(mock.rpc.mock.calls.map(([name])=>name)).toEqual(['project_paid_payroll_summary','project_paid_payroll_summary']);
  }finally{cleanup();await db.close();}
 },30000);
});
