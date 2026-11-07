/** Manual sends only: durable lock before logging/provider I/O. Until rollout,
 * no route should enable this without the coordinated scheduler and review UI.
 * A manual send is intentional, so it is not subject to the automatic 24h
 * cooldown, but unresolved history still blocks it to avoid duplicate sends. */
import {reserveDelivery,finishDelivery,readContactHistory,reserveClientSms,finishClientSms,readClientSmsHistory,recipientMatches} from './coordination';
type Db={rpc:(name:string,args:Record<string,unknown>)=>PromiseLike<{data:unknown;error:unknown}>};
type Outcome='accepted'|'rejected'|'cancelled'|'unconfirmed';
type Result<T>={status:'completed';result:T}|{status:'busy'|'unavailable'|'unconfirmed'};
export async function coordinateManualDelivery<T>(input:{db:Db;invoiceId:string|null;clientId?:string;channel:'email'|'sms';attemptId:string;deliver:(attemptId:string,beforeSend:(recipient:string)=>Promise<boolean>)=>Promise<T>;outcome:(result:T)=>Outcome}):Promise<Result<T>> {
  const {db,invoiceId,channel,attemptId,clientId}=input;
  if(!invoiceId && (channel!=='sms'||!clientId))return {status:'unavailable'};
  const reservation=invoiceId?await reserveDelivery(db,{invoiceId,channel,source:'manual',attemptId}):await reserveClientSms(db,{clientId:clientId!,attemptId});
  if(reservation!=='reserved')return {status:reservation==='busy'?'busy':'unavailable'};
  const finish=(outcome:Outcome)=>invoiceId?finishDelivery(db,{invoiceId,channel,attemptId,outcome}):finishClientSms(db,{clientId:clientId!,attemptId,outcome});
  const history=()=>invoiceId?readContactHistory(db,{invoiceId,channel,ownAttemptId:attemptId}):readClientSmsHistory(db,{clientId:clientId!,ownAttemptId:attemptId});
  const beforeSend=async(recipient:string)=>{const h=await history();return h!==null && !h.unresolvedAttempt && await recipientMatches(db,{attemptId,channel,recipient});};
  const initial=await history();
  if(!initial || initial.unresolvedAttempt){
    const settled=await finish('cancelled');
    return {status:!settled?'unconfirmed':initial?'busy':'unavailable'};
  }
  let result:T;let outcome:Outcome;
  try {result=await input.deliver(attemptId,beforeSend);outcome=input.outcome(result);} catch {await finish('unconfirmed');return {status:'unconfirmed'};}
  const finished=await finish(outcome);
  if(!finished || outcome==='unconfirmed')return {status:'unconfirmed'};
  return {status:'completed',result};
}
