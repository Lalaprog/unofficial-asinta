// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),founder:true}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mocks.rpc})}));
vi.mock('next/navigation',()=>({useParams:()=>({id:'site'}),useRouter:()=>({push:vi.fn()})}));
vi.mock('next/link',()=>({default:({href,children}: {href:string;children:React.ReactNode})=>React.createElement('a',{href},children)}));
vi.mock('@/components/layout/AppShell',()=>({AppShell:({children}:{children:React.ReactNode})=>React.createElement('main',null,children)}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:'f'},isFounder:mocks.founder,isSupervisor:!mocks.founder})}));
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:vi.fn()})}));
vi.mock('@/lib/data/store',()=>({useDataStore:()=>({projects:[{id:'site',name:'Site',client_id:'client',location:'Lipa',budget_estimate:1000,status:'active',start_date:'2026-01-01',target_completion_date:'2026-12-01'}],clients:[],invoices:[],expenses:[{id:'partial',project_id:'site',amount:999}],tools:[],users:[],projectSupervisors:[],getProjectsForSupervisor:()=>[],updateProject:vi.fn(),deleteProject:vi.fn()})}));
import ProjectPage from '@/app/projects/page';
import ProjectDetail from '@/app/projects/[id]/page';
beforeEach(()=>{mocks.founder=true;mocks.rpc.mockReset();mocks.rpc.mockImplementation((fn:string)=>Promise.resolve(fn==='project_expense_totals'?{data:[{project_id:'site',expense_count:1051,total:'265.65'}],error:null}:{data:{items:[],has_more:false},error:null}));});
afterEach(()=>cleanup());
describe('server-backed project expense totals',()=>{
 it('uses the server total on project cards, not the partial shared store',async()=>{
  render(React.createElement(ProjectPage));expect(await screen.findByText('₱265.65')).toBeTruthy();
  expect(screen.queryByText('₱999.00')).toBeNull();expect(screen.getByText(/27% of estimate/)).toBeTruthy();
 });
 it('shows the same scoped total and a paginated ledger on project detail',async()=>{
  render(React.createElement(ProjectDetail));expect(await screen.findByText('₱265.65')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Expenses (1051)'}));
  expect(await screen.findByText('No recorded expenses found for this project.')).toBeTruthy();
  expect(mocks.rpc).toHaveBeenCalledWith('project_expense_page',expect.objectContaining({p_project_id:'site'}));
 });
 it('never displays an old partial total as zero on a failed query',async()=>{
  mocks.rpc.mockResolvedValue({data:null,error:{message:'offline'}});
  render(React.createElement(ProjectPage));
  await waitFor(()=>expect(screen.getByRole('alert').textContent).toMatch(/could not be loaded/));
  expect(screen.getByText('Unavailable')).toBeTruthy();expect(screen.queryByText('₱999.00')).toBeNull();
 });
});
