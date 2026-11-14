import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {describe,expect,it} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
const generator=readFileSync('scripts/build-development-corrected-review.mjs','utf8');
const artifact=readFileSync('supabase/release/development-corrected-review.sql','utf8');
const paths=['supabase/release/development-correction-attribution.sql','supabase/drafts/project_cost_correction_inventory.sql','supabase/drafts/project_cost_corrected_preview.sql','supabase/drafts/project_cost_corrected_review_ledger.sql','supabase/preflight/development-corrected-writer-audit.sql'];
function fixture(){const dir=mkdtempSync(join(tmpdir(),'corrected-release-'));mkdirSync(join(dir,'scripts'));writeFileSync(join(dir,'scripts/build.mjs'),generator);for(const path of paths){mkdirSync(dirname(join(dir,path)),{recursive:true});writeFileSync(join(dir,path),readFileSync(path));}return dir;}
describe('development corrected review preparation artifact',()=>{
 it('is pinned, deterministic, and explicitly not approved',()=>{const dir=fixture();try{execFileSync('node',['scripts/build.mjs'],{cwd:dir});const built=readFileSync(join(dir,'supabase/release/development-corrected-review.sql'),'utf8');expect(built).toBe(artifact);expect(built).toContain('NOT APPROVED FOR EXECUTION');expect(built).toContain('Corrected review dependency drift');expect(built).toContain('Development source data changed');for(const path of paths)expect(built).toContain(readFileSync(path,'utf8'));}finally{rmSync(dir,{recursive:true,force:true});}});
 it('fails closed before making objects when the manual review hold is not deliberately cleared',async()=>{const db=new PGlite();try{await expect(db.exec(`BEGIN;${artifact} COMMIT`)).rejects.toThrow(/held pending target verification/);await db.exec('ROLLBACK');expect((await db.query("SELECT to_regclass('public.project_cost_corrected_reviews') IS NULL absent")).rows[0]).toEqual({absent:true});}finally{await db.close();}},30000);
 it('refuses each changed input and unexpected arguments',()=>{for(const path of paths){const dir=fixture();try{writeFileSync(join(dir,path),readFileSync(path,'utf8')+'\n-- changed');expect(()=>execFileSync('node',['scripts/build.mjs'],{cwd:dir,stdio:'pipe'})).toThrow();}finally{rmSync(dir,{recursive:true,force:true});}}const dir=fixture();try{expect(()=>execFileSync('node',['scripts/build.mjs','--unsafe'],{cwd:dir,stdio:'pipe'})).toThrow();}finally{rmSync(dir,{recursive:true,force:true});}});
});
