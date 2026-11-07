import {describe,expect,it,vi} from 'vitest';
import {revokeSupervisorAccess} from '@/lib/users/revokeAccess';
const actor='00000000-0000-4000-8000-000000000001',target='00000000-0000-4000-8000-000000000002';
function setup(){const rpc=vi.fn(async()=>({data:true as unknown,error:null as unknown}));const updateUserById=vi.fn(async()=>({data:{user:{id:target}},error:null as unknown}));const db={rpc,auth:{admin:{updateUserById}}};return {rpc,updateUserById,run:()=>revokeSupervisorAccess({db,actorId:actor,targetId:target})};}
describe('staged Supervisor access service',()=>{
  it('blocks database access before requesting an Auth ban',async()=>{const {rpc,updateUserById,run}=setup();expect(await run()).toEqual({ok:true,alreadyRevoked:false,authBanConfirmed:true});expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(updateUserById.mock.invocationCallOrder[0]);expect(updateUserById).toHaveBeenCalledWith(target,{ban_duration:'876000h'});});
  it('never changes Auth when database revocation is uncertain',async()=>{const {rpc,updateUserById,run}=setup();rpc.mockRejectedValue(Error('lost'));expect(await run()).toMatchObject({ok:false});expect(updateUserById).not.toHaveBeenCalled();});
  it('reports an uncertain Auth response instead of claiming the login ban succeeded',async()=>{const {updateUserById,run}=setup();updateUserById.mockRejectedValue(Error('lost'));expect(await run()).toMatchObject({ok:true,authBanConfirmed:false,warning:expect.stringMatching(/not confirmed/)});});
  it('can retry the login ban on an already blocked Supervisor',async()=>{const {rpc,run}=setup();rpc.mockResolvedValue({data:false,error:null});expect(await run()).toMatchObject({ok:true,alreadyRevoked:true,authBanConfirmed:true});});
  it('refuses self-deactivation before making any calls',async()=>{const {rpc,updateUserById}=setup();expect(await revokeSupervisorAccess({db:{rpc,auth:{admin:{updateUserById}}},actorId:actor,targetId:actor})).toMatchObject({ok:false});expect(rpc).not.toHaveBeenCalled();});
});
