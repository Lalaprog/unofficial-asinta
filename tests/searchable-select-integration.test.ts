// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({
  projects:[] as Array<{id:string;name:string}>,
  clients:Array.from({length:10},(_,i)=>({id:`client-${i}`,name:i===8?'Luna Holdings':`Client ${i}`,contact_person:`Contact ${i}`})),
  tools:[] as Array<{id:string;name:string;quantity:number;condition:string;project_id:string|null}>,
  createProject:vi.fn(),createTool:vi.fn(),updateTool:vi.fn(),toast:vi.fn(),
}));
vi.mock('@/components/layout/AppShell',()=>({AppShell:({children}:{children:React.ReactNode})=>children}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({isFounder:true,isSupervisor:false,user:{id:'founder'}})}));
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:mock.toast})}));
vi.mock('@/lib/data/store',()=>({useDataStore:()=>({
  projects:mock.projects,clients:mock.clients,tools:mock.tools,invoices:[],expenses:[],
  createProject:mock.createProject,createTool:mock.createTool,updateTool:mock.updateTool,
  deleteTool:vi.fn(),refresh:vi.fn(),getProjectsForSupervisor:()=>[],
})}));
import ProjectsPage from '@/app/projects/page';
import ToolsPage from '@/app/tools/page';
beforeEach(()=>{vi.clearAllMocks();mock.projects=[];mock.tools=[];mock.createProject.mockResolvedValue({id:'new'});mock.createTool.mockResolvedValue({id:'tool-new'});mock.updateTool.mockResolvedValue({id:'tool'});});
afterEach(()=>cleanup());
describe('searchable native selectors in existing forms',()=>{
  it('filters client choices without selecting or saving, then preserves the chosen client in project creation',async()=>{
    render(React.createElement(ProjectsPage));fireEvent.click(screen.getByRole('button',{name:'New Project'}));
    const modal=screen.getByRole('dialog',{name:'Create New Project'});fireEvent.click(within(modal).getByRole('button',{name:'Search clients'}));
    fireEvent.change(within(modal).getByRole('searchbox',{name:'Search clients'}),{target:{value:'luna'}});
    const select=within(modal).getByRole('combobox',{name:'Client'}) as HTMLSelectElement;
    expect(select.value).toBe('');expect(mock.createProject).not.toHaveBeenCalled();
    fireEvent.change(select,{target:{value:'client-8'}});
    fireEvent.change(within(modal).getByLabelText('Project Name'),{target:{value:'New Test Project'}});
    fireEvent.change(within(modal).getByLabelText('Site Location'),{target:{value:'Batangas'}});
    fireEvent.change(within(modal).getByLabelText('Budget Estimate (PHP ₱)'),{target:{value:'0'}});
    fireEvent.change(within(modal).getByLabelText('Start Date'),{target:{value:'2026-01-01'}});
    fireEvent.change(within(modal).getByLabelText('Target Completion Date'),{target:{value:'2026-02-01'}});
    fireEvent.click(within(modal).getByRole('button',{name:'Create Project'}));
    await waitFor(()=>expect(mock.createProject).toHaveBeenCalledWith(expect.objectContaining({name:'New Test Project',client_id:'client-8',budget_estimate:0})));
  });
  it('retains the depot default and sends the explicitly selected site in the tool form',async()=>{
    mock.projects=Array.from({length:10},(_,i)=>({id:`site-${i}`,name:i===8?'Luna Site':`Site ${i}`}));
    render(React.createElement(ToolsPage));fireEvent.click(screen.getByRole('button',{name:'Add Tool'}));
    const modal=screen.getByRole('dialog',{name:'Register New Tool / Machine'});
    const select=within(modal).getByRole('combobox',{name:'Assigned Project Site'}) as HTMLSelectElement;
    expect(select.value).toBe('');fireEvent.click(within(modal).getByRole('button',{name:'Search project sites'}));
    fireEvent.change(within(modal).getByRole('searchbox',{name:'Search project sites'}),{target:{value:'luna'}});
    expect(select.value).toBe('');expect(mock.createTool).not.toHaveBeenCalled();
    fireEvent.change(select,{target:{value:'site-8'}});fireEvent.change(within(modal).getByLabelText('Tool / Equipment Description'),{target:{value:'Test drill'}});
    fireEvent.click(within(modal).getByRole('button',{name:'Add to Inventory'}));
    await waitFor(()=>expect(mock.createTool).toHaveBeenCalledWith(expect.objectContaining({name:'Test drill',project_id:'site-8',quantity:1})));
  });
  it('preserves an unavailable existing site during tool edits and search',async()=>{
    mock.projects=Array.from({length:10},(_,i)=>({id:`site-${i}`,name:`Site ${i}`}));
    mock.tools=[{id:'tool',name:'Drill',quantity:1,condition:'good',project_id:'missing-site'}];
    render(React.createElement(ToolsPage));fireEvent.click(screen.getByRole('button',{name:'Edit Drill'}));
    const modal=screen.getByRole('dialog',{name:'Update Equipment Record'});
    fireEvent.click(within(modal).getByRole('button',{name:'Search project sites'}));
    fireEvent.change(within(modal).getByRole('searchbox',{name:'Search project sites'}),{target:{value:'Site 9'}});
    const select=within(modal).getByRole('combobox',{name:'Assigned Project Site'}) as HTMLSelectElement;
    expect(select.value).toBe('missing-site');expect(within(select).getByRole('option',{name:'Assigned project unavailable'})).toBeTruthy();
    fireEvent.click(within(modal).getByRole('button',{name:'Save Tool'}));
    await waitFor(()=>expect(mock.updateTool).toHaveBeenCalledWith('tool',expect.objectContaining({project_id:'missing-site'})));
  });
});
