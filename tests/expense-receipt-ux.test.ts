// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({create:vi.fn(),toast:vi.fn(),upload:vi.fn(),load:vi.fn(),save:vi.fn(),remove:vi.fn()}));
vi.mock('@/components/layout/AppShell',()=>({AppShell:({children}:{children:React.ReactNode})=>children}));
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:mock.toast})}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:'founder'},isFounder:true,assurance:'ready',isLoading:false})}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({storage:{from:()=>({upload:mock.upload,createSignedUrl:async()=>({data:{signedUrl:'https://example.test/private-photo'},error:null})})}})}));
vi.mock('@/lib/expenses/draftStore',()=>({loadExpenseDraft:mock.load,saveExpenseDraft:mock.save,deleteExpenseDraft:mock.remove}));
vi.mock('@/lib/data/store',()=>{const store={isLoaded:true,expenses:[],projects:[{id:'p',name:'Site'}],workers:[],createExpense:mock.create,createAdvance:vi.fn()};return {useDataStore:()=>store}});
import ExpensesPage from '@/app/expenses/page';
const reading='JMC Hardware\nCEMENT\nITEM 4800';
const draft={description:'CEMENT',amount:null,expenseDate:null,projectId:null,projectLabel:null,category:null,categorySource:'none',vendor:null,vendorToken:null,isBaleHint:false,noteEvidence:null,evidence:[],unresolved:['The receipt date needs your input.'],source:'llm',verification:'model-reported'};
beforeEach(()=>{sessionStorage.clear(); HTMLElement.prototype.scrollIntoView=vi.fn(); window.matchMedia=vi.fn().mockReturnValue({matches:false}); mock.load.mockReset().mockResolvedValue({ok:true,value:null});mock.save.mockReset().mockImplementation(async (_client,owner,previous,id,payload)=>({ok:true,value:{owner_id:owner,draft_id:id,revision:(previous?.revision||0)+1,payload,updated_at:'2026-11-06'}}));mock.remove.mockReset().mockResolvedValue({ok:true,value:true});mock.create.mockReset();mock.toast.mockReset();mock.upload.mockReset().mockResolvedValue({error:null});vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({ok:true,draft,read:{model:'mock',extractedText:reading}})}));URL.createObjectURL=vi.fn().mockReturnValue('blob:receipt');URL.revokeObjectURL=vi.fn()});
afterEach(()=>{cleanup();vi.unstubAllGlobals()});
async function saveAndClose(dialog:HTMLElement){fireEvent.click(within(dialog).getByRole('button',{name:'Cancel'}));const confirmation=screen.getByRole('alertdialog',{name:'Unfinished expense'});await waitFor(()=>expect((within(confirmation).getByRole('button',{name:'Save draft'}) as HTMLButtonElement).disabled).toBe(false));await act(async()=>{fireEvent.click(within(confirmation).getByRole('button',{name:'Save draft'}))});await waitFor(()=>expect(screen.queryByRole('alertdialog',{name:'Unfinished expense'})).toBeNull());}
async function scan(){const file=new File(['photo'],'receipt.jpg',{type:'image/jpeg'});fireEvent.change(screen.getByLabelText('Scan a receipt photo'),{target:{files:[file]}});const confirm=screen.queryByRole('alertdialog');if(confirm)fireEvent.click(within(confirm).getByRole('button',{name:'Scan new receipt'}));await screen.findByText('Read from the receipt photo')}
describe('expense receipt review',()=>{
  it('opens a saved expense draft from the manual shortcut without overwriting it', async()=>{
    render(React.createElement(ExpensesPage));
    fireEvent.click(screen.getAllByRole('button',{name:'Record Expense'})[0]);
    const dialog=screen.getByRole('dialog',{name:'Record Site Expense'});
    fireEvent.change(within(dialog).getByLabelText('Expense title'),{target:{value:'Keep draft'}});
    await saveAndClose(dialog);
    act(()=>{ window.dispatchEvent(new CustomEvent('asinta:mobile-quick-action',{detail:'expense-manual'})); });
    await waitFor(()=>expect(screen.getByRole('dialog',{name:'Record Site Expense'})).toBeTruthy());
    expect((within(screen.getByRole('dialog',{name:'Record Site Expense'})).getByLabelText('Expense title') as HTMLInputElement).value).toBe('Keep draft');
    expect(mock.create).not.toHaveBeenCalled();
  });
  it('keeps a saved draft when starting a scan and asks before replacing unfinished work', async()=>{
    render(React.createElement(ExpensesPage));
    fireEvent.click(screen.getAllByRole('button',{name:'Record Expense'})[0]);
    const dialog=screen.getByRole('dialog',{name:'Record Site Expense'});
    fireEvent.change(within(dialog).getByLabelText('Expense title'),{target:{value:'Keep draft'}});
    await saveAndClose(dialog);
    act(()=>{ window.dispatchEvent(new CustomEvent('asinta:mobile-quick-action',{detail:'expense-scan'})); });
    expect(screen.getByRole('button',{name:'Continue draft'})).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Scan a receipt photo'),{target:{files:[new File(['photo'],'receipt.jpg',{type:'image/jpeg'})]}});
    expect(screen.getByRole('alertdialog',{name:'Replace unfinished expense?'})).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Keep my entry'}));
    expect(screen.getByRole('button',{name:'Continue draft'})).toBeTruthy();
  });
  it('prevents quick navigation away from an unsaved expense description when cancelled',async()=>{
    vi.spyOn(window,'confirm').mockReturnValue(false);
    render(React.createElement(ExpensesPage));
    await waitFor(()=>expect(mock.load).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Describe the expense'),{target:{value:'cement for site'}});
    const event=new CustomEvent('asinta:quick-leave',{cancelable:true,detail:{destination:'/invoices'}});
    expect(window.dispatchEvent(event)).toBe(false);
    expect((screen.getByLabelText('Describe the expense') as HTMLTextAreaElement).value).toBe('cement for site');
    vi.restoreAllMocks();
  });

  it('removes voice controls, opens a review with short editable description and keeps full OCR separate',async()=>{
    render(React.createElement(ExpensesPage));expect(screen.queryByText(/voice note/i)).toBeNull();await scan();
    const dialog=screen.getByRole('dialog',{name:'Record Site Expense'});expect((within(dialog).getByLabelText('Expense title') as HTMLInputElement).value).toBe('CEMENT');
    await waitFor(()=>expect(document.activeElement).toBe(dialog)); expect(dialog.className).toContain('max-w-5xl');
    expect((within(dialog).getByLabelText('Amount (PHP ₱)') as HTMLInputElement).value).toBe('');expect((within(dialog).getByLabelText('Expense Date') as HTMLInputElement).value).toBe('');
    expect(dialog.querySelector('pre')?.textContent).toBe(reading);expect(within(dialog).getByText(/Text read from the receipt \(not part of the recorded expense\)/)).toBeTruthy();expect(within(dialog).getByAltText('Receipt photo awaiting your review')).toBeTruthy();
    expect(mock.create).not.toHaveBeenCalled();expect(mock.upload).not.toHaveBeenCalled();
  });
  it('does not reuse earlier unsaved amounts or dates for an uncertain new receipt',async()=>{
    render(React.createElement(ExpensesPage));fireEvent.click(screen.getAllByRole('button',{name:'Record Expense'})[0]);const dialog=screen.getByRole('dialog',{name:'Record Site Expense'});fireEvent.change(within(dialog).getByLabelText('Amount (PHP ₱)'),{target:{value:'999'}});fireEvent.change(within(dialog).getByLabelText('Expense Date'),{target:{value:'2026-01-01'}});await saveAndClose(dialog);await scan();const next=screen.getByRole('dialog',{name:'Record Site Expense'});expect((within(next).getByLabelText('Amount (PHP ₱)') as HTMLInputElement).value).toBe('');expect((within(next).getByLabelText('Expense Date') as HTMLInputElement).value).toBe('');
  });
  it('saves the reviewed description and selected photo, not raw OCR',async()=>{
    mock.create.mockImplementation(async x=>({...x,id:'new'}));render(React.createElement(ExpensesPage));await scan();const dialog=screen.getByRole('dialog',{name:'Record Site Expense'});
    fireEvent.change(within(dialog).getByLabelText('Associated Project Site'),{target:{value:'p'}});fireEvent.change(within(dialog).getByLabelText('Expense Category'),{target:{value:'materials'}});fireEvent.change(within(dialog).getByLabelText('Expense title'),{target:{value:'Cement for site'}});fireEvent.change(within(dialog).getByLabelText('Amount (PHP ₱)'),{target:{value:'4800'}});fireEvent.change(within(dialog).getByLabelText('Expense Date'),{target:{value:'2026-10-30'}});
    fireEvent.change(within(dialog).getByLabelText('Description (optional)'),{target:{value:'Supplies for site'}}); fireEvent.click(within(dialog).getByRole('button',{name:'Add item'})); fireEvent.change(within(dialog).getByLabelText('Item 1'),{target:{value:'Cement'}}); fireEvent.change(within(dialog).getByLabelText('Quantity 1'),{target:{value:'10 bags'}}); fireEvent.change(within(dialog).getByLabelText('Item amount 1 (₱)'),{target:{value:'4000'}});
    await act(async()=>{fireEvent.click(within(dialog).getByRole('button',{name:'Confirm & Save Expense'}))});await waitFor(()=>expect(mock.create).toHaveBeenCalledTimes(1));expect(mock.upload).toHaveBeenCalledTimes(1);expect(mock.create.mock.calls[0][0]).toMatchObject({description:'Cement for site',details:'Supplies for site',line_items:[{name:'Cement',quantity:'10 bags',amount:4000}],amount:4800,project_id:'p',expense_date:'2026-10-30'});expect(JSON.stringify(mock.create.mock.calls[0][0])).not.toContain(reading);
  });
  it('does not attach a failed scan or overwrite an existing manual entry',async()=>{
    vi.mocked(fetch).mockResolvedValueOnce({ok:false,json:async()=>({error:'Scan failed'})} as Response);render(React.createElement(ExpensesPage));fireEvent.click(screen.getAllByRole('button',{name:'Record Expense'})[0]);let dialog=screen.getByRole('dialog',{name:'Record Site Expense'});fireEvent.change(within(dialog).getByLabelText('Expense title'),{target:{value:'Existing note'}});await saveAndClose(dialog);const file=new File(['photo'],'receipt.jpg',{type:'image/jpeg'});fireEvent.change(screen.getByLabelText('Scan a receipt photo'),{target:{files:[file]}});fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Scan new receipt'}));await waitFor(()=>expect(mock.toast).toHaveBeenCalledWith('error',expect.stringContaining('No new photo was attached')));fireEvent.click(screen.getAllByRole('button',{name:'Record Expense'})[0]);dialog=screen.getByRole('dialog',{name:'Record Site Expense'});expect((within(dialog).getByLabelText('Expense title') as HTMLInputElement).value).toBe('Existing note');expect(within(dialog).queryByAltText('Receipt photo awaiting your review')).toBeNull();
  });
  it('clears the old scan review if a different photo is manually attached',async()=>{
    render(React.createElement(ExpensesPage));await scan();const dialog=screen.getByRole('dialog',{name:'Record Site Expense'});
    const upload=within(dialog).getByLabelText('Attach Photo');const file=new File(['new photo'],'replacement.jpg',{type:'image/jpeg'});
    await act(async()=>{fireEvent.change(upload,{target:{files:[file]}})});
    expect(within(dialog).queryByText('Text read from the receipt (not saved)')).toBeNull();expect(within(dialog).getByText(/Receipt Attached/)).toBeTruthy();expect(mock.toast).toHaveBeenCalledWith('info',expect.stringContaining('earlier scan'));
  });

  it('asks before replacing an unfinished expense and keeps it on cancel',async()=>{
    render(React.createElement(ExpensesPage));fireEvent.click(screen.getAllByRole('button',{name:'Record Expense'})[0]);let dialog=screen.getByRole('dialog',{name:'Record Site Expense'});fireEvent.change(within(dialog).getByLabelText('Expense title'),{target:{value:'Keep this'}});await saveAndClose(dialog);
    fireEvent.change(screen.getByLabelText('Scan a receipt photo'),{target:{files:[new File(['photo'],'new.jpg',{type:'image/jpeg'})]}});fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Keep my entry'}));expect(fetch).not.toHaveBeenCalled();fireEvent.click(screen.getAllByRole('button',{name:'Record Expense'})[0]);dialog=screen.getByRole('dialog',{name:'Record Site Expense'});expect((within(dialog).getByLabelText('Expense title') as HTMLInputElement).value).toBe('Keep this');
  });

  it('saves a receipt draft, restores it after remount, and records with the same ID',async()=>{
    const first=render(React.createElement(ExpensesPage)); await scan(); let dialog=screen.getByRole('dialog',{name:'Record Site Expense'});
    fireEvent.change(within(dialog).getByLabelText('Associated Project Site'),{target:{value:'p'}});
    fireEvent.change(within(dialog).getByLabelText('Expense Category'),{target:{value:'materials'}});
    fireEvent.change(within(dialog).getByLabelText('Amount (PHP ₱)'),{target:{value:'4800'}});
    fireEvent.change(within(dialog).getByLabelText('Expense Date'),{target:{value:'2026-10-30'}});
    await saveAndClose(dialog); expect(mock.create).not.toHaveBeenCalled(); expect(mock.upload).toHaveBeenCalledTimes(1);
    const saved=(await mock.save.mock.results[0].value).value; expect(saved.payload.form.receipt_url).toContain('founder/');
    first.unmount();mock.load.mockResolvedValue({ok:true,value:saved});mock.create.mockImplementation(async x=>({...x,id:saved.draft_id}));
    render(React.createElement(ExpensesPage));fireEvent.click(await screen.findByRole('button',{name:'Continue draft'}));
    dialog=await screen.findByRole('dialog',{name:'Record Site Expense'});expect((within(dialog).getByLabelText('Amount (PHP ₱)') as HTMLInputElement).value).toBe('4800');
    expect((within(dialog).getByAltText('Receipt photo awaiting your review') as HTMLImageElement).src).toBe('https://example.test/private-photo');
    await act(async()=>{fireEvent.click(within(dialog).getByRole('button',{name:'Confirm & Save Expense'}))});
    await waitFor(()=>expect(mock.create).toHaveBeenCalledTimes(1));expect(mock.create.mock.calls[0][1]).toBe(saved.draft_id);expect(mock.remove).toHaveBeenCalledTimes(1);expect(mock.upload).toHaveBeenCalledTimes(1);
  });
  it('keeps unsaved work if saving a draft fails and lets the user return to editing',async()=>{
    mock.save.mockResolvedValue({ok:false,message:'Draft changed elsewhere. Refresh and check.'});
    render(React.createElement(ExpensesPage));fireEvent.click(screen.getAllByRole('button',{name:'Record Expense'})[0]);
    const dialog=screen.getByRole('dialog',{name:'Record Site Expense'});fireEvent.change(within(dialog).getByLabelText('Expense title'),{target:{value:'Still here'}});
    fireEvent.click(within(dialog).getByRole('button',{name:'Cancel'}));const prompt=screen.getByRole('alertdialog',{name:'Unfinished expense'});
    await waitFor(()=>expect((within(prompt).getByRole('button',{name:'Save draft'}) as HTMLButtonElement).disabled).toBe(false));
    await act(async()=>{fireEvent.click(within(prompt).getByRole('button',{name:'Save draft'}))});
    expect(mock.toast).toHaveBeenCalledWith('error',expect.stringContaining('changed elsewhere'));
    fireEvent.click(within(prompt).getByRole('button',{name:'Keep editing'}));expect((within(dialog).getByLabelText('Expense title') as HTMLInputElement).value).toBe('Still here');expect(mock.create).not.toHaveBeenCalled();
  });

  it('blocks recording a saved draft if another tab changed its revision',async()=>{
    render(React.createElement(ExpensesPage)); await scan(); const dialog=screen.getByRole('dialog',{name:'Record Site Expense'});
    fireEvent.change(within(dialog).getByLabelText('Associated Project Site'),{target:{value:'p'}});fireEvent.change(within(dialog).getByLabelText('Expense Category'),{target:{value:'materials'}});fireEvent.change(within(dialog).getByLabelText('Amount (PHP ₱)'),{target:{value:'4800'}});fireEvent.change(within(dialog).getByLabelText('Expense Date'),{target:{value:'2026-10-30'}});
    await waitFor(()=>expect((within(dialog).getByRole('button',{name:'Save draft'}) as HTMLButtonElement).disabled).toBe(false));
    await act(async()=>{fireEvent.click(within(dialog).getByRole('button',{name:'Save draft'}))});const saved=(await mock.save.mock.results[0].value).value;mock.load.mockResolvedValue({ok:true,value:{...saved,revision:saved.revision+1}});
    await act(async()=>{fireEvent.click(within(dialog).getByRole('button',{name:'Confirm & Save Expense'}))});
    expect(mock.create).not.toHaveBeenCalled();expect(mock.toast).toHaveBeenCalledWith('error',expect.stringContaining('changed elsewhere'));
  });

  it('shows an advisory cooldown and keeps manual entry available without silently retrying',async()=>{
    vi.mocked(fetch).mockResolvedValueOnce({ok:false,status:429,json:async()=>({error:'Limit reached',rateLimited:true,retryAfterSeconds:1})} as Response);
    render(React.createElement(ExpensesPage));
    fireEvent.change(screen.getByLabelText('Scan a receipt photo'),{target:{files:[new File(['photo'],'new.jpg',{type:'image/jpeg'})]}});
    await screen.findByText(/Receipt scanning is temporarily limited/);
    expect((screen.getByLabelText('Scan a receipt photo') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/Try again in about/)).toBeTruthy();expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByRole('button',{name:'Record Expense'})[0]);expect(screen.getByRole('dialog',{name:'Record Site Expense'})).toBeTruthy();
    await waitFor(()=>expect((screen.getByLabelText('Scan a receipt photo',{selector:'input'}) as HTMLInputElement).disabled).toBe(false),{timeout:3000});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not invent or enforce a cooldown when no reliable wait was supplied',async()=>{
    vi.mocked(fetch).mockResolvedValueOnce({ok:false,status:429,json:async()=>({error:'Limit reached',rateLimited:true})} as Response);
    render(React.createElement(ExpensesPage));fireEvent.change(screen.getByLabelText('Scan a receipt photo'),{target:{files:[new File(['photo'],'new.jpg',{type:'image/jpeg'})]}});
    await screen.findByText(/a wait time was not provided/);expect((screen.getByLabelText('Scan a receipt photo') as HTMLInputElement).disabled).toBe(false);expect(fetch).toHaveBeenCalledTimes(1);
  });

});
