import {describe,expect,it,vi} from 'vitest';
import {equipmentAttempt,parseEquipmentAttempt,parseEquipmentSnapshot,verifyEquipmentResult,verifyEquipmentStatus} from '@/lib/tools/ownedEquipment';
import {tool,siteA,siteB} from './helpers/owned-equipment-fixture';
const request='00000000-0000-0000-0000-000000000099';
const raw={items:[{id:tool,name:'Drill',stock:5,condition:'good',legacy_project_id:null,managed:true,sites:[{project_id:siteA,name:'Site A',quantity:3}]}],projects:[{id:siteA,name:'Site A'},{id:siteB,name:'Site B'}]};
const result={id:request,tool_id:tool,stock:5,allocated:4,depot:1,site_quantity:1,replayed:false};
describe('equipment snapshot and retry validation',()=>{
 it('validates complete snapshots and prevents invalid allocation requests',()=>{
  vi.stubGlobal('crypto',{randomUUID:()=>request});try{
   const snap=parseEquipmentSnapshot(raw),item=snap.items[0];const a=equipmentAttempt(item,siteB,1);
   expect(a).toEqual({id:request,tool,action:'allocate',project:siteB,quantity:1,expectedStock:5,expectedSite:0});expect(verifyEquipmentResult(result,a)).toEqual({replayed:false});
   expect(verifyEquipmentStatus({found:true,attempt:a,result},a).found).toBe(true);expect(verifyEquipmentStatus({found:false},a).found).toBe(false);
   expect(()=>verifyEquipmentStatus({found:true,attempt:{...a,project:siteA},result},a)).toThrow(/differ/);
   expect(()=>verifyEquipmentResult({...result,depot:2},a)).toThrow();expect(()=>equipmentAttempt(item,siteB,3)).toThrow(/exceeds/);
   expect(()=>equipmentAttempt({...item,managed:false,legacy_project_id:siteA,sites:[]},null,null)).toThrow(/reconciliation/);
   expect(parseEquipmentAttempt(a)).toEqual(a);
  }finally{vi.unstubAllGlobals();}
 });
 it('rejects incomplete, duplicated, contradictory or excessive records',()=>{
  for(const invalid of [{items:[]}, {...raw,projects:[]}, {...raw,items:[raw.items[0],raw.items[0]]}, {...raw,items:[{...raw.items[0],legacy_project_id:siteA}]},{...raw,items:[{...raw.items[0],sites:[{...raw.items[0].sites[0],quantity:6}]}]}, {...raw,items:[{...raw.items[0],managed:false}]}])expect(()=>parseEquipmentSnapshot(invalid)).toThrow();
  expect(()=>parseEquipmentAttempt({id:request,tool,action:'allocate',project:siteA,quantity:1,expectedStock:-1,expectedSite:0})).toThrow();
 });
});
