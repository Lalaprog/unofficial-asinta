import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {fixture,founder,supervisor,tool,siteA,siteB} from './helpers/owned-equipment-fixture';
const sql=readFileSync('supabase/drafts/owned_equipment_allocations.sql','utf8');
const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
describe('owned equipment allocation draft',()=>{
 it('opt-in adoption and per-site quantities preserve stock, deny untrusted access and handle retries',async()=>{
  const db=new PGlite();try{
   await db.exec(fixture);const before=(await db.query('SELECT * FROM public.tools')).rows;
   await db.exec(`BEGIN; ${sql} COMMIT;`);expect((await db.query('SELECT * FROM public.tools')).rows).toEqual(before);
   await expect(db.exec(`BEGIN; ${sql} COMMIT;`)).rejects.toThrow(/already exists/);await db.exec('ROLLBACK');
   await db.exec(`SET ROLE authenticated; SET test.uid='${supervisor}'; SET test.assurance='yes'`);
   await expect(db.query('SELECT public.owned_equipment_snapshot()')).rejects.toThrow(/Founder access/);
   await expect(db.query('SELECT public.change_owned_equipment($1,$2,$3,$4,$5,$6,$7)',[id(20),tool,'adopt',null,null,5,null])).rejects.toThrow(/Founder access/);
   await expect(db.query('SELECT * FROM public.owned_equipment_allocations')).rejects.toThrow(/permission denied/);
   await db.exec(`SET test.uid='${founder}'`);
   const change=(request:string,action:string,project:string|null,quantity:number|null,stock:number,prior:number|null)=>db.query<{v:{replayed:boolean;allocated:number;depot:number}}>('SELECT public.change_owned_equipment($1,$2,$3,$4,$5,$6,$7) v',[request,tool,action,project,quantity,stock,prior]);
   expect((await change(id(20),'adopt',null,null,5,null)).rows[0].v).toMatchObject({replayed:false,allocated:0,depot:5});
   expect((await change(id(20),'adopt',null,null,5,null)).rows[0].v.replayed).toBe(true);
   await expect(change(id(20),'adopt',null,null,4,null)).rejects.toThrow(/different request/);
   expect((await change(id(21),'allocate',siteA,3,5,0)).rows[0].v).toMatchObject({allocated:3,depot:2});
   await expect(change(id(22),'allocate',siteB,3,5,0)).rejects.toThrow(/exceeds owned stock/);
   expect((await change(id(23),'allocate',siteB,2,5,0)).rows[0].v).toMatchObject({allocated:5,depot:0});
   await expect(change(id(24),'allocate',siteA,1,5,0)).rejects.toThrow(/Site allocation changed/);
   await expect(db.query('UPDATE public.tools SET quantity=4 WHERE id=$1',[tool])).rejects.toThrow(/lower than allocated/);
   await expect(db.query('UPDATE public.tools SET project_id=$1 WHERE id=$2',[siteA,tool])).rejects.toThrow(/legacy single-site/);
   await expect(db.query('DELETE FROM public.tools WHERE id=$1',[tool])).rejects.toThrow(/foreign key/);
   await expect(db.query('UPDATE public.owned_equipment_allocations SET quantity=9')).rejects.toThrow(/permission denied/);
   expect((await change(id(25),'allocate',siteA,0,5,3)).rows[0].v).toMatchObject({allocated:2,depot:3});
   await db.query('UPDATE public.tools SET quantity=3 WHERE id=$1',[tool]);
   await expect(change(id(26),'allocate',siteA,1,5,0)).rejects.toThrow(/Stock changed/);
   const snap=(await db.query<{v:{items:unknown[]}}>('SELECT public.owned_equipment_snapshot() v')).rows[0].v;
   expect(snap.items).toEqual([expect.objectContaining({managed:true,stock:3,sites:[{project_id:siteB,name:'Site B',quantity:2}]})]);
   await db.exec("SET test.assurance='no'");await expect(db.query('SELECT public.owned_equipment_snapshot()')).rejects.toThrow(/Founder access/);
   await db.exec('RESET ROLE; SET ROLE anon');await expect(db.query('SELECT public.owned_equipment_snapshot()')).rejects.toThrow(/permission denied/);await db.exec('RESET ROLE');
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.owned_equipment_events')).rows[0].n).toBe(4);
  }finally{await db.close();}
 },30000);
 it('does not reinterpret site-assigned legacy stock and fails closed on schema drift',async()=>{
  const db=new PGlite();try{
   await db.exec(fixture);await db.exec('ALTER TABLE public.tools ALTER COLUMN quantity TYPE bigint');
   await expect(db.exec(`BEGIN; ${sql} COMMIT;`)).rejects.toThrow(/prerequisite columns.*tools.quantity/);await db.exec('ROLLBACK');
   await db.exec(`ALTER TABLE public.tools ALTER COLUMN quantity TYPE integer; UPDATE public.tools SET project_id='${siteA}' WHERE id='${tool}'`);await db.exec(`BEGIN; ${sql} COMMIT;`);
   await db.exec(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'`);
   await expect(db.query('SELECT public.change_owned_equipment($1,$2,$3,$4,$5,$6,$7)',[id(31),tool,'adopt',null,null,5,null])).rejects.toThrow(/separate reconciliation/);
   await db.exec('RESET ROLE');expect((await db.query<{project_id:string}>('SELECT project_id FROM public.tools WHERE id=$1',[tool])).rows[0].project_id).toBe(siteA);
  }finally{await db.close();}
 },30000);
});
