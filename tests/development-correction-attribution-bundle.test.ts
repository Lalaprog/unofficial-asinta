import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';
const source=readFileSync('supabase/drafts/project_cost_correction_attribution.sql','utf8');
const generator=readFileSync('scripts/build-development-correction-attribution.mjs','utf8');
const artifact=readFileSync('supabase/release/development-correction-attribution.sql','utf8');
const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
function fixture(content:string){const dir=mkdtempSync(join(tmpdir(),'correction-bundle-'));mkdirSync(join(dir,'scripts'),{recursive:true});mkdirSync(join(dir,'supabase/drafts'),{recursive:true});mkdirSync(join(dir,'supabase/release'),{recursive:true});writeFileSync(join(dir,'scripts/build.mjs'),generator);writeFileSync(join(dir,'supabase/drafts/project_cost_correction_attribution.sql'),content);return dir;}
describe('development-only correction evidence artifact',()=>{
 it('reproduces the pinned artifact and names its exact source',()=>{const dir=fixture(source);try{execFileSync('node',['scripts/build.mjs'],{cwd:dir});expect(readFileSync(join(dir,'supabase/release/development-correction-attribution.sql'),'utf8')).toBe(artifact);expect(artifact).toContain('NOT YET APPROVED FOR EXECUTION');expect(artifact).toContain(`Source SHA256 ${digest(source)}`);expect(artifact).toContain('Business state changed');expect(artifact).toContain('Development schema differs');expect(artifact).toContain('Prerequisite function drift');expect(artifact).toContain('Source history guard changed');expect(artifact).toContain('Source table owner, RLS or write privilege changed');expect(artifact).toContain(source);}finally{rmSync(dir,{recursive:true,force:true});}});
 it('refuses modified source instead of silently producing a new release',()=>{const dir=fixture(source+'\n-- changed');try{expect(()=>execFileSync('node',['scripts/build.mjs'],{cwd:dir,stdio:'pipe'})).toThrow();}finally{rmSync(dir,{recursive:true,force:true});}});
});
