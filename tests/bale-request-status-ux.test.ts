// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdvanceRequest } from '@/types';

const mock = vi.hoisted(() => ({ founder: true, focus: '', replace: vi.fn(), review: vi.fn(), issue: vi.fn(), batch: vi.fn(), submit: vi.fn(), toast: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mock.replace }), useSearchParams: () => new URLSearchParams(mock.focus ? `tab=requests&request=${mock.focus}` : 'tab=requests') }));
vi.mock('@/lib/auth/authContext', () => ({useAuth: () => ({user:{id:mock.founder?'founder':'sup'},isFounder:mock.founder,isSupervisor:!mock.founder})}));
vi.mock('@/components/ui/Toast', () => ({useToast: () => ({showToast:mock.toast})}));
vi.mock('@/components/ui/Modal', () => ({Modal: ({isOpen,title,description,children}:{isOpen:boolean;title:string;description?:string;children:React.ReactNode}) => isOpen ? React.createElement('div',{role:'dialog','aria-label':title},description && React.createElement('p',null,description),children) : null}));

const req = (id: string, status: AdvanceRequest['status'], extras: Partial<AdvanceRequest> = {}): AdvanceRequest => ({
  id, worker_id:id, project_id:'site', requested_amount:1000, submitted_by:'sup',status,approved_by:null,approved_at:null,rejected_by:null,rejected_at:null,issued_by:null,issued_at:null,issued_advance_id:null,created_at:'2026-11-02T16:00:00Z',updated_at:'2026-11-02T16:00:00Z',...extras,
});
const rows: AdvanceRequest[] = [
  req('pending','pending_approval'),
  req('approved','approved_pending_payment',{approved_at:'2026-11-03T16:00:00Z',issued_at:'2026-11-04T00:00:00Z'}),
  req('issued','issued',{approved_at:'2026-11-03T16:00:00Z',issued_at:'2026-11-05T16:00:00Z',issued_advance_id:'advance'}),
  req('rejected','rejected',{rejected_at:'2026-11-06T16:00:00Z',approved_at:'2026-11-03T16:00:00Z'}),
  req('unknown-date','issued',{created_at:'not a date',approved_at:null,issued_at:null,issued_advance_id:'other'}),
  req('other-user','pending_approval',{submitted_by:'other'}),
];
const projects=[{id:'site',name:'Site A'}];
const workers=rows.map(r=>({id:r.id,name:`Worker ${r.id}`,position:'Mason',active:true}));
vi.mock('@/lib/data/store',()=>({useDataStore:()=>({advanceRequests:rows,projects,workers,users:[{id:'sup',name:'Supervisor'}],getProjectsForSupervisor:()=>projects,createAdvanceRequest:mock.submit,reviewAdvanceRequest:mock.review,approveAdvanceRequests:mock.batch,issueAdvanceRequest:mock.issue})}));
import {AdvanceRequestsPanel} from '@/components/advances/AdvanceRequestsPanel';
const row=(id:string)=>document.getElementById(`advance-request-${id}`)!;

beforeEach(()=>{mock.founder=true;mock.focus='';mock.replace.mockReset();mock.review.mockReset().mockResolvedValue(true);mock.issue.mockReset().mockResolvedValue(true);mock.batch.mockReset();mock.submit.mockReset();mock.toast.mockReset();});
afterEach(()=>cleanup());

describe('Bale request status clarity',()=>{
  it('shows accurate recorded stages, expands only real status dates and marks loaded totals',()=>{
    render(React.createElement(AdvanceRequestsPanel));
    expect(screen.getByText(/Summary covers loaded requests/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Request status'),{target:{value:'all'}});
    expect(within(row('pending')).getByText(/Waiting for the Founder/)).toBeTruthy();
    expect(within(row('approved')).getByText(/Approved, but payment and issue have not been confirmed/)).toBeTruthy();
    expect(within(row('issued')).getByText('Issued · payment confirmed')).toBeTruthy();
    expect(within(row('rejected')).getByText(/This request did not create an issued advance/)).toBeTruthy();
    expect(screen.getByText(/it is not an amount due/)).toBeTruthy();
    const details=row('issued').querySelector('details')!; expect(details.open).toBe(false);
    fireEvent.click(details.querySelector('summary')!);expect(details.open).toBe(true);
    expect(within(details).getByText('Request submitted: November 3, 2026')).toBeTruthy();
    expect(within(details).getByText('Approval recorded: November 4, 2026')).toBeTruthy();
    expect(within(details).getByText('Issue confirmation recorded: November 6, 2026')).toBeTruthy();
    expect(within(details).getByText(/not a payment receipt/)).toBeTruthy();
    expect(within(row('approved')).queryByText(/Issue confirmation recorded/)).toBeNull();
    expect(within(row('rejected')).queryByText(/Approval recorded/)).toBeNull();
    expect(within(row('unknown-date')).getByText('Request submitted: Date unavailable')).toBeTruthy();
    expect(within(row('unknown-date')).queryByText(/Issue confirmation recorded/)).toBeNull();
  });
  it('preserves individual approval and requires confirmation before issuing',async()=>{
    render(React.createElement(AdvanceRequestsPanel));
    fireEvent.click(within(row('pending')).getByRole('button',{name:'Approve'}));
    await waitFor(()=>expect(mock.review).toHaveBeenCalledWith('pending','approve'));
    fireEvent.click(within(row('approved')).getByRole('button',{name:'Confirm paid & issue'}));
    const modal=screen.getByRole('dialog',{name:'Confirm Bale payment'});
    expect(within(modal).getByText(/It does not transfer money/)).toBeTruthy();expect(mock.issue).not.toHaveBeenCalled();
    fireEvent.click(within(modal).getByRole('button',{name:'Not yet'}));expect(mock.issue).not.toHaveBeenCalled();
    fireEvent.click(within(row('approved')).getByRole('button',{name:'Confirm paid & issue'}));
    fireEvent.click(within(screen.getByRole('dialog',{name:'Confirm Bale payment'})).getByRole('button',{name:'Confirm paid & issue'}));
    await waitFor(()=>expect(mock.issue).toHaveBeenCalledTimes(1));expect(mock.issue).toHaveBeenCalledWith('approved');
  });
  it('shows supervisors only their own records and no Founder action controls',()=>{
    mock.founder=false;render(React.createElement(AdvanceRequestsPanel));fireEvent.click(screen.getByRole('button',{name:'All requests'}));
    expect(row('issued')).toBeTruthy();expect(row('other-user')).toBeNull();expect(screen.queryByRole('button',{name:'Approve'})).toBeNull();expect(screen.queryByRole('button',{name:'Confirm paid & issue'})).toBeNull();
  });
  it('explains an unavailable linked request and lets either role return to filters',()=>{
    mock.founder=false;mock.focus='missing';render(React.createElement(AdvanceRequestsPanel));
    expect(screen.getByText('This Bale request is not in the loaded list')).toBeTruthy();expect(screen.getByText(/outside the loaded history/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Back to filtered requests'}));expect(mock.replace).toHaveBeenCalledWith('/advances?tab=requests',{scroll:false});expect(row('pending')).toBeTruthy();
  });
});
