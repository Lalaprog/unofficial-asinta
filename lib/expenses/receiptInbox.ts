import type {SupabaseClient} from '@supabase/supabase-js';
import {RECEIPT_BUCKET,validateReceiptFile} from '@/lib/supabase/receipts';

export interface ReceiptInboxItem {id:string;saved_by:string|null;object_path:string;file_name:string;mime_type:string;file_size:number;sha256:string;status:'pending'|'ready';created_at:string}
export interface ReceiptInboxPage {items:ReceiptInboxItem[];hasMore:boolean}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function parseReceiptItem(value:unknown):ReceiptInboxItem {
 if(!value || typeof value!=='object') throw new Error('Invalid saved photo');
 const x=value as Record<string,unknown>;
 if(typeof x.id!=='string'||!uuid.test(x.id)||!(x.saved_by===null||(typeof x.saved_by==='string'&&uuid.test(x.saved_by)))||typeof x.object_path!=='string'||!/^[-0-9a-f]{36}\/inbox\/[-0-9a-f]{36}\.(jpg|png|webp)$/.test(x.object_path)||typeof x.file_name!=='string'||!x.file_name.trim()||x.file_name.length>200||!['image/jpeg','image/png','image/webp'].includes(String(x.mime_type))||!Number.isSafeInteger(x.file_size)||Number(x.file_size)<1||Number(x.file_size)>5242880||typeof x.sha256!=='string'||! /^[0-9a-f]{64}$/.test(x.sha256)||!['pending','ready'].includes(String(x.status))||typeof x.created_at!=='string'||!Number.isFinite(Date.parse(x.created_at))) throw new Error('Invalid saved photo');
 const ext=x.mime_type==='image/jpeg'?'jpg':x.mime_type==='image/png'?'png':'webp';
 if(!x.object_path.endsWith(`/inbox/${x.id}.${ext}`) || (x.saved_by && !x.object_path.startsWith(`${x.saved_by}/`))) throw new Error('Invalid saved photo');
 return x as unknown as ReceiptInboxItem;
}
export function parseReceiptPage(value:unknown,cursor?:ReceiptInboxItem):ReceiptInboxPage {
 if(!value||typeof value!=='object') throw new Error('Invalid photo page');
 const page=value as {items?:unknown;has_more?:unknown};
 if(!Array.isArray(page.items)||page.items.length>20||typeof page.has_more!=='boolean'||(page.has_more&&page.items.length===0)) throw new Error('Invalid photo page');
 let previous=cursor;
 const items=page.items.map(raw=>{const item=parseReceiptItem(raw);if(previous && (Date.parse(item.created_at)>Date.parse(previous.created_at)||(item.created_at===previous.created_at && item.id>=previous.id))) throw new Error('Invalid photo cursor');previous=item;return item;});
 return {items,hasMore:page.has_more};
}
export async function receiptDigest(file:File):Promise<string> {
 const hash=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());
 return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
/** The same id/path is used on retries; never remove a potentially saved object. */
export async function prepareInboxItem(userId:string,file:File):Promise<Omit<ReceiptInboxItem,'status'|'created_at'>> {
 const check=validateReceiptFile(file);
 if(!check.ok || !check.extension || !uuid.test(userId)) throw new Error(check.error || 'Sign in as a Founder first.');
 const id=crypto.randomUUID();const mime=file.type.toLowerCase()==='image/jpg'?'image/jpeg':file.type.toLowerCase();
 return {id,saved_by:userId,object_path:`${userId}/inbox/${id}.${check.extension}`,file_name:file.name.trim().slice(0,200)||'Receipt photo',mime_type:mime,file_size:file.size,sha256:await receiptDigest(file)};
}
export function matchesReceiptFile(item:ReceiptInboxItem,file:File,digest:string):boolean {
 const mime=file.type.toLowerCase()==='image/jpg'?'image/jpeg':file.type.toLowerCase();
 return validateReceiptFile(file).ok && mime===item.mime_type && file.size===item.file_size && digest===item.sha256;
}
/** Upload may succeed even if its response is lost. Finish by checking the object in the database. */
export async function uploadAndFinishInbox(client:SupabaseClient,item:ReceiptInboxItem,file:File):Promise<boolean> {
 if(!matchesReceiptFile(item,file,await receiptDigest(file))) throw new Error('Choose the same photo that started this upload.');
 try {await client.storage.from(RECEIPT_BUCKET).upload(item.object_path,file,{upsert:false,contentType:item.mime_type});} catch { /* completion check below handles ambiguous upload */ }
 try {
  const {data,error}=await client.from('receipt_photo_inbox').update({status:'ready'}).eq('id',item.id).eq('status','pending').select('*').maybeSingle();
  const matchesReady=(value:unknown)=>{const saved=parseReceiptItem(value);return saved.status==='ready' && saved.id===item.id && saved.object_path===item.object_path && saved.sha256===item.sha256 && saved.file_size===item.file_size && saved.mime_type===item.mime_type;};
  if(!error && data && matchesReady(data)) return true;
  const checked=await client.from('receipt_photo_inbox').select('*').eq('id',item.id).maybeSingle();
  return !checked.error && !!checked.data && matchesReady(checked.data);
 }catch{return false;}
}

/** A changed object must not silently remain attached to a new expense. */
export class ReceiptInboxMismatchError extends Error {
 constructor() { super('The saved photo no longer matches its inbox record.'); this.name='ReceiptInboxMismatchError'; }
}

/** Download only the selected private object; verify its bytes before sending to AI. */
export async function downloadInboxPhoto(client:SupabaseClient,item:ReceiptInboxItem):Promise<File> {
 if(item.status!=='ready') throw new Error('This photo upload is not ready.');
 const {data,error}=await client.storage.from(RECEIPT_BUCKET).download(item.object_path);
 if(error || !data) throw new Error('The saved photo could not be downloaded.');
 if(data.size!==item.file_size) throw new ReceiptInboxMismatchError();
 const file=new File([data],item.file_name,{type:item.mime_type});
 if(!matchesReceiptFile(item,file,await receiptDigest(file))) throw new ReceiptInboxMismatchError();
 return file;
}
