import type {AdvanceRequest} from '@/types';
import type {WeeklyBaleStatus} from '@/lib/attendance/weeklyBaleStatus';

export type BaleDuplicateSignal = {workerId:string;periodStart:string;requestCount:number};

/** A review hint, not a uniqueness check: it sees only loaded, verified rows. */
export function selectedBaleDuplicateSignals(requests:AdvanceRequest[],statuses:WeeklyBaleStatus[],selectedIds:ReadonlySet<string>):BaleDuplicateSignal[] {
 const byId=new Map(statuses.map(status=>[status.id,status]));
 const groups=new Map<string,{workerId:string;periodStart:string;ids:Set<string>;selected:boolean}>();
 for(const request of requests){
  const status=byId.get(request.id);
  if(!status || status.kind!=='weekly' || !status.period_start || status.stored_status!==request.status || status.effective_status==='rejected' || status.effective_status==='expired_unapproved') continue;
  const key=JSON.stringify([request.worker_id,status.period_start]);
  const group=groups.get(key)??{workerId:request.worker_id,periodStart:status.period_start,ids:new Set<string>(),selected:false};
  group.ids.add(request.id);group.selected ||= selectedIds.has(request.id);groups.set(key,group);
 }
 return Array.from(groups.values()).filter(group=>group.selected&&group.ids.size>1)
  .map(group=>({workerId:group.workerId,periodStart:group.periodStart,requestCount:group.ids.size}));
}
