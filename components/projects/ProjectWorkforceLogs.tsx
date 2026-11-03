'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, Search, UserCheck } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { formatDatePH } from '@/lib/email/format';
import type { Attendance, Worker } from '@/types';

const DATE_PAGE_SIZE = 10;
const RECORD_PAGE_SIZE = 20;

function AttendanceDay({ date, records, workers }: { date: string; records: Attendance[]; workers: Map<string, Worker> }) {
  const [visibleRecords, setVisibleRecords] = useState(RECORD_PAGE_SIZE);
  return (
    <details className="group rounded-xl border border-surface-border bg-white">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-xl px-3 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand sm:px-4 [&::-webkit-details-marker]:hidden">
        <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 -rotate-90 text-ink-secondary transition-transform duration-200 group-open:rotate-0 motion-reduce:transition-none" />
        <time dateTime={date} className="min-w-0 flex-1 text-sm font-semibold text-navy">{formatDatePH(date)}</time>
        <span className="shrink-0 text-xs font-medium tabular-nums text-ink-secondary">{records.length} {records.length === 1 ? 'record' : 'records'}</span>
      </summary>
      <div className="divide-y divide-surface-border/70 border-t border-surface-border/70">
        {records.slice(0, visibleRecords).map((record) => {
          const worker = workers.get(record.worker_id);
          const label = record.status === 'half_day' ? 'Half day' : record.status === 'leave' ? 'Leave' : record.status === 'present' ? 'Present' : 'Absent';
          return (
            <div key={record.id} className="flex flex-wrap items-start justify-between gap-2 px-3 py-3 text-xs sm:px-4">
              <div className="min-w-0 flex-1">
                <div className="break-words font-semibold text-navy">{worker?.name || 'Worker'}</div>
                {worker?.position && <div className="mt-0.5 break-words text-ink-secondary">{worker.position}</div>}
                {record.notes && <div className="mt-1 break-words text-ink-secondary">{record.notes}</div>}
              </div>
              <div className="flex shrink-0 items-center gap-2 text-right">
                <span className="font-medium tabular-nums text-ink-secondary">{record.hours_worked} hrs</span>
                <Badge variant={record.status === 'present' ? 'success' : record.status === 'half_day' ? 'warning' : record.status === 'leave' ? 'info' : 'danger'} size="sm">{label}</Badge>
              </div>
            </div>
          );
        })}
        {visibleRecords < records.length && (
          <div className="px-3 py-2 sm:px-4">
            <Button type="button" variant="secondary" size="sm" onClick={() => setVisibleRecords((n) => n + RECORD_PAGE_SIZE)}>
              Show more records for {formatDatePH(date)}
            </Button>
            <span className="ml-2 text-xs text-ink-secondary">Showing {visibleRecords} of {records.length}</span>
          </div>
        )}
      </div>
    </details>
  );
}

/** A compact view over the records already in the shared store, not a server-wide search. */
export function ProjectWorkforceLogs({ records, workers }: { records: Attendance[]; workers: Worker[] }) {
  const [query, setQuery] = useState('');
  const [date, setDate] = useState('');
  const [visibleDates, setVisibleDates] = useState(DATE_PAGE_SIZE);
  const workerById = useMemo(() => new Map(workers.map((worker) => [worker.id, worker])), [workers]);
  const groups = useMemo(() => {
    const search = query.trim().toLowerCase();
    const grouped = new Map<string, Attendance[]>();
    records.forEach((record) => {
      if (date && record.date !== date) return;
      const worker = workerById.get(record.worker_id);
      const searchable = [worker?.name || 'Worker', worker?.position || '', record.notes || ''].join(' ').toLowerCase();
      if (search && !searchable.includes(search)) return;
      const day = grouped.get(record.date) || [];
      day.push(record);
      grouped.set(record.date, day);
    });
    return [...grouped.entries()].sort(([a], [b]) => b.localeCompare(a));
  }, [records, workerById, query, date]);
  const matchingRecords = groups.reduce((sum, [, day]) => sum + day.length, 0);

  return (
    <div className="animate-panel-enter animate-panel-lift space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-navy">Site Attendance Logs</h3>
        <Link href="/attendance" className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-brand bg-brand px-3 text-xs font-medium text-white hover:bg-brand-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2">
          <UserCheck className="h-3.5 w-3.5" aria-hidden="true" />
          Go to Attendance Terminal
        </Link>
      </div>
      <div className="grid grid-cols-1 gap-3 rounded-xl border border-surface-border bg-white p-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <Input label="Search loaded logs" placeholder="Worker, craft or note" value={query} onChange={(event) => { setQuery(event.target.value); setVisibleDates(DATE_PAGE_SIZE); }} leftIcon={<Search className="h-4 w-4" aria-hidden="true" />} />
        <Input label="Attendance date" type="date" value={date} onChange={(event) => { setDate(event.target.value); setVisibleDates(DATE_PAGE_SIZE); }} />
      </div>
      <p aria-live="polite" className="text-xs text-ink-secondary">
        {matchingRecords} matching {matchingRecords === 1 ? 'record' : 'records'} in loaded data. Showing {Math.min(visibleDates, groups.length)} of {groups.length} matching dates.
      </p>
      {groups.length ? (
        <div className="space-y-2">
          {groups.slice(0, visibleDates).map(([day, dayRecords]) => <AttendanceDay key={day} date={day} records={dayRecords} workers={workerById} />)}
          {visibleDates < groups.length && (
            <Button type="button" variant="secondary" onClick={() => setVisibleDates((n) => n + DATE_PAGE_SIZE)} className="w-full sm:w-auto">Show more dates</Button>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-surface-border bg-white p-8 text-center text-xs text-ink-secondary">
          {records.length ? 'No loaded attendance records match these filters.' : 'No attendance records are currently loaded for this site.'}
        </div>
      )}
    </div>
  );
}
