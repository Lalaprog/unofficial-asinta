export interface ConfirmedRental {id:string;expenseId:string;expenseAmount:number;expenseDate:string;description:string;item:string;supplier:string;quantity:number;start:string;end:string;confirmedAt:string}
const date=(x:unknown):x is string=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(Date.parse(`${x}T00:00:00Z`))&&new Date(`${x}T00:00:00Z`).toISOString().slice(0,10)===x;
/** Fail closed instead of rendering partial or cross-site rental results. */
export function parseConfirmedRentals(raw:unknown,project:string):ConfirmedRental[] {
 if(!raw||typeof raw!=='object')throw new Error('Invalid rental list');const list=raw as {project_id?:unknown;items?:unknown};
 if(list.project_id!==project||!Array.isArray(list.items)||list.items.length>200)throw new Error('Invalid rental list');
 const ids=new Set<string>(),expenses=new Set<string>();let previous:{start:string;id:string}|undefined;
 return list.items.map((v:unknown)=>{
  if(!v||typeof v!=='object')throw new Error('Invalid rental');const r=v as Record<string,unknown>;
  if(typeof r.id!=='string'||!r.id||ids.has(r.id)||typeof r.expense_id!=='string'||!r.expense_id||expenses.has(r.expense_id)||r.project_id!==project||typeof r.expense_amount!=='string'||!/^\d+(?:\.\d{1,2})?$/.test(r.expense_amount)||!date(r.expense_date)||!date(r.rental_start)||!date(r.rental_end)||r.rental_start>r.rental_end||typeof r.expense_description!=='string'||typeof r.item_name!=='string'||!r.item_name||r.item_name.length>160||typeof r.supplier!=='string'||!r.supplier||r.supplier.length>160||typeof r.quantity!=='number'||!Number.isSafeInteger(r.quantity)||r.quantity<1||r.quantity>100000||typeof r.confirmed_at!=='string'||!Number.isFinite(Date.parse(r.confirmed_at)))throw new Error('Invalid rental');
  const [whole,fraction='']=r.expense_amount.split('.');const cents=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));if(cents<=0n||cents>4503599627370495n)throw new Error('Invalid rental amount');
  if(previous&&(r.rental_start>previous.start||(r.rental_start===previous.start&&r.id>=previous.id)))throw new Error('Invalid rental order');previous={start:r.rental_start,id:r.id};ids.add(r.id);expenses.add(r.expense_id);
  return {id:r.id,expenseId:r.expense_id,expenseAmount:Number(cents)/100,expenseDate:r.expense_date,description:r.expense_description,item:r.item_name,supplier:r.supplier,quantity:r.quantity,start:r.rental_start,end:r.rental_end,confirmedAt:r.confirmed_at};
 });
}
