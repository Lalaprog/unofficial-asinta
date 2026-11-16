import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const run=(env:Record<string,string|undefined>)=>spawnSync('bash',['scripts/vercel-release-hold.sh'],{env:{PATH:process.env.PATH,NODE_ENV:'test',...env},encoding:'utf8'});
describe('temporary Vercel release hold',()=>{
 it('wires the checked-in ignore command to a script available before installation',()=>{
  const config=JSON.parse(readFileSync('vercel.json','utf8'));expect(config.ignoreCommand).toBe('bash scripts/vercel-release-hold.sh');
  expect(execFileSync('bash',['-n','scripts/vercel-release-hold.sh']).toString()).toBe('');
 });
 it('allows preview and development builds',()=>{
  for(const name of ['preview','development'])expect(run({VERCEL_ENV:name}).status).toBe(1);
 });
 it('only permits the pinned development branch release to build for production',()=>{
  const sha='a'.repeat(40);const release={VERCEL_ENV:'production',VERCEL_GIT_COMMIT_REF:'arena/e137cf5b-unofficial-asinta',VERCEL_GIT_COMMIT_SHA:sha,ASINTA_DEVELOPMENT_RELEASE_SHA:sha};
  expect(run(release).status).toBe(1);
  for(const override of [{VERCEL_GIT_COMMIT_REF:'main'},{VERCEL_GIT_COMMIT_SHA:'b'.repeat(40)},{ASINTA_DEVELOPMENT_RELEASE_SHA:''},{ASINTA_DEVELOPMENT_RELEASE_SHA:'A'.repeat(40)}])expect(run({...release,...override}).status).toBe(0);
 });
 it('holds production, missing and unexpected environments even with unrelated override-like values',()=>{
  for(const name of ['production','','Production','staging',' preView '])expect(run({VERCEL_ENV:name,ASINTA_PRODUCTION_RELEASE_SHA:'anything'}).status).toBe(0);
  expect(run({}).status).toBe(0);
 });
});
