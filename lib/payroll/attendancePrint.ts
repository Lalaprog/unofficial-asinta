import { escapeHtml } from '@/lib/email/format';
import type { AttendancePrintData } from './attendanceMatrix';

/** Standalone document; accepts attendance-only data and never serializes app DOM. */
export function buildAttendancePrintDocument(data:AttendancePrintData):string {
  const escape = (value:string) => escapeHtml(value);
  const pages:string[]=[];
  const rosterNote=data.scopeKind==='all'
    ? 'All-sites view includes active workers and inactive workers with recorded attendance in this period.'
    : 'Site view includes only workers with recorded attendance at this site in this period; it is not a complete site roster.';
  for(let start=0;start<data.dates.length;start+=7) {
    const dates=data.dates.slice(start,start+7);
    const headers=dates.map(date=>`<th scope="col">${escape(date)}</th>`).join('');
    const rows=data.rows.map(row=>{
      const cells=dates.map((_,offset)=>{
        const marks=row.cells[start+offset]||[];
        return `<td>${marks.length ? marks.map(mark=>`<div><strong>${escape(mark.code)}</strong> · ${escape(mark.site)}</div>`).join('') : '—'}</td>`;
      }).join('');
      return `<tr><th scope="row">${escape(row.name)}<small>${escape(row.position)}${row.active?'':' · inactive'}</small></th>${cells}</tr>`;
    }).join('');
    pages.push(`<section><h1>Attendance matrix</h1><p>Period: ${escape(data.start)} to ${escape(data.end)} · Scope: ${escape(data.scope)}</p><p>P = Present · A = Absent · H = Half day · L = Leave · — = Unmarked in this scope</p><p>Recorded attendance only; unmarked is not absent. Multiple site entries are shown separately. This is not a payroll calculation or review approval.</p><p>${escape(rosterNote)}</p><table><thead><tr><th scope="col">Worker</th>${headers}</tr></thead><tbody>${rows}</tbody></table></section>`);
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Attendance matrix</title><style>@page{size:landscape;margin:12mm}body{font:11px Arial,sans-serif;color:#111}h1{font-size:18px;margin:0 0 5px}p{margin:4px 0}section+section{break-before:page}table{width:100%;border-collapse:collapse;table-layout:fixed;margin-top:10px}th,td{border:1px solid #777;padding:5px;vertical-align:top;text-align:left;overflow-wrap:anywhere}th:first-child{width:19%}thead{display:table-header-group}tr{break-inside:avoid}small{display:block;font-weight:normal;margin-top:3px}</style></head><body>${pages.join('')}</body></html>`;
}
