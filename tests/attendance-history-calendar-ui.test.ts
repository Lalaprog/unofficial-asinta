// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
import {AttendanceHistoryCalendar} from '@/components/attendance/AttendanceHistoryCalendar';
const filters={projectId:'all',status:'all',date:'',search:''};
const deferred=()=>{let resolve!:(data:unknown)=>void;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
beforeEach(()=>mock.rpc.mockReset());afterEach(()=>cleanup());
describe('attendance history calendar',()=>{
 it('uses filters for counts and selecting a date updates history without declaring absences',async()=>{
  mock.rpc.mockResolvedValue({data:[{date:'2026-10-12',count:3}],error:null});const select=vi.fn();
  render(React.createElement(AttendanceHistoryCalendar,{userId:'supervisor',today:'2026-10-12',filters:{...filters,projectId:'site',status:'present',search:'mason'},settling:false,revision:0,onSelectDate:select}));
  await screen.findAllByText('3 rec.');expect(mock.rpc).toHaveBeenCalledWith('attendance_history_calendar',{p_month:'2026-10-01',p_project_id:'site',p_status:'present',p_search:'mason'});
  fireEvent.click(screen.getAllByRole('button',{name:/October 12, 2026, 3 matching records/})[0]);expect(select).toHaveBeenCalledWith('2026-10-12');
  expect(screen.getByText(/Blank means no matching records, not absence/)).toBeTruthy();
 });
 it('supports month and mobile week navigation, selected-date clearing and blocks future days',async()=>{
  mock.rpc.mockResolvedValue({data:[],error:null});const select=vi.fn();
  const {rerender}=render(React.createElement(AttendanceHistoryCalendar,{userId:'f',today:'2026-10-12',filters:{...filters,date:'2026-10-01'},settling:false,revision:0,onSelectDate:select}));
  await waitFor(()=>expect(mock.rpc).toHaveBeenCalled());fireEvent.click(screen.getByRole('button',{name:'Next week'}));fireEvent.click(screen.getByRole('button',{name:'Next week'}));
  await waitFor(()=>expect(screen.getByRole('button',{name:'Next week'}).matches(':disabled')).toBe(true));
  fireEvent.click(screen.getByRole('button',{name:'Show all dates'}));expect(select).toHaveBeenCalledWith('');
  rerender(React.createElement(AttendanceHistoryCalendar,{userId:'f',today:'2026-10-12',filters:filters,settling:false,revision:0,onSelectDate:select}));
  fireEvent.click(screen.getByRole('button',{name:'Previous month'}));expect(await screen.findByText('September 2026')).toBeTruthy();
  const calendar=screen.getByRole('region',{name:'Attendance history calendar'});expect(within(calendar).getByRole('button',{name:'Next month'}).matches(':disabled')).toBe(false);
 });
 it('discards stale responses and shows errors instead of false zeroes',async()=>{
  const stale=deferred();mock.rpc.mockReturnValueOnce(stale.promise).mockResolvedValueOnce({data:null,error:{message:'offline'}}).mockResolvedValueOnce({data:[],error:null});
  const view=render(React.createElement(AttendanceHistoryCalendar,{userId:'f',today:'2026-10-12',filters:{...filters,projectId:'old'},settling:false,revision:0,onSelectDate:vi.fn()}));
  view.rerender(React.createElement(AttendanceHistoryCalendar,{userId:'f',today:'2026-10-12',filters:{...filters,projectId:'new'},settling:false,revision:0,onSelectDate:vi.fn()}));
  expect((await screen.findByRole('alert')).textContent).toContain('Calendar could not be loaded');
  await act(async()=>stale.resolve({data:[{date:'2026-10-12',count:99}],error:null}));expect(screen.queryByText('99 rec.')).toBeNull();expect(screen.queryByLabelText(/no matching records/)).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Retry calendar'}));await waitFor(()=>expect(screen.queryByRole('alert')).toBeNull());expect(mock.rpc).toHaveBeenCalledTimes(3);
 });
 it('does not query or show stale counts while a search is settling',async()=>{
  mock.rpc.mockResolvedValue({data:[{date:'2026-10-12',count:5}],error:null});
  const view=render(React.createElement(AttendanceHistoryCalendar,{userId:'f',today:'2026-10-12',filters:filters,settling:false,revision:0,onSelectDate:vi.fn()}));await screen.findAllByText('5 rec.');
  view.rerender(React.createElement(AttendanceHistoryCalendar,{userId:'f',today:'2026-10-12',filters:filters,settling:true,revision:0,onSelectDate:vi.fn()}));
  expect(screen.queryByText('5 rec.')).toBeNull();expect(screen.getByText('Updating calendar filters…')).toBeTruthy();expect(mock.rpc).toHaveBeenCalledTimes(1);
 });
});
