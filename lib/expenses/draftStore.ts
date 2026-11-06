import type { SupabaseClient } from '@supabase/supabase-js';
import { parseSavedDraft, type SavedDraftPayload, type SavedDraftRow } from '@/lib/expenses/savedDraft';

export type DraftResult<T> = {ok:true; value:T} | {ok:false; message:string};
const problem = 'The saved draft could not be confirmed. Refresh and check it before retrying.';
function asRow(row: any, owner: string): SavedDraftRow | null {
  const payload = parseSavedDraft(row?.payload);
  if (!payload || row.owner_id !== owner || typeof row.draft_id !== 'string' || !Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.updated_at !== 'string') return null;
  return {...row, payload};
}
export async function loadExpenseDraft(client:SupabaseClient, owner:string): Promise<DraftResult<SavedDraftRow | null>> {
  try {
    const {data,error}=await client.from('expense_drafts').select('*').eq('owner_id',owner).maybeSingle();
    if (error) return {ok:false,message:problem};
    if (!data) return {ok:true,value:null};
    const row=asRow(data,owner);
    return row ? {ok:true,value:row} : {ok:false,message:'This saved draft could not be read safely. It has not been changed.'};
  } catch { return {ok:false,message:problem}; }
}
export async function saveExpenseDraft(client:SupabaseClient, owner:string, previous:SavedDraftRow | null, id:string, payload:SavedDraftPayload): Promise<DraftResult<SavedDraftRow>> {
  if (!parseSavedDraft(payload) || new TextEncoder().encode(JSON.stringify(payload)).length > 90000) return {ok:false,message:'This draft is too large or contains an unsupported value. Review it before saving.'};
  try {
    const update={draft_id:id,payload,updated_at:new Date().toISOString(),revision:previous ? previous.revision+1 : 1};
    const query=previous
      ? client.from('expense_drafts').update(update).eq('owner_id',owner).eq('draft_id',previous.draft_id).eq('revision',previous.revision)
      : client.from('expense_drafts').insert({owner_id:owner,...update});
    const {data,error}=await query.select('*').maybeSingle();
    if (error || !data) return {ok:false,message:problem};
    const row=asRow(data,owner);
    return row ? {ok:true,value:row} : {ok:false,message:problem};
  } catch { return {ok:false,message:problem}; }
}
export async function deleteExpenseDraft(client:SupabaseClient, owner:string, row:SavedDraftRow): Promise<DraftResult<boolean>> {
  try {
    const {data,error}=await client.from('expense_drafts').delete().eq('owner_id',owner).eq('draft_id',row.draft_id).eq('revision',row.revision).select('draft_id').maybeSingle();
    return !error && data ? {ok:true,value:true} : {ok:false,message:problem};
  } catch { return {ok:false,message:problem}; }
}
