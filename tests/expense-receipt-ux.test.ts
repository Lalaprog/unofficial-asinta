// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({create:vi.fn(),toast:vi.fn(),upload:vi.fn()}));
vi.mock('@/components/layout/AppShell',()=>({AppShell:({children}:{children:React.ReactNode})=>children}));
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:mock.toast})}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:'founder'}})}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({storage:{from:()=>({upload:mock.upload})}})}));
vi.mock('@/lib/data/store',()=>{const store={expenses:[],projects:[{id:'p',name:'Site'}],workers:[],createExpense:mock.create,createAdvance:vi.fn()};return {useDataStore:()=>store}});
import ExpensesPage from '@/app/expenses/page';
const reading='JMC Hardware\nCEMENT\nITEM 4800';
const draft={description:'CEMENT',amount:null,expenseDate:null,projectId:null,projectLabel:null,category:null,categorySource:'none',vendor:null,vendorToken:null,isBaleHint:false,noteEvidence:null,evidence:[],unresolved:['The receipt date needs your input.'],source:'llm',verification:'model-reported'};
beforeEach(()=>{mock.create.mockReset();mock.toast.mockReset();mock.upload.mockReset().mockResolvedValue({error:null});vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({ok:true,draft,read:{model:'mock',extractedText:reading}})}));URL.createObjectURL=vi.fn().mockReturnValue('blob:receipt');URL.revokeObjectURL=vi.fn()});
afterEach(()=>{cleanup();vi.unstubAllGlobals()});
async function scan(){const file=new File(['photo'],'receipt.jpg',{type:'image/jpeg'});fireEvent.change(screen.getByLabelText('Scan a receipt photo'),{target:{files:[file]}});const confirm=screen.queryByRole('alertdialog');if(confirm)fireEvent.click(within(confirm).getByRole('button',{name:'Scan new receipt'}));await screen.findByText('Read from the receipt photo')}
describe('expense receipt review',()=>{
  it('removes voice controls, opens a review with short editable description and keeps full OCR separate',async()=>{
    render(React.createElement(ExpensesPage));expect(screen.queryByText(/voice note/i)).toBeNull();await scan();
    const dialog=screen.getByRole('dialog',{name:'Record Site Expense'});expect((within(dialog).getByLabelText('Expense title') as HTMLInputElement).value).toBe('CEMENT');
    expect((within(dialog).getByLabelText('Amount (PHP ₱)') as HTMLInputElement).value).toBe('');expect((within(dialog).getByLabelText('Expense Date') as HTMLInputElement).value).toBe('');
    expect(dialog.querySelector('pre')?.textContent).toBe(reading);expect(within(dialog).getByText(/Text read from the receipt \(not saved\)/)).toBeTruthy();expect(within(dialog).getByAltText('Receipt photo awaiting your review')).toBeTruthy();
    expect(mock.create).not.toHaveBeenCalled();expect(mock.upload).not.toHaveBeenCalled();
  });
  it('does not reuse earlier unsaved amounts or dates for an uncertain new receipt',async()=>{
    render(React.createElement(ExpensesPage));fireEvent.click(screen.getAllByRole('button',{name:'Record Expense'})[0]);const dialog=screen.getByRole('dialog',{name:'Record Site Expense'});fireEvent.change(within(dialog).getByLabelText('Amount (PHP ₱)'),{target:{value:'999'}});fireEvent.change(within(dialog).getByLabelText('Expense Date'),{target:{value:'2026-01-01'}});fireEvent.click(within(dialog).getByRole('button',{name:'Cancel'}));await scan();const next=screen.getByRole('dialog',{name:'Record Site Expense'});expect((within(next).getByLabelText('Amount (PHP ₱)') as HTMLInputElement).value).toBe('');expect((within(next).getByLabelText('Expense Date') as HTMLInputElement).value).toBe('');
  });
  it('saves the reviewed description and selected photo, not raw OCR',async()=>{
    mock.create.mockImplementation(async x=>({...x,id:'new'}));render(React.createElement(ExpensesPage));await scan();const dialog=screen.getByRole('dialog',{name:'Record Site Expense'});
    fireEvent.change(within(dialog).getByLabelText('Associated Project Site'),{target:{value:'p'}});fireEvent.change(within(dialog).getByLabelText('Expense Category'),{target:{value:'materials'}});fireEvent.change(within(dialog).getByLabelText('Expense title'),{target:{value:'Cement for site'}});fireEvent.change(within(dialog).getByLabelText('Amount (PHP ₱)'),{target:{value:'4800'}});fireEvent.change(within(dialog).getByLabelText('Expense Date'),{target:{value:'2026-10-30'}});
    fireEvent.change(within(dialog).getByLabelText('Description (optional)'),{target:{value:'Supplies for site'}}); fireEvent.click(within(dialog).getByRole('button',{name:'Add item'})); fireEvent.change(within(dialog).getByLabelText('Item 1'),{target:{value:'Cement'}}); fireEvent.change(within(dialog).getByLabelText('Quantity 1'),{target:{value:'10 bags'}}); fireEvent.change(within(dialog).getByLabelText('Item amount 1 (₱)'),{target:{value:'4000'}});
    await act(async()=>{fireEvent.click(within(dialog).getByRole('button',{name:'Confirm & Save Expense'}))});await waitFor(()=>expect(mock.create).toHaveBeenCalledTimes(1));expect(mock.upload).toHaveBeenCalledTimes(1);expect(mock.create.mock.calls[0][0]).toMatchObject({description:'Cement for site',details:'Supplies for site',line_items:[{name:'Cement',quantity:'10 bags',amount:4000}],amount:4800,project_id:'p',expense_date:'2026-10-30'});expect(JSON.stringify(mock.create.mock.calls[0][0])).not.toContain(reading);
  });
  it('does not attach a failed scan or overwrite an existing manual entry',async()=>{
    vi.mocked(fetch).mockResolvedValueOnce({ok:false,json:async()=>({error:'Scan failed'})} as Response);render(React.createElement(ExpensesPage));fireEvent.click(screen.getAllByRole('button',{name:'Record Expense'})[0]);let dialog=screen.getByRole('dialog',{name:'Record Site Expense'});fireEvent.change(within(dialog).getByLabelText('Expense title'),{target:{value:'Existing note'}});fireEvent.click(within(dialog).getByRole('button',{name:'Cancel'}));const file=new File(['photo'],'receipt.jpg',{type:'image/jpeg'});fireEvent.change(screen.getByLabelText('Scan a receipt photo'),{target:{files:[file]}});fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Scan new receipt'}));await waitFor(()=>expect(mock.toast).toHaveBeenCalledWith('error',expect.stringContaining('No new photo was attached')));fireEvent.click(screen.getAllByRole('button',{name:'Record Expense'})[0]);dialog=screen.getByRole('dialog',{name:'Record Site Expense'});expect((within(dialog).getByLabelText('Expense title') as HTMLInputElement).value).toBe('Existing note');expect(within(dialog).queryByAltText('Receipt photo awaiting your review')).toBeNull();
  });
  it('clears the old scan review if a different photo is manually attached',async()=>{
    render(React.createElement(ExpensesPage));await scan();const dialog=screen.getByRole('dialog',{name:'Record Site Expense'});
    const upload=within(dialog).getByLabelText('Attach Photo');const file=new File(['new photo'],'replacement.jpg',{type:'image/jpeg'});
    await act(async()=>{fireEvent.change(upload,{target:{files:[file]}})});
    expect(within(dialog).queryByText('Text read from the receipt (not saved)')).toBeNull();expect(within(dialog).getByText(/Receipt Attached/)).toBeTruthy();expect(mock.toast).toHaveBeenCalledWith('info',expect.stringContaining('earlier scan'));
  });

  it('asks before replacing an unfinished expense and keeps it on cancel',async()=>{
    render(React.createElement(ExpensesPage));fireEvent.click(screen.getAllByRole('button',{name:'Record Expense'})[0]);let dialog=screen.getByRole('dialog',{name:'Record Site Expense'});fireEvent.change(within(dialog).getByLabelText('Expense title'),{target:{value:'Keep this'}});fireEvent.click(within(dialog).getByRole('button',{name:'Cancel'}));
    fireEvent.change(screen.getByLabelText('Scan a receipt photo'),{target:{files:[new File(['photo'],'new.jpg',{type:'image/jpeg'})]}});fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Keep my entry'}));expect(fetch).not.toHaveBeenCalled();fireEvent.click(screen.getAllByRole('button',{name:'Record Expense'})[0]);dialog=screen.getByRole('dialog',{name:'Record Site Expense'});expect((within(dialog).getByLabelText('Expense title') as HTMLInputElement).value).toBe('Keep this');
  });

});
