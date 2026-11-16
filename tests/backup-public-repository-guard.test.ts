import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {describe,expect,it} from 'vitest';

describe('partial export public-repository guard',()=>{
 it('fails closed before secrets or dump for public and missing repository metadata',()=>{
  const workflow=readFileSync('.github/workflows/backup.yml','utf8');
  const match=workflow.match(/      - name: Refuse unencrypted exports from public repositories\n[\s\S]*?        run: \|\n([\s\S]*?)(?=\n      - name:)/);
  expect(match).not.toBeNull();
  const script=match![1].split('\n').map(line=>line.startsWith('          ')?line.slice(10):line).join('\n');
  expect(workflow.indexOf('Refuse unencrypted exports from public repositories')).toBeLessThan(workflow.indexOf('Check the database URL secret'));
  expect(workflow).toContain('REPOSITORY_PRIVATE: ${{ github.event.repository.private }}');
  for(const value of ['false','', 'TRUE','1']){
   const result=spawnSync('bash',['-e','-c',script],{encoding:'utf8',env:{...process.env,REPOSITORY_PRIVATE:value}});
   expect(result.status).not.toBe(0);expect(result.stdout).toMatch(/must not be uploaded from a public repository/);
  }
  const privateResult=spawnSync('bash',['-e','-c',script],{encoding:'utf8',env:{...process.env,REPOSITORY_PRIVATE:'true'}});
  expect(privateResult.status).toBe(0);
 });
});
