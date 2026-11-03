import { describe,expect,it } from 'vitest';
import {attendancePrintData,buildMatrix,matrixDates,parseMatrixSnapshot} from '@/lib/payroll/attendanceMatrix';
import {buildAttendancePrintDocument} from '@/lib/payroll/attendancePrint';
const data=()=>({
  workers:[{id:'w',name:'<script>alert(1)</script>',position:'Mason',active:true,pay_rate:45678,pay_rate_type:'daily' as const},{id:'empty',name:'No logs',position:'Helper',active:true,pay_rate:12345,pay_rate_type:'hourly' as const}],
  projects:[{id:'s1',name:'Alpha & <Site>'},{id:'s2',name:'Beta'}],
  attendance:[{id:'1',worker_id:'w',project_id:'s1',date:'2026-01-01',status:'present' as const},{id:'2',worker_id:'w',project_id:'s2',date:'2026-01-01',status:'absent' as const},{id:'3',worker_id:'w',project_id:'s1',date:'2026-01-02',status:'half_day' as const},{id:'4',worker_id:'w',project_id:'s1',date:'2026-01-03',status:'leave' as const}],
  vouchers:[{id:'v',worker_id:'w',gross_pay:98765,net_pay:87654,status:'draft' as const}],
});
describe('attendance matrix and isolated print document',()=>{
  it('preserves multiple site statuses, explicit unmarked, and screen-only voucher details',()=>{
    const view=buildMatrix(parseMatrixSnapshot(data()),'2026-01-01','2026-01-04');
    const w=view.rows.find(x=>x.id==='w')!;expect(w.cells.map(cell=>cell.map(m=>m.code))).toEqual([['P','A'],['H'],['L'],[]]);expect(w.cells[0].map(x=>x.site)).toEqual(['Alpha & <Site>','Beta']);
    expect(w.rate).toBe(45678);expect(w.vouchers[0].net_pay).toBe(87654);expect(view.rows.find(x=>x.id==='empty')?.cells.every(c=>!c.length)).toBe(true);
    const printable=attendancePrintData(view,'2026-01-01','2026-01-04','All sites','all');
    const html=buildAttendancePrintDocument(printable);
    for(const value of ['45678','12345','98765','87654','gross_pay','net_pay','pay_rate','Bale','Gross wages','NET TAKE-HOME']) expect(html).not.toContain(value);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');expect(html).not.toContain('<script>');expect(html).toContain('Alpha &amp; &lt;Site&gt;');expect(html).toContain('Unmarked');expect(html).toContain('not a payroll calculation');
    const siteHtml=buildAttendancePrintDocument(attendancePrintData(view,'2026-01-01','2026-01-04','Alpha','site'));expect(siteHtml).toContain('not a complete site roster');
  });
  it('chunks long periods into seven date columns per print section and repeats names',()=>{
    const view=buildMatrix(parseMatrixSnapshot(data()),'2026-01-01','2026-01-09');const html=buildAttendancePrintDocument(attendancePrintData(view,'2026-01-01','2026-01-09','All','all'));
    expect((html.match(/<section>/g)||[]).length).toBe(2);expect((html.match(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/g)||[]).length).toBe(2);expect(html).toContain('2026-01-09');
  });
  it('rejects malformed data, out-of-period rows and unsafe sizes',()=>{
    expect(()=>matrixDates('2026-02-30','2026-03-01')).toThrow();expect(()=>matrixDates('2026-02-02','2026-02-01')).toThrow();expect(()=>matrixDates('2026-01-01','2026-04-05')).toThrow(/93 days/);
    expect(matrixDates('2024-02-28','2024-03-01')).toEqual(['2024-02-28','2024-02-29','2024-03-01']);
    const invalid=data();invalid.attendance[0].worker_id='unknown';expect(()=>parseMatrixSnapshot(invalid)).toThrow(/attendance/);
    expect(()=>buildMatrix(parseMatrixSnapshot(data()),'2026-01-02','2026-01-04')).toThrow(/outside/);
    const huge=data();huge.workers=Array.from({length:1001},(_,i)=>({...huge.workers[0],id:String(i)}));huge.attendance=[];huge.vouchers=[];expect(()=>buildMatrix(parseMatrixSnapshot(huge),'2026-01-01','2026-01-10')).toThrow(/too large/);
  });
});
