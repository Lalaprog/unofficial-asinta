// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
const mock = vi.hoisted(() => ({ response: {} as any }));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({from:()=>({select:()=>({eq:()=>({order:()=>Promise.resolve(mock.response)})})})})}));
vi.mock('@/lib/data/store',()=>({useDataStore:()=>({users:[]})}));
import { EmailHistoryModal } from '@/components/email/EmailHistoryModal';
afterEach(cleanup);
describe('email history safety',()=>{
 it('explains that pending attempts may have been sent',async()=>{
  mock.response={data:[{id:'1',status:'pending',template_type:'initial_request',template_version:1,subject:'Invoice',recipient:'a@example.test',created_at:'2026-11-01T00:00:00Z',sent_by:null}],error:null};
  render(React.createElement(EmailHistoryModal,{isOpen:true,onClose:vi.fn(),invoiceId:'inv'}));
  await screen.findByText('Pending or unconfirmed');expect(screen.getByText(/outcome may be unconfirmed/)).toBeTruthy();
 });
 it('does not show an empty-history message when loading fails',async()=>{
  mock.response={data:null,error:{message:'offline'}};
  render(React.createElement(EmailHistoryModal,{isOpen:true,onClose:vi.fn(),invoiceId:'inv'}));
  await screen.findByText(/Could not load email history/);expect(screen.queryByText(/No billing emails have been sent/)).toBeNull();
 });
});
