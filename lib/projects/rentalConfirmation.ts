export type RentalAttempt={id:string;expense:string;project:string;amount:string;date:string;description:string;item:string;supplier:string;quantity:number;start:string;end:string};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const date=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(`${v}T00:00:00Z`))&&new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)===v;
export function parseRentalAttempt(value:unknown):RentalAttempt{
 if(!value||typeof value!=='object')throw new Error('Invalid saved confirmation');const a=value as RentalAttempt;
 if(!uuid(a.id)||!uuid(a.expense)||!uuid(a.project)||typeof a.amount!=='string'||!/^\d{1,10}\.\d{2}$/.test(a.amount)||Number(a.amount)<=0||!date(a.date)||typeof a.description!=='string'||typeof a.item!=='string'||a.item!==a.item.trim()||a.item.length<1||a.item.length>160||typeof a.supplier!=='string'||a.supplier!==a.supplier.trim()||a.supplier.length<1||a.supplier.length>160||!Number.isInteger(a.quantity)||a.quantity<1||a.quantity>100000||!date(a.start)||!date(a.end)||a.end<a.start)throw new Error('Invalid saved confirmation');
 return {id:a.id,expense:a.expense,project:a.project,amount:a.amount,date:a.date,description:a.description,item:a.item,supplier:a.supplier,quantity:a.quantity,start:a.start,end:a.end};
}
export function verifyRentalResult(raw:unknown,a:RentalAttempt):void{
 if(!raw||typeof raw!=='object')throw new Error('Invalid confirmation result');const r=raw as Record<string,unknown>;
 if(r.id!==a.id||r.expense_id!==a.expense||typeof r.replayed!=='boolean')throw new Error('Invalid confirmation result');
}
export function verifyRentalStatus(raw:unknown,a:RentalAttempt):boolean{
 if(!raw||typeof raw!=='object')throw new Error('Invalid confirmation status');const r=raw as Record<string,unknown>;
 if(r.found===false)return false;
 if(r.found!==true||Object.entries(a).some(([key,value])=>r[key]!==value))throw new Error('Confirmation details do not match');return true;
}
export function rentalArguments(a:RentalAttempt){return {p_id:a.id,p_expense:a.expense,p_project:a.project,p_expected_amount:a.amount,p_expected_date:a.date,p_expected_description:a.description,p_item:a.item,p_supplier:a.supplier,p_quantity:a.quantity,p_start:a.start,p_end:a.end};}
