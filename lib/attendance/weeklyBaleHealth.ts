export type WeeklyBaleHealth={checked_at:string;last_success:string|null;last_processed:number|null;last_remaining_due:number|null;current_remaining_due:number;healthy:boolean};
/** Reject contradictory or incomplete scheduler health reports. */
export function parseWeeklyBaleHealth(raw:unknown):WeeklyBaleHealth {
 if(!raw||typeof raw!=='object')throw new Error('Invalid expiry health');const h=raw as WeeklyBaleHealth;
 const timestamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value));
 const count=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
 if(!timestamp(h.checked_at)||typeof h.healthy!=='boolean'||!count(h.current_remaining_due))throw new Error('Invalid expiry health');
 if(h.last_success===null){if(h.last_processed!==null||h.last_remaining_due!==null||h.healthy)throw new Error('Invalid expiry health');}
 else if(!timestamp(h.last_success)||!count(h.last_processed)||h.last_processed>500||!count(h.last_remaining_due))throw new Error('Invalid expiry health');
 if(h.healthy&&(h.current_remaining_due!==0||!h.last_success||Date.parse(h.last_success)>Date.parse(h.checked_at)||Date.parse(h.checked_at)-Date.parse(h.last_success)>180000))throw new Error('Invalid expiry health');
 return h;
}
