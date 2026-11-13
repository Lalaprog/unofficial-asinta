import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {args,call,expense,fixture,founder,otherSite,site,supervisor} from './helpers/rental-fixture';
const sql=readFileSync('supabase/drafts/confirmed_rental_expense_link.sql','utf8');
const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
async function setup(){const db=new PGlite();await db.exec(fixture);await db.exec(`BEGIN; ${sql} COMMIT; SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'`);return db;}
describe('confirmed rental expense link (uninstalled)',()=>{
 it('links exactly one existing expense once, preserves receipts, locks financial details and supports exact retries',async()=>{
  const db=await setup();try{
   expect((await db.query<{v:object}>('SELECT public.rental_confirmation_status($1) v',[id(10)])).rows[0].v).toEqual({found:false});
   expect((await db.query<{v:object}>(call,args(id(10)))).rows[0].v).toEqual({id:id(10),expense_id:expense,replayed:false});
   expect((await db.query<{v:object}>('SELECT public.rental_confirmation_status($1) v',[id(10)])).rows[0].v).toEqual({found:true,id:id(10),expense,project:site,amount:'1234.50',date:'2026-10-14',description:'Excavator hire',item:'Excavator',supplier:'Supplier',quantity:1,start:'2026-10-10',end:'2026-10-14'});
   expect((await db.query<{v:object}>(call,args(id(10)))).rows[0].v).toEqual({id:id(10),expense_id:expense,replayed:true});
   expect((await db.query<{revision:number}>('SELECT revision FROM public.expenses WHERE id=$1',[expense])).rows[0].revision).toBe(1);
   await db.exec(`RESET ROLE; INSERT INTO public.users VALUES ('${id(99)}','founder'); SET ROLE authenticated; SET test.uid='${id(99)}'`);
   expect((await db.query<{v:object}>('SELECT public.rental_confirmation_status($1) v',[id(10)])).rows[0].v).toEqual({found:false});await db.exec(`SET test.uid='${founder}'`);
   await expect(db.query(call,[...args(id(10)).slice(0,6),'Different',...args(id(10)).slice(7)])).rejects.toThrow(/different details/);
   await expect(db.query(call,args(id(11)))).rejects.toThrow(/already linked/);
   await expect(db.query('UPDATE public.expenses SET amount=1 WHERE id=$1',[expense])).rejects.toThrow(/locked/);
   await expect(db.query('DELETE FROM public.expenses WHERE id=$1',[expense])).rejects.toThrow();
   await db.query("UPDATE public.expenses SET receipt_url='receipt' WHERE id=$1",[expense]);
   expect((await db.query<{revision:number}>('SELECT revision FROM public.expenses WHERE id=$1',[expense])).rows[0].revision).toBe(2);
   const list=(await db.query<{v:{items:object[]}}>('SELECT public.project_confirmed_rentals($1) v',[site])).rows[0].v.items;
   expect(list).toEqual([expect.objectContaining({expense_id:expense,project_id:site,expense_amount:'1234.50',rental_start:'2026-10-10',rental_end:'2026-10-14'})]);
   expect((await db.query<{total:string}>('SELECT sum(amount)::text total FROM public.expenses WHERE project_id=$1',[site])).rows[0].total).toBe('1234.50');
   await db.exec('RESET ROLE');await expect(db.query('DELETE FROM public.confirmed_rental_expenses WHERE id=$1',[id(10)])).rejects.toThrow(/immutable/);
  }finally{await db.close();}
 },30000);
 it('checks role, assurance, stale expense, dates, project, classification and direct access',async()=>{
  const db=await setup();try{
   await db.exec(`SET test.uid='${supervisor}'`);await expect(db.query(call,args(id(12)))).rejects.toThrow(/Founder/);await expect(db.query('SELECT public.rental_confirmation_status($1)',[id(12)])).rejects.toThrow(/Founder/);await expect(db.query('SELECT public.project_confirmed_rentals($1)',[site])).rejects.toThrow(/Founder/);await expect(db.query('SELECT * FROM public.confirmed_rental_expenses')).rejects.toThrow(/permission denied/);
   await db.exec(`SET test.uid='${founder}'; SET test.assurance='no'`);await expect(db.query(call,args(id(12)))).rejects.toThrow(/Founder/);await db.exec("SET test.assurance='yes'");
   await expect(db.query(call,args(id(12),expense,otherSite))).rejects.toThrow(/changed/);
   await expect(db.query(call,[...args(id(12)).slice(0,10),'2026-10-09'])).rejects.toThrow(/Invalid/);
   const invalidAmount=args(id(12));invalidAmount[3]='NaN';await expect(db.query(call,invalidAmount)).rejects.toThrow(/Invalid/);
   const invalidDate=args(id(12));invalidDate[10]='infinity';await expect(db.query(call,invalidDate)).rejects.toThrow(/Invalid/);
   await db.query("UPDATE public.expenses SET ai_bale_detection=true WHERE id=$1",[expense]);await expect(db.query(call,args(id(12)))).rejects.toThrow(/Bale flag/);
   await db.query("UPDATE public.expenses SET ai_bale_detection=false,category='labor' WHERE id=$1",[expense]);await expect(db.query(call,args(id(12)))).rejects.toThrow(/equipment expense/);
  }finally{await db.close();}
 },30000);
 it('rolls back the link and expense version if recording the confirmation fails',async()=>{
  const db=await setup();try{
   await db.exec("RESET ROLE; CREATE FUNCTION public.fail_rental() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$; CREATE TRIGGER fail_rental BEFORE INSERT ON public.confirmed_rental_expenses FOR EACH ROW EXECUTE FUNCTION public.fail_rental(); SET ROLE authenticated");
   await expect(db.query(call,args(id(15)))).rejects.toThrow(/synthetic failure/);
   expect((await db.query<{v:{items:unknown[]}}>('SELECT public.project_confirmed_rentals($1) v',[site])).rows[0].v.items).toEqual([]);
   expect((await db.query<{revision:number}>('SELECT revision FROM public.expenses WHERE id=$1',[expense])).rows[0].revision).toBe(0);
   await db.query('UPDATE public.expenses SET amount=99 WHERE id=$1',[expense]);
  }finally{await db.close();}
 },30000);
});
