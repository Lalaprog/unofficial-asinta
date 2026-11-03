import type { AttendanceStatus, PayrollStatus } from '@/types';

export interface MatrixWorker { id: string; name: string; position: string; active: boolean; pay_rate: number | string; pay_rate_type: 'daily' | 'hourly' }
export interface MatrixAttendance { id: string; worker_id: string; project_id: string; date: string; status: AttendanceStatus }
export interface MatrixVoucher { id: string; worker_id: string; gross_pay: number | string; net_pay: number | string; status: PayrollStatus }
export interface MatrixSnapshot { workers: MatrixWorker[]; attendance: MatrixAttendance[]; projects: {id:string;name:string}[]; vouchers: MatrixVoucher[] }
export interface MatrixMark { code: 'P'|'A'|'H'|'L'; label: string; site: string }
export interface AttendancePrintRow { name: string; position: string; active: boolean; cells: MatrixMark[][] }
export interface AttendancePrintData { start: string; end: string; scope: string; scopeKind: 'all'|'site'; dates: string[]; rows: AttendancePrintRow[] }
export interface MatrixRow extends AttendancePrintRow { id: string; rate: number; rateType: 'daily'|'hourly'; vouchers: MatrixVoucher[] }
export interface MatrixView { dates: string[]; rows: MatrixRow[] }

const codes: Record<AttendanceStatus, {code:MatrixMark['code'];label:string}> = {
  present:{code:'P',label:'Present'}, absent:{code:'A',label:'Absent'}, half_day:{code:'H',label:'Half day'}, leave:{code:'L',label:'Leave'},
};
export function matrixDates(start: string, end: string): string[] {
  const parse = (value:string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
    const time = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0,10) === value ? time : NaN;
  };
  const first=parse(start), last=parse(end);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) throw new Error('Choose a valid start and end date.');
  const days=(last-first)/86400000+1;
  if (days > 93) throw new Error('Choose a period of at most 93 days for the matrix.');
  return Array.from({length:days},(_,i)=>new Date(first+i*86400000).toISOString().slice(0,10));
}
const number = (value: unknown) => value !== null && value !== '' && value !== undefined && Number.isFinite(Number(value));
export function parseMatrixSnapshot(value: unknown): MatrixSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Invalid matrix response.');
  const data=value as MatrixSnapshot;
  if (!Array.isArray(data.workers)||!Array.isArray(data.attendance)||!Array.isArray(data.projects)||!Array.isArray(data.vouchers)) throw new Error('Invalid matrix response.');
  if (data.workers.length > 10000 || data.attendance.length > 10000 || data.vouchers.length > 10000) throw new Error('Matrix response exceeds safety limits.');
  if (data.workers.some(w=>!w || typeof w.id!=='string' || typeof w.name!=='string' || typeof w.position!=='string' || typeof w.active!=='boolean' || !number(w.pay_rate) || !['daily','hourly'].includes(w.pay_rate_type))) throw new Error('Invalid matrix workers.');
  if (data.projects.some(p=>!p || typeof p.id!=='string' || typeof p.name!=='string')) throw new Error('Invalid matrix sites.');
  const workerIds=new Set(data.workers.map(w=>w.id));
  if (workerIds.size!==data.workers.length || new Set(data.projects.map(p=>p.id)).size!==data.projects.length) throw new Error('Duplicate matrix identities.');
  if (data.attendance.some(a=>!a || typeof a.id!=='string' || !workerIds.has(a.worker_id) || typeof a.project_id!=='string' || typeof a.date!=='string' || !Object.hasOwn(codes,a.status))) throw new Error('Invalid matrix attendance.');
  if (new Set(data.attendance.map(a=>a.id)).size!==data.attendance.length) throw new Error('Duplicate attendance records.');
  if (data.vouchers.some(v=>!v || typeof v.id!=='string' || !workerIds.has(v.worker_id) || !number(v.gross_pay) || !number(v.net_pay) || !['draft','reviewed','approved','paid'].includes(v.status))) throw new Error('Invalid matrix vouchers.');
  return data;
}
export function buildMatrix(data:MatrixSnapshot, start:string, end:string): MatrixView {
  const dates=matrixDates(start,end);
  if (data.workers.length*dates.length > 10000) throw new Error('Matrix is too large to display safely. Choose a narrower period or site.');
  const names=new Map(data.projects.map(p=>[p.id,p.name]));
  const nameCounts=new Map<string,number>();
  for(const p of data.projects) nameCounts.set(p.name,(nameCounts.get(p.name)||0)+1);
  const duplicateNames=new Set([...nameCounts].filter(([,count])=>count>1).map(([name])=>name));
  const siteName=(id:string) => {const name=names.get(id);return name ? duplicateNames.has(name) ? `${name} (${id})` : name : 'Site unavailable';};
  const cells=new Map<string,MatrixMark[]>();
  const validDates=new Set(dates);
  for (const a of data.attendance) {
    if (!validDates.has(a.date)) throw new Error('Matrix contains attendance outside the selected period.');
    const key=`${a.worker_id}:${a.date}`, mark={...codes[a.status],site:siteName(a.project_id)};
    const existing=cells.get(key);
    if (existing) existing.push(mark); else cells.set(key,[mark]);
  }
  const vouchers=new Map<string,MatrixVoucher[]>();
  for(const voucher of data.vouchers) {const existing=vouchers.get(voucher.worker_id);if(existing) existing.push(voucher);else vouchers.set(voucher.worker_id,[voucher]);}
  const rows=data.workers.map(w=>({id:w.id,name:w.name,position:w.position,active:w.active,rate:Number(w.pay_rate),rateType:w.pay_rate_type,vouchers:vouchers.get(w.id)||[],cells:dates.map(date=>(cells.get(`${w.id}:${date}`)||[]).sort((a,b)=>a.site.localeCompare(b.site)||a.code.localeCompare(b.code)))}))
    .sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
  return {dates,rows};
}

/** Explicitly remove all rate and voucher fields before preparing a print document. */
export function attendancePrintData(view:MatrixView, start:string, end:string, scope:string, scopeKind:'all'|'site'):AttendancePrintData {
  return {start,end,scope,scopeKind,dates:[...view.dates],rows:view.rows.map(({name,position,active,cells})=>({name,position,active,cells:cells.map(day=>day.map(({code,label,site})=>({code,label,site})))}))};
}
