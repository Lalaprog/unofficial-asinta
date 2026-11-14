import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const founder='00000000-0000-0000-0000-000000000001',sup='00000000-0000-0000-0000-000000000002',worker='00000000-0000-0000-0000-000000000003';
const id=(n:number)=>`81000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sql=(n:string)=>readFileSync(`supabase/drafts/${n}.sql`,'utf8');
async function setup(){const db=new PGlite();await db.exec(baseFixture);await db.exec('ALTER ROLE service_role BYPASSRLS');await db.exec(`BEGIN; ${sql('worker_category_catalog')} ${sql('worker_category_workforce_cutover')} COMMIT;`);return db;}
describe('coordinated worker category integration (synthetic only)',()=>{
 it('maps legacy workers, enforces active categories, preserves payroll and syncs renamed groups',async()=>{const db=await setup();try{
  const before=(await db.query<{category_id:string;position:string}>('SELECT category_id,position FROM public.workers WHERE id=$1',[worker])).rows[0];expect(before.position).toBe('Mason');expect(before.category_id).toBeTruthy();
  await db.exec(`INSERT INTO public.payroll(id,worker_id,status) VALUES('${id(1)}','${worker}','paid'); SET test.uid='${sup}';SET test.assurance='yes';SET ROLE authenticated`);
  expect((await db.query<{v:{label:string}[]}>('SELECT public.active_worker_categories() v')).rows[0].v.map(x=>x.label)).toContain('Mason');
  await expect(db.query('SELECT public.change_worker_category($1,$2,$3,$4,$5)',[id(2),before.category_id,'rename','Master Mason',1])).rejects.toThrow(/Founder/);
  await db.exec(`SET test.uid='${founder}'`);const changed=(await db.query<{v:{revision:number}}>('SELECT public.change_worker_category($1,$2,$3,$4,$5) v',[id(2),before.category_id,'rename','Master Mason',1])).rows[0].v;expect(changed.revision).toBe(2);
  await db.exec('RESET ROLE');expect((await db.query('SELECT position,category_id FROM public.workers WHERE id=$1',[worker])).rows[0]).toEqual({position:'Master Mason',category_id:before.category_id});expect((await db.query('SELECT status FROM public.payroll WHERE id=$1',[id(1)])).rows[0]).toEqual({status:'paid'});
  await db.exec(`SET ROLE authenticated;SET test.uid='${founder}'`);await db.query('SELECT public.change_worker_category($1,$2,$3,$4,$5)',[id(3),before.category_id,'archive',null,2]);
  await db.exec('RESET ROLE');await expect(db.query("INSERT INTO public.workers(id,name,position,contact_number,pay_rate,pay_rate_type,active) VALUES($1,'New','Master Mason','none',600,'daily',true)",[id(4)])).rejects.toThrow(/active Founder-managed/);
  await db.query("UPDATE public.workers SET name='Renamed person' WHERE id=$1",[worker]);expect((await db.query('SELECT category_id FROM public.workers WHERE id=$1',[worker])).rows[0]).toEqual({category_id:before.category_id});
  await db.exec('SET ROLE service_role');await db.query("INSERT INTO public.workers(id,name,position,contact_number,pay_rate,pay_rate_type,active) VALUES($1,'Supervisor','Site Supervisor','none',600,'daily',true)",[sup]);await db.query("INSERT INTO public.workers(id,name,position,contact_number,pay_rate,pay_rate_type,active) VALUES($1,'Field Worker','Carpenter','none',600,'daily',true)",[id(8)]);await db.exec('RESET ROLE');expect((await db.query('SELECT role FROM public.users WHERE id=$1',[sup])).rows[0]).toEqual({role:'supervisor'});expect((await db.query('SELECT category_id IS NOT NULL ok FROM public.workers WHERE id=$1',[id(8)])).rows[0]).toEqual({ok:true});
  await expect(db.query("INSERT INTO public.workers(id,name,position,contact_number,pay_rate,pay_rate_type,active) VALUES($1,'New','Site Supervisor','none',600,'daily',true)",[id(5)])).rejects.toThrow(/active Founder-managed/);
  await db.exec(`SET ROLE authenticated;SET test.uid='${founder}'`);await expect(db.query('SELECT public.change_worker_category($1,$2,$3,$4,$5)',[id(6),id(7),'add','Site Supervisor',null])).rejects.toThrow(/Supervisor account designation/);
  await db.exec('RESET ROLE');await expect(db.exec('DELETE FROM public.worker_category_events')).rejects.toThrow(/immutable/);
 }finally{await db.close();}},30000);
 it('rolls back a rename and worker relabel if event evidence fails',async()=>{const db=await setup();try{
  const category=(await db.query<{id:string}>("SELECT id FROM public.worker_categories WHERE label='Mason'")).rows[0].id;
  await db.exec("CREATE FUNCTION public.reject_category_event() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic evidence failure'; END$$; CREATE TRIGGER reject_category_event BEFORE INSERT ON public.worker_category_events FOR EACH ROW EXECUTE FUNCTION public.reject_category_event(); SET ROLE authenticated; SET test.assurance='yes'; SET test.uid='"+founder+"'");
  await expect(db.query('SELECT public.change_worker_category($1,$2,$3,$4,$5)',[id(30),category,'rename','Senior Mason',1])).rejects.toThrow(/synthetic evidence failure/);
  await db.exec('RESET ROLE');expect((await db.query('SELECT label,revision FROM public.worker_categories WHERE id=$1',[category])).rows[0]).toEqual({label:'Mason',revision:1});expect((await db.query('SELECT position FROM public.workers WHERE id=$1',[worker])).rows[0]).toEqual({position:'Mason'});
 }finally{await db.close();}},30000);
 it('denies table and service access and refuses inherited grants or ambiguous legacy data',async()=>{const db=await setup();try{
  expect((await db.query<{a:boolean;s:boolean;f:boolean}>("SELECT has_table_privilege('authenticated','public.worker_categories','SELECT') a,has_table_privilege('service_role','public.worker_categories','SELECT') s,has_function_privilege('service_role','public.change_worker_category(uuid,uuid,text,text,integer)','EXECUTE') f")).rows[0]).toEqual({a:false,s:false,f:false});
  await db.exec(`SET ROLE authenticated;SET test.uid='${sup}';SET test.assurance='no'`);await expect(db.query('SELECT public.active_worker_categories()')).rejects.toThrow(/assured account/);
 }finally{await db.close();}
 const other=new PGlite();try{await other.exec(baseFixture);await other.exec(sql('worker_category_catalog'));await other.exec("UPDATE public.workers SET position='Supervisor helper'");await expect(other.exec(`BEGIN; ${sql('worker_category_workforce_cutover')} COMMIT;`)).rejects.toThrow(/manual review/);await other.exec('ROLLBACK');}finally{await other.close();}
 },30000);
});
