import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {describe,expect,it} from 'vitest';
const generator=readFileSync('scripts/build-development-cross-site-review.mjs','utf8');
const paths=['supabase/drafts/project_cost_correction_original_context.sql','supabase/drafts/project_cost_cross_site_preview.sql','supabase/drafts/project_cost_cross_site_review_context.sql','supabase/drafts/project_cost_cross_site_corrected_preview.sql','supabase/drafts/project_cost_cross_site_review_ledger.sql','supabase/preflight/development-corrected-writer-audit.sql'];
const built=readFileSync('supabase/release/development-cross-site-review.sql','utf8');
function fixture(){const d=mkdtempSync(join(tmpdir(),'cross-site-bundle-'));mkdirSync(join(d,'scripts'));mkdirSync(join(d,'supabase/release'),{recursive:true});writeFileSync(join(d,'scripts/build.mjs'),generator);for(const p of paths){mkdirSync(dirname(join(d,p)),{recursive:true});writeFileSync(join(d,p),readFileSync(p));}return d;}
describe('development cross-site held bundle',()=>{
 it('reproduces exact pinned parts in dependency order with a hold and writer audit',()=>{const d=fixture();try{execFileSync('node',['scripts/build.mjs'],{cwd:d});expect(readFileSync(join(d,'supabase/release/development-cross-site-review.sql'),'utf8')).toBe(built);let last=0;for(const p of paths.slice(0,5)){const position=built.indexOf(readFileSync(p,'utf8'));expect(position).toBeGreaterThan(last);last=position;}expect(built).toContain(readFileSync(paths[5],'utf8'));expect(built).toContain('Cross-site preparation held pending target verification and rehearsal');expect(built).toContain('cross_site_development_preflight');}finally{rmSync(d,{recursive:true,force:true});}});
 it('refuses any changed source and command-line arguments',()=>{for(const p of paths){const d=fixture();try{writeFileSync(join(d,p),'changed');expect(()=>execFileSync('node',['scripts/build.mjs'],{cwd:d,stdio:'pipe'})).toThrow();}finally{rmSync(d,{recursive:true,force:true});}}const d=fixture();try{expect(()=>execFileSync('node',['scripts/build.mjs','--install'],{cwd:d,stdio:'pipe'})).toThrow();}finally{rmSync(d,{recursive:true,force:true});}});
 it('fails at the hold before creating anything without explicit review',async()=>{const db=new PGlite();try{await expect(db.exec(`BEGIN;${built} COMMIT`)).rejects.toThrow(/held pending target verification/);await db.exec('ROLLBACK');expect((await db.query("SELECT to_regclass('public.project_cost_cross_site_reviews') IS NULL absent")).rows[0]).toEqual({absent:true});}finally{await db.close();}},30000);
});
