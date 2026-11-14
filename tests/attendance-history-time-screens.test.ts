// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:'founder'},isFounder:true,isSupervisor:false,assurance:'ready'})}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
vi.mock('next/link',()=>({default:({children,href}:{children:React.ReactNode;href:string})=>React.createElement('a',{href},children)}));
const row={id:'a',worker_id:'w',project_id:'site',date:'2024-11-03',status:'present',hours_worked:8,submitted_at:'2024-11-03T08:00:00+00:00',is_supervisor:false,is_founder_override:false,worker_name:'Ada',worker_position:'Mason',project_name:'Site',notes:''};
vi.mock('@/lib/attendance/useAttendanceHistory',()=>({useAttendanceHistory:()=>({items:[row],error:null,loading:false,hasMore:false,retry:vi.fn(),loadMore:vi.fn()})}));
vi.mock('@/components/attendance/TimeDetailDialog',()=>({TimeDetailDialog:({onClose}:{onClose:()=>void})=>React.createElement('button',{onClick:onClose},'Close mocked detail')}));
import {HistorySheetRecords} from '@/components/attendance/HistorySheetRecords';
import {ProjectWorkforceLogs} from '@/components/projects/ProjectWorkforceLogs';
beforeEach(()=>{vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_ATTENDANCE_TIME_HISTORY_PREVIEW','true');mock.rpc.mockReset();mock.rpc.mockImplementation(async(name:string)=>name==='project_attendance_calendar'?{data:[],error:null}:{data:{items:[{...row,detail:{regular_hours:'8.00',overtime_hours:'2.50',stale:false}}]},error:null});});afterEach(()=>{cleanup();vi.unstubAllEnvs();delete (row as Record<string,unknown>).entry_craft;delete (row as Record<string,unknown>).entry_craft_at;});
describe('time detail screen integration',()=>{
 it('shows regular/OT on expanded Attendance History and reloads when the editor closes',async()=>{
  render(React.createElement(HistorySheetRecords,{sheet:{date:row.date,project_id:'site',project_name:'Site',record_count:1,present_count:1,half_day_count:0,absent_count:0,leave_count:0,pending_count:0},filters:{projectId:'site',status:'all',date:row.date,search:''},userId:'founder',revision:0,isFounder:true,reviewing:false,onReview:vi.fn(),onEdit:vi.fn()}));
  expect(screen.getByText(/Current craft: Mason; historical craft not recorded/)).toBeTruthy();await screen.findByText('Regular 8.00 h · OT 2.50 h');fireEvent.click(screen.getByRole('button',{name:'Regular / OT'}));fireEvent.click(screen.getByRole('button',{name:'Close mocked detail'}));await screen.findByText('Regular 8.00 h · OT 2.50 h');expect(mock.rpc.mock.calls.filter(c=>c[0]==='attendance_history_time_batch')).toHaveLength(2);
 });
 it('labels saved craft as the value observed at entry, not as proof of the work-date craft',()=>{
  Object.assign(row,{worker_position:'Lead Mason',entry_craft:'Mason',entry_craft_at:'2026-11-14T02:00:00Z'});
  const view=render(React.createElement(HistorySheetRecords,{sheet:{date:row.date,project_id:'site',project_name:'Site',record_count:1,present_count:1,half_day_count:0,absent_count:0,leave_count:0,pending_count:0},filters:{projectId:'site',status:'all',date:row.date,search:''},userId:'founder',revision:0,isFounder:true,reviewing:false,onReview:vi.fn(),onEdit:vi.fn()}));
  expect(screen.getByText(/Craft at entry: Mason; may differ from work date/)).toBeTruthy();view.unmount();
  render(React.createElement(ProjectWorkforceLogs,{projectId:'site',userId:'founder'}));expect(screen.getByText(/Craft at entry: Mason \(may differ from work date\)/)).toBeTruthy();row.worker_position='Mason';
 });
 it('also shows the details on Project Workforce Logs and refreshes with the log',async()=>{
  render(React.createElement(ProjectWorkforceLogs,{projectId:'site',userId:'founder'}));expect(screen.getByText(/Current craft: Mason \(historical craft not recorded\)/)).toBeTruthy();await screen.findByText('Regular 8.00 h · OT 2.50 h');fireEvent.click(screen.getByRole('button',{name:'Refresh logs'}));await screen.findByText('Regular 8.00 h · OT 2.50 h');expect(mock.rpc.mock.calls.filter(c=>c[0]==='attendance_history_time_batch')).toHaveLength(2);
 });
});
