// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {prepareSupervisorPortrait} from '@/lib/users/supervisorPortrait';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('Supervisor portrait preparation',()=>{
 it('rejects unsupported, empty and over-limit selections before decoding',async()=>{
  const create=vi.fn();vi.stubGlobal('URL',{createObjectURL:create});
  for(const file of [new File(['x'],'x.svg',{type:'image/svg+xml'}),new File([],'x.png',{type:'image/png'}),new File([new Uint8Array(20*1024*1024+1)],'x.jpg',{type:'image/jpeg'})])
   await expect(prepareSupervisorPortrait(file)).rejects.toThrow(/Choose a nonempty JPEG/);
  expect(create).not.toHaveBeenCalled();
 });
 it('scales on device and revokes its object URL',async()=>{
  const revoke=vi.fn();vi.stubGlobal('URL',{createObjectURL:vi.fn(()=> 'blob:local'),revokeObjectURL:revoke});
  class FakeImage { naturalWidth=4000;naturalHeight=2000;onload:()=>void=()=>{};onerror:()=>void=()=>{};set src(_v:string){queueMicrotask(()=>this.onload());} }
  vi.stubGlobal('Image',FakeImage);
  const draw=vi.fn();vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:draw} as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype,'toBlob').mockImplementation(function(callback){callback(new Blob(['small'],{type:'image/jpeg'}));});
  // jsdom Blob lacks arrayBuffer; supply an encoded small output instead of the source.
  vi.spyOn(Blob.prototype,'arrayBuffer').mockImplementation(async()=>new TextEncoder().encode('small').buffer);
  const result=await prepareSupervisorPortrait(new File(['original'],'a.jpg',{type:'image/jpeg'}));
  expect(result).toEqual({mime:'image/jpeg',data:btoa('small')});
  expect(draw).toHaveBeenCalledWith(expect.any(FakeImage),0,0,512,256);expect(revoke).toHaveBeenCalledWith('blob:local');
 });
 it('revokes temporary URLs when decoding fails',async()=>{
  const revoke=vi.fn();vi.stubGlobal('URL',{createObjectURL:()=> 'blob:local',revokeObjectURL:revoke});
  class BadImage { onload=()=>{};onerror=()=>{};set src(_v:string){queueMicrotask(()=>this.onerror());} }
  vi.stubGlobal('Image',BadImage);
  await expect(prepareSupervisorPortrait(new File(['x'],'a.png',{type:'image/png'}))).rejects.toThrow(/could not be read/);
  expect(revoke).toHaveBeenCalledWith('blob:local');
 });
});
