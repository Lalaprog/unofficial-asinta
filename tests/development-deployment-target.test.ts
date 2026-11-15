import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const ref='abcdefghijklmnopqrst';
const good={NEXT_PUBLIC_DEVELOPMENT_FINANCE_CUTOVER:'true',NEXT_PUBLIC_DEVELOPMENT_BALE_SUPABASE_REF:ref,NEXT_PUBLIC_DEVELOPMENT_CORRECTION_SUPABASE_REF:ref,NEXT_PUBLIC_SUPABASE_URL:`https://${ref}.supabase.co`,NEXT_PUBLIC_SUPABASE_ANON_KEY:'test-public-key'};
const run=(overrides:Record<string,string|undefined>)=>spawnSync(process.execPath,['scripts/check-development-deployment-target.mjs'],{env:{PATH:process.env.PATH,NODE_ENV:'test',...good,...overrides},encoding:'utf8'});
const flags=['NEXT_PUBLIC_DEVELOPMENT_SITE','NEXT_PUBLIC_DEVELOPMENT_FINANCE_CUTOVER','NEXT_PUBLIC_SUPERVISOR_PAYROLL_REVISION_PREVIEW','NEXT_PUBLIC_SUPERVISOR_REVISION_HISTORY_PREVIEW','NEXT_PUBLIC_WORKER_CATEGORY_PREVIEW','NEXT_PUBLIC_WORKER_CATEGORY_WORKFORCE_PREVIEW','NEXT_PUBLIC_SUPERVISOR_PORTRAIT_PREVIEW','NEXT_PUBLIC_WEEKLY_BALE_IDEMPOTENT_SUBMISSION_PREVIEW','NEXT_PUBLIC_PROJECT_COST_CORRECTION_PREVIEW','NEXT_PUBLIC_CORRECTED_PROJECT_COST_REVIEW_PREVIEW'];
const releaseRef='mchkdkjntnbwrgmyobpd';
const sha='a'.repeat(40);
const release={...Object.fromEntries(flags.map(flag=>[flag,'true'])),VERCEL_ENV:'production',VERCEL_GIT_COMMIT_REF:'arena/e137cf5b-unofficial-asinta',VERCEL_GIT_COMMIT_SHA:sha,ASINTA_DEVELOPMENT_RELEASE_SHA:sha,NEXT_PUBLIC_DEVELOPMENT_BALE_SUPABASE_REF:releaseRef,NEXT_PUBLIC_DEVELOPMENT_CORRECTION_SUPABASE_REF:releaseRef,NEXT_PUBLIC_SUPABASE_URL:`https://${releaseRef}.supabase.co`};
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
 it('only allows a production build for the pinned development release and complete configuration',()=>{
  expect(run(release).status).toBe(0);
  for(const flag of flags)expect(run({...release,[flag]:''}).status,flag).toBe(1);
  for(const override of [
   {VERCEL_GIT_COMMIT_REF:'main'},{VERCEL_GIT_COMMIT_SHA:'b'.repeat(40)},
   {ASINTA_DEVELOPMENT_RELEASE_SHA:''},{ASINTA_DEVELOPMENT_RELEASE_SHA:'A'.repeat(40)},{AUTOMATIC_REMINDERS_ENABLED:'true'},
   {NEXT_PUBLIC_DEVELOPMENT_BALE_SUPABASE_REF:ref,NEXT_PUBLIC_DEVELOPMENT_CORRECTION_SUPABASE_REF:ref,NEXT_PUBLIC_SUPABASE_URL:`https://${ref}.supabase.co`},
   {NEXT_PUBLIC_SUPABASE_URL:'https://wrong.example'},{NEXT_PUBLIC_SUPABASE_ANON_KEY:''}
  ])expect(run({...release,...override}).status).toBe(1);
 });
 it('never prints values on failure, and does not require development configuration in other modes',()=>{
  const bad=run({NEXT_PUBLIC_SUPABASE_URL:'https://user:password@bad.test',NEXT_PUBLIC_SUPABASE_ANON_KEY:'sensitive-key'});
  expect(bad.stderr).not.toContain('password');expect(bad.stderr).not.toContain('sensitive-key');expect(bad.stdout).not.toContain('bad.test');
  expect(run({NEXT_PUBLIC_DEVELOPMENT_FINANCE_CUTOVER:'false',NEXT_PUBLIC_SUPABASE_URL:'',NEXT_PUBLIC_SUPABASE_ANON_KEY:''}).status).toBe(0);
 });
});
