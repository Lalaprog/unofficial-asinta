'use client';

import React, {useEffect, useRef, useState} from 'react';
import { ChevronDown, Printer } from 'lucide-react';
import { useAuth } from '@/lib/auth/authContext';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { formatPeso } from '@/lib/email/format';
import { attendancePrintData, buildMatrix, matrixDates, parseMatrixSnapshot, type MatrixSnapshot, type MatrixView } from '@/lib/payroll/attendanceMatrix';
import { buildAttendancePrintDocument } from '@/lib/payroll/attendancePrint';
import type { Project } from '@/types';

type Props = { start:string; end:string; site:string; setStart:(value:string)=>void; setEnd:(value:string)=>void; setSite:(value:string)=>void; projects:Project[] };
type State = {key:string;loading:boolean;error:string|null;data:MatrixSnapshot|null;view:MatrixView|null};
const EMPTY=(key:string):State=>({key,loading:false,error:null,data:null,view:null});
const colors={P:'bg-status-success-bg text-status-success',A:'bg-status-danger-bg text-status-danger',H:'bg-status-warning-bg text-status-warning',L:'bg-blue-50 text-blue-800'};

/** A separate read-only view. Never generates, reviews or changes payroll. */
export function AttendanceMatrix({start,end,site,setStart,setEnd,setSite,projects}:Props) {
  const [open,setOpen]=useState(false);
  return <section className="rounded-2xl border border-surface-border bg-white overflow-hidden">
    <button type="button" aria-expanded={open} onClick={()=>setOpen(value=>!value)} className="flex min-h-11 w-full items-center justify-between gap-3 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand sm:p-5">
      <span><span className="block text-sm font-semibold text-navy">Payroll-period attendance matrix</span><span className="mt-1 block text-xs font-normal text-ink-secondary">View recorded attendance by worker and date</span></span>
      <ChevronDown aria-hidden="true" className={`h-4 w-4 shrink-0 text-ink-secondary transition-transform motion-reduce:transition-none ${open?'rotate-180':''}`} />
    </button>
    {open && <MatrixContents start={start} end={end} site={site} setStart={setStart} setEnd={setEnd} setSite={setSite} projects={projects} />}
  </section>;
}

function MatrixContents({start,end,site,setStart,setEnd,setSite,projects}:Props) {
  const {user,isFounder}=useAuth();
  const key=JSON.stringify([user?.id,isFounder,start,end,site]);
  const currentKey=useRef(key);currentKey.current=key;
  const request=useRef(0),busy=useRef(false);
  const [state,setState]=useState<State>(()=>EMPTY(key));
  const [printError,setPrintError]=useState('');
  useEffect(()=>{request.current+=1;busy.current=false;setState(EMPTY(key));setPrintError('');return()=>{request.current+=1;busy.current=false;};},[key]);
  const current=state.key===key?state:EMPTY(key);
  const load=async()=>{
    if (!isFounder || !user?.id || busy.current) return;
    try {matrixDates(start,end);} catch (e) {setState({...EMPTY(key),error:e instanceof Error?e.message:'Choose a valid period.'});return;}
    const token=++request.current;busy.current=true;setPrintError('');
    setState({...EMPTY(key),loading:true});
    try {
      const {data,error}=await createClient().rpc('payroll_attendance_matrix',{p_period_start:start,p_period_end:end,p_project_id:site==='all'?null:site});
      if(error) throw new Error(error.message);
      const snapshot=parseMatrixSnapshot(data);
      const view=buildMatrix(snapshot,start,end);
      if(token!==request.current || currentKey.current!==key) return;
      setState({key,loading:false,error:null,data:snapshot,view});
    } catch(e) {
      if(token!==request.current || currentKey.current!==key) return;
      setState({...EMPTY(key),error:e instanceof Error?e.message:'Could not load the attendance matrix.'});
    } finally {if(token===request.current && currentKey.current===key) busy.current=false;}
  };
  const selectedName=current.data?.projects.find(p=>p.id===site)?.name;
  const duplicateSelected=selectedName && projects.filter(p=>p.name===selectedName).length>1;
  const scope=site==='all'?'All sites':selectedName ? `${selectedName}${duplicateSelected ? ` (${site})` : ''}` : 'Site unavailable';
  const print=()=>{
    if(!current.view || !current.view.rows.length) return;
    const documentText=buildAttendancePrintDocument(attendancePrintData(current.view,start,end,scope,site==='all'?'all':'site'));
    const popup=window.open('','_blank');
    if(!popup) {setPrintError('The print window was blocked. Allow pop-ups for this site and try again.');return;}
    try {
      popup.opener=null;
      popup.document.open();popup.document.write(documentText);popup.document.close();popup.focus();popup.print();
    } catch {
      popup.close();
      setPrintError('Could not open the print preview. Check your browser settings and try again.');
    }
  };
  return <div className="space-y-4 border-t border-surface-border p-4 sm:p-5">
    <p className="text-xs leading-relaxed text-ink-secondary">These controls match the payroll run. Loading the matrix is read-only and does not review attendance or change vouchers.</p>
    <div className="grid gap-3 sm:grid-cols-3">
      <Input label="Matrix period start" type="date" value={start} max={end} onChange={e=>setStart(e.target.value)} />
      <Input label="Matrix period end" type="date" value={end} min={start} onChange={e=>setEnd(e.target.value)} />
      <SearchableSelect label="Matrix project site" searchLabel="Search matrix project sites" value={site} onChange={e=>setSite(e.target.value)} fixedOption={{label:'All project sites',value:'all'}} options={projects.map(p=>({value:p.id,label:`${p.name}${projects.filter(other=>other.name===p.name).length>1 ? ` (${p.id})` : ''}`}))} />
    </div>
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="secondary" size="sm" onClick={load} isLoading={current.loading} disabled={!isFounder || !user?.id}>{current.view?'Refresh matrix':'Load matrix'}</Button>
      <Button type="button" variant="secondary" size="sm" onClick={print} disabled={!current.view?.rows.length || current.loading} leftIcon={<Printer className="h-4 w-4" />}>Print attendance only</Button>
    </div>
    <p className="text-xs leading-relaxed text-ink-secondary">Site choices use the loaded project list. A site view includes only workers with attendance at that site in this period; the app does not have a site crew roster. All-sites view also includes active workers without logs. An unmarked day means no record in this scope, not absent.</p>
    {current.error && <p role="alert" className="text-sm text-status-danger">Could not load matrix: {current.error}</p>}
    {printError && <p role="alert" className="text-sm text-status-danger">{printError}</p>}
    {current.loading && <p role="status" className="text-sm text-ink-secondary">Loading attendance matrix…</p>}
    {current.view && <>
      <p className="text-xs leading-relaxed text-ink-secondary">P = Present · A = Absent · H = Half day · L = Leave · — = Unmarked. Multiple site records appear separately. Recorded statuses are not payroll eligibility or proof of review; supervisor logs may be held from payroll.</p>
      <p className="text-xs leading-relaxed text-ink-secondary">Rates are current worker rates. Voucher amounts are saved for this exact period, not a calculation from this matrix; a voucher may cover other sites or reflect older data. Attendance and payroll can change after loading. Refresh to check again.</p>
      {!current.view.rows.length ? <p className="py-5 text-sm text-ink-secondary">{site==='all' ? 'No active workers or workers with recorded attendance in this period.' : 'No worker rows with recorded attendance at this site in this period.'}</p> : <>
      <p className="text-xs text-ink-secondary">Scroll sideways to see all dates and the saved voucher column.</p>
      <div role="region" aria-label="Attendance matrix, scroll horizontally to see dates" tabIndex={0} className="relative max-w-full overflow-x-auto rounded-xl border border-surface-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
        <table className="w-full border-collapse text-xs">
          <caption className="sr-only">Attendance matrix for {start} to {end}, {scope}. Current rates and saved vouchers are visible on screen only.</caption>
          <thead className="bg-surface-inset"><tr><th scope="col" className="sticky left-0 z-10 min-w-44 bg-surface-inset p-3 text-left">Worker</th>{current.view.dates.map(date=><th scope="col" key={date} className="min-w-28 p-3 text-left tabular-nums">{date}</th>)}<th scope="col" className="min-w-48 p-3 text-left">Rate &amp; saved voucher</th></tr></thead>
          <tbody>{current.view.rows.map(row=><tr key={row.id} className="border-t border-surface-border align-top">
            <th scope="row" className="sticky left-0 z-10 bg-white p-3 text-left"><span className="block break-words font-semibold text-navy">{row.name}</span><span className="block font-normal text-ink-secondary">{row.position}{!row.active && ' · inactive'}</span></th>
            {row.cells.map((marks,i)=><td key={current.view!.dates[i]} className="p-2">{marks.length? <div className="space-y-1">{marks.map((mark,index)=><div key={`${mark.site}:${mark.code}:${index}`} className={`rounded-md px-2 py-1 break-words ${colors[mark.code]}`}><span aria-hidden="true" className="font-bold">{mark.code}</span><span className="sr-only">{mark.label}</span><span> · {mark.site}</span></div>)}</div>:<span><span aria-hidden="true">—</span><span className="sr-only">Unmarked</span></span>}</td>)}
            <td className="p-3 text-ink-secondary"><div>Current rate: {formatPeso(row.rate)} / {row.rateType==='daily'?'day':'hour'}</div>{row.vouchers.length===0?<div className="mt-1">No saved voucher for this period</div>:row.vouchers.length===1?<div className="mt-1">Saved voucher ({row.vouchers[0].status}): gross {formatPeso(Number(row.vouchers[0].gross_pay))} · net {formatPeso(Number(row.vouchers[0].net_pay))}</div>:<div className="mt-1 font-semibold text-status-danger">Multiple vouchers for this period; check the voucher list.</div>}</td>
          </tr>)}</tbody>
        </table>
      </div></>}
    </>}
  </div>;
}
