// Only runs against an empty local disposable PostgreSQL database.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {fixture,roles,founder,supervisor,tool,siteA,siteB} from './helpers/owned-equipment-fixture';
const url=process.env.OWNED_EQUIPMENT_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
let admin:Client,a:Client,b:Client;
const change=(client:Client,req:string,action:string,project:string|null,quantity:number|null,stock:number,site:number|null)=>client.query('SELECT public.change_owned_equipment($1,$2,$3,$4,$5,$6,$7) v',[req,tool,action,project,quantity,stock,site]);
const delay=()=>new Promise(resolve=>setTimeout(resolve,150));
suite('owned equipment allocation concurrency on isolated PostgreSQL',()=>{
 beforeAll(async()=>{
  const p=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(p.hostname)||p.pathname!=='/asinta_test_owned_equipment'||p.search||p.hash)throw new Error('Use only the empty local asinta_test_owned_equipment database');
  admin=new Client({connectionString:url});a=new Client({connectionString:url});b=new Client({connectionString:url});await Promise.all([admin.connect(),a.connect(),b.connect()]);
  const existing=await admin.query("SELECT (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')) objects,(SELECT count(*)::int FROM pg_namespace WHERE nspname='auth') schemas");
  if(existing.rows[0].objects||existing.rows[0].schemas)throw new Error('Test database must be empty');
  await admin.query(`DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END$$;`);
  await admin.query(fixture.slice(roles.length));await admin.query(`BEGIN; ${readFileSync('supabase/drafts/owned_equipment_allocations.sql','utf8')} COMMIT;`);
  await Promise.all([a.query(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'; SET lock_timeout='5s'`),b.query(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'; SET lock_timeout='5s'`)]);
  await change(a,id(10),'adopt',null,null,5,null);
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),a?.end(),b?.end()]);});
 it('serializes legacy site adoption with old-client assignment writes and preserves the site allocation',async()=>{
  const other=id(90);await admin.query("INSERT INTO public.tools VALUES ($1,'Site saw',4,'good',$2)",[other,siteA]);
  await a.query('BEGIN');await b.query('BEGIN');try{
   const adopt=(client:Client,request:string)=>client.query('SELECT public.change_owned_equipment($1,$2,$3,$4,$5,$6,$7) v',[request,other,'adopt_site',siteA,4,4,null]);
   await adopt(a,id(91));
   let settled=false;const pending=b.query('UPDATE public.tools SET project_id=$1 WHERE id=$2',[siteB,other]).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{settled=true;});
   await delay();expect(settled).toBe(false);await a.query('COMMIT');expect((await pending).code).toBe('23514');await b.query('ROLLBACK');
   expect((await adopt(b,id(91))).rows[0].v.replayed).toBe(true);
   expect((await admin.query('SELECT t.project_id,a.project_id site,a.quantity FROM public.tools t JOIN public.owned_equipment_allocations a ON a.tool_id=t.id WHERE t.id=$1',[other])).rows[0]).toEqual({project_id:null,site:siteA,quantity:4});
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');}
 },15000);
 it('site adoption waits for legacy moves and rejects a stale original site',async()=>{
  const other=id(94);await admin.query("INSERT INTO public.tools VALUES ($1,'Move race',4,'good',$2)",[other,siteA]);
  await a.query('BEGIN');await b.query('BEGIN');try{
   await a.query('UPDATE public.tools SET project_id=$1 WHERE id=$2',[siteB,other]);
   let settled=false;const pending=b.query('SELECT public.change_owned_equipment($1,$2,$3,$4,$5,$6,$7)',[id(95),other,'adopt_site',siteA,4,4,null]).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{settled=true;});
   await delay();expect(settled).toBe(false);await a.query('COMMIT');expect((await pending).code).toBe('40001');await b.query('ROLLBACK');
   expect((await admin.query('SELECT project_id FROM public.tools WHERE id=$1',[other])).rows[0].project_id).toBe(siteB);
   expect((await admin.query('SELECT count(*)::int n FROM public.managed_owned_equipment WHERE tool_id=$1',[other])).rows[0].n).toBe(0);
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');}
 },15000);
 it('a stale repeatable-read legacy writer cannot overwrite a site adoption',async()=>{
  const other=id(92);await admin.query("INSERT INTO public.tools VALUES ($1,'Old site saw',4,'good',$2)",[other,siteA]);
  await b.query('BEGIN ISOLATION LEVEL REPEATABLE READ');try{
   await b.query('SELECT project_id FROM public.tools WHERE id=$1',[other]);
   await a.query('SELECT public.change_owned_equipment($1,$2,$3,$4,$5,$6,$7)',[id(93),other,'adopt_site',siteA,4,4,null]);
   await expect(b.query('UPDATE public.tools SET project_id=$1 WHERE id=$2',[siteB,other])).rejects.toMatchObject({code:'40001'});
  }finally{await b.query('ROLLBACK');}
 },15000);
 it('restricts the site snapshot to an assigned Supervisor without exposing other site stock',async()=>{
  await admin.query("INSERT INTO public.tools VALUES ($1,'Legacy drill',3,'fair',$2)",[id(80),siteA]);
  await change(a,id(81),'allocate',siteA,2,5,0);
  try {
   await b.query(`SET test.uid='${supervisor}'`);
   const view=(await b.query('SELECT public.project_equipment_snapshot($1) v',[siteA])).rows[0].v;
   expect(view.items.filter((item:{id:string})=>[tool,id(80)].includes(item.id)).map((item:{name:string;quantity:number})=>[item.name,item.quantity])).toEqual([['Drill',2],['Legacy drill',3]]);
   await expect(b.query('SELECT public.project_equipment_snapshot($1)',[siteB])).rejects.toMatchObject({code:'42501'});
  } finally {
   await b.query(`SET test.uid='${founder}'`);await change(a,id(82),'allocate',siteA,0,5,2);await admin.query('DELETE FROM public.tools WHERE id=$1',[id(80)]);
  }
 });
 it('serializes simultaneous allocations to distinct sites and rejects over-allocation',async()=>{
  await a.query('BEGIN');await b.query('BEGIN');try{
   await change(a,id(11),'allocate',siteA,3,5,0);
   let settled=false;const pending=change(b,id(12),'allocate',siteB,3,5,0).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{settled=true;});
   await delay();expect(settled).toBe(false);await a.query('COMMIT');expect((await pending).code).toBe('23514');await b.query('ROLLBACK');
   expect((await admin.query<{n:number}>('SELECT coalesce(sum(quantity),0)::int n FROM public.owned_equipment_allocations WHERE tool_id=$1',[tool])).rows[0].n).toBe(3);
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');}
 },15000);
 it('legacy stock reduction waits for allocations and cannot make them exceed stock',async()=>{
  await a.query('BEGIN');await b.query('BEGIN');try{
   await change(a,id(13),'allocate',siteB,2,5,0);
   let settled=false;const pending=b.query('UPDATE public.tools SET quantity=4 WHERE id=$1',[tool]).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{settled=true;});
   await delay();expect(settled).toBe(false);await a.query('COMMIT');expect((await pending).code).toBe('23514');await b.query('ROLLBACK');
   expect((await admin.query('SELECT quantity FROM public.tools WHERE id=$1',[tool])).rows[0].quantity).toBe(5);
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');}
 },15000);
 it('an allocation waiting behind a legacy stock reduction rejects the stale snapshot',async()=>{
  await a.query('BEGIN');await b.query('BEGIN');try{
   await a.query('UPDATE public.tools SET quantity=6 WHERE id=$1',[tool]);
   let settled=false;const pending=change(b,id(16),'allocate',siteA,1,5,3).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{settled=true;});
   await delay();expect(settled).toBe(false);await a.query('COMMIT');expect((await pending).code).toBe('40001');await b.query('ROLLBACK');
   await a.query('UPDATE public.tools SET quantity=5 WHERE id=$1',[tool]);
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');}
 },15000);
 it('blocks a legacy single-site assignment racing with adoption',async()=>{
  const other=id(28);await admin.query("INSERT INTO public.tools VALUES ($1,'Depot stock',4,'good',NULL)",[other]);
  await a.query('BEGIN');await b.query('BEGIN');try{
   await a.query('SELECT public.change_owned_equipment($1,$2,$3,$4,$5,$6,$7)',[id(29),other,'adopt',null,null,4,null]);
   let settled=false;const pending=b.query('UPDATE public.tools SET project_id=$1 WHERE id=$2',[siteA,other]).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{settled=true;});
   await delay();expect(settled).toBe(false);await a.query('COMMIT');expect((await pending).code).toBe('23514');await b.query('ROLLBACK');
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');}
 },15000);
 it('invalidates legacy repeatable-read snapshots taken before adoption or allocation',async()=>{
  const other=id(30);await admin.query("INSERT INTO public.tools VALUES ($1,'Other',4,'good',NULL)",[other]);
  await b.query('BEGIN ISOLATION LEVEL REPEATABLE READ');try{
   await b.query('SELECT quantity FROM public.tools WHERE id=$1',[other]);
   await a.query('SELECT public.change_owned_equipment($1,$2,$3,$4,$5,$6,$7)',[id(31),other,'adopt',null,null,4,null]);
   await expect(b.query('UPDATE public.tools SET project_id=$1 WHERE id=$2',[siteA,other])).rejects.toMatchObject({code:'40001'});
  }finally{await b.query('ROLLBACK');}
  await b.query('BEGIN ISOLATION LEVEL REPEATABLE READ');try{
   await b.query('SELECT quantity FROM public.tools WHERE id=$1',[tool]);
   await change(a,id(32),'allocate',siteB,1,5,2);
   await expect(b.query('UPDATE public.tools SET quantity=0 WHERE id=$1',[tool])).rejects.toMatchObject({code:'40001'});
  }finally{await b.query('ROLLBACK');}
  await change(a,id(33),'allocate',siteB,2,5,1);
 },15000);
 it('serializes exact retries and rejects repeatable-read writes',async()=>{
  await a.query('BEGIN');await b.query('BEGIN');try{
   expect((await change(a,id(14),'allocate',siteA,2,5,3)).rows[0].v.replayed).toBe(false);
   let settled=false;const pending=change(b,id(14),'allocate',siteA,2,5,3).finally(()=>{settled=true;});await delay();expect(settled).toBe(false);await a.query('COMMIT');expect((await pending).rows[0].v.replayed).toBe(true);await b.query('COMMIT');
   expect((await admin.query('SELECT count(*)::int n FROM public.owned_equipment_events WHERE id=$1',[id(14)])).rows[0].n).toBe(1);
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');}
  await a.query('BEGIN ISOLATION LEVEL REPEATABLE READ');try{await expect(change(a,id(15),'allocate',siteA,1,5,2)).rejects.toMatchObject({code:'P1002'});}finally{await a.query('ROLLBACK');}
  await a.query('BEGIN ISOLATION LEVEL REPEATABLE READ');try{await expect(a.query('UPDATE public.tools SET quantity=6 WHERE id=$1',[tool])).rejects.toMatchObject({code:'P1002'});}finally{await a.query('ROLLBACK');}
 },15000);
});
