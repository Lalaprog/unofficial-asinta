// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
vi.mock('@/components/layout/AppShell',()=>({AppShell:({children}:{children:React.ReactNode})=>React.createElement('main',null,children)}));
vi.mock('next/link',()=>({default:({children,href}:{children:React.ReactNode;href:string})=>React.createElement('a',{href},children)}));
vi.mock('@/lib/reminders/scheduler',()=>({getManilaClock:()=>({dateIso:'2026-11-18'})}));
vi.mock('next/navigation',()=>({notFound:()=>{throw Error('not found')}}));
import {WeeklyFinanceWalkthrough} from '@/components/payroll/WeeklyFinanceWalkthrough';
import Page from '@/app/payroll/weekly-preview/page';
import {calculateWeeklyWalkthrough} from '@/lib/payroll/weeklyWalkthrough';

afterEach(()=>{cleanup();vi.unstubAllEnvs();});
const blank=()=>Array.from({length:7},()=>({regular:'',overtime:''}));
const change=(label:string,value:string)=>fireEvent.change(screen.getByLabelText(label),{target:{value}});
describe('safe Vercel finance walkthrough',()=>{
 it('is unavailable outside a Vercel preview deployment',()=>{
  for(const value of ['production','development','']){vi.stubEnv('VERCEL_ENV',value);expect(()=>Page()).toThrow('not found');}
  vi.stubEnv('VERCEL_ENV','preview');expect(Page().type).toBe(WeeklyFinanceWalkthrough);
 });
 it('starts without fabricated records and calculates user-entered examples locally',()=>{
  render(React.createElement(WeeklyFinanceWalkthrough));expect(screen.getByText(/does not create payroll/)).toBeTruthy();
  expect(screen.getByText(/Enter a rate and at least one worked day/)).toBeTruthy();
  change('Daily rate (₱)','600');change('Tuesday regular hours','8');change('Tuesday overtime hours','2');change('Approved allowance (₱)','50.25');change('Wednesday Bale (₱)','100.25');
  expect(screen.getByText('Wages ₱750.00')).toBeTruthy();expect(screen.getByText('Gross ₱800.25')).toBeTruthy();expect(screen.getByText('Illustrative net ₱700.00')).toBeTruthy();
  expect((screen.getByRole('button',{name:'Record external payment'}) as HTMLButtonElement).disabled).toBe(true);
  change('Wednesday Bale (₱)','900');expect(screen.getByText('Net withheld — review')).toBeTruthy();expect(screen.getByText(/Bale exceeds estimated earnings/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Clear example'}));expect((screen.getByLabelText('Daily rate (₱)') as HTMLInputElement).value).toBe('');expect(screen.getByText(/Enter a rate and at least one worked day/)).toBeTruthy();
 });
 it('rejects bad values and does not mistake blank days for absence',()=>{
  const days=blank();days[1]={regular:'8',overtime:'2'};
  const input={date:'2026-11-18',rate:'600',days,allowance:'50.25',bale:'100.25'};
  const {row}=calculateWeeklyWalkthrough(input);expect(row.net).toBe('700.00');expect(row.pastUnmarked).toBe(true);expect(row.days[0].unmarked).toBe('past');
  expect(()=>calculateWeeklyWalkthrough({...input,rate:'-1'})).toThrow();expect(()=>calculateWeeklyWalkthrough({...input,rate:''})).toThrow(/daily rate/);
  expect(()=>calculateWeeklyWalkthrough({...input,days:days.map((v,i)=>i===1?{regular:'9',overtime:'0'}:v)})).toThrow(/cannot exceed 8/);
  expect(()=>calculateWeeklyWalkthrough({...input,days:blank(),allowance:'1'})).toThrow(/worked day/);
 });
});
