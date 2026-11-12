export type EquipmentProject={id:string;name:string};
export type EquipmentSite={project_id:string;name:string;quantity:number};
export type EquipmentItem={id:string;name:string;stock:number;condition:'excellent'|'good'|'fair'|'needs_repair'|'damaged';legacy_project_id:string|null;managed:boolean;sites:EquipmentSite[]};
export type EquipmentSnapshot={items:EquipmentItem[];projects:EquipmentProject[]};
export type EquipmentAttempt={id:string;tool:string;action:'adopt'|'adopt_site'|'allocate';project:string|null;quantity:number|null;expectedStock:number;expectedSite:number|null};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId=(v:unknown):v is string=>typeof v==='string'&&uuid.test(v);
const str=(v:unknown):v is string=>typeof v==='string'&&!!v.trim();
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isInteger(v)&&v>=0&&v<=2147483647;
const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function ownedEquipmentPreviewEnabled(){return process.env.NEXT_PUBLIC_OWNED_EQUIPMENT_PREVIEW==='true';}
export function parseEquipmentSnapshot(raw:unknown):EquipmentSnapshot{
 if(!obj(raw)||!Array.isArray(raw.items)||raw.items.length>2000||!Array.isArray(raw.projects)||raw.projects.length>2000)throw new Error('Invalid equipment snapshot');
 const projectIds=new Set<string>();
 const projects=raw.projects.map((p:unknown):EquipmentProject=>{if(!obj(p)||!isId(p.id)||!str(p.name)||projectIds.has(p.id.toLowerCase()))throw new Error('Invalid equipment projects');projectIds.add(p.id.toLowerCase());return {id:p.id,name:p.name};});
 const ids=new Set<string>();let siteCount=0;
 const items=raw.items.map((v:unknown):EquipmentItem=>{
  if(!obj(v)||!isId(v.id)||ids.has(v.id.toLowerCase())||!str(v.name)||!integer(v.stock)||!['excellent','good','fair','needs_repair','damaged'].includes(String(v.condition))||typeof v.managed!=='boolean'||!(v.legacy_project_id===null||isId(v.legacy_project_id))||!Array.isArray(v.sites))throw new Error('Invalid equipment item');
  ids.add(v.id.toLowerCase());const siteIds=new Set<string>();let sum=0;
  const sites=v.sites.map((s:unknown):EquipmentSite=>{if(!obj(s)||!isId(s.project_id)||!str(s.name)||!integer(s.quantity)||s.quantity===0||siteIds.has(s.project_id.toLowerCase())||!projectIds.has(s.project_id.toLowerCase()))throw new Error('Invalid equipment site');
   const projectId=s.project_id;const p=projects.find(p=>p.id.toLowerCase()===projectId.toLowerCase());if(p?.name!==s.name)throw new Error('Inconsistent equipment project');siteIds.add(projectId.toLowerCase());sum+=s.quantity;siteCount++;return {project_id:projectId,name:s.name,quantity:s.quantity};});
  if((v.managed&&v.legacy_project_id!==null)||(!v.managed&&sites.length>0)||sum>v.stock||(v.legacy_project_id!==null&&!projectIds.has(v.legacy_project_id.toLowerCase())))throw new Error('Inconsistent equipment allocations');
  return {id:v.id,name:v.name,stock:v.stock,condition:v.condition as EquipmentItem['condition'],legacy_project_id:v.legacy_project_id as string|null,managed:v.managed,sites};
 });
 if(siteCount>10000)throw new Error('Equipment snapshot exceeds limit');
 return {items,projects};
}
export function parseEquipmentAttempt(raw:unknown):EquipmentAttempt{
 if(!obj(raw)||!isId(raw.id)||!isId(raw.tool)||!['adopt','adopt_site','allocate'].includes(String(raw.action))||!integer(raw.expectedStock))throw new Error('Invalid equipment retry record');
 if(raw.action==='adopt'?raw.project!==null||raw.quantity!==null||raw.expectedSite!==null:raw.action==='adopt_site'?!isId(raw.project)||!integer(raw.quantity)||raw.quantity===0||raw.quantity!==raw.expectedStock||raw.expectedSite!==null:!isId(raw.project)||!integer(raw.quantity)||!integer(raw.expectedSite))throw new Error('Invalid equipment retry details');
 return raw as EquipmentAttempt;
}
export function verifyEquipmentStatus(raw:unknown,attempt:EquipmentAttempt):{found:boolean;result?:unknown}{
 if(!obj(raw)||typeof raw.found!=='boolean')throw new Error('Invalid equipment operation status');
 if(!raw.found)return {found:false};
 const actual=parseEquipmentAttempt(raw.attempt);
 if(actual.id!==attempt.id||actual.tool!==attempt.tool||actual.action!==attempt.action||actual.project!==attempt.project||actual.quantity!==attempt.quantity||actual.expectedStock!==attempt.expectedStock||actual.expectedSite!==attempt.expectedSite)throw new Error('Equipment operation details differ');
 verifyEquipmentResult(raw.result,attempt);
 return {found:true,result:raw.result};
}
export function verifyEquipmentResult(raw:unknown,attempt:EquipmentAttempt):{replayed:boolean}{
 if(!obj(raw)||raw.id!==attempt.id||raw.tool_id!==attempt.tool||raw.stock!==attempt.expectedStock||!integer(raw.allocated)||!integer(raw.depot)||raw.allocated+raw.depot!==raw.stock||!integer(raw.site_quantity)||typeof raw.replayed!=='boolean'||raw.site_quantity>raw.allocated||(attempt.action==='adopt'?(raw.allocated!==0||raw.site_quantity!==0):attempt.action==='adopt_site'?(raw.site_quantity!==attempt.quantity||raw.allocated!==attempt.expectedStock||raw.depot!==0):raw.site_quantity!==attempt.quantity))throw new Error('Unverified equipment result');
 return {replayed:raw.replayed};
}
export function equipmentAttempt(item:EquipmentItem,project:string|null,quantity:number|null):EquipmentAttempt{
 if(!item.managed){
  if(item.legacy_project_id!==null){if(project!==item.legacy_project_id||quantity!==item.stock||item.stock===0)throw new Error('Confirm all recorded stock at the original site; zero-stock records need separate reconciliation');return {id:crypto.randomUUID(),tool:item.id,action:'adopt_site',project,quantity,expectedStock:item.stock,expectedSite:null};}
  if(project!==null||quantity!==null)throw new Error('Unassigned stock requires depot adoption');return {id:crypto.randomUUID(),tool:item.id,action:'adopt',project:null,quantity:null,expectedStock:item.stock,expectedSite:null};
 }
 if(!isId(project)||!integer(quantity))throw new Error('Choose a project and a whole-number quantity');
 const prior=item.sites.find(s=>s.project_id===project)?.quantity??0,allocated=item.sites.reduce((n,s)=>n+s.quantity,0);
 if(allocated-prior+quantity>item.stock)throw new Error('Allocation exceeds owned stock');
 return {id:crypto.randomUUID(),tool:item.id,action:'allocate',project,quantity,expectedStock:item.stock,expectedSite:prior};
}
