import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const audit=readFileSync('supabase/preflight/development-corrected-writer-audit.sql','utf8');
const entries=[...audit.matchAll(/\('(public\.[^']+)',\s*'([a-f0-9]{64})',\s*(true|false)\)/g)].map(([,signature,digest,allowed])=>({signature,digest,allowed:allowed==='true'}));
async function fixture(){
 const db=new PGlite();await db.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA app_private;');
 if(entries.length!==12)throw Error('Unexpected audit inventory');
 for(const e of entries){
  await db.exec(`CREATE FUNCTION ${e.signature} RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN UPDATE public.expenses SET id=id WHERE false;RETURN NULL;END$$; REVOKE ALL ON FUNCTION ${e.signature} FROM PUBLIC,anon,authenticated,service_role; ${e.allowed?`GRANT EXECUTE ON FUNCTION ${e.signature} TO authenticated;`:''}`);
 }
 let synthetic=audit;
 for(const e of entries){const hash=(await db.query<{h:string}>('SELECT encode(sha256(convert_to(pg_get_functiondef(to_regprocedure($1)),\'UTF8\')),\'hex\') h',[e.signature])).rows[0].h;synthetic=synthetic.replace(e.digest,hash);}
 return {db,synthetic};
}
describe('development corrected source writer catalog guard',()=>{
 it('accepts its exact synthetic catalog and rejects body, permission and new-writer drift',async()=>{const {db,synthetic}=await fixture();try{
  await db.exec(synthetic);
  const internal=entries.find(x=>!x.allowed)!;
  await db.exec(`ALTER FUNCTION ${internal.signature} SECURITY INVOKER`);await expect(db.exec(synthetic)).rejects.toThrow(/source writer changed/);await db.exec(`ALTER FUNCTION ${internal.signature} SECURITY DEFINER`);
  await db.exec(`GRANT EXECUTE ON FUNCTION ${internal.signature} TO PUBLIC`);await expect(db.exec(synthetic)).rejects.toThrow(/source writer changed/);await db.exec(`REVOKE EXECUTE ON FUNCTION ${internal.signature} FROM PUBLIC`);
  await db.exec(`GRANT EXECUTE ON FUNCTION ${internal.signature} TO authenticated`);await expect(db.exec(synthetic)).rejects.toThrow(/source writer changed/);
  await db.exec(`REVOKE EXECUTE ON FUNCTION ${internal.signature} FROM authenticated`);
  await db.exec('CREATE FUNCTION public.extra_writer() RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN DELETE FROM public.expenses WHERE false;END$$');
  await expect(db.exec(synthetic)).rejects.toThrow(/Additional selected textual source writer/);await db.exec('DROP FUNCTION public.extra_writer()');
  await db.exec(`CREATE OR REPLACE FUNCTION ${internal.signature} RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN UPDATE public.expenses SET id=id WHERE true;RETURN NULL;END$$`);
  await expect(db.exec(synthetic)).rejects.toThrow(/source writer changed/);
 }finally{await db.close();}},30000);
 it('fails when a required selected writer is absent',async()=>{const {db,synthetic}=await fixture();try{
  await db.exec(`DROP FUNCTION ${entries[0].signature}`);await expect(db.exec(synthetic)).rejects.toThrow(/source writer changed/);
 }finally{await db.close();}},30000);
});
