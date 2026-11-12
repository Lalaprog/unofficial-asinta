import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {fixture,founder,supervisor,tool,siteA,siteB} from './helpers/owned-equipment-fixture';
import {verifyEquipmentStatus} from '@/lib/tools/ownedEquipment';
const sql=readFileSync('supabase/drafts/owned_equipment_allocations.sql','utf8');
const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
describe('legacy site equipment adoption draft',()=>{
 it('preserves original recorded site quantity atomically, checks actor and stale inputs, and supports retries',async()=>{
  const db=new PGlite();try{
   await db.exec(fixture);await db.query('UPDATE public.tools SET project_id=$1 WHERE id=$2',[siteA,tool]);await db.exec(`BEGIN; ${sql} COMMIT; SET ROLE authenticated; SET test.uid='${supervisor}'; SET test.assurance='yes'`);
   const change=(req:string,project:string,qty:number,stock:number)=>db.query<{v:{replayed:boolean;allocated:number;depot:number;site_quantity:number}}>('SELECT public.change_owned_equipment($1,$2,$3,$4,$5,$6,$7) v',[req,tool,'adopt_site',project,qty,stock,null]);
   const site=async(project:string)=>(await db.query<{v:{items:{id:string;quantity:number;source:string}[]}}>('SELECT public.project_equipment_snapshot($1) v',[project])).rows[0].v.items;
   expect(await site(siteA)).toEqual([expect.objectContaining({id:tool,quantity:5,source:'legacy'})]);await expect(change(id(1),siteA,5,5)).rejects.toThrow(/Founder access/);
   await db.exec(`SET test.uid='${founder}'`);
   await expect(change(id(2),siteB,5,5)).rejects.toThrow(/Legacy site changed/);await expect(change(id(3),siteA,4,5)).rejects.toThrow(/Invalid equipment operation/);await expect(change(id(4),siteA,4,4)).rejects.toThrow(/Stock changed/);
   expect((await change(id(5),siteA,5,5)).rows[0].v).toMatchObject({replayed:false,allocated:5,depot:0,site_quantity:5});
   expect(await site(siteA)).toEqual([expect.objectContaining({id:tool,quantity:5,source:'allocated'})]);expect(await site(siteB)).toEqual([]);
   expect((await change(id(5),siteA,5,5)).rows[0].v.replayed).toBe(true);await expect(change(id(5),siteB,5,5)).rejects.toThrow(/different request/);
   const attempt={id:id(5),tool,action:'adopt_site' as const,project:siteA,quantity:5,expectedStock:5,expectedSite:null};
   const status=(await db.query<{v:unknown}>('SELECT public.owned_equipment_operation_status($1) v',[id(5)])).rows[0].v;expect(verifyEquipmentStatus(status,attempt).found).toBe(true);
   await db.exec('RESET ROLE');expect((await db.query('SELECT quantity,project_id FROM public.tools WHERE id=$1',[tool])).rows[0]).toEqual({quantity:5,project_id:null});expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.owned_equipment_events')).rows[0].n).toBe(1);
  }finally{await db.close();}
 },30000);
 it('rolls back the site pointer and allocation if recording the adoption event fails',async()=>{
  const db=new PGlite();try{
   await db.exec(fixture);await db.query('UPDATE public.tools SET project_id=$1 WHERE id=$2',[siteA,tool]);await db.exec(`BEGIN; ${sql} COMMIT; CREATE FUNCTION public.fail_equipment_event() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic event failure'; END$$; CREATE TRIGGER fail_equipment_event BEFORE INSERT ON public.owned_equipment_events FOR EACH ROW EXECUTE FUNCTION public.fail_equipment_event(); SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'`);
   await expect(db.query('SELECT public.change_owned_equipment($1,$2,$3,$4,$5,$6,$7)',[id(9),tool,'adopt_site',siteA,5,5,null])).rejects.toThrow(/synthetic event failure/);
   await db.exec('RESET ROLE');expect((await db.query('SELECT quantity,project_id FROM public.tools WHERE id=$1',[tool])).rows[0]).toEqual({quantity:5,project_id:siteA});expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.managed_owned_equipment')).rows[0].n).toBe(0);expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.owned_equipment_allocations')).rows[0].n).toBe(0);
  }finally{await db.close();}
 },30000);
 it('rejects a zero-quantity site record without converting or erasing its site',async()=>{
  const db=new PGlite();try{
   await db.exec(fixture);await db.query('UPDATE public.tools SET quantity=0,project_id=$1 WHERE id=$2',[siteA,tool]);await db.exec(`BEGIN; ${sql} COMMIT; SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'`);
   await expect(db.query('SELECT public.change_owned_equipment($1,$2,$3,$4,$5,$6,$7)',[id(10),tool,'adopt_site',siteA,0,0,null])).rejects.toThrow(/Invalid equipment operation/);
   await db.exec('RESET ROLE');expect((await db.query('SELECT quantity,project_id FROM public.tools WHERE id=$1',[tool])).rows[0]).toEqual({quantity:0,project_id:siteA});
  }finally{await db.close();}
 },30000);
});
