import {describe,expect,it,vi} from 'vitest';
import {downloadInboxPhoto,matchesReceiptFile,parseReceiptItem,parseReceiptPage,prepareInboxItem,receiptDigest,uploadAndFinishInbox} from '@/lib/expenses/receiptInbox';
const owner='11111111-1111-4111-8111-111111111111',id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const item={id,saved_by:owner,object_path:`${owner}/inbox/${id}.jpg`,file_name:'photo.jpg',mime_type:'image/jpeg',file_size:3,sha256:'a'.repeat(64),status:'pending' as const,created_at:'2026-10-01T00:00:00+00:00'};
describe('receipt inbox preparation and recovery',()=>{
 it('validates rows and cursor responses',()=>{
  expect(parseReceiptItem(item)).toEqual(item);expect(parseReceiptPage({items:[item],has_more:false}).items).toHaveLength(1);
  for(const bad of [{...item,object_path:'https://evil.test/x'}, {...item,sha256:'bad'}, {...item,status:'other'}, {...item,saved_by:'bad'}]) expect(()=>parseReceiptItem(bad)).toThrow();
  expect(()=>parseReceiptPage({items:[],has_more:true})).toThrow();
 });
 it('builds bounded metadata and checks the same content on retry',async()=>{
  const file=new File(['abc'],'photo.jpg',{type:'image/jpeg'});const prepared=await prepareInboxItem(owner,file);
  expect(prepared.object_path).toContain(`${owner}/inbox/`);expect(prepared.sha256).toBe(await receiptDigest(file));
  expect(matchesReceiptFile({...prepared,status:'pending' as const,created_at:item.created_at},file,prepared.sha256)).toBe(true);
  expect(matchesReceiptFile({...prepared,status:'pending' as const,created_at:item.created_at},new File(['abd'],'other.jpg',{type:'image/jpeg'}),await receiptDigest(new File(['abd'],'other.jpg',{type:'image/jpeg'})))).toBe(false);
 });
 it('canonicalizes the JPEG alias consistently for inbox upload and retry',async()=>{
  const file=new File(['abc'],'photo.jpg',{type:'image/jpg'}),prepared=await prepareInboxItem(owner,file);
  const data={...prepared,status:'pending' as const,created_at:item.created_at};
  const upload=vi.fn().mockResolvedValue({error:null});const query={eq:vi.fn().mockReturnThis(),select:vi.fn().mockReturnThis(),maybeSingle:vi.fn().mockResolvedValue({data:{...data,status:'ready'},error:null})};
  const client={storage:{from:()=>({upload})},from:()=>({update:()=>query})};
  expect(prepared.mime_type).toBe('image/jpeg');expect(await uploadAndFinishInbox(client as never,data,file)).toBe(true);
  const [path,body,options]=upload.mock.calls[0] as unknown as [string,File,unknown];
  expect(path).toBe(prepared.object_path);expect(body.type).toBe('image/jpeg');expect(await receiptDigest(body)).toBe(prepared.sha256);expect(options).toEqual({upsert:false,contentType:'image/jpeg'});
 });
 it('checks database completion after an ambiguous upload response',async()=>{
  const file=new File(['abc'],'photo.jpg',{type:'image/jpeg'}),digest=await receiptDigest(file);const data={...item,sha256:digest};
  const upload=vi.fn().mockRejectedValue(new Error('timeout'));
  const maybeSingle=vi.fn().mockResolvedValue({data:{...data,status:'ready'},error:null});
  const query={eq:vi.fn().mockReturnThis(),select:vi.fn().mockReturnThis(),maybeSingle};
  const client={storage:{from:()=>({upload})},from:()=>({update:()=>query})};
  expect(await uploadAndFinishInbox(client as never,data,file)).toBe(true);expect(upload).toHaveBeenCalledTimes(1);
 });
 it('reads only a ready private photo whose bytes match its recorded digest',async()=>{
  const file=new File(['abc'],'photo.jpg',{type:'image/jpeg'}),digest=await receiptDigest(file);
  const ready={...item,status:'ready' as const,sha256:digest};
  const download=vi.fn().mockResolvedValue({data:new Blob(['abc'],{type:'image/jpeg'}),error:null});
  const client={storage:{from:()=>({download})}};
  expect((await downloadInboxPhoto(client as never,ready)).size).toBe(3);
  expect(download).toHaveBeenCalledWith(item.object_path);
  download.mockResolvedValue({data:new Blob(['bad'],{type:'image/jpeg'}),error:null});
  await expect(downloadInboxPhoto(client as never,ready)).rejects.toThrow(/no longer matches/);
  await expect(downloadInboxPhoto(client as never,item)).rejects.toThrow(/not ready/);
 });

});
