// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),insert:vi.fn(),finish:vi.fn(),prepare:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mocks.rpc,from:()=>({insert:mocks.insert})})}));
vi.mock('@/lib/expenses/receiptInbox',async(importOriginal)=>({...await importOriginal<typeof import('@/lib/expenses/receiptInbox')>(),prepareInboxItem:mocks.prepare,uploadAndFinishInbox:mocks.finish}));
import {ReceiptInbox} from '@/components/expenses/ReceiptInbox';
const owner='11111111-1111-4111-8111-111111111111',id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const item={id,saved_by:owner,object_path:`${owner}/inbox/${id}.jpg`,file_name:'photo.jpg',mime_type:'image/jpeg',file_size:3,sha256:'a'.repeat(64),status:'pending' as const,created_at:'2026-10-01T00:00:00+00:00'};
beforeEach(()=>{mocks.rpc.mockReset();mocks.insert.mockReset();mocks.finish.mockReset();mocks.prepare.mockReset();});afterEach(()=>cleanup());
describe('receipt photo inbox',()=>{
 it('saves a separate photo then offers it for manual expense entry',async()=>{
  const {status:_status,created_at:_created,...metadata}=item;
  mocks.prepare.mockResolvedValue(metadata);
  mocks.insert.mockReturnValue({select:()=>({maybeSingle:async()=>({data:item,error:null})})});
  mocks.finish.mockResolvedValue(true);
  mocks.rpc.mockResolvedValueOnce({data:{items:[],has_more:false},error:null}).mockResolvedValueOnce({data:{items:[{...item,status:'ready'}],has_more:false},error:null});
  const use=vi.fn();render(React.createElement(ReceiptInbox,{userId:owner,canUse:true,canScan:true,onUse:use,onScan:vi.fn(),onView:vi.fn()}));
  fireEvent.click(screen.getByRole('button',{name:'Open photos'}));await screen.findByText('No saved photos yet.');
  fireEvent.change(screen.getByLabelText('Save photo for later'),{target:{files:[new File(['abc'],'photo.jpg',{type:'image/jpeg'})]}});
  expect(await screen.findByText('Photo saved. It is not an expense.')).toBeTruthy();expect(mocks.insert).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button',{name:'Use in expense'}));expect(use).toHaveBeenCalledWith(expect.objectContaining({id,status:'ready'}));
 });
 it('does not offer pending photos as complete, and shows failure without pretending empty',async()=>{
  mocks.rpc.mockResolvedValueOnce({data:null,error:{message:'offline'}}).mockResolvedValueOnce({data:{items:[item],has_more:false},error:null});
  render(React.createElement(ReceiptInbox,{userId:owner,canUse:false,canScan:false,onUse:vi.fn(),onScan:vi.fn(),onView:vi.fn()}));
  fireEvent.click(screen.getByRole('button',{name:'Open photos'}));expect(await screen.findByRole('alert')).toBeTruthy();expect(screen.queryByText('No saved photos yet.')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Retry photos'}));await waitFor(()=>expect(screen.getByText(/Upload pending/)).toBeTruthy());
  expect(screen.queryByRole('button',{name:'Use in expense'})).toBeNull();expect(screen.getByLabelText('Resume with same photo')).toBeTruthy();
 });
});
