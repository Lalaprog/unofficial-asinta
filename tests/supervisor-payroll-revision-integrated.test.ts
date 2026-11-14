// @vitest-environment jsdom
// UI -> synthetic PGlite RPC only. No real accounts, transfers or records.
import React from 'react';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const mock=vi.hoisted(()=>({rpc:vi.fn(),today:'',actor:''}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:mock.actor},isFounder:true,assurance:'ready'})}));
vi.mock('@/lib/reminders/scheduler',()=>({getManilaClock:()=>({dateIso:mock.today})}));
vi.mock('@/lib/dates/useManilaToday',()=>({useManilaToday:()=>mock.today}));
import {SupervisorPayrollLedger} from '@/components/payroll/SupervisorPayrollLedger';
const founder='00000000-0000-0000-0000-000000000001',sup='00000000-0000-0000-0000-000000000002';
const id=(n:number)=>`77000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sql=(name:string)=>readFileSync(`supabase/drafts/${name}.sql`,'utf8');
afterEach(()=>{cleanup();sessionStorage.clear();vi.unstubAllEnvs();vi.restoreAllMocks();});
async function fixture(){
 const db=new PGlite();await db.exec(baseFixture);for(const name of ['supervisor_table_foundation','supervisor_rpc_rollout','supervisor_payroll_preview','supervisor_payroll_ledger'])await db.exec(`BEGIN; ${sql(name)} COMMIT;`);
 await db.exec(`INSERT INTO public.workers VALUES ('${sup}','Supervisor','Supervisor','none',600,'daily',true);SET test.assurance='yes';SET test.uid='${sup}';SET ROLE authenticated`);
 await db.query("SELECT public.submit_supervisor_day($1,'2024-12-01','present')",[id(1)]);await db.exec(`SET test.uid='${founder}'`);await db.query("SELECT public.review_supervisor_day($1,'approved')",[id(1)]);
 const p=(await db.query<{v:unknown}>("SELECT public.supervisor_period_prepare($1,'2024-12-01') v",[sup])).rows[0].v;
 await db.query("SELECT public.create_supervisor_period_draft($1,$2,'2024-12-01',600,$3)",[id(10),sup,JSON.stringify(p)]);await db.query("SELECT public.transition_supervisor_period_payroll($1,$2,'approved',NULL,true)",[id(11),id(10)]);
 await db.exec(`RESET ROLE; BEGIN; ${sql('supervisor_payroll_revision')} COMMIT; SET ROLE authenticated`);
 const now=(await db.query<{d:string}>("SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Manila')::date)::text d")).rows[0].d;return {db,now};
}
describe('Supervisor revision UI and synthetic SQL',()=>{
 it('returns an approval, refreshes a draft, safely retries a lost response and approves only the new revision',async()=>{
  vi.stubEnv('NEXT_PUBLIC_DEVELOPMENT_FINANCE_CUTOVER','true');vi.stubEnv('NEXT_PUBLIC_SUPERVISOR_PAYROLL_REVISION_PREVIEW','true');const {db,now}=await fixture();mock.today=now;mock.actor=founder;let loseRefresh=true;
  vi.spyOn(crypto,'randomUUID').mockReturnValueOnce(id(12)).mockReturnValueOnce(id(13)).mockReturnValueOnce(id(14));
  mock.rpc.mockReset();mock.rpc.mockImplementation(async(name:string,args:Record<string,unknown>={})=>{try{
   const calls:Record<string,{q:string;p:unknown[]}>= {
    supervisor_payroll_preview_catalog:{q:'SELECT public.supervisor_payroll_preview_catalog() v',p:[]},
    supervisor_period_prepare:{q:'SELECT public.supervisor_period_prepare($1,$2) v',p:[args.p_supervisor,args.p_start]},
    supervisor_period_payroll_review_v2:{q:'SELECT public.supervisor_period_payroll_review_v2($1,$2) v',p:[args.p_supervisor,args.p_start]},
    supervisor_payroll_revision_action:{q:'SELECT public.supervisor_payroll_revision_action($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) v',p:[args.p_request,args.p_id,args.p_revision,args.p_action,args.p_rate,args.p_expected===null?null:JSON.stringify(args.p_expected),args.p_reason,args.p_paid_on,args.p_ack]},
   };const call=calls[name];if(!call)throw Error('unexpected RPC');const data=(await db.query<{v:unknown}>(call.q,call.p)).rows[0].v;
   if(name==='supervisor_payroll_revision_action'&&args.p_action==='refresh'&&loseRefresh){loseRefresh=false;return {data:null,error:Error('lost response after commit')};}return {data,error:null};
  }catch(error){return {data:null,error};}});
  try{
   render(React.createElement(SupervisorPayrollLedger));fireEvent.click(screen.getByRole('button',{name:'Experimental Supervisor payroll ledger'}));fireEvent.click(screen.getByRole('button',{name:'Load Supervisors'}));await screen.findByLabelText('Supervisor for payroll ledger');fireEvent.change(screen.getByLabelText('Supervisor for payroll ledger'),{target:{value:sup}});fireEvent.change(screen.getByLabelText('Date in Supervisor payroll period'),{target:{value:'2024-12-01'}});
   const load=async()=>{fireEvent.click(screen.getByRole('button',{name:'Review Supervisor period and ledger'}));await screen.findByText(/Reviewed identity:/);};
   const confirm=()=>{const dialog=screen.getByRole('dialog');fireEvent.click(within(dialog).getByRole('checkbox'));fireEvent.click(within(dialog).getByRole('button',{name:'Confirm action'}));};
   await load();fireEvent.change(screen.getByLabelText('Reason for Supervisor payroll revision'),{target:{value:'Verified unpaid'}});fireEvent.click(screen.getByRole('button',{name:'Review return to draft'}));confirm();await screen.findByText(/Action recorded/);
   await load();fireEvent.change(screen.getByLabelText('Reason for Supervisor payroll revision'),{target:{value:'Corrected rate'}});fireEvent.change(screen.getByLabelText('Revised daily rate in pesos'),{target:{value:'650'}});fireEvent.click(screen.getByRole('button',{name:'Review draft refresh'}));confirm();await screen.findByText(/Outcome not verified/);fireEvent.click(screen.getByRole('button',{name:'Retry exact request'}));await screen.findByText(/Action recorded/);
   await load();expect(screen.getByText(/gross ₱650.00/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Review approval'}));confirm();await screen.findByText(/Action recorded/);
   await db.exec('RESET ROLE');expect((await db.query<{status:string;revision:string;gross:string}>("SELECT status,revision::text,gross::text FROM public.supervisor_period_payroll WHERE id=$1",[id(10)])).rows[0]).toEqual({status:'approved',revision:'3',gross:'650.00'});
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.supervisor_payroll_revision_events WHERE request_id=$1',[id(13)])).rows[0].n).toBe(1);
   const calls=mock.rpc.mock.calls.filter(([name,args])=>name==='supervisor_payroll_revision_action'&&args.p_action==='refresh');expect(calls).toHaveLength(2);expect(calls[0][1]).toEqual(calls[1][1]);
  }finally{await db.close();}
 },30000);
});
