import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PGlite} from '@electric-sql/pglite';
import {describe,expect,it} from 'vitest';

const generator=readFileSync('scripts/build-development-bale-idempotent.mjs','utf8');
const candidate=readFileSync('supabase/drafts/weekly_bale_idempotent_submission.sql','utf8');
const artifact=readFileSync('supabase/release/development-bale-idempotent.sql','utf8');
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'bale-release-'));
 mkdirSync(join(dir,'scripts'));mkdirSync(join(dir,'supabase/drafts'),{recursive:true});
 writeFileSync(join(dir,'scripts/build.mjs'),generator);
 writeFileSync(join(dir,'supabase/drafts/weekly_bale_idempotent_submission.sql'),candidate);
 return dir;
}
describe('development Bale exact retry bundle',()=>{
 it('is deterministic, pins the source and retains the reviewed candidate',()=>{
  const dir=fixture();try{execFileSync('node',['scripts/build.mjs'],{cwd:dir});expect(readFileSync(join(dir,'supabase/release/development-bale-idempotent.sql'),'utf8')).toBe(artifact);expect(artifact).toContain(candidate);expect(artifact).toContain('Request trigger changed');expect(artifact).toContain('Bale dependency changed');}finally{rmSync(dir,{recursive:true,force:true});}
 });
 it('refuses changed source and unexpected arguments',()=>{
  const dir=fixture();try{writeFileSync(join(dir,'supabase/drafts/weekly_bale_idempotent_submission.sql'),candidate+'\n-- drift');expect(()=>execFileSync('node',['scripts/build.mjs'],{cwd:dir,stdio:'pipe'})).toThrow();expect(()=>execFileSync('node',['scripts/build.mjs','extra'],{cwd:dir,stdio:'pipe'})).toThrow();}finally{rmSync(dir,{recursive:true,force:true});}
 });
 it('fails closed before any DDL without deliberate development review',async()=>{
  const db=new PGlite();try{await expect(db.exec(`BEGIN;${artifact} COMMIT;`)).rejects.toThrow(/held pending review/);await db.exec('ROLLBACK');expect((await db.query("SELECT to_regprocedure('public.submit_weekly_bale_request(uuid,uuid,uuid,numeric,date)') IS NULL AS absent")).rows[0]).toEqual({absent:true});}finally{await db.close();}
 },30000);
});
