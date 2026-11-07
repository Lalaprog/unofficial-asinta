/** Bounded, injected batch for the coordinated scheduler. Candidate selection
 * advances a durable cursor. Crashes may delay, but never authorize a send; the
 * one-channel dispatcher owns all fresh checks, claims and provider decisions. */
import type {DispatchOneResult} from './dispatchOne';
type Channel='email'|'sms';
type Settings={master_enabled:boolean;email_enabled:boolean;sms_enabled:boolean};
type Result={ran:boolean;reason?:string;scanned:number;outcomes:Record<string,number>};
export async function runReminderBatch(input:{allowed:()=>boolean;clock:()=>number;settings:()=>Promise<Settings|null>;next:()=>Promise<{ok:boolean;invoiceId:string|null}>;run:(invoiceId:string,channel:Channel)=>Promise<DispatchOneResult>;maxInvoices?:number;budgetMs?:number}):Promise<Result> {
 const summary:Result={ran:false,scanned:0,outcomes:{}};
 const started=input.clock(),seen=new Set<string>();
 if(!Number.isFinite(started)||!input.allowed())return {...summary,reason:'disabled_or_outside_window'};
 const limit=Math.min(Math.max(input.maxInvoices??30,1),100),budget=Math.min(Math.max(input.budgetMs??20000,1000),60000);
 for(let n=0;n<limit;n++) {
  if(!input.allowed()||input.clock()-started>=budget)break;
  let settings:Settings|null;try{settings=await input.settings();}catch{return {...summary,reason:'settings_unavailable'};}
  if(!settings || typeof settings.master_enabled!=='boolean' || typeof settings.email_enabled!=='boolean' || typeof settings.sms_enabled!=='boolean')return {...summary,reason:'settings_unavailable'};
  if(!settings.master_enabled || (!settings.email_enabled&&!settings.sms_enabled))return {...summary,reason:'founder_reminders_disabled'};
  let candidate:{ok:boolean;invoiceId:string|null};try{candidate=await input.next();}catch{return {...summary,reason:'scan_unavailable'};}
  if(!candidate.ok || (candidate.invoiceId!==null && typeof candidate.invoiceId!=='string'))return {...summary,reason:'scan_unavailable'};
  if(!candidate.invoiceId||seen.has(candidate.invoiceId))break;
  seen.add(candidate.invoiceId);summary.ran=true;summary.scanned++;
  for(const channel of ['email','sms'] as const) {
    if(!input.allowed()||input.clock()-started>=budget)break;
    if((channel==='email'&&!settings.email_enabled)||(channel==='sms'&&!settings.sms_enabled))continue;
    let result:DispatchOneResult;try{result=await input.run(candidate.invoiceId,channel);}catch{result={outcome:'unavailable'};}
    // Only aggregate categories; no client or invoice details in cron response.
    const key=result.lockUnconfirmed?'lock_unconfirmed':result.outcome;summary.outcomes[key]=(summary.outcomes[key]??0)+1;
  }
 }
 return summary;
}
