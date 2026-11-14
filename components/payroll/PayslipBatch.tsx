'use client';

import React, { useRef, useState } from 'react';
import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { formatPeso } from '@/lib/email/format';
import { formatRecordedWork } from '@/lib/payroll/display';
import { chunkPayslips, parsePayslipBatch, type BatchPayslip } from '@/lib/payroll/payslipBatch';
import { workerPayrollPeriod } from '@/lib/payroll/periods';
import { manilaDateISO } from '@/lib/dates/manila';
import { createClient } from '@/lib/supabase/client';

export function PayslipBatch({ onClose }: { onClose: () => void }) {
  const initial = workerPayrollPeriod(manilaDateISO());
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);
  const [rows, setRows] = useState<BatchPayslip[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const lock = useRef(false);
  const clear = () => { sequence.current += 1; setRows(null); setError(''); };
  const close = () => { sequence.current += 1; onClose(); };

  const prepare = async () => {
    if (lock.current || !start || !end || end < start) return;
    const token = ++sequence.current;
    lock.current = true; setBusy(true); setError(''); setRows(null);
    try {
      const { data, error: rpcError } = await createClient().rpc('payslip_batch_snapshot', { p_start: start, p_end: end });
      if (rpcError) {
        if (rpcError.code === 'P1004') throw new Error('Review duplicate vouchers, missing workers or unlinked Supervisor profiles for this period before printing.');
        throw new Error('Could not load complete payslips. Check the period and try again.');
      }
      const next = parsePayslipBatch(data, start, end);
      if (sequence.current === token) setRows(next);
    } catch (err) {
      if (sequence.current === token) setError(err instanceof Error ? err.message : 'Could not load payslips.');
    } finally { lock.current = false; setBusy(false); }
  };

  return <Modal isOpen onClose={close} title="Print worker payslips" description="Review all vouchers for one exact period before printing." maxWidth="5xl" presentation="workspace">
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Input type="date" label="Payslip period start" value={start} onChange={event => {clear(); setStart(event.target.value);}} />
        <Input type="date" label="Payslip period end" value={end} onChange={event => {clear(); setEnd(event.target.value);}} />
      </div>
      <p className="text-xs text-ink-secondary">The batch includes existing worker vouchers in all statuses for this exact period; draft and approved vouchers are not necessarily paid. Accounts linked to Supervisor profiles are excluded; review the list for legacy unlinked profiles. Printing does not change or pay a voucher.</p>
      <p className="text-xs text-ink-secondary">Up to nine slips are arranged per A4 page. Check print preview and readability, and handle each sheet privately. The rate can still be inferred from other figures.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={() => void prepare()} disabled={busy || !start || !end || end < start}>{busy ? 'Loading payslips…' : 'Load period payslips'}</Button>
        <Button type="button" variant="primary" onClick={() => window.print()} disabled={busy || !rows?.length} leftIcon={<Printer className="h-4 w-4" />}>Print all payslips</Button>
        <Button type="button" variant="ghost" onClick={close}>Close</Button>
      </div>
      {error && <p role="alert" className="rounded-lg bg-status-danger-bg p-3 text-xs text-status-danger">{error}</p>}
      {rows && <p role="status" className="text-xs text-ink-secondary">{rows.length === 0 ? 'No worker vouchers exist for this exact period.' : `${rows.length} worker voucher(s) loaded. Refresh before printing if payroll changed elsewhere.`}</p>}
      {rows && rows.length > 0 && <div data-print-document="payslip-batch" className="space-y-4">
        {chunkPayslips(rows).map((page, index, pages) => <section key={index} className={`payslip-batch-page grid gap-2 sm:grid-cols-3 ${index === pages.length - 1 ? 'payslip-batch-last' : ''}`} aria-label={`Payslip page ${index + 1}`}>
          {page.map(pay => <article key={pay.id} className="payslip-batch-card flex flex-col gap-1 rounded-lg border border-slate-300 bg-white p-2 text-xs text-black">
            <div className="font-bold">WORKER PAYSLIP · {pay.status.toUpperCase()}</div>
            <div className="font-bold break-words">{pay.worker_name}</div>
            <div className="break-words">{pay.recorded_craft ? <>Craft at voucher entry: {pay.recorded_craft.label} (may differ from work date)</> : <>Current craft: {pay.worker_position} (not a historical snapshot)</>}</div>
            <div>Period: {pay.period_start} to {pay.period_end}</div>
            <div>Days: {formatRecordedWork(pay.days_worked, 'days')} · Hours: {formatRecordedWork(pay.hours_worked, 'hours')}</div>
            <div className="payslip-batch-amounts border-t border-slate-200 pt-1">
              <div>Gross wages: {formatPeso(pay.gross_pay)}</div>
              <div>Bale deduction: −{formatPeso(pay.bale_deduction)}</div>
              {pay.other_deductions > 0 && <div>Other deductions: −{formatPeso(pay.other_deductions)}</div>}
              <div className="font-bold">NET PAY: {formatPeso(pay.net_pay)}</div>
            </div>
            <div className="mt-auto pt-2 text-[10px]">Authorized by: Ar. Junel Buyagon<br />Worker signature &amp; date: __________________</div>
          </article>)}
        </section>)}
      </div>}
    </div>
  </Modal>;
}
