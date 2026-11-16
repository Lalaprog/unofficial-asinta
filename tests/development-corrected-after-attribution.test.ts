import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {describe,expect,it} from 'vitest';
const generator=readFileSync('scripts/build-development-corrected-after-attribution.mjs','utf8');
const old=readFileSync('supabase/release/development-corrected-review.sql','utf8');
const attribution=readFileSync('supabase/release/development-correction-attribution.sql','utf8');
const built=readFileSync('supabase/release/development-corrected-after-attribution.sql','utf8');
function fixture(){const d=mkdtempSync(join(tmpdir(),'post-attribution-'));mkdirSync(join(d,'scripts'));mkdirSync(join(d,'supabase/release'),{recursive:true});writeFileSync(join(d,'scripts/build.mjs'),generator);writeFileSync(join(d,'supabase/release/development-corrected-review.sql'),old);writeFileSync(join(d,'supabase/release/development-correction-attribution.sql'),attribution);return d;}
describe('post-attribution development candidate',()=>{
 it('reproduces the held bundle, replacing only the installed section',()=>{const d=fixture();try{execFileSync('node',['scripts/build.mjs'],{cwd:d});expect(readFileSync(join(d,'supabase/release/development-corrected-after-attribution.sql'),'utf8')).toBe(built);expect(built).not.toContain(attribution);expect(built).toContain('installed_attribution_preflight');expect(built).toContain('Corrected review preparation is held pending target verification');expect(built).toContain(readFileSync('supabase/drafts/project_cost_correction_inventory.sql','utf8'));expect(built).toContain(readFileSync('supabase/drafts/project_cost_corrected_preview.sql','utf8'));expect(built).toContain(readFileSync('supabase/drafts/project_cost_corrected_review_ledger.sql','utf8'));expect(built).toContain(readFileSync('supabase/preflight/development-corrected-writer-audit.sql','utf8'));}finally{rmSync(d,{recursive:true,force:true});}});
 it('rejects changed inputs and arguments',()=>{for(const p of ['development-corrected-review.sql','development-correction-attribution.sql']){const d=fixture();try{writeFileSync(join(d,'supabase/release',p),'changed');expect(()=>execFileSync('node',['scripts/build.mjs'],{cwd:d,stdio:'pipe'})).toThrow();}finally{rmSync(d,{recursive:true,force:true});}}const d=fixture();try{expect(()=>execFileSync('node',['scripts/build.mjs','--install'],{cwd:d,stdio:'pipe'})).toThrow();}finally{rmSync(d,{recursive:true,force:true});}});
 it('fails before objects are created without the explicit hold',async()=>{const db=new PGlite();try{await expect(db.exec(`BEGIN;${built} COMMIT`)).rejects.toThrow(/held pending target verification/);await db.exec('ROLLBACK');expect((await db.query("SELECT to_regclass('public.project_cost_corrected_reviews') IS NULL absent")).rows[0]).toEqual({absent:true});}finally{await db.close();}},30000);
});
