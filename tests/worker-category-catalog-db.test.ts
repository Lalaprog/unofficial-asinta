import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const founder=id(1),otherFounder=id(2),supervisor=id(3),category=id(4),req=id(5);

describe('experimental worker category catalog',()=>{
 it('restricts management to Founder/MFA, records history, prevents stale edits and preserves worker data',async()=>{
  const db=new PGlite();try {
   await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
    CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.assurance',true)='yes'$$;
    CREATE TABLE public.users(id uuid primary key,role text);
    CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder')$$;
    CREATE TABLE public.workers(id uuid primary key,position text);
    CREATE TABLE public.payroll(id uuid primary key,worker_id uuid,status text);
    INSERT INTO public.users VALUES('${founder}','founder'),('${otherFounder}','founder'),('${supervisor}','supervisor');
    INSERT INTO public.workers VALUES('${id(100)}','Old Mason');INSERT INTO public.payroll VALUES('${id(101)}','${id(100)}','paid');
    GRANT USAGE ON SCHEMA public,auth TO authenticated,anon;`);
   await db.exec(readFileSync('supabase/drafts/worker_category_catalog.sql','utf8'));
   await db.exec(`SET test.assurance='yes';SET test.uid='${supervisor}';SET ROLE authenticated`);
   const change=(request:string,cat:string,action:string,label:string|null,revision:number|null)=>db.query<{result:{id:string;label:string;archived:boolean;revision:number;replayed:boolean}}>('SELECT public.change_worker_category($1,$2,$3,$4,$5) result',[request,cat,action,label,revision]);
   await expect(change(req,category,'add','Mason',null)).rejects.toThrow(/Founder/);
   await expect(db.query('SELECT public.worker_category_catalog()')).rejects.toThrow(/Founder/);
   await expect(db.query(`SELECT public.worker_category_history('${category}')`)).rejects.toThrow(/Founder/);
   await expect(db.query('SELECT * FROM public.worker_categories')).rejects.toThrow(/permission denied/);
   await expect(db.query('TRUNCATE public.worker_categories')).rejects.toThrow(/permission denied/);
   await db.exec(`SET test.uid='${founder}';SET test.assurance='no'`);
   await expect(change(req,category,'add','Mason',null)).rejects.toThrow(/Founder/);
   await db.exec(`SET test.assurance='yes'`);
   expect((await change(req,category,'add',' Mason ',null)).rows[0].result).toEqual({id:category,label:'Mason',archived:false,revision:1,replayed:false});
   expect((await change(req,category,'add','Mason',null)).rows[0].result.replayed).toBe(true);
   await expect(change(req,category,'add','Carpenter',null)).rejects.toThrow(/different category change/);
   await expect(change(id(6),id(7),'add','mason',null)).rejects.toThrow(/unique/);
   await expect(change(id(6),category,'rename','  ',1)).rejects.toThrow(/category name/);
   expect((await change(id(6),category,'rename','Master Mason',1)).rows[0].result.revision).toBe(2);
   await expect(change(id(8),category,'archive',null,1)).rejects.toThrow(/changed; refresh/);
   expect((await change(id(8),category,'archive',null,2)).rows[0].result).toMatchObject({archived:true,revision:3});
   await expect(change(id(9),id(10),'add','master mason',null)).rejects.toThrow(/unique/);
   expect((await change(id(11),category,'restore',null,3)).rows[0].result).toMatchObject({archived:false,revision:4});
   // A late replay reports its original result, never re-applies the old change.
   expect((await change(req,category,'add','Mason',null)).rows[0].result).toMatchObject({label:'Mason',revision:1,replayed:true});
   const catalog=await db.query<{result:unknown[]}>('SELECT public.worker_category_catalog() result');
   expect(catalog.rows[0].result).toEqual([{id:category,label:'Master Mason',archived:false,revision:4}]);
   const history=await db.query<{result:{items:Array<{action:string;after_revision:number}>;has_more:boolean}}>('SELECT public.worker_category_history($1) result',[category]);
   expect(history.rows[0].result.items.map(e=>[e.action,e.after_revision])).toEqual([['restore',4],['archive',3],['rename',2],['add',1]]);
   expect(history.rows[0].result.has_more).toBe(false);
   await expect(db.query('SELECT public.worker_category_history($1,now(),NULL)',[category])).rejects.toThrow(/cursor/);
   await db.exec(`SET test.uid='${otherFounder}'`);
   await expect(change(req,category,'add','Mason',null)).rejects.toThrow(/different category change/);
   await db.exec('RESET ROLE');
   expect((await db.query('SELECT position FROM public.workers')).rows).toEqual([{position:'Old Mason'}]);
   expect((await db.query('SELECT status FROM public.payroll')).rows).toEqual([{status:'paid'}]);
   expect((await db.query<{count:number}>('SELECT count(*)::int AS count FROM public.worker_category_events')).rows[0].count).toBe(4);
   await db.exec(`INSERT INTO public.worker_category_events(request_id,category_id,actor_id,action,after_label,after_archived,after_revision,occurred_at)
     SELECT md5('synthetic-'||i)::uuid,'${category}','${founder}','rename','Synthetic',false,4,'2099-01-01'::timestamptz+i*interval '1 second' FROM generate_series(1,105) i;
     SET test.uid='${founder}';SET ROLE authenticated`);
   type Page={items:Array<{request_id:string;occurred_at:string}>;has_more:boolean};
   const page1=(await db.query<{result:Page}>('SELECT public.worker_category_history($1) result',[category])).rows[0].result;
   expect(page1.items).toHaveLength(100);expect(page1.has_more).toBe(true);
   const cursor=page1.items[99];
   const page2=(await db.query<{result:Page}>('SELECT public.worker_category_history($1,$2,$3) result',[category,cursor.occurred_at,cursor.request_id])).rows[0].result;
   expect(page2.items).toHaveLength(9);expect(page2.has_more).toBe(false);
   expect(new Set([...page1.items,...page2.items].map(x=>x.request_id)).size).toBe(109);

  }finally{await db.close();}
 },30000);
});
