// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({load:vi.fn(),save:vi.fn(),create:vi.fn(),upload:vi.fn(),download:vi.fn(),rpc:vi.fn(),toast:vi.fn()}));
vi.mock('@/components/layout/AppShell',()=>({AppShell:({children}:{children:React.ReactNode})=>children}));
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:mock.toast})}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:'11111111-1111-4111-8111-111111111111'},isFounder:true,assurance:'ready',isLoading:false})}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc,storage:{from:()=>({upload:mock.upload,createSignedUrl:async()=>({data:{signedUrl:'https://example.test/private'},error:null})})}})}));
vi.mock('@/lib/expenses/receiptInbox',async(importOriginal)=>({...await importOriginal<typeof import('@/lib/expenses/receiptInbox')>(),downloadInboxPhoto:mock.download}));
vi.mock('@/lib/expenses/draftStore',()=>({loadExpenseDraft:mock.load,saveExpenseDraft:mock.save,deleteExpenseDraft:vi.fn()}));
vi.mock('@/lib/data/store',()=>{const store={isLoaded:true,expenses:[],projects:[{id:'p',name:'Site'}],workers:[],createExpense:mock.create,createAdvance:vi.fn()};return {useDataStore:()=>store}});
import ExpensesPage from '@/app/expenses/page';
import {ReceiptInboxMismatchError} from '@/lib/expenses/receiptInbox';
const owner='11111111-1111-4111-8111-111111111111',id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const item={id,saved_by:owner,object_path:`${owner}/inbox/${id}.jpg`,file_name:'photo.jpg',mime_type:'image/jpeg',file_size:3,sha256:'a'.repeat(64),status:'ready',created_at:'2026-10-01T00:00:00+00:00'};
const draft={description:'CEMENT',amount:300,expenseDate:'2026-10-01',projectId:null,projectLabel:null,category:'materials',categorySource:'llm',vendor:null,vendorToken:null,isBaleHint:false,noteEvidence:null,evidence:[],unresolved:[],source:'llm',verification:'model-reported'};
beforeEach(()=>{sessionStorage.clear();window.matchMedia=vi.fn().mockReturnValue({matches:false});HTMLElement.prototype.scrollIntoView=vi.fn();mock.load.mockReset().mockResolvedValue({ok:true,value:null});mock.save.mockReset().mockImplementation(async(_client,owner,previous,id,payload)=>({ok:true,value:{owner_id:owner,draft_id:id,revision:1,payload,updated_at:'2026-11-06'}}));mock.create.mockReset();mock.upload.mockReset();mock.download.mockReset();mock.toast.mockReset();mock.rpc.mockReset().mockResolvedValue({data:{items:[item],has_more:false},error:null});vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({ok:true,draft,read:{model:'mock',extractedText:'CEMENT TOTAL 300'}})}));URL.createObjectURL=vi.fn().mockReturnValue('blob:receipt');URL.revokeObjectURL=vi.fn();});
afterEach(()=>{cleanup();vi.unstubAllGlobals()});
async function openPhotos(){render(React.createElement(ExpensesPage));await waitFor(()=>expect(mock.load).toHaveBeenCalled());fireEvent.click(screen.getByRole('button',{name:'Open photos'}));await screen.findByRole('button',{name:'Scan with AI'});}
describe('scan a previously saved photo',()=>{
 it('locks the entry during reading and saves the same path without a second upload',async()=>{
  let resolve!:(file:File)=>void;mock.download.mockReturnValue(new Promise<File>(r=>resolve=r));await openPhotos();fireEvent.click(screen.getByRole('button',{name:'Scan with AI'}));
  const dialog=screen.getByRole('dialog',{name:'Record Site Expense'});expect(within(dialog).getByText(/Reading the saved photo/)).toBeTruthy();expect(within(dialog).getByLabelText('Expense title').matches(':disabled')).toBe(true);expect(mock.create).not.toHaveBeenCalled();
  await act(async()=>resolve(new File(['abc'],'photo.jpg',{type:'image/jpeg'})));
  await within(dialog).findByText('Read from the receipt photo');expect((within(dialog).getByLabelText('Expense title') as HTMLInputElement).value).toBe('CEMENT');
  await act(async()=>{fireEvent.click(within(dialog).getByRole('button',{name:'Save draft'}))});
  expect(mock.save.mock.calls[0][4].form.receipt_url).toBe(item.object_path);expect(mock.upload).not.toHaveBeenCalled();expect(mock.create).not.toHaveBeenCalled();
  const saved=(await mock.save.mock.results[0].value).value;mock.load.mockResolvedValue({ok:true,value:saved});
  mock.create.mockResolvedValue({...saved.payload.form,id:saved.draft_id});
  fireEvent.change(within(dialog).getByLabelText('Associated Project Site'),{target:{value:'p'}});
  await act(async()=>{fireEvent.click(within(dialog).getByRole('button',{name:'Confirm & Save Expense'}))});
  await waitFor(()=>expect(mock.create).toHaveBeenCalled());
  expect(mock.create.mock.calls[0][0].receipt_url).toBe(item.object_path);expect(mock.upload).not.toHaveBeenCalled();
 });
 it('keeps the photo attached for manual entry if download fails',async()=>{
  mock.download.mockRejectedValue(new Error('mismatch'));await openPhotos();fireEvent.click(screen.getByRole('button',{name:'Scan with AI'}));
  const dialog=await screen.findByRole('dialog',{name:'Record Site Expense'});await waitFor(()=>expect(mock.toast).toHaveBeenCalledWith('error',expect.stringContaining('link remains attached')));
  expect(within(dialog).getByText(/Receipt Attached/)).toBeTruthy();expect(fetch).not.toHaveBeenCalled();expect(mock.create).not.toHaveBeenCalled();
 });
 it('does not attach a photo whose bytes changed since it was saved',async()=>{
  mock.download.mockRejectedValue(new ReceiptInboxMismatchError());await openPhotos();fireEvent.click(screen.getByRole('button',{name:'Scan with AI'}));
  const dialog=await screen.findByRole('dialog',{name:'Record Site Expense'});
  await waitFor(()=>expect(mock.toast).toHaveBeenCalledWith('error',expect.stringContaining('was not attached')));
  expect(within(dialog).queryByText(/Receipt Attached/)).toBeNull();expect(fetch).not.toHaveBeenCalled();expect(mock.create).not.toHaveBeenCalled();
 });
 it('keeps manual attachment available when AI is rate limited',async()=>{
  mock.download.mockResolvedValue(new File(['abc'],'photo.jpg',{type:'image/jpeg'}));
  vi.mocked(fetch).mockResolvedValueOnce({ok:false,status:429,json:async()=>({error:'Limit reached',rateLimited:true,retryAfterSeconds:45})} as Response);
  await openPhotos();fireEvent.click(screen.getByRole('button',{name:'Scan with AI'}));
  const dialog=await screen.findByRole('dialog',{name:'Record Site Expense'});
  await waitFor(()=>expect(mock.toast).toHaveBeenCalledWith('error',expect.stringContaining('still attached')));
  expect(within(dialog).getByText(/Receipt Attached/)).toBeTruthy();expect(within(dialog).getByLabelText('Expense title').matches(':disabled')).toBe(false);expect(mock.create).not.toHaveBeenCalled();
 });
 it('unlocks manual entry on download timeout and ignores a late result',async()=>{
  let resolve!:(file:File)=>void;mock.download.mockReturnValue(new Promise<File>(r=>resolve=r));
  await openPhotos();vi.useFakeTimers();
  try {
   fireEvent.click(screen.getByRole('button',{name:'Scan with AI'}));
   const dialog=screen.getByRole('dialog',{name:'Record Site Expense'});
   await act(async()=>{await vi.advanceTimersByTimeAsync(45000)});
   expect(within(dialog).getByLabelText('Expense title').matches(':disabled')).toBe(false);
   expect(mock.toast).toHaveBeenCalledWith('error',expect.stringContaining('link remains attached'));
   await act(async()=>resolve(new File(['abc'],'photo.jpg',{type:'image/jpeg'})));
   expect(fetch).not.toHaveBeenCalled();expect(within(dialog).getByText(/Receipt Attached/)).toBeTruthy();
  } finally {vi.useRealTimers();}
 });
 it('keeps an oversized photo for manual entry without downloading or calling AI',async()=>{
  mock.rpc.mockResolvedValue({data:{items:[{...item,file_size:4*1024*1024+1}],has_more:false},error:null});
  await openPhotos();fireEvent.click(screen.getByRole('button',{name:'Scan with AI'}));
  const dialog=screen.getByRole('dialog',{name:'Record Site Expense'});expect(within(dialog).getByText(/Receipt Attached/)).toBeTruthy();expect(mock.download).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
 });
 it('does not replace a saved draft with an inbox photo',async()=>{
  const payload={version:1,form:{project_id:'',description:'Keep this',details:'',amount:'',category:'materials',expense_date:'2026-10-01',notes:'',receipt_url:null,vendor:''},rows:[],receiptFileName:null,draft:null,draftInputKind:null,draftModel:null,draftExtractedText:null,aiResult:null,aiAccepted:false,contextWarnings:[]};
  mock.load.mockResolvedValue({ok:true,value:{owner_id:owner,draft_id:id,revision:1,payload,updated_at:'2026-10-01'}});
  await openPhotos();expect((screen.getByRole('button',{name:'Scan with AI'}) as HTMLButtonElement).disabled).toBe(true);expect((screen.getByRole('button',{name:'Use in expense'}) as HTMLButtonElement).disabled).toBe(true);expect(mock.download).not.toHaveBeenCalled();
 });
});
