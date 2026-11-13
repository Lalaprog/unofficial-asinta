// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
import {WeeklyBaleExpiryHealth} from '@/components/advances/WeeklyBaleExpiryHealth';
import {parseWeeklyBaleHealth} from '@/lib/attendance/weeklyBaleHealth';
import {weeklyBaleExpiryHealthPreviewEnabled} from '@/lib/finance/featureAvailability';
const healthy={checked_at:'2026-11-18T04:01:00Z',last_success:'2026-11-18T04:00:00Z',last_processed:1,last_remaining_due:0,current_remaining_due:0,healthy:true};
beforeEach(()=>mock.rpc.mockReset());afterEach(()=>{cleanup();vi.unstubAllEnvs();});
describe('expiry health candidate',()=>{
 it('requires all three display flags',()=>{
  vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_WEEKLY_BALE_RELEASE_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_WEEKLY_BALE_EXPIRY_HEALTH_PREVIEW','false');expect(weeklyBaleExpiryHealthPreviewEnabled()).toBe(false);
  vi.stubEnv('NEXT_PUBLIC_WEEKLY_BALE_EXPIRY_HEALTH_PREVIEW','true');expect(weeklyBaleExpiryHealthPreviewEnabled()).toBe(true);
  vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','false');expect(weeklyBaleExpiryHealthPreviewEnabled()).toBe(false);
 });
 it('checks on demand, warns about stale observations, and fails closed',async()=>{
  mock.rpc.mockResolvedValueOnce({data:healthy,error:null}).mockResolvedValueOnce({data:{...healthy,current_remaining_due:2},error:null});
  render(React.createElement(WeeklyBaleExpiryHealth,{userId:'founder'}));expect(mock.rpc).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Check expiry worker'}));
  await screen.findByText(/Recent successful run/);expect(screen.getByText(/observation can become stale/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Check expiry worker'}));expect((await screen.findByRole('alert')).textContent).toMatch(/Do not assume/);expect(screen.queryByText(/Recent successful run/)).toBeNull();
 });
 it('clears data on identity changes and ignores an old response',async()=>{
  let resolve!:(value:unknown)=>void;mock.rpc.mockReturnValue(new Promise(r=>{resolve=r;}));const view=render(React.createElement(WeeklyBaleExpiryHealth,{userId:'one'}));
  fireEvent.click(screen.getByRole('button',{name:'Check expiry worker'}));view.rerender(React.createElement(WeeklyBaleExpiryHealth,{userId:'two'}));resolve({data:healthy,error:null});
  await Promise.resolve();expect(screen.queryByText(/Recent successful run/)).toBeNull();
 });
 it('rejects contradictory and stale healthy payloads',()=>{
  expect(parseWeeklyBaleHealth(healthy)).toEqual(healthy);
  expect(()=>parseWeeklyBaleHealth({...healthy,last_success:null})).toThrow();expect(()=>parseWeeklyBaleHealth({...healthy,checked_at:'2026-11-18T04:04:00Z'})).toThrow();
 });
});
