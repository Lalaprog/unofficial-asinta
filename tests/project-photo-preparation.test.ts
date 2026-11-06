// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkProjectPhotoSelection, prepareProjectPhoto } from '@/lib/projects/preparePhoto';

afterEach(()=>vi.restoreAllMocks());
describe('project photo preparation',()=>{
 it('accepts phone-size photos and rejects unsupported or over-20-MB input',()=>{
  expect(checkProjectPhotoSelection({type:'image/jpeg',size:15*1024*1024})).toBeNull();
  expect(checkProjectPhotoSelection({type:'image/heic',size:1})).toContain('JPEG');
  expect(checkProjectPhotoSelection({type:'image/png',size:20*1024*1024+1})).toContain('20 MB');
 });
 it('downscales on the device, preserves transparency formats, and revokes the temporary URL',async()=>{
  const original=globalThis.Image;
  class FakeImage { naturalWidth=4000; naturalHeight=2000; onload:()=>void=()=>{};onerror:()=>void=()=>{};set src(_v:string){queueMicrotask(()=>this.onload())} }
  vi.stubGlobal('Image',FakeImage);
  const revoke=vi.fn();URL.createObjectURL=vi.fn(()=> 'blob:test');URL.revokeObjectURL=revoke;
  const draw=vi.fn();vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:draw} as unknown as CanvasRenderingContext2D);
  const toBlob=vi.spyOn(HTMLCanvasElement.prototype,'toBlob').mockImplementation(function(callback,type){callback(new Blob(['x'],{type}));});
  const photo=new File(['original'],'photo.png',{type:'image/png'});const result=await prepareProjectPhoto(photo);
  expect(toBlob).toHaveBeenCalledWith(expect.any(Function),'image/webp',0.84);expect(result.type).toBe('image/webp');expect(draw).toHaveBeenCalledWith(expect.anything(),0,0,1920,960);expect(revoke).toHaveBeenCalledWith('blob:test');expect(photo.name).toBe('photo.png');
  vi.stubGlobal('Image',original);
 });
 it('does not upload the original if preparation fails',async()=>{
  class BadImage {onload=()=>{};onerror=()=>{};set src(_v:string){queueMicrotask(()=>this.onerror())}}
  vi.stubGlobal('Image',BadImage);URL.createObjectURL=vi.fn(()=> 'blob:test');URL.revokeObjectURL=vi.fn();
  await expect(prepareProjectPhoto(new File(['x'],'broken.jpg',{type:'image/jpeg'}))).rejects.toThrow('Could not read');expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test');vi.unstubAllGlobals();
 });
});
