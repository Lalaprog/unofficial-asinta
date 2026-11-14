'use client';
import React, { useState } from 'react';
import { TimeDetailDialog } from './TimeDetailDialog';
import { AllowanceDialog } from './AllowanceDialog';
import {AttendanceTimeDetails,AttendanceTimeLabel} from './AttendanceTimeDetails';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { formatDatePH } from '@/lib/email/format';
import { useAttendanceHistory } from '@/lib/attendance/useAttendanceHistory';
import { financeFoundationEnabled } from '@/lib/finance/featureAvailability';
import type { HistoryFilters, HistoryRecord, HistorySheet } from '@/lib/attendance/history';
import type { AttendanceStatus } from '@/types';
import {parseRecordedCraft} from '@/lib/workforce/recordedCraft';

function formatStatusLabel(status: AttendanceStatus): string {
  if (status === 'present') return 'Present (Full Day)';
  if (status === 'half_day') return 'Half Day';
  if (status === 'absent') return 'Absent';
  return 'Approved Leave';
}

export function HistorySheetRecords({sheet, filters, userId, revision, isFounder, reviewing, onReview, onEdit}: {
  sheet: HistorySheet; filters: HistoryFilters; userId: string | undefined; revision: number;
  isFounder: boolean; reviewing: boolean;
  onReview: (record: HistoryRecord, status: 'present'|'half_day'|'absent') => void;
  onEdit: (record: HistoryRecord) => void;
}) {
  const [timeRecord, setTimeRecord] = useState<HistoryRecord | null>(null);
  const [allowanceRecord, setAllowanceRecord] = useState<HistoryRecord | null>(null);
  const [timeRevision, setTimeRevision] = useState(0);
  const records = useAttendanceHistory<HistoryRecord>('records', true, userId, {...filters,projectId:sheet.project_id,date:sheet.date}, revision);
  return (
    <div className="divide-y divide-surface-border/60 border-t border-surface-border/60">
      <AttendanceTimeDetails records={records.items} userId={userId} revision={revision+timeRevision} loading={records.loading||Boolean(records.error)}>
      {records.items.map((rec) => {
        const observedCraft = parseRecordedCraft(rec as unknown as Record<string,unknown>);
        const isUnverifiedSelf = rec.is_supervisor && !rec.is_founder_override && (rec.status === 'present' || rec.status === 'half_day');
        return (
          <div key={rec.id} className="flex flex-col justify-between gap-2 px-4 py-2.5 text-xs transition-colors hover:bg-slate-50 sm:flex-row sm:items-center">
            <div className="min-w-0 space-y-0.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="break-words font-bold text-navy">{rec.worker_name || 'Worker (details unavailable)'}</span>
                {observedCraft ? <span className="text-[11px] text-ink-secondary">(Craft at entry: {observedCraft.label}; may differ from work date)</span> : rec.worker_position && <span className="text-[11px] text-ink-secondary">(Current craft: {rec.worker_position}; historical craft not recorded)</span>}
                {isUnverifiedSelf && <Badge variant="warning" size="sm">Pending Founder Approval (Held from Payroll)</Badge>}
                {rec.is_supervisor && rec.is_founder_override && <Badge variant="success" size="sm">Founder Approved ✓</Badge>}
                {!rec.is_supervisor && rec.is_founder_override && <Badge variant="navy" size="sm">Founder Override</Badge>}
              </div>
              {rec.notes && <div className="max-w-2xl whitespace-pre-wrap break-words text-[11px] text-ink-muted">{rec.notes}</div>}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              {typeof rec.hours_worked === 'number' && Number.isFinite(rec.hours_worked) && <span className="text-ink-secondary">{rec.hours_worked} hrs recorded</span>}
              {!rec.is_supervisor&&<AttendanceTimeLabel id={rec.id} />}
              <Badge variant={rec.status === 'present' ? 'success' : rec.status === 'half_day' ? 'warning' : rec.status === 'leave' ? 'info' : 'danger'} size="sm">{formatStatusLabel(rec.status)}</Badge>
              {isFounder && isUnverifiedSelf && <>
                <Button type="button" variant="primary" size="sm" disabled={reviewing || records.loading || Boolean(records.error)} onClick={() => onReview(rec,'present')}>Full Day</Button>
                <Button type="button" variant="secondary" size="sm" disabled={reviewing || records.loading || Boolean(records.error)} onClick={() => onReview(rec,'half_day')}>Half Day</Button>
                <Button type="button" variant="danger" size="sm" disabled={reviewing || records.loading || Boolean(records.error)} onClick={() => onReview(rec,'absent')}>Absent</Button>
              </>}
              {financeFoundationEnabled() && !rec.is_supervisor && (rec.status === 'present' || rec.status === 'half_day') && <Button type="button" variant="secondary" size="sm" disabled={records.loading || Boolean(records.error)} onClick={() => setTimeRecord(rec)}>Regular / OT</Button>}
              {financeFoundationEnabled() && !rec.is_supervisor && (rec.status === 'present' || rec.status === 'half_day') && <Button type="button" variant="secondary" size="sm" disabled={records.loading || Boolean(records.error)} onClick={() => setAllowanceRecord(rec)}>Allowances</Button>}
              {isFounder && <Button type="button" variant="secondary" size="sm" disabled={reviewing || records.loading || Boolean(records.error)} onClick={() => onEdit(rec)}>Edit</Button>}
            </div>
          </div>
        );
      })}
      </AttendanceTimeDetails>
      {financeFoundationEnabled() && allowanceRecord && <AllowanceDialog record={allowanceRecord} isFounder={isFounder} onClose={() => setAllowanceRecord(null)} />}
      {financeFoundationEnabled() && timeRecord && <TimeDetailDialog record={timeRecord} onClose={() => {setTimeRecord(null);setTimeRevision(n=>n+1);}} />}
      {records.loading && <p role="status" className="px-4 py-3 text-xs text-ink-secondary">Loading attendance records…</p>}
      {records.error && <div className="space-y-2 px-4 py-3 text-xs"><p role="alert" className="text-status-danger">Unable to load attendance records. Please retry.</p><Button type="button" variant="secondary" size="sm" onClick={records.retry}>Retry records</Button></div>}
      {!records.loading && !records.error && records.items.length === 0 && <p className="px-4 py-3 text-xs text-ink-secondary">No records match this sheet now. Refresh history to update its count.</p>}
      {records.hasMore && !records.error && <div className="flex flex-wrap items-center gap-2 px-4 py-2">
        <Button type="button" variant="secondary" size="sm" disabled={records.loading} onClick={records.loadMore}>Show more records for {formatDatePH(sheet.date)} · {sheet.project_name || 'Project Site'}</Button>
        <span className="text-xs text-ink-secondary">Showing {records.items.length} of {sheet.record_count} at last check</span>
      </div>}
    </div>
  );
}
