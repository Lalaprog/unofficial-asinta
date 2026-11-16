import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const founder='00000000-0000-0000-0000-000000000001',sup='00000000-0000-0000-0000-000000000002',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004';
const id=(n:number)=>`90000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sql=readFileSync('supabase/drafts/historical_external_worker_payroll.sql','utf8');
describe('uninstalled external historical worker payroll assertion',()=>{
 it('records immutable evidence without creating vouchers or advances and blocks duplicate finance paths',async()=>{
  const db=new PGlite();try{
   await db.exec(baseFixture);const before=(await db.query<{v:unknown}>("SELECT jsonb_build_object('payroll',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.payroll p),'advances',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.advances a),'expenses',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.expenses e)) v")).rows[0].v;
   await db.exec(`BEGIN; ${sql} COMMIT;`);await expect(db.exec(`BEGIN; ${sql} COMMIT;`)).rejects.toThrow(/collision/);await db.exec('ROLLBACK');
   await db.exec(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'`);
   const review=async()=>(await db.query<{v:{worker:unknown;overlapping_vouchers:number;period_advances:number;older_open_advances:number;existing_assertions:number;possible_supervisor:boolean}}>("SELECT public.historical_external_worker_review($1,'2024-11-03') v",[worker])).rows[0].v;
   const seen=await review();expect(seen).toMatchObject({overlapping_vouchers:0,period_advances:0,older_open_advances:0,existing_assertions:0,possible_supervisor:false,possible_worker_duplicate:false});
   expect((await db.query<{v:{workers:{id:string}[]}}>('SELECT public.historical_external_worker_catalog() v')).rows[0].v.workers.some(w=>w.id===worker)).toBe(true);
   expect((await db.query<{v:unknown}>('SELECT public.historical_external_worker_lookup($1) v',[id(1)])).rows[0].v).toBeNull();
   const call=(key:string,overrides:Partial<{gross:string;bale:string;other:string;net:string;note:string;expected:unknown;ack:boolean}>={})=>db.query<{v:{request_id:string;replayed:boolean}}>("SELECT public.record_historical_external_worker_payroll($1,$2,'2024-11-03','2024-11-09',$3,$4,$5,$6,$7,$8,$9) v",[key,worker,overrides.gross??'1000.25',overrides.bale??'100.25',overrides.other??'50',overrides.net??'850',overrides.note??'Original payroll book',JSON.stringify(overrides.expected??seen.worker),overrides.ack??true]);
   await expect(call(id(1),{ack:false})).rejects.toThrow(/confirmation/);await expect(call(id(1),{net:'850.01'})).rejects.toThrow(/reconcile/);await expect(call(id(1),{gross:'1000.251'})).rejects.toThrow(/monetary/);await expect(call(id(1),{expected:{}})).rejects.toThrow(/Worker changed/);
   expect((await call(id(1))).rows[0].v).toEqual({request_id:id(1),replayed:false});expect((await call(id(1))).rows[0].v.replayed).toBe(true);await expect(call(id(1),{note:'Different note'})).rejects.toThrow(/different evidence/);await expect(call(id(2))).rejects.toThrow(/reconciliation/);
   expect((await review()).existing_assertions).toBe(1);
   const list=(await db.query<{v:{total:number;items:{gross:string;bale:string;net:string;period_end:string}[]}}>('SELECT public.historical_external_worker_list($1,0) v',[worker])).rows[0].v;expect(list.total).toBe(1);expect(list.items[0]).toMatchObject({gross:'1000.25',bale:'100.25',net:'850.00',period_end:'2024-11-09'});
   expect((await db.query<{v:unknown}>('SELECT public.historical_external_worker_lookup($1) v',[id(1)])).rows[0].v).toEqual(list.items[0]);
   await expect(db.query('SELECT * FROM public.historical_external_worker_payroll')).rejects.toThrow(/permission denied/);
   await db.exec(`SET test.uid='${sup}'`);await expect(review()).rejects.toThrow(/Founder/);await expect(db.query('SELECT public.historical_external_worker_catalog()')).rejects.toThrow(/Founder/);await expect(db.query('SELECT public.historical_external_worker_lookup($1)',[id(1)])).rejects.toThrow(/Founder/);await db.exec(`SET test.uid='${founder}'; SET test.assurance='no'`);await expect(review()).rejects.toThrow(/Founder/);await expect(db.query('SELECT public.historical_external_worker_lookup($1)',[id(1)])).rejects.toThrow(/Founder/);
   await db.exec('RESET ROLE');
   await expect(db.query("INSERT INTO public.payroll(id,worker_id,period_start,period_end,status) VALUES($1,$2,'2024-11-06','2024-11-12','draft')",[id(3),worker])).rejects.toThrow(/Historical external payroll evidence/);
   await expect(db.query("INSERT INTO public.advances(id,worker_id,project_id,date,amount,amount_deducted,status) VALUES($1,$2,$3,'2024-11-06',100,0,'active')",[id(4),worker,site])).rejects.toThrow(/Historical external payroll evidence/);
   await expect(db.query("INSERT INTO public.advances(id,worker_id,project_id,date,amount,amount_deducted,status) VALUES($1,$2,$3,'2024-10-30',100,0,'active')",[id(5),worker,site])).rejects.toThrow(/older open balance/);
   await expect(db.query('UPDATE public.historical_external_worker_payroll SET net=0')).rejects.toThrow(/immutable/);await expect(db.query('DELETE FROM public.historical_external_worker_events')).rejects.toThrow(/immutable/);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.historical_external_worker_events')).rows[0].n).toBe(1);
   expect((await db.query<{v:unknown}>("SELECT jsonb_build_object('payroll',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.payroll p),'advances',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.advances a),'expenses',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.expenses e)) v")).rows[0].v).toEqual(before);
  }finally{await db.close();}
 },30000);
 it('fails closed on existing finance, stale identity and failed audit event',async()=>{
  const db=new PGlite();try{
   await db.exec(baseFixture);await db.exec(`BEGIN; ${sql} COMMIT;`);await db.exec(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'`);
   const review=async()=>(await db.query<{v:{worker:unknown}}>("SELECT public.historical_external_worker_review($1,'2024-11-03') v",[worker])).rows[0].v.worker;
   const expected=await review();const call=(key:string)=>db.query("SELECT public.record_historical_external_worker_payroll($1,$2,'2024-11-03','2024-11-09',600,0,0,600,'Original ledger',$3,true)",[key,worker,JSON.stringify(expected)]);
   await db.exec(`RESET ROLE; INSERT INTO public.advances VALUES ('${id(10)}','${worker}','${site}','2024-11-06',100,0,'active'); SET ROLE authenticated`);await expect(call(id(11))).rejects.toThrow(/reconciliation/);
   await db.exec(`RESET ROLE; DELETE FROM public.advances WHERE id='${id(10)}'; INSERT INTO public.workers(id,name,position,active) SELECT '${id(12)}',name,position,true FROM public.workers WHERE id='${worker}'; SET ROLE authenticated`);await expect(call(id(11))).rejects.toThrow(/duplicate worker identity/);
   await db.exec(`RESET ROLE; DELETE FROM public.workers WHERE id='${id(12)}'; UPDATE public.workers SET name='Changed' WHERE id='${worker}'; SET ROLE authenticated`);await expect(call(id(11))).rejects.toThrow(/Worker changed/);
   await db.exec(`RESET ROLE; UPDATE public.workers SET name='Test Worker' WHERE id='${worker}'; ALTER TABLE public.historical_external_worker_events ADD CONSTRAINT reject_test_event CHECK(action<>'recorded') NOT VALID; SET ROLE authenticated`);
   await expect(call(id(11))).rejects.toThrow(/reject_test_event/);await db.exec('RESET ROLE');expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.historical_external_worker_payroll')).rows[0].n).toBe(0);expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.historical_external_worker_events')).rows[0].n).toBe(0);
  }finally{await db.close();}
 },30000);
});
