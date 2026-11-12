import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {fixture,founder,supervisor,tool,siteA,siteB} from './helpers/owned-equipment-fixture';
import {parseProjectEquipment} from '@/lib/tools/projectEquipment';
const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const sql=readFileSync('supabase/drafts/owned_equipment_allocations.sql','utf8');
describe('project equipment snapshot draft',()=>{
 it('returns only the authorized site, including legacy and allocated stock, without changing records',async()=>{
  const db=new PGlite();try{
   await db.exec(fixture);await db.query("INSERT INTO public.tools VALUES ($1,'Legacy drill',3,'fair',$2),($3,'Private other',2,'good',$4)",[id(10),siteA,id(11),siteB]);
   await db.exec(`BEGIN; ${sql} COMMIT; SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'`);
   const change=(req:string,action:string,project:string|null,qty:number|null,expected:number|null)=>db.query('SELECT public.change_owned_equipment($1,$2,$3,$4,$5,$6,$7)',[req,tool,action,project,qty,5,expected]);
   await change(id(20),'adopt',null,null,null);await change(id(21),'allocate',siteA,2,0);await change(id(22),'allocate',siteB,3,0);
   const get=async(project:string)=>(await db.query<{v:unknown}>('SELECT public.project_equipment_snapshot($1) v',[project])).rows[0].v;
   const founderView=parseProjectEquipment(await get(siteA),siteA);expect(founderView.items).toEqual([{id:tool,name:'Drill',condition:'good',quantity:2,source:'allocated'},{id:id(10),name:'Legacy drill',condition:'fair',quantity:3,source:'legacy'}]);
   await db.exec(`SET test.uid='${supervisor}'`);expect(parseProjectEquipment(await get(siteA),siteA)).toEqual(founderView);await expect(get(siteB)).rejects.toThrow(/access required/);await expect(db.query('SELECT public.owned_equipment_snapshot()')).rejects.toThrow(/Founder access/);
   await db.exec("SET test.assurance='no'");await expect(get(siteA)).rejects.toThrow(/access required/);
   await db.exec('RESET ROLE; SET ROLE anon');await expect(get(siteA)).rejects.toThrow(/permission denied/);
   await db.exec('RESET ROLE');expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.owned_equipment_events')).rows[0].n).toBe(3);
  }finally{await db.close();}
 },30000);
 it('does not silently include contradictory managed legacy records',async()=>{
  const db=new PGlite();try{
   await db.exec(fixture);await db.exec(`BEGIN; ${sql} COMMIT;`);
   // Explicitly bypass application safeguards only inside this synthetic test.
   await db.exec(`ALTER TABLE public.tools DISABLE TRIGGER guard_managed_equipment; INSERT INTO public.managed_owned_equipment(tool_id,adopted_by) VALUES('${tool}','${founder}'); UPDATE public.tools SET project_id='${siteA}' WHERE id='${tool}'; SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'`);
   await expect(db.query('SELECT public.project_equipment_snapshot($1)',[siteA])).rejects.toThrow(/requires reconciliation/);
  }finally{await db.close();}
 },30000);
});
