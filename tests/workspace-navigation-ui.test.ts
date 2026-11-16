// @vitest-environment jsdom
import React, {useState} from 'react';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('@/components/payroll/WeeklyWorkerPreview', () => ({WeeklyWorkerPreview: () => React.createElement(Card,{name:'Weekly worker'})}));
vi.mock('@/components/payroll/WorkerAllowanceQueue', () => ({WorkerAllowanceQueue: () => React.createElement(Card,{name:'Allowances'})}));
vi.mock('@/components/payroll/PaidHistoryReview', () => ({PaidHistoryReview: () => React.createElement(Card,{name:'Paid history'})}));
vi.mock('@/components/attendance/SupervisorDayPanel', () => ({SupervisorDayPanel: () => React.createElement(Card,{name:'Daily attendance'})}));
vi.mock('@/components/attendance/SupervisorLeavePanel', () => ({SupervisorLeavePanel: () => React.createElement(Card,{name:'Leave'})}));
import {PayrollFoundationPanels} from '@/components/payroll/PayrollFoundationPanels';
import {SupervisorFoundationPanels} from '@/components/attendance/SupervisorFoundationPanels';

function Card({name}:{name:string}) {
 const [open,setOpen]=useState(false);
 return React.createElement('section',null,
  React.createElement('button',{type:'button','aria-expanded':open,onClick:()=>setOpen(v=>!v)},name),
  open && React.createElement('input',{'aria-label':`${name} draft`})
 );
}
afterEach(()=>{cleanup();vi.unstubAllEnvs();});
describe('workspace navigation',()=>{
 it('keeps independent open panels and drafts intact while another task opens',()=>{
  vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','true');
  const view=render(React.createElement(React.Fragment,null,React.createElement(PayrollFoundationPanels),React.createElement(SupervisorFoundationPanels)));
  fireEvent.click(screen.getByRole('button',{name:'Weekly worker'}));
  fireEvent.change(screen.getByRole('textbox',{name:'Weekly worker draft'}),{target:{value:'unfinished'}});
  fireEvent.click(screen.getByRole('button',{name:'More payroll tools'}));
  fireEvent.click(screen.getByRole('button',{name:'Allowances'}));
  fireEvent.click(screen.getByRole('button',{name:'My own attendance and leave'}));
  fireEvent.click(screen.getByRole('button',{name:'Leave'}));
  expect((screen.getByRole('textbox',{name:'Weekly worker draft'}) as HTMLInputElement).value).toBe('unfinished');
  expect(screen.getByRole('button',{name:'Weekly worker'}).getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('button',{name:'Allowances'}).getAttribute('aria-expanded')).toBe('true');
  expect(view.container.querySelectorAll('.workspace-bento')).toHaveLength(2);
 });
});
