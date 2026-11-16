import {describe,expect,it,vi} from 'vitest';
import {check,connectionConfig} from '../scripts/check-weekly-bale-expiry.mjs';

const env={BALE_MONITOR_DATABASE_URL:'postgresql://bale_monitor:private@db.example.invalid/postgres?sslmode=verify-full',BALE_MONITOR_DATABASE_ROLE:'bale_monitor'};
const safe={role_name:'bale_monitor',session_role:'bale_monitor',superuser:false,bypass_rls:false,create_role:false,create_db:false,replication:false,elevated_membership:false,schema_create:false,owns_monitor:false,can_run_job:false,table_access:false};
function client(role:object=safe,health:unknown=true){
 const c={connect:vi.fn().mockResolvedValue(undefined),query:vi.fn().mockResolvedValueOnce({rows:[role]}).mockResolvedValueOnce({rows:[{healthy:health}]}),end:vi.fn().mockResolvedValue(undefined)};
 return c;
}
describe('external Bale expiry probe',()=>{
 it('requires certificate verification and never allows connection string SSL overrides',()=>{
  expect(connectionConfig(env).options.ssl).toEqual({rejectUnauthorized:true});
  expect(connectionConfig(env).options.connectionString).not.toContain('sslmode=');
  for(const url of ['postgresql://x:y@host/db','postgresql://x:y@host/db?sslmode=require','postgresql://x:y@host/db?sslmode=verify-full&sslmode=disable','postgresql://x:y@host/db?sslmode=verify-full&sslrootcert=x'])
   expect(()=>connectionConfig({...env,BALE_MONITOR_DATABASE_URL:url})).toThrow();
 });
 it('reports healthy only after role checks and a positive fresh database signal',async()=>{
  const c=client();expect(await check(env,()=>c as never)).toBe(true);expect(c.query).toHaveBeenCalledTimes(2);expect(c.end).toHaveBeenCalledOnce();
  for(const health of [false,null,'true',1]){const c=client(safe,health);expect(await check(env,()=>c as never)).toBe(false);expect(c.end).toHaveBeenCalledOnce();}
 });
 it('fails closed for privileged, wrong or malformed roles before reading health',async()=>{
  for(const change of [{role_name:'postgres'},{session_role:'postgres'},{superuser:true},{bypass_rls:true},{create_role:true},{create_db:true},{replication:true},{elevated_membership:true},{schema_create:true},{owns_monitor:true},{can_run_job:true},{table_access:true},{table_access:null}]){
   const c=client({...safe,...change});expect(await check(env,()=>c as never)).toBe(false);expect(c.query).toHaveBeenCalledTimes(1);expect(c.end).toHaveBeenCalledOnce();
  }
 });
 it('fails closed on connection and query errors without exposing them',async()=>{
  const c=client();c.connect.mockRejectedValueOnce(Error('a secret'));expect(await check(env,()=>c as never)).toBe(false);expect(c.end).toHaveBeenCalledOnce();
  const d=client();d.query.mockReset().mockRejectedValueOnce(Error('a secret'));expect(await check(env,()=>d as never)).toBe(false);expect(d.end).toHaveBeenCalledOnce();
  expect(await check({...env,BALE_MONITOR_DATABASE_ROLE:'UPPERCASE'},()=>client() as never)).toBe(false);
 });
});
