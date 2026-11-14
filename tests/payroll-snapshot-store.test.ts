// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const mock=vi.hoisted(()=>({snapshot:null as unknown,error:null as null|{message:string},writes:[] as Array<{kind:string,payload:any,filters:unknown[]}>,toast:vi.fn(),audit:vi.fn()}));
vi.mock('@/lib/attendance/loadBaleRequests',()=>({loadBaleRequests:async()=>({data:[],coverage:{openOmitted:0,historyOmitted:0}})}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({
  rpc:(name:string)=>name==='visible_projects' ? {order:async()=>({data:[],error:null})} : Promise.resolve({data:mock.snapshot,error:mock.error}),
  from:(table:string)=>({
    select:()=>({order:async()=>({data:[],error:null}),then:(resolve:(v:unknown)=>void)=>resolve({data:[],error:null})}),
    insert:(payload:any[])=>({select:async()=>{mock.writes.push({kind:'insert',payload,filters:[]});return {data:payload.map((p,i)=>({...p,id:`new-${i}`})),error:null}}}),
    update:(payload:any)=>{const filters:Array<[string,unknown]>=[];const builder={eq:(key:string,value:unknown)=>{filters.push([key,value]);return builder},select:()=>({single:async()=>{mock.writes.push({kind:'update',payload,filters});return {data:{...mock.snapshot as any,payload,...payload,id:filters[0]?.[1]},error:null}}})};return builder},
  }),
})}));
vi.mock('@/lib/auth/authContext',()=>{const user={id:'founder',email:'founder@test',role:'founder'};return {useAuth:()=>({assurance:'ready',user,isFounder:true,authLoading:false})}});
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:mock.toast})}));
vi.mock('@/lib/audit/log',()=>({writeAuditEntry:async (...args:unknown[])=>{mock.audit(...args);return {ok:true}},auditFailureMessage:()=>''}));
import {DataStoreProvider,useDataStore} from '@/lib/data/store';
let current:ReturnType<typeof useDataStore>;
function Probe(){current=useDataStore();return null}
const worker={id:'w',name:'Mason',position:'Mason',active:true,pay_rate:800,pay_rate_type:'daily'};
const attendance={id:'a',worker_id:'w',project_id:'p',date:'2026-10-10',status:'present',hours_worked:8,notes:null,recorded_by:'founder',is_founder_override:false};
const snapshot=()=>({attendance:[attendance],workers:[worker],projects:[{id:'p',name:'Site'}],users:[],advances:[{id:'b',worker_id:'w',project_id:'p',amount:100,amount_deducted:0,status:'active'}],payroll:[] as any[]});
beforeEach(()=>{mock.snapshot=snapshot();mock.error=null;mock.writes=[];mock.toast.mockReset();mock.audit.mockReset();window.sessionStorage.clear()});
afterEach(()=>cleanup());
async function setup(){render(React.createElement(DataStoreProvider,null,React.createElement(Probe)));await waitFor(()=>expect(current.isLoaded).toBe(true))}
describe('payroll run server inputs',()=>{
  it('uses records absent from the shared store to create the calculated voucher',async()=>{await setup();expect(current.attendance).toHaveLength(0);await act(async()=>{await current.createPayrollRun('2026-10-01','2026-10-15','all')});expect(mock.writes).toHaveLength(1);expect(mock.writes[0].payload[0]).toMatchObject({worker_id:'w',gross_pay:800,bale_deduction:100,net_pay:700});});
  it('fails closed when the RPC fails or returns a malformed response',async()=>{await setup();mock.error={message:'missing function'};await act(async()=>{expect(await current.createPayrollRun('2026-10-01','2026-10-15','all')).toBeNull()});expect(mock.writes).toHaveLength(0);mock.error=null;mock.snapshot={};await act(async()=>{expect(await current.createPayrollRun('2026-10-01','2026-10-15','all')).toBeNull()});expect(mock.writes).toHaveLength(0);});
  it('uses server vouchers to recalculate rather than duplicate, preserving other deductions and guarding status changes',async()=>{const data=snapshot();data.payroll.push({id:'v',worker_id:'w',period_start:'2026-10-01',period_end:'2026-10-15',gross_pay:100,bale_deduction:0,other_deductions:50,net_pay:50,status:'draft'});mock.snapshot=data;await setup();await act(async()=>{await current.createPayrollRun('2026-10-01','2026-10-15','all')});expect(mock.writes).toHaveLength(1);expect(mock.writes[0]).toMatchObject({kind:'update',payload:{gross_pay:800,bale_deduction:100,net_pay:650},filters:[['id','v'],['status','draft']]});});
  it('holds unverified supervisors and skips approved server vouchers',async()=>{
    const data=snapshot();data.users.push({id:'supervisor',name:'  Mason  ',role:'supervisor'} as never);mock.snapshot=data;
    await setup();await act(async()=>{await current.createPayrollRun('2026-10-01','2026-10-15','all')});expect(mock.writes).toHaveLength(0);expect(mock.toast).toHaveBeenCalledWith('info',expect.stringContaining('verification'));
    data.users=[];data.payroll.push({id:'v',worker_id:'w',period_start:'2026-10-01',period_end:'2026-10-15',other_deductions:0,status:'approved'});mock.toast.mockReset();
    await act(async()=>{await current.createPayrollRun('2026-10-01','2026-10-15','all')});expect(mock.writes).toHaveLength(0);expect(mock.toast).toHaveBeenCalledWith('info',expect.stringContaining('approved/paid'));
  });

});
