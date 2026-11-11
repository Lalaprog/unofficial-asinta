export interface ProjectExpenseTotal { projectId:string; count:number; total:number }
export interface ProjectExpenseRow { id:string; project_id:string; description:string; category:string; amount:number; expense_date:string; notes:string|null }
export interface ProjectExpensePage { items:ProjectExpenseRow[]; hasMore:boolean }

/** Bounded, exact-to-cent numeric strings; reject malformed or unsafe values. */
function parseAmount(value:unknown): number {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error('Invalid expense amount');
  const [whole,fraction=''] = value.split('.');
  const cents=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
  if(cents>4503599627370495n) throw new Error('Expense amount is too large');
  return Number(cents)/100;
}
function isDate(value:unknown): value is string {
  if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed=new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10)===value;
}
export function parseExpenseTotals(value:unknown, expected:string[]): Map<string,ProjectExpenseTotal> {
  if(!Array.isArray(value) || value.length!==expected.length || new Set(expected).size!==expected.length) throw new Error('Invalid expense totals');
  const wanted=new Set(expected), result=new Map<string,ProjectExpenseTotal>();
  for (const row of value) {
    if(!row || typeof row.project_id!=='string' || !wanted.has(row.project_id) || result.has(row.project_id) || !Number.isSafeInteger(row.expense_count) || row.expense_count<0) throw new Error('Invalid expense totals');
    result.set(row.project_id,{projectId:row.project_id,count:row.expense_count,total:parseAmount(row.total)});
  }
  return result;
}
export function parseExpensePage(value:unknown, projectId:string, cursor?:ProjectExpenseRow): ProjectExpensePage {
  if(!value || typeof value!=='object') throw new Error('Invalid expense page');
  const page=value as {items?:unknown; has_more?:unknown};
  if(!Array.isArray(page.items) || page.items.length>25 || typeof page.has_more!=='boolean' || (page.has_more && page.items.length===0)) throw new Error('Invalid expense page');
  let previous=cursor;
  const items=page.items.map((row:Record<string,unknown>):ProjectExpenseRow=>{
    if(!row || typeof row.id!=='string' || !row.id || row.project_id!==projectId || typeof row.description!=='string' || typeof row.category!=='string' || !isDate(row.expense_date) || !(row.notes===null || typeof row.notes==='string')) throw new Error('Invalid expense record');
    if(previous && (row.expense_date>previous.expense_date || (row.expense_date===previous.expense_date && row.id>=previous.id))) throw new Error('Invalid expense cursor');
    const item={id:row.id,project_id:projectId,description:row.description,category:row.category,amount:parseAmount(row.amount),expense_date:row.expense_date,notes:row.notes as string|null};
    previous=item; return item;
  });
  return {items,hasMore:page.has_more};
}
