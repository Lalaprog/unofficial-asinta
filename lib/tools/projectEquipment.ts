import type {ToolCondition} from '@/types';
export type ProjectEquipmentItem={id:string;name:string;condition:ToolCondition;quantity:number;source:'legacy'|'allocated'};
export type ProjectEquipmentSnapshot={project_id:string;items:ProjectEquipmentItem[]};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseProjectEquipment(raw:unknown,projectId:string):ProjectEquipmentSnapshot{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Invalid project equipment response');
 const v=raw as ProjectEquipmentSnapshot;
 if(!uuid.test(projectId)||v.project_id!==projectId||!Array.isArray(v.items)||v.items.length>2000)throw new Error('Invalid project equipment snapshot');
 const ids=new Set<string>();
 for(const item of v.items){
  if(!item||typeof item.id!=='string'||!uuid.test(item.id)||ids.has(item.id.toLowerCase())||typeof item.name!=='string'||!item.name.trim()||!['excellent','good','fair','needs_repair','damaged'].includes(item.condition)||!Number.isInteger(item.quantity)||item.quantity<0||item.quantity>2147483647||!['legacy','allocated'].includes(item.source)||(item.source==='allocated'&&item.quantity===0))throw new Error('Invalid project equipment record');
  ids.add(item.id.toLowerCase());
 }
 return v;
}
