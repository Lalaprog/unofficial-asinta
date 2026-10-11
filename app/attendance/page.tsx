'use client';

import React, { useState, useEffect } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { useDataStore } from '@/lib/data/store';
import { useAuth } from '@/lib/auth/authContext';
import { AttendanceStatus } from '@/types';
import {
  UserCheck,
  CheckCircle2,
  Search,
  History,
  Save,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';

export default function AttendancePage() {
  const { user, isFounder, isSupervisor } = useAuth();
  const { showToast } = useToast();
  const {
    workers,
    projects,
    attendance,
    recordAttendanceBatch,
    updateAttendanceRecord,
    getProjectsForSupervisor,
  } = useDataStore();

  // Accessible projects for user
  const accessibleProjects = isSupervisor && user
    ? getProjectsForSupervisor(user.id)
    : projects;

  // Terminal workflow state
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    accessibleProjects[0]?.id || projects[0]?.id || ''
  );
  const [selectedDate, setSelectedDate] = useState<string>(today);
  const [activeTab, setActiveTab] = useState<'terminal' | 'history'>('terminal');

  // Terminal active draft attendance records
  const [draftAttendance, setDraftAttendance] = useState<
    Record<
      string,
      {
        status: AttendanceStatus;
        hours_worked: number;
        notes: string;
      }
    >
  >({});

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionSuccess, setSubmissionSuccess] = useState(false);
  const [searchWorker, setSearchWorker] = useState('');

  // History tab filters
  const [historyProjectFilter, setHistoryProjectFilter] = useState<string>('all');
  const [historyStatusFilter, setHistoryStatusFilter] = useState<string>('all');
  const [historyDateFilter, setHistoryDateFilter] = useState<string>('');
  const [historySearchQuery, setHistorySearchQuery] = useState<string>('');

  // Founder Override modal
  const [overrideModalOpen, setOverrideModalOpen] = useState(false);
  const [selectedRecordForOverride, setSelectedRecordForOverride] = useState<any>(null);
  const [overrideStatus, setOverrideStatus] = useState<AttendanceStatus>('present');
  const [overrideHours, setOverrideHours] = useState('8');
  const [overrideNotes, setOverrideNotes] = useState('');

  // Update selectedProjectId when accessible projects change
  useEffect(() => {
    if (accessibleProjects.length > 0 && !accessibleProjects.some((p) => p.id === selectedProjectId)) {
      setSelectedProjectId(accessibleProjects[0].id);
    }
  }, [accessibleProjects, selectedProjectId]);

  // Load existing records for project and date into terminal
  useEffect(() => {
    if (!selectedProjectId) return;
    const existing = attendance.filter(
      (a) => a.project_id === selectedProjectId && a.date === selectedDate
    );

    const initialDraft: Record<string, { status: AttendanceStatus; hours_worked: number; notes: string }> = {};

    workers.filter((w) => w.active).forEach((w) => {
      const match = existing.find((a) => a.worker_id === w.id);
      if (match) {
        initialDraft[w.id] = {
          status: match.status,
          hours_worked: match.hours_worked,
          notes: match.notes || '',
        };
      } else {
        // Default to present 8 hours
        initialDraft[w.id] = {
          status: 'present',
          hours_worked: 8,
          notes: '',
        };
      }
    });

    setDraftAttendance(initialDraft);
    setSubmissionSuccess(false);
  }, [selectedProjectId, selectedDate, attendance, workers]);

  const handleStatusChange = (workerId: string, status: AttendanceStatus) => {
    const current = draftAttendance[workerId] || { status: 'present', hours_worked: 8, notes: '' };
    let hours = 8;
    if (status === 'half_day') hours = 4;
    if (status === 'absent' || status === 'leave') hours = 0;

    setDraftAttendance({
      ...draftAttendance,
      [workerId]: {
        ...current,
        status,
        hours_worked: hours,
      },
    });
  };

  const handleHoursChange = (workerId: string, hours: number) => {
    const current = draftAttendance[workerId] || { status: 'present', hours_worked: 8, notes: '' };
    setDraftAttendance({
      ...draftAttendance,
      [workerId]: {
        ...current,
        hours_worked: hours,
      },
    });
  };

  const handleNotesChange = (workerId: string, notes: string) => {
    const current = draftAttendance[workerId] || { status: 'present', hours_worked: 8, notes: '' };
    setDraftAttendance({
      ...draftAttendance,
      [workerId]: {
        ...current,
        notes,
      },
    });
  };

  const handleBatchSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProjectId) return;
    if (!user) return;
    if (selectedDate > today) {
      showToast('error', 'Attendance cannot be recorded for a future date.');
      return;
    }

    setIsSubmitting(true);
    const batch = Object.entries(draftAttendance).map(([workerId, data]) => ({
      worker_id: workerId,
      project_id: selectedProjectId,
      date: selectedDate,
      status: data.status,
      hours_worked: data.hours_worked,
      notes: data.notes || null,
      recorded_by: user.id,
    }));

    const success = await recordAttendanceBatch(batch);
    setIsSubmitting(false);
    if (success) {
      setSubmissionSuccess(true);
      setTimeout(() => setSubmissionSuccess(false), 3000);
    }
  };

  const handleFounderOverrideSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRecordForOverride) return;

    const success = await updateAttendanceRecord(
      selectedRecordForOverride.id,
      {
        status: overrideStatus,
        hours_worked: parseFloat(overrideHours),
        notes: overrideNotes
          ? `[Founder Override]: ${overrideNotes}`
          : `[Founder Override by ${user?.name || 'Founder'}]`,
      },
      true // set founder override = true
    );

    if (success) {
      setOverrideModalOpen(false);
    }
  };

  // Filtered workers
  const filteredWorkers = workers
    .filter((w) => w.active)
    .filter((w) => w.name.toLowerCase().includes(searchWorker.toLowerCase()) || w.position.toLowerCase().includes(searchWorker.toLowerCase()));

  // Attendance summary counts for active date & project
  const presentCount = Object.values(draftAttendance).filter((d) => d.status === 'present').length;
  const halfDayCount = Object.values(draftAttendance).filter((d) => d.status === 'half_day').length;
  const absentCount = Object.values(draftAttendance).filter((d) => d.status === 'absent').length;
  const leaveCount = Object.values(draftAttendance).filter((d) => d.status === 'leave').length;

  const accessibleProjectIdSet = new Set(accessibleProjects.map((p) => p.id));
  const filteredHistoryAttendance = attendance.filter((rec) => {
    if (isSupervisor && !accessibleProjectIdSet.has(rec.project_id)) {
      return false;
    }
    if (historyProjectFilter !== 'all' && rec.project_id !== historyProjectFilter) {
      return false;
    }
    if (historyStatusFilter !== 'all' && rec.status !== historyStatusFilter) {
      return false;
    }
    if (historyDateFilter && rec.date !== historyDateFilter) {
      return false;
    }
    if (historySearchQuery.trim()) {
      const q = historySearchQuery.toLowerCase();
      const worker = workers.find((w) => w.id === rec.worker_id);
      const proj = projects.find((p) => p.id === rec.project_id);
      const matchesName = worker?.name.toLowerCase().includes(q) || false;
      const matchesPos = worker?.position.toLowerCase().includes(q) || false;
      const matchesProj = proj?.name.toLowerCase().includes(q) || false;
      const matchesNotes = rec.notes?.toLowerCase().includes(q) || false;
      if (!matchesName && !matchesPos && !matchesProj && !matchesNotes) {
        return false;
      }
    }
    return true;
  });

  return (
    <AppShell>
      <div className="space-y-6 max-w-5xl mx-auto">
        {/* Terminal Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-surface-border/60">
          <div>
            <div className="flex items-center space-x-2">
              <span className="text-xs font-bold text-navy uppercase tracking-widest">
                {isFounder ? 'Workforce Management' : 'Field Attendance Terminal'}
              </span>
              <span className="text-xs text-ink-muted">·</span>
              <span className="text-xs text-ink-secondary">
                {isFounder ? 'Founder Override Enabled' : 'Touch Optimized'}
              </span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-navy tracking-tight mt-1">
              Site Workforce & Attendance
            </h1>
          </div>

          <div className="flex items-center space-x-2">
            <Button
              variant={activeTab === 'terminal' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setActiveTab('terminal')}
              leftIcon={<UserCheck className="w-3.5 h-3.5" />}
            >
              Daily Roster
            </Button>
            <Button
              variant={activeTab === 'history' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setActiveTab('history')}
              leftIcon={<History className="w-3.5 h-3.5" />}
            >
              Logs & History
            </Button>
          </div>
        </div>

        {/* WORKFLOW BAR: STEP 1 (PROJECT) & STEP 2 (DATE) */}
        <div className="p-4 sm:p-5 rounded-3xl bg-white border border-surface-border shadow-[6px_6px_18px_rgba(11,31,58,0.06),-6px_-6px_18px_rgba(255,255,255,0.95)] grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
          <div>
            <label className="text-[11px] font-bold text-navy uppercase tracking-wider block mb-1.5">
              1. Project Site
            </label>
            <Select
              value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(e.target.value)}
            >
              {accessibleProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.location.split(',')[0]})
                </option>
              ))}
            </Select>
          </div>

          <div>
            <label className="text-[11px] font-bold text-navy uppercase tracking-wider block mb-1.5">
              2. Attendance Date
            </label>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setSelectedDate(today)}
                className={`py-2 px-3 text-xs font-semibold rounded-xl border transition-all ${
                  selectedDate === today
                    ? 'bg-navy text-white border-navy shadow-sm'
                    : 'bg-surface-inset text-navy border-surface-border hover:bg-slate-200'
                }`}
              >
                Today
              </button>
              <button
                type="button"
                onClick={() => setSelectedDate(yesterday)}
                className={`py-2 px-3 text-xs font-semibold rounded-xl border transition-all ${
                  selectedDate === yesterday
                    ? 'bg-navy text-white border-navy shadow-sm'
                    : 'bg-surface-inset text-navy border-surface-border hover:bg-slate-200'
                }`}
              >
                Yesterday
              </button>
              <Input
                type="date"
                value={selectedDate}
                max={today}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="py-1.5 text-xs"
              />
            </div>
          </div>
        </div>

        {/* TAB 1: TERMINAL / DAILY ROSTER */}
        {activeTab === 'terminal' && (
          <form onSubmit={handleBatchSubmit} className="space-y-6">
            {/* Live Count Summary */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-3 rounded-2xl bg-status-success-bg/70 border border-status-success/20 text-status-success text-center">
                <div className="text-xl font-bold">{presentCount}</div>
                <div className="text-[11px] font-semibold uppercase tracking-wider">Present Full Day</div>
              </div>
              <div className="p-3 rounded-2xl bg-status-warning-bg/70 border border-status-warning/20 text-status-warning text-center">
                <div className="text-xl font-bold">{halfDayCount}</div>
                <div className="text-[11px] font-semibold uppercase tracking-wider">Half Day (4h)</div>
              </div>
              <div className="p-3 rounded-2xl bg-status-danger-bg/70 border border-status-danger/20 text-status-danger text-center">
                <div className="text-xl font-bold">{absentCount}</div>
                <div className="text-[11px] font-semibold uppercase tracking-wider">Absent</div>
              </div>
              <div className="p-3 rounded-2xl bg-status-info-bg/70 border border-status-info/20 text-status-info text-center">
                <div className="text-xl font-bold">{leaveCount}</div>
                <div className="text-[11px] font-semibold uppercase tracking-wider">Approved Leave</div>
              </div>
            </div>

            {/* Quick search */}
            <div className="max-w-md">
              <Input
                placeholder="Filter worker by name or craft..."
                value={searchWorker}
                onChange={(e) => setSearchWorker(e.target.value)}
                leftIcon={<Search className="w-4 h-4" />}
              />
            </div>

            {/* Submission Banner */}
            {submissionSuccess && (
              <div className="p-4 rounded-2xl bg-status-success-bg border border-status-success/20 text-status-success text-sm font-semibold flex items-center space-x-2 animate-in fade-in">
                <CheckCircle2 className="w-5 h-5 text-status-success" />
                <span>Attendance records successfully saved and synchronized with BALE ledger!</span>
              </div>
            )}

            {/* WORKER ATTENDANCE CARDS (TOUCH-OPTIMIZED) */}
            <div className="space-y-4">
              {filteredWorkers.map((worker) => {
                const currentDraft = draftAttendance[worker.id] || {
                  status: 'present',
                  hours_worked: 8,
                  notes: '',
                };

                return (
                  <div
                    key={worker.id}
                    className="p-5 rounded-3xl bg-white border border-surface-border shadow-[5px_5px_15px_rgba(11,31,58,0.05),-5px_-5px_15px_rgba(255,255,255,0.95)] space-y-4"
                  >
                    {/* Top worker line */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div>
                        <div className="text-base font-bold text-navy">{worker.name}</div>
                        <div className="text-xs text-ink-secondary flex items-center gap-2">
                          <span>{worker.position}</span>
                          <span>·</span>
                          <span>Daily Rate: ₱{worker.pay_rate}</span>
                        </div>
                      </div>

                      <div className="flex items-center space-x-2">
                        <span className="text-xs text-ink-secondary">Hours Worked:</span>
                        <input
                          type="number"
                          step="0.5"
                          min="0"
                          max="24"
                          value={currentDraft.hours_worked}
                          onChange={(e) =>
                            handleHoursChange(worker.id, parseFloat(e.target.value) || 0)
                          }
                          className="w-16 p-1.5 text-center text-sm font-bold text-navy bg-surface-inset border border-surface-border rounded-xl focus:bg-white focus:outline-none"
                        />
                      </div>
                    </div>

                    {/* LARGE TOUCH-TOGGLE STATUS BUTTONS */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {[
                        { id: 'present', label: 'Present (8h)', color: 'bg-status-success', activeBg: 'bg-status-success-bg border-status-success text-status-success shadow-sm ring-2 ring-status-success/20' },
                        { id: 'half_day', label: 'Half Day (4h)', color: 'bg-status-warning', activeBg: 'bg-status-warning-bg border-status-warning text-status-warning shadow-sm ring-2 ring-status-warning/20' },
                        { id: 'absent', label: 'Absent (0h)', color: 'bg-status-danger', activeBg: 'bg-status-danger-bg border-status-danger text-status-danger shadow-sm ring-2 ring-status-danger/20' },
                        { id: 'leave', label: 'Leave (0h)', color: 'bg-status-info', activeBg: 'bg-status-info-bg border-status-info text-status-info shadow-sm ring-2 ring-status-info/20' },
                      ].map((item) => {
                        const isSelected = currentDraft.status === item.id;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => handleStatusChange(worker.id, item.id as AttendanceStatus)}
                            className={`p-3 rounded-2xl border text-xs font-bold transition-all select-none flex items-center justify-center space-x-2 ${
                              isSelected
                                ? item.activeBg
                                : 'bg-surface-inset/50 border-surface-border/70 text-ink-secondary hover:bg-surface-inset'
                            }`}
                          >
                            <span
                              className={`w-2.5 h-2.5 rounded-full ${
                                isSelected ? item.color : 'bg-slate-300'
                              }`}
                            />
                            <span>{item.label}</span>
                          </button>
                        );
                      })}
                    </div>

                    {/* Activity Notes */}
                    <div>
                      <Input
                        placeholder="Site activity notes (e.g. Balcony formwork, concrete pouring assistance)..."
                        value={currentDraft.notes}
                        onChange={(e) => handleNotesChange(worker.id, e.target.value)}
                        className="text-xs"
                      />
                    </div>
                  </div>
                );
              })}

              {filteredWorkers.length === 0 && (
                <div className="bg-white rounded-3xl border border-surface-border">
                  <EmptyState
                    title="No workers on this site"
                    description={
                      workers.length === 0
                        ? 'Register workers first — they will appear here for daily attendance.'
                        : 'No worker matches the current filter.'
                    }
                  />
                </div>
              )}
            </div>

            {/* Bottom Submit Sticky Bar */}
            <div className="sticky bottom-4 z-30 p-4 rounded-2xl bg-white/95 backdrop-blur-md border border-surface-border shadow-2xl flex items-center justify-between">
              <div className="text-xs text-ink-secondary">
                Ready to submit for <span className="font-bold text-navy">{filteredWorkers.length} workers</span> on {selectedDate}.
              </div>

              <Button
                type="submit"
                variant="primary"
                size="lg"
                isLoading={isSubmitting}
                leftIcon={<Save className="w-4 h-4" />}
              >
                Submit Site Attendance
              </Button>
            </div>
          </form>
        )}

        {/* TAB 2: ATTENDANCE HISTORY & FOUNDER OVERRIDE */}
        {activeTab === 'history' && (
          <div className="space-y-4">
            {/* Project Site, Status, Date & Worker Filters for History */}
            <div className="p-4 rounded-3xl bg-white border border-surface-border shadow-sm flex flex-col sm:flex-row flex-wrap items-center gap-3">
              <div className="w-full sm:w-64">
                <Input
                  placeholder="Search worker, craft, project, or notes..."
                  value={historySearchQuery}
                  onChange={(e) => setHistorySearchQuery(e.target.value)}
                  leftIcon={<Search className="w-4 h-4" />}
                />
              </div>

              <div className="w-full sm:w-60">
                <Select
                  value={historyProjectFilter}
                  onChange={(e) => setHistoryProjectFilter(e.target.value)}
                  options={[
                    { label: 'All Project Sites', value: 'all' },
                    ...accessibleProjects.map((p) => ({
                      label: `${p.name} (${p.location.split(',')[0]})`,
                      value: p.id,
                    })),
                  ]}
                />
              </div>

              <div className="w-full sm:w-44">
                <Select
                  value={historyStatusFilter}
                  onChange={(e) => setHistoryStatusFilter(e.target.value)}
                  options={[
                    { label: 'All Statuses', value: 'all' },
                    { label: 'Present', value: 'present' },
                    { label: 'Half Day', value: 'half_day' },
                    { label: 'Absent', value: 'absent' },
                    { label: 'Approved Leave', value: 'leave' },
                  ]}
                />
              </div>

              <div className="w-full sm:w-auto flex items-center gap-2">
                <Input
                  type="date"
                  value={historyDateFilter}
                  max={today}
                  onChange={(e) => setHistoryDateFilter(e.target.value)}
                  className="py-1.5 text-xs"
                />
                {(historyProjectFilter !== 'all' ||
                  historyStatusFilter !== 'all' ||
                  historyDateFilter ||
                  historySearchQuery) && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setHistoryProjectFilter('all');
                      setHistoryStatusFilter('all');
                      setHistoryDateFilter('');
                      setHistorySearchQuery('');
                    }}
                  >
                    Reset
                  </Button>
                )}
              </div>
            </div>

            <div className="bg-white rounded-3xl border border-surface-border shadow-sm overflow-hidden">
              <div className="p-4 border-b border-surface-border/60 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <h3 className="font-bold text-navy text-sm">Attendance Logs &amp; Audit Trail</h3>
                  <p className="text-xs text-ink-secondary">
                    Review historical records by project site. {isFounder ? 'Founders may override or correct records.' : 'Read-only access.'}
                  </p>
                </div>
                <Badge variant="neutral" size="sm">
                  {filteredHistoryAttendance.length} record{filteredHistoryAttendance.length === 1 ? '' : 's'}
                </Badge>
              </div>

              <div className="divide-y divide-surface-border/70">
                {filteredHistoryAttendance.map((rec) => {
                  const worker = workers.find((w) => w.id === rec.worker_id);
                  const proj = projects.find((p) => p.id === rec.project_id);

                  return (
                    <div
                      key={rec.id}
                      className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs hover:bg-slate-50 transition-colors"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center space-x-2">
                          <span className="font-bold text-navy text-sm">{worker?.name}</span>
                          <span className="text-ink-secondary">({worker?.position})</span>
                          {rec.is_founder_override && (
                            <Badge variant="navy" size="sm">
                              Founder Override
                            </Badge>
                          )}
                        </div>
                        <div className="text-ink-secondary">
                          Project: <span className="font-semibold text-navy">{proj?.name}</span> · Date: {rec.date}
                        </div>
                        {rec.notes && <div className="text-ink-muted italic">{rec.notes}</div>}
                      </div>

                      <div className="flex items-center space-x-4">
                        <div className="text-right">
                          <div className="font-bold text-navy">{rec.hours_worked} Hours</div>
                          <Badge
                            variant={
                              rec.status === 'present'
                                ? 'success'
                                : rec.status === 'half_day'
                                ? 'warning'
                                : 'danger'
                            }
                            size="sm"
                            className="mt-0.5 capitalize"
                          >
                            {rec.status.replace('_', ' ')}
                          </Badge>
                        </div>

                        {isFounder && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              setSelectedRecordForOverride(rec);
                              setOverrideStatus(rec.status);
                              setOverrideHours(String(rec.hours_worked));
                              setOverrideNotes(rec.notes || '');
                              setOverrideModalOpen(true);
                            }}
                          >
                            Override
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}

                {filteredHistoryAttendance.length === 0 && (
                  <EmptyState
                    title="No attendance records match"
                    description={
                      attendance.length === 0
                        ? 'Submitted site attendance will appear here with its full audit trail.'
                        : 'Try selecting "All Project Sites" or clearing the date/search filter.'
                    }
                  />
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* FOUNDER OVERRIDE MODAL */}
      <Modal
        isOpen={overrideModalOpen}
        onClose={() => setOverrideModalOpen(false)}
        title="Founder Attendance Override"
        description="Correct or adjust site attendance records. An audit flag will be attached."
      >
        {selectedRecordForOverride && (
          <form onSubmit={handleFounderOverrideSubmit} className="space-y-4 text-xs">
            <div className="p-3 rounded-xl bg-surface-inset border border-surface-border space-y-1">
              <div className="font-bold text-navy">
                Worker: {workers.find((w) => w.id === selectedRecordForOverride.worker_id)?.name}
              </div>
              <div className="text-ink-secondary">
                Original Date: {selectedRecordForOverride.date}
              </div>
            </div>

            <Select
              label="Corrected Status"
              value={overrideStatus}
              onChange={(e) => setOverrideStatus(e.target.value as AttendanceStatus)}
            >
              <option value="present">Present</option>
              <option value="half_day">Half Day</option>
              <option value="absent">Absent</option>
              <option value="leave">Approved Leave</option>
            </Select>

            <Input
              label="Hours Worked"
              type="number"
              step="0.5"
              value={overrideHours}
              onChange={(e) => setOverrideHours(e.target.value)}
              required
            />

            <Input
              label="Reason for Override"
              placeholder="e.g. Approved medical leave with barangay certificate"
              value={overrideNotes}
              onChange={(e) => setOverrideNotes(e.target.value)}
            />

            <div className="pt-3 flex justify-end space-x-2">
              <Button variant="secondary" onClick={() => setOverrideModalOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" type="submit">
                Apply Founder Override
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </AppShell>
  );
}
