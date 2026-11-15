// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:m.rpc})}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:'founder'},isFounder:true,assurance:'ready'})}));
import {ProjectCostReconciliation} from '@/components/projects/ProjectCostReconciliation';
function gates(){vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_PROJECT_COST_RECONCILIATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_PROJECT_COST_CORRECTION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_CORRECTED_PROJECT_COST_REVIEW_PREVIEW','true');}
afterEach(()=>{cleanup();vi.unstubAllEnvs();m.rpc.mockReset();});
describe('simplified project cost workspace',()=>{
 it('shows the main review first and keeps the scratchpad available without loading data',()=>{
  gates();const view=render(React.createElement(ProjectCostReconciliation,{projectId:'site',userId:'founder'}));
  const main=screen.getByRole('region',{name:'Experimental corrected cost review'}),tools=screen.getByRole('button',{name:'Other cost investigation tools'});
  expect(tools.getAttribute('aria-expanded')).toBe('false');expect(screen.queryByRole('button',{name:'Load review snapshot'})).toBeNull();
  expect(main.compareDocumentPosition(tools)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();expect(m.rpc).not.toHaveBeenCalled();
  fireEvent.click(tools);expect(tools.getAttribute('aria-expanded')).toBe('true');expect(screen.getByRole('button',{name:'Load review snapshot'})).toBeTruthy();
  fireEvent.click(tools);expect(screen.queryByRole('button',{name:'Load review snapshot'})).toBeNull();expect(view.container.querySelector('#cost-corrected-review')).toBeTruthy();expect(m.rpc).not.toHaveBeenCalled();
 });
 it('opens and focuses the scratchpad when reached from the payroll evidence shortcut',()=>{
  gates();render(React.createElement(ProjectCostReconciliation,{projectId:'site',userId:'founder',reviewTarget:'scratch'}));
  expect(screen.getByRole('button',{name:'Other cost investigation tools'}).getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement?.textContent).toBe('Experimental project-cost review');expect(screen.getByRole('button',{name:'Load review snapshot'})).toBeTruthy();
 });
 it('keeps the existing scratchpad directly accessible if the main review is not enabled',()=>{
  gates();vi.stubEnv('NEXT_PUBLIC_CORRECTED_PROJECT_COST_REVIEW_PREVIEW','false');render(React.createElement(ProjectCostReconciliation,{projectId:'site',userId:'founder'}));
  expect(screen.queryByRole('button',{name:'Other cost investigation tools'})).toBeNull();expect(screen.getByRole('button',{name:'Load review snapshot'})).toBeTruthy();expect(m.rpc).not.toHaveBeenCalled();
 });
});
