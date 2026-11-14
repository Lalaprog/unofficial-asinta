import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const file=readFileSync('supabase/release/development-disable-legacy-bale-writers.sql','utf8');
const fingerprints: Record<string,string>={
 'public.issue_advance_request(uuid)':'e13682f4109effd605b0e6f4345442cb',
 'public.record_advance_deduction_atomic(uuid,numeric)':'48bf0e5af8ac1069b6a195c6450ef5f1',
 'public.record_weekly_bale_release(uuid)':'cef0a73eba1cab46cba3406a339c9e94',
 'public.record_weekly_worker_payment(uuid,date,bigint)':'24f9a6cceda75d6b8c978ff738b8a655',
};
async function fixture(){
 const db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
 CREATE TABLE public.advances(id integer); CREATE TABLE public.advance_requests(id integer); CREATE TABLE public.payroll(id integer);
 CREATE FUNCTION public.issue_advance_request(uuid) RETURNS integer LANGUAGE sql AS $$SELECT 1$$;
 CREATE FUNCTION public.record_advance_deduction_atomic(uuid,numeric) RETURNS integer LANGUAGE sql AS $$SELECT 1$$;
 CREATE FUNCTION public.record_weekly_bale_release(uuid) RETURNS integer LANGUAGE sql AS $$SELECT 1$$;
 CREATE FUNCTION public.record_weekly_worker_payment(uuid,date,bigint) RETURNS integer LANGUAGE sql AS $$SELECT 1$$;
 CREATE FUNCTION public.review_advance_request(uuid,text) RETURNS integer LANGUAGE sql AS $$SELECT 1$$;
 REVOKE ALL ON FUNCTION public.issue_advance_request(uuid),public.record_advance_deduction_atomic(uuid,numeric),public.record_weekly_bale_release(uuid),public.record_weekly_worker_payment(uuid,date,bigint),public.review_advance_request(uuid,text) FROM PUBLIC;
 GRANT EXECUTE ON FUNCTION public.issue_advance_request(uuid),public.record_advance_deduction_atomic(uuid,numeric) TO authenticated,service_role;
 GRANT EXECUTE ON FUNCTION public.record_weekly_bale_release(uuid),public.record_weekly_worker_payment(uuid,date,bigint),public.review_advance_request(uuid,text) TO authenticated;
 CREATE FUNCTION public.guard_weekly_bale_transition() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
 CREATE FUNCTION public.guard_weekly_bale_balance_cutover() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
 CREATE FUNCTION public.require_weekly_bale_source_on_insert() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
 CREATE FUNCTION public.guard_weekly_worker_draft() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
 CREATE FUNCTION public.require_weekly_worker_source_on_insert() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
 CREATE TRIGGER guard_weekly_bale_transition BEFORE UPDATE ON public.advance_requests FOR EACH ROW EXECUTE FUNCTION public.guard_weekly_bale_transition();
 CREATE TRIGGER guard_weekly_bale_balance_cutover BEFORE UPDATE ON public.advances FOR EACH ROW EXECUTE FUNCTION public.guard_weekly_bale_balance_cutover();
 CREATE TRIGGER require_weekly_bale_source_on_insert BEFORE INSERT ON public.advances FOR EACH ROW EXECUTE FUNCTION public.require_weekly_bale_source_on_insert();
 CREATE TRIGGER guard_weekly_worker_draft BEFORE UPDATE ON public.payroll FOR EACH ROW EXECUTE FUNCTION public.guard_weekly_worker_draft();
 CREATE TRIGGER require_weekly_worker_source_on_insert BEFORE INSERT ON public.payroll FOR EACH ROW EXECUTE FUNCTION public.require_weekly_worker_source_on_insert();`);
 // The actual script pins the hosted definitions; fixture stubs intentionally
 // differ, so substitute their real hashes without changing any other logic.
 let source=file;
 for(const [signature,hash] of Object.entries(fingerprints)){
  const result=await db.query<{hash:string}>('SELECT md5(pg_get_functiondef(to_regprocedure($1))) AS hash',[signature]);
  source=source.replace(hash,result.rows[0].hash);
 }
 return {db,source};
}
const allowed=async(db:PGlite,role:string,signature:string)=>(await db.query<{v:boolean}>("SELECT has_function_privilege($1,$2,'EXECUTE') v",[role,signature])).rows[0].v;

describe('target-specific legacy Bale writer ACL cutover',()=>{
 it('removes only old release and manual-deduction access while keeping weekly replacements and review',async()=>{
  const {db,source}=await fixture();try{
   await db.exec(`BEGIN;${source}COMMIT;`);
   for(const role of ['anon','authenticated','service_role'])for(const sig of Object.keys(fingerprints).slice(0,2)) expect(await allowed(db,role,sig)).toBe(false);
   for(const sig of [...Object.keys(fingerprints).slice(2),'public.review_advance_request(uuid,text)']) expect(await allowed(db,'authenticated',sig)).toBe(true);
   await db.exec('SET ROLE authenticated');
   await expect(db.query('SELECT public.issue_advance_request(NULL)')).rejects.toThrow(/permission denied/);
   expect((await db.query('SELECT public.record_weekly_bale_release(NULL) AS value')).rows[0]).toEqual({value:1});
  }finally{await db.close();}
 },30000);
 it.each(['data','function','trigger','replacement privilege','inherited privilege'])('fails closed on %s without partially changing direct grants',async(kind)=>{
  const {db,source}=await fixture();try{
   if(kind==='data') await db.exec('INSERT INTO public.advances VALUES (1)');
   if(kind==='function') await db.exec('CREATE OR REPLACE FUNCTION public.issue_advance_request(uuid) RETURNS integer LANGUAGE sql AS $$SELECT 2$$');
   if(kind==='trigger') await db.exec('ALTER TABLE public.advances DISABLE TRIGGER guard_weekly_bale_balance_cutover');
   if(kind==='replacement privilege') await db.exec('REVOKE EXECUTE ON FUNCTION public.record_weekly_bale_release(uuid) FROM authenticated');
   if(kind==='inherited privilege') await db.exec('CREATE ROLE legacy_inherited; GRANT EXECUTE ON FUNCTION public.issue_advance_request(uuid) TO legacy_inherited; GRANT legacy_inherited TO service_role');
   await expect(db.exec(`BEGIN;${source}COMMIT;`)).rejects.toThrow(); await db.exec('ROLLBACK');
   expect(await allowed(db,'authenticated','public.issue_advance_request(uuid)')).toBe(true);
   expect(await allowed(db,'authenticated','public.record_advance_deduction_atomic(uuid,numeric)')).toBe(true);
  }finally{await db.close();}
 },30000);
});
