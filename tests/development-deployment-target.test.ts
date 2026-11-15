import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const ref='abcdefghijklmnopqrst';
const good={NEXT_PUBLIC_DEVELOPMENT_FINANCE_CUTOVER:'true',NEXT_PUBLIC_DEVELOPMENT_BALE_SUPABASE_REF:ref,NEXT_PUBLIC_DEVELOPMENT_CORRECTION_SUPABASE_REF:ref,NEXT_PUBLIC_SUPABASE_URL:`https://${ref}.supabase.co`,NEXT_PUBLIC_SUPABASE_ANON_KEY:'test-public-key'};
const run=(overrides:Record<string,string|undefined>)=>spawnSync(process.execPath,['scripts/check-development-deployment-target.mjs'],{env:{PATH:process.env.PATH,NODE_ENV:'test',...good,...overrides},encoding:'utf8'});
describe('development deployment target check',()=>{
 it('is run by the deployment build and accepts the configured target',()=>{
  expect(JSON.parse(readFileSync('package.json','utf8')).scripts.build).toContain('node scripts/check-development-deployment-target.mjs && next build');
  expect(run({}).status).toBe(0);
 });
 it('rejects missing or unsafe targets, different references and missing client key',()=>{
  for(const x of [
   {NEXT_PUBLIC_SUPABASE_URL:''},{NEXT_PUBLIC_SUPABASE_URL:'invalid'}, {NEXT_PUBLIC_SUPABASE_URL:`http://${ref}.supabase.co`},
   {NEXT_PUBLIC_SUPABASE_URL:`https://${ref}.supabase.co.evil.test`},{NEXT_PUBLIC_SUPABASE_URL:`https://user@${ref}.supabase.co`},
   {NEXT_PUBLIC_SUPABASE_URL:`https://${ref}.supabase.co/path`},{NEXT_PUBLIC_SUPABASE_URL:`https://${ref}.supabase.co/?x=1`},
   {NEXT_PUBLIC_DEVELOPMENT_BALE_SUPABASE_REF:''},{NEXT_PUBLIC_DEVELOPMENT_CORRECTION_SUPABASE_REF:'other'}, {NEXT_PUBLIC_SUPABASE_ANON_KEY:''}
  ])expect(run(x).status,JSON.stringify(x)).toBe(1);
 });
 it('never prints values on failure, and does not require development configuration in other modes',()=>{
  const bad=run({NEXT_PUBLIC_SUPABASE_URL:'https://user:password@bad.test',NEXT_PUBLIC_SUPABASE_ANON_KEY:'sensitive-key'});
  expect(bad.stderr).not.toContain('password');expect(bad.stderr).not.toContain('sensitive-key');expect(bad.stdout).not.toContain('bad.test');
  expect(run({NEXT_PUBLIC_DEVELOPMENT_FINANCE_CUTOVER:'false',NEXT_PUBLIC_SUPABASE_URL:'',NEXT_PUBLIC_SUPABASE_ANON_KEY:''}).status).toBe(0);
 });
});
