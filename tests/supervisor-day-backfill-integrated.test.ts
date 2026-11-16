// @vitest-environment jsdom
import React from 'react';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const mock=vi.hoisted(()=>({rpc:vi.fn()}));vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
import {SupervisorDayBackfill} from '@/components/attendance/SupervisorDayBackfill';
const founder='00000000-0000-0000-0000-000000000001',supervisor='00000000-0000-0000-0000-000000000002';
afterEach(()=>{cleanup();sessionStorage.clear();vi.restoreAllMocks();});
describe('Founder daily backfill UI and database',()=>{
 it('retries a committed response loss exactly after navigation, then uses the existing approval queue',async()=>{const db=new PGlite();try{
  await db.exec(baseFixture);for(const p of ['supervisor_table_foundation','supervisor_rpc_rollout','supervisor_day_founder_backfill'])await db.exec(`BEGIN;${readFileSync(`supabase/drafts/${p}.sql`,'utf8')} COMMIT;`);await db.exec(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);
  let lost=true;mock.rpc.mockReset().mockImplementation(async(name:string,a:Record<string,unknown>={})=>{try{let result;
   if(name==='supervisor_day_backfill_catalog')result=await db.query<{v:unknown}>('SELECT public.supervisor_day_backfill_catalog() v');
   else if(name==='supervisor_day_backfill_lookup')result=await db.query<{v:unknown}>('SELECT public.supervisor_day_backfill_lookup($1) v',[a.p_id]);
   else if(name==='record_supervisor_day_backfill'){result=await db.query<{v:unknown}>('SELECT public.record_supervisor_day_backfill($1,$2,$3,$4,$5) v',[a.p_id,a.p_supervisor,a.p_date,a.p_work_status,a.p_reason]);if(lost){lost=false;return {data:null,error:Error('lost response')};}}
   else throw Error('unexpected call');return {data:result.rows[0].v,error:null};
  }catch(error){return {data:null,error};}});
  render(React.createElement(SupervisorDayBackfill,{userId:founder}));fireEvent.click(screen.getByRole('button',{name:'Load Supervisors'}));await screen.findByRole('option',{name:'Supervisor'});
  fireEvent.change(screen.getByLabelText('Supervisor'),{target:{value:supervisor}});fireEvent.change(screen.getByLabelText('Backfill work date'),{target:{value:'2024-08-04'}});fireEvent.change(screen.getByLabelText('Backfill work status'),{target:{value:'half_day'}});fireEvent.change(screen.getByLabelText('Reason or source for backfill'),{target:{value:'Reviewed paper attendance'}});fireEvent.click(screen.getByRole('checkbox',{name:/checked the original record/}));fireEvent.click(screen.getByRole('button',{name:'Record pending day'}));await screen.findByText(/Outcome unconfirmed/);
  const stored=sessionStorage.getItem(`supervisor-day-backfill:${founder}`);expect(stored).toContain('Reviewed paper attendance');cleanup();render(React.createElement(SupervisorDayBackfill,{userId:founder}));await screen.findByText(/Unconfirmed request/);fireEvent.click(screen.getByRole('button',{name:'Retry same request'}));await screen.findByText(/Daily record verified as pending/);
  const calls=mock.rpc.mock.calls.filter(c=>c[0]==='record_supervisor_day_backfill');expect(calls).toHaveLength(2);expect(calls[0][1]).toEqual(calls[1][1]);expect(sessionStorage.getItem(`supervisor-day-backfill:${founder}`)).toBeNull();
  const id=calls[0][1].p_id;const list=(await db.query<{v:{items:{id:string;status:string}[]}}>('SELECT public.supervisor_day_list(0) v')).rows[0].v;expect(list.items).toEqual(expect.arrayContaining([expect.objectContaining({id,status:'pending'})]));await db.query("SELECT public.review_supervisor_day($1,'approved')",[id]);
  await db.exec('RESET ROLE');expect((await db.query('SELECT count(*)::int n FROM public.supervisor_day_founder_backfills')).rows[0]).toEqual({n:1});expect((await db.query<{status:string}>('SELECT status FROM public.supervisor_daily_attendance WHERE id=$1',[id])).rows[0].status).toBe('approved');
 }finally{cleanup();await db.close();}},30000);
 it('does not send when retry storage is unavailable',async()=>{
  mock.rpc.mockResolvedValue({data:{supervisors:[{id:supervisor,name:'Supervisor'}]},error:null});render(React.createElement(SupervisorDayBackfill,{userId:founder}));fireEvent.click(screen.getByRole('button',{name:'Load Supervisors'}));await screen.findByRole('option',{name:'Supervisor'});
  fireEvent.change(screen.getByLabelText('Supervisor'),{target:{value:supervisor}});fireEvent.change(screen.getByLabelText('Backfill work date'),{target:{value:'2024-08-04'}});fireEvent.change(screen.getByLabelText('Reason or source for backfill'),{target:{value:'Paper record'}});fireEvent.click(screen.getByRole('checkbox',{name:/checked the original record/}));vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('quota')});fireEvent.click(screen.getByRole('button',{name:'Record pending day'}));await screen.findByText(/no request was sent/);expect(mock.rpc.mock.calls.filter(c=>c[0]==='record_supervisor_day_backfill')).toHaveLength(0);
 });
});
