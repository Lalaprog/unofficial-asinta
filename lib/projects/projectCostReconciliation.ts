import {parsePaidWorkerPage,type PaidWorkerEvidence} from './paidWorkerEvidence';
import {parseConfirmedRentals,type ConfirmedRental} from './confirmedRentals';
export type CostExpense={id:string;description:string;category:string;amount:string;date:string;baleHint:boolean;rental?:ConfirmedRental};
export type CostPaid=PaidWorkerEvidence&{voucherGross:string;voucherBale:string;voucherOther:string;voucherNet:string};
export type CostSnapshot={projectId:string;capturedAt:string;expenses:CostExpense[];paid:CostPaid[]};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const date=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(`${v}T00:00:00Z`))&&new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)===v;
/** Exact integer centavos; no floating-point arithmetic for totals. */
export function costCents(v:unknown):bigint{if(typeof v!=='string'||!/^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(v))throw Error('Invalid cost amount');const [a,b]=v.split('.');return BigInt(a)*100n+BigInt(b);}
export function formatCostCents(n:bigint):string{const whole=n/100n,dec=(n%100n).toString().padStart(2,'0');return `₱${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g,',')}.${dec}`;}
export function parseCostSnapshot(raw:unknown,projectId:string):CostSnapshot{
 if(!uuid(projectId)||!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid cost snapshot');const s=raw as Record<string,unknown>;
 if(s.project_id!==projectId||typeof s.captured_at!=='string'||!Number.isFinite(Date.parse(s.captured_at))||!Array.isArray(s.expenses)||s.expenses.length>200||!Array.isArray(s.paid_allocations)||s.paid_allocations.length>500||!Array.isArray(s.rentals))throw Error('Incomplete cost snapshot');
 const rentals=parseConfirmedRentals({project_id:projectId,items:s.rentals},projectId);if(rentals.some(r=>!uuid(r.id)||!uuid(r.expenseId)))throw Error('Invalid rental identity');
 const byExpense=new Map(rentals.map(r=>[r.expenseId,r]));const ids=new Set<string>();let previous:{date:string;id:string}|undefined;
 const expenses=s.expenses.map((raw:unknown):CostExpense=>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid expense');const x=raw as Record<string,unknown>;
  if(!uuid(x.id)||ids.has(x.id)||x.project_id!==projectId||typeof x.description!=='string'||!x.description.trim()||typeof x.category!=='string'||!x.category.trim()||!date(x.expense_date)||typeof x.ai_bale_detection!=='boolean'||costCents(x.amount)<=0n)throw Error('Invalid expense');
  if(previous&&(x.expense_date>previous.date||(x.expense_date===previous.date&&x.id>=previous.id)))throw Error('Invalid expense order');
  const rental=byExpense.get(x.id);if(rental&&(rental.expenseDate!==x.expense_date||rental.description!==x.description||rental.expenseAmount.toFixed(2)!==x.amount||x.category!=='equipment'||x.ai_bale_detection))throw Error('Rental differs from expense');
  ids.add(x.id);previous={date:x.expense_date,id:x.id};return {id:x.id,description:x.description,category:x.category,amount:x.amount as string,date:x.expense_date,baleHint:x.ai_bale_detection,rental};
 });
 if(rentals.some(r=>!ids.has(r.expenseId)))throw Error('Rental expense missing');
 const paid:CostPaid[]=[];const payrollIds=new Set<string>();for(let i=0;i<s.paid_allocations.length;i+=25){
  const chunk=s.paid_allocations.slice(i,i+25);const page=parsePaidWorkerPage({project_id:projectId,items:chunk,has_more:i+25<s.paid_allocations.length},projectId,paid.at(-1));
  for(const [index,x] of page.items.entries()){
   if(!uuid(x.payrollId)||!uuid(x.workerId)||payrollIds.has(x.payrollId))throw Error('Invalid paid identity');const row=chunk[index] as Record<string,unknown>;
   const gross=costCents(row.voucher_gross),bale=costCents(row.voucher_bale),other=costCents(row.voucher_other),net=costCents(row.voucher_net);
   if(gross-bale-other!==net||costCents(x.gross)>gross)throw Error('Inconsistent voucher deduction');
   payrollIds.add(x.payrollId);paid.push({...x,voucherGross:row.voucher_gross as string,voucherBale:row.voucher_bale as string,voucherOther:row.voucher_other as string,voucherNet:row.voucher_net as string});
  }
 }
 return {projectId,capturedAt:s.captured_at,expenses,paid};
}
export type CostChoice='include'|'exclude';
/** Pure scratch calculation; caller must review every row before displaying it. */
export function estimateProjectCost(snapshot:CostSnapshot,choices:Record<string,CostChoice>):{expenses:bigint;excluded:bigint;payroll:bigint;total:bigint}{
 let expenses=0n,excluded=0n,payroll=0n;for(const e of snapshot.expenses){const c=choices[e.id];if(c!=='include'&&c!=='exclude')throw Error('Review every expense');if(c==='include')expenses+=costCents(e.amount);else excluded+=costCents(e.amount);}
 for(const p of snapshot.paid)payroll+=costCents(p.gross);return {expenses,excluded,payroll,total:expenses+payroll};
}
