import { describe, expect, it } from 'vitest';
import { parseSavedDraft, stableDraftJson, type SavedDraftPayload } from '@/lib/expenses/savedDraft';
import { loadExpenseDraft, saveExpenseDraft, deleteExpenseDraft } from '@/lib/expenses/draftStore';
const payload:SavedDraftPayload={version:1,form:{project_id:'',description:'Cement',details:'',amount:'12',category:'materials',expense_date:'2026-11-06',notes:'',receipt_url:null,vendor:''},rows:[{name:'bags',quantity:'2',amount:'10'}],receiptFileName:null,draft:null,draftInputKind:null,draftModel:null,draftExtractedText:null,aiResult:null,aiAccepted:false,contextWarnings:[]};
const owner='owner',id='draft';
function fakeClient() {
  let row:any=null;
  return {get row(){return row}, client:{from:()=>{
    let filters:Record<string,unknown>={}; let operation='select'; let data:any;
    const chain:any={select:()=>chain,eq:(k:string,v:unknown)=>{filters[k]=v;return chain},insert:(v:any)=>{operation='insert';data=v;return chain},update:(v:any)=>{operation='update';data=v;return chain},delete:()=>{operation='delete';return chain},maybeSingle:async()=>{
      const matches=()=>row && Object.entries(filters).every(([key,value])=>row[key]===value);
      if(operation==='insert') {if(row)return {data:null,error:{message:'duplicate'}};row={...data};return {data:row,error:null};}
      if(operation==='update'){if(!matches())return {data:null,error:null};row={...row,...data};return {data:row,error:null};}
      if(operation==='delete'){if(!matches())return {data:null,error:null};const old=row;row=null;return {data:old,error:null};}
      return {data:matches()?row:null,error:null};
    }};return chain;
  }} as any};
}
describe('saved expense draft storage',()=>{
  it('rejects malformed versions and tolerates JSONB key reordering',()=>{
    expect(parseSavedDraft(payload)).toEqual(payload);
    expect(parseSavedDraft({...payload,version:2})).toBeNull();
    expect(parseSavedDraft({...payload,rows:[{name:'x'}]})).toBeNull();
    expect(parseSavedDraft({...payload,contextWarnings:[{}]})).toBeNull();
    expect(stableDraftJson({b:1,a:{y:2,x:3}})).toBe(stableDraftJson({a:{x:3,y:2},b:1}));
  });
  it('loads, saves, and rejects stale saves and stale deletes without altering the newer draft',async()=>{
    const f=fakeClient(); expect(await loadExpenseDraft(f.client,owner)).toEqual({ok:true,value:null});
    const first=await saveExpenseDraft(f.client,owner,null,id,payload); expect(first.ok).toBe(true); if(!first.ok) return;
    const next=await saveExpenseDraft(f.client,owner,first.value,id,{...payload,form:{...payload.form,description:'newer'}});expect(next.ok).toBe(true);
    expect((await saveExpenseDraft(f.client,owner,first.value,id,payload)).ok).toBe(false);
    expect((await deleteExpenseDraft(f.client,owner,first.value)).ok).toBe(false);
    expect(f.row.payload.form.description).toBe('newer');
    if(next.ok) expect((await deleteExpenseDraft(f.client,owner,next.value)).ok).toBe(true);
    expect(f.row).toBeNull();
  });
  it('does not assume success when storage fails or data is unreadable',async()=>{
    const f=fakeClient();const first=await saveExpenseDraft(f.client,owner,null,id,payload); expect(first.ok).toBe(true);
    if(f.row) f.row.payload={version:99};
    expect((await loadExpenseDraft(f.client,owner)).ok).toBe(false);
    expect((await saveExpenseDraft(f.client,owner,null,id,payload)).ok).toBe(false);
  });
});
