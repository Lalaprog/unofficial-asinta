'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { useDataStore } from '@/lib/data/store';
import { useAuth } from '@/lib/auth/authContext';
import { Attendance, AttendanceStatus, Worker } from '@/types';
import {
  CheckCircle2,
  Clock,
  Save,
  Search,
  UserPlus,
  Settings2,
  MapPin,
  ShieldAlert,
  ShieldCheck,
  ChevronDown,
  ChevronRight,
  LayoutList,
  LayoutGrid,
  MessageSquare,
  CheckCheck,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';

type CraftGroupKey =
  | 'supervision'
  | 'masonry'
  | 'carpentry'
  | 'mep_steel'
  | 'general';

const CRAFT_GROUP_META: Record<
  CraftGroupKey,
  { label: string; order: number }
> = {
  supervision: { label: 'Site Supervision & Foremen', order: 1 },
  masonry: { label: 'Masonry & Concrete', order: 2 },
  carpentry: { label: 'Carpentry & Formworks', order: 3 },
  mep_steel: { label: 'Steel, Electrical & Plumbing', order: 4 },
  general: { label: 'Finishing & General Labor', order: 5 },
};

function getCraftGroup(position: string): CraftGroupKey {
  const pos = position.toLowerCase();
  if (pos.includes('supervisor') || pos.includes('foreman') || pos.includes('engineer')) {
    return 'supervision';
  }
  if (pos.includes('mason') || pos.includes('concrete') || pos.includes('tile')) {
    return 'masonry';
  }
  if (pos.includes('carpenter') || pos.includes('formwork') || pos.includes('joiner')) {
    return 'carpentry';
  }
  if (
    pos.includes('steel') ||
    pos.includes('welder') ||
    pos.includes('tinsmith') ||
    pos.includes('electric') ||
    pos.includes('plumb')
  ) {
    return 'mep_steel';
  }
  return 'general';
}

export default function AttendancePage() {
  const { user, isFounder, isSupervisor } = useAuth();
  const { showToast } = useToast();
  const {
    users,
    workers,
    projects,
    attendance,
    createWorker,
    updateWorker,
    toggleWorkerStatus,
    recordAttendanceBatch,
    updateAttendanceRecord,
    getProjectsForSupervisor,
  } = useDataStore();

  // Accessible projects for user
  const accessibleProjects =
    isSupervisor && user ? getProjectsForSupervisor(user.id) : projects;

  // Terminal workflow state
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    accessibleProjects[0]?.id || projects[0]?.id || ''
  );
  const [selectedDate, setSelectedDate] = useState<string>(today);
  const [activeTab, setActiveTab] = useState<'terminal' | 'history' | 'workforce'>('terminal');

  // Compact vs Card view for Daily Roster (defaults to compact grouped rows)
  const [viewMode, setViewMode] = useState<'compact' | 'cards'>('compact');
  const [craftFilter, setCraftFilter] = useState<string>('all');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [expandedNoteWorkers, setExpandedNoteWorkers] = useState<Record<string, boolean>>({});
  const [isLocatingGps, setIsLocatingGps] = useState(false);

  // Workforce tab state (add & edit worker)
  const [workerName, setWorkerName] = useState('');
  const [workerPosition, setWorkerPosition] = useState('Mason');
  const [workerRate, setWorkerRate] = useState('850');
  const [workerRateType, setWorkerRateType] = useState<'daily' | 'hourly'>('daily');
  const [workerPhone, setWorkerPhone] = useState('');
  const [isAddingWorker, setIsAddingWorker] = useState(false);
  const [workforceSearch, setWorkforceSearch] = useState('');
  const [workforceCraftFilter, setWorkforceCraftFilter] = useState<string>('all');

  const [editingWorker, setEditingWorker] = useState<Worker | null>(null);
  const [editWorkerName, setEditWorkerName] = useState('');
  const [editWorkerPosition, setEditWorkerPosition] = useState('');
  const [editWorkerRate, setEditWorkerRate] = useState('');
  const [editWorkerRateType, setEditWorkerRateType] = useState<'daily' | 'hourly'>('daily');
  const [editWorkerPhone, setEditWorkerPhone] = useState('');
  const [isSavingWorker, setIsSavingWorker] = useState(false);

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

  // History tab filters & collapsible daily sheets
  const [historyProjectFilter, setHistoryProjectFilter] = useState<string>('all');
  const [historyStatusFilter, setHistoryStatusFilter] = useState<string>('all');
  const [historyDateFilter, setHistoryDateFilter] = useState<string>('');
  const [historySearchQuery, setHistorySearchQuery] = useState<string>('');
  const [collapsedHistorySheets, setCollapsedHistorySheets] = useState<Record<string, boolean>>({});

  // Founder Override modal
  const [overrideModalOpen, setOverrideModalOpen] = useState(false);
  const [selectedRecordForOverride, setSelectedRecordForOverride] = useState<Attendance | null>(null);
  const [overrideStatus, setOverrideStatus] = useState<AttendanceStatus>('present');
  const [overrideHours, setOverrideHours] = useState('8');
  const [overrideNotes, setOverrideNotes] = useState('');

  const isSelfSupervisorWorker = (w: Worker): boolean => {
    if (!isSupervisor || !user) return false;
    return (
      w.id === user.id || w.name.trim().toLowerCase() === user.name.trim().toLowerCase()
    );
  };

  // Update selectedProjectId when accessible projects change
  useEffect(() => {
    if (
      accessibleProjects.length > 0 &&
      !accessibleProjects.some((p) => p.id === selectedProjectId)
    ) {
      setSelectedProjectId(accessibleProjects[0].id);
    }
  }, [accessibleProjects, selectedProjectId]);

  // Sync activeTab with ?tab= query parameter (used by Supervisor sidebar & notifications)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const tabParam = params.get('tab');
    if (tabParam === 'history' || tabParam === 'workforce' || tabParam === 'terminal') {
      setActiveTab(tabParam);
    }
  }, []);

  // Load existing records for project and date into terminal
  useEffect(() => {
    if (!selectedProjectId) return;
    const existing = attendance.filter(
      (a) => a.project_id === selectedProjectId && a.date === selectedDate
    );

    const initialDraft: Record<
      string,
      { status: AttendanceStatus; hours_worked: number; notes: string }
    > = {};

    workers
      .filter((w) => w.active)
      .forEach((w) => {
        const match = existing.find((a) => a.worker_id === w.id);
        if (match) {
          initialDraft[w.id] = {
            status: match.status,
            hours_worked: match.hours_worked,
            notes: match.notes || '',
          };
        } else if (isSupervisor && user && (w.id === user.id || w.name.trim().toLowerCase() === user.name.trim().toLowerCase())) {
          // Anti-fraud default: Supervisor's OWN row defaults to Absent (0h)
          // until they perform an explicit GPS Self Check-In (which still requires
          // Founder verification before payroll payout).
          initialDraft[w.id] = {
            status: 'absent',
            hours_worked: 0,
            notes: '',
          };
        } else {
          // Regular field crew defaults to present 8 hours
          initialDraft[w.id] = {
            status: 'present',
            hours_worked: 8,
            notes: '',
          };
        }
      });

    setDraftAttendance(initialDraft);
    setSubmissionSuccess(false);
  }, [selectedProjectId, selectedDate, attendance, workers, isSupervisor, user]);

  // Capture GPS proof when a Supervisor checks themselves in as Present or Half Day
  const stampSupervisorSelfCheckIn = (workerId: string, status: AttendanceStatus, hours: number) => {
    const timeLabel = new Date().toLocaleTimeString('en-PH', {
      hour: '2-digit',
      minute: '2-digit',
    });

    if (typeof navigator !== 'undefined' && 'geolocation' in navigator) {
      setIsLocatingGps(true);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setIsLocatingGps(false);
          const lat = pos.coords.latitude.toFixed(4);
          const lng = pos.coords.longitude.toFixed(4);
          const acc = Math.round(pos.coords.accuracy);
          const stamp = `[SELF-CHECKIN | GPS: ${lat}, ${lng} (±${acc}m) @ ${timeLabel} | Pending Founder Verification]`;
          setDraftAttendance((prev) => ({
            ...prev,
            [workerId]: {
              status,
              hours_worked: hours,
              notes: stamp,
            },
          }));
          showToast(
            'info',
            `GPS Check-In stamped (${lat}, ${lng}). A Founder must verify your self-attendance before payroll.`
          );
        },
        () => {
          setIsLocatingGps(false);
          const stamp = `[SELF-CHECKIN | NO GPS PROOF (Location Denied/Unavailable) @ ${timeLabel} | Pending Founder Verification]`;
          setDraftAttendance((prev) => ({
            ...prev,
            [workerId]: {
              status,
              hours_worked: hours,
              notes: stamp,
            },
          }));
          showToast(
            'info',
            'GPS location was unavailable — self-attendance is flagged as No GPS Proof for Founder review.'
          );
        },
        { enableHighAccuracy: true, timeout: 6000, maximumAge: 60000 }
      );
    } else {
      const stamp = `[SELF-CHECKIN | NO GPS DEVICE @ ${timeLabel} | Pending Founder Verification]`;
      setDraftAttendance((prev) => ({
        ...prev,
        [workerId]: {
          status,
          hours_worked: hours,
          notes: stamp,
        },
      }));
    }
  };

  const handleStatusChange = (worker: Worker, status: AttendanceStatus) => {
    const current = draftAttendance[worker.id] || {
      status: 'present',
      hours_worked: 8,
      notes: '',
    };
    let hours = 8;
    if (status === 'half_day') hours = 4;
    if (status === 'absent' || status === 'leave') hours = 0;

    // If a Supervisor is marking their OWN row Present or Half Day, require GPS stamp
    if (isSelfSupervisorWorker(worker) && (status === 'present' || status === 'half_day')) {
      stampSupervisorSelfCheckIn(worker.id, status, hours);
      return;
    }

    setDraftAttendance({
      ...draftAttendance,
      [worker.id]: {
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

  // Bulk mark all regular crew (or a specific craft group) Present 8h
  const handleMarkCrewPresent = (targetWorkers: Worker[]) => {
    const updated = { ...draftAttendance };
    targetWorkers.forEach((w) => {
      // Never bulk-mark a Supervisor's own row without explicit GPS check-in
      if (isSelfSupervisorWorker(w)) return;
      updated[w.id] = {
        status: 'present',
        hours_worked: 8,
        notes: updated[w.id]?.notes || '',
      };
    });
    setDraftAttendance(updated);
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

  // 1-Click Founder Verification or Rejection of Supervisor Self-Attendance
  const handleQuickVerifySelfAttendance = async (rec: Attendance, approve: boolean) => {
    const cleanExistingNotes = (rec.notes || '').replace(
      /\s*\|\s*Pending Founder Verification\]?/gi,
      ']'
    );
    if (approve) {
      const ok = await updateAttendanceRecord(
        rec.id,
        {
          status: rec.status,
          hours_worked: rec.hours_worked,
          notes: `${cleanExistingNotes} [Founder Verified On-Site by ${user?.name || 'Founder'}]`.trim(),
        },
        true
      );
      if (ok) {
        showToast('success', 'Supervisor self-attendance verified and unlocked for Payroll.');
      }
    } else {
      const ok = await updateAttendanceRecord(
        rec.id,
        {
          status: 'absent',
          hours_worked: 0,
          notes: `[Founder Rejected Self-Check-In → Marked Absent by ${user?.name || 'Founder'}] ${cleanExistingNotes}`.trim(),
        },
        true
      );
      if (ok) {
        showToast('info', 'Supervisor self-check-in rejected and marked Absent (0h).');
      }
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
      true
    );

    if (success) {
      setOverrideModalOpen(false);
    }
  };

  const handleAddWorkerSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workerName.trim() || isAddingWorker) return;
    setIsAddingWorker(true);
    const created = await createWorker({
      name: workerName.trim(),
      position: workerPosition.trim() || 'Mason',
      pay_rate: parseFloat(workerRate) || 0,
      pay_rate_type: workerRateType,
      contact_number: workerPhone.trim() || '—',
      active: true,
    });
    setIsAddingWorker(false);
    if (created) {
      setWorkerName('');
      setWorkerPhone('');
      showToast('success', `Added ${created.name} (${created.position}) to the workforce roster.`);
    }
  };

  const openEditWorkerModal = (w: Worker) => {
    setEditingWorker(w);
    setEditWorkerName(w.name);
    setEditWorkerPosition(w.position);
    setEditWorkerRate(String(w.pay_rate));
    setEditWorkerRateType(w.pay_rate_type);
    setEditWorkerPhone(w.contact_number === '—' ? '' : w.contact_number);
  };

  const handleEditWorkerSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingWorker || isSavingWorker) return;
    setIsSavingWorker(true);
    const updated = await updateWorker(editingWorker.id, {
      name: editWorkerName.trim(),
      position: editWorkerPosition.trim(),
      pay_rate: parseFloat(editWorkerRate) || 0,
      pay_rate_type: editWorkerRateType,
      contact_number: editWorkerPhone.trim() || '—',
    });
    setIsSavingWorker(false);
    if (updated) {
      setEditingWorker(null);
      showToast('success', `Updated ${updated.name}.`);
    }
  };

  // Filtered workers (Supervisors placed at the top of the daily roster)
  const filteredWorkers = useMemo(() => {
    return workers
      .filter((w) => w.active)
      .filter((w) => {
        if (craftFilter !== 'all' && getCraftGroup(w.position) !== craftFilter) {
          return false;
        }
        if (!searchWorker.trim()) return true;
        const q = searchWorker.toLowerCase();
        return (
          w.name.toLowerCase().includes(q) || w.position.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        const aSup = a.position.toLowerCase().includes('supervisor') ? 0 : 1;
        const bSup = b.position.toLowerCase().includes('supervisor') ? 0 : 1;
        if (aSup !== bSup) return aSup - bSup;
        return a.name.localeCompare(b.name);
      });
  }, [workers, craftFilter, searchWorker]);

  // Group filteredWorkers by CraftGroupKey for compact collapsible display
  const groupedRosterWorkers = useMemo(() => {
    const map = new Map<CraftGroupKey, Worker[]>();
    filteredWorkers.forEach((w) => {
      const key = getCraftGroup(w.position);
      const list = map.get(key) || [];
      list.push(w);
      map.set(key, list);
    });
    return Array.from(map.entries()).sort(
      (a, b) => CRAFT_GROUP_META[a[0]].order - CRAFT_GROUP_META[b[0]].order
    );
  }, [filteredWorkers]);

  // Detect any Supervisor profiles not yet enrolled on the active `workers` roster
  const candidateSupervisors = [
    ...(isSupervisor && user ? [user] : []),
    ...users.filter((u) => u.role === 'supervisor'),
  ].filter(
    (sup, idx, arr) =>
      arr.findIndex((item) => item.id === sup.id) === idx &&
      !workers.some(
        (w) =>
          w.active &&
          (w.id === sup.id || w.name.trim().toLowerCase() === sup.name.trim().toLowerCase())
      )
  );

  const handleEnrollSupervisor = async (sup: { id: string; name: string }) => {
    setIsAddingWorker(true);
    const created = await createWorker({
      id: sup.id,
      name: sup.name,
      position: 'Site Supervisor',
      pay_rate: 1200,
      pay_rate_type: 'daily',
      contact_number: '—',
      active: true,
    });
    setIsAddingWorker(false);
    if (created) {
      showToast('success', `${sup.name} is now enrolled in the Attendance & Payroll roster.`);
    }
  };

  // Existing submitted attendance records for the active project & date
  const existingSiteDateRecords = attendance.filter(
    (a) => a.project_id === selectedProjectId && a.date === selectedDate
  );

  // Unverified Supervisor self-attendance logs across the ledger
  const unverifiedSelfLogs = attendance.filter(
    (a) =>
      a.worker_id === a.recorded_by &&
      !a.is_founder_override &&
      (a.status === 'present' || a.status === 'half_day')
  );

  const activeWorkersList = workers.filter((w) => w.active);
  const hasUnsavedChanges =
    existingSiteDateRecords.length === 0
      ? activeWorkersList.length > 0
      : activeWorkersList.some((w) => {
          const draft = draftAttendance[w.id];
          const saved = existingSiteDateRecords.find((a) => a.worker_id === w.id);
          if (!saved || !draft) return true;
          return (
            draft.status !== saved.status ||
            Number(draft.hours_worked) !== Number(saved.hours_worked) ||
            (draft.notes || '').trim() !== (saved.notes || '').trim()
          );
        });

  const latestSubmittedAt = existingSiteDateRecords.reduce<string | null>((latest, rec) => {
    if (!rec.submitted_at) return latest;
    if (!latest || rec.submitted_at > latest) return rec.submitted_at;
    return latest;
  }, null);

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

  // Group history records by (date + project_id) so each daily sheet is compact & collapsible
  const groupedHistorySheets = useMemo(() => {
    const sheets = new Map<
      string,
      { key: string; date: string; projectId: string; records: Attendance[] }
    >();
    filteredHistoryAttendance.forEach((rec) => {
      const key = `${rec.date}::${rec.project_id}`;
      const existing = sheets.get(key);
      if (existing) {
        existing.records.push(rec);
      } else {
        sheets.set(key, {
          key,
          date: rec.date,
          projectId: rec.project_id,
          records: [rec],
        });
      }
    });
    return Array.from(sheets.values()).sort((a, b) => b.date.localeCompare(a.date));
  }, [filteredHistoryAttendance]);

  // Group Workforce tab workers by craft group
  const groupedWorkforceDirectory = useMemo(() => {
    const filtered = workers.filter((w) => {
      if (workforceCraftFilter !== 'all' && getCraftGroup(w.position) !== workforceCraftFilter) {
        return false;
      }
      if (!workforceSearch.trim()) return true;
      const q = workforceSearch.toLowerCase();
      return w.name.toLowerCase().includes(q) || w.position.toLowerCase().includes(q);
    });

    const map = new Map<CraftGroupKey, Worker[]>();
    filtered.forEach((w) => {
      const key = getCraftGroup(w.position);
      const list = map.get(key) || [];
      list.push(w);
      map.set(key, list);
    });
    return Array.from(map.entries()).sort(
      (a, b) => CRAFT_GROUP_META[a[0]].order - CRAFT_GROUP_META[b[0]].order
    );
  }, [workers, workforceCraftFilter, workforceSearch]);

  const toggleGroupCollapse = (key: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleNoteInput = (workerId: string) => {
    setExpandedNoteWorkers((prev) => ({ ...prev, [workerId]: !prev[workerId] }));
  };

  return (
    <AppShell>
      <div className="space-y-5 max-w-5xl mx-auto">
        {/* Terminal Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-surface-border/60">
          <div>
            <div className="flex items-center space-x-2">
              <span className="text-xs font-bold text-navy uppercase tracking-widest">
                {isFounder ? 'Workforce Management' : 'Field Attendance Terminal'}
              </span>
              <span className="text-xs text-ink-muted">·</span>
              <span className="text-xs text-ink-secondary">
                {isFounder ? 'Founder Verification & Override' : 'GPS Self-Check-In Protected'}
              </span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-navy tracking-tight mt-1">
              Site Workforce &amp; Attendance
            </h1>
          </div>

          <div className="flex items-center space-x-2">
            <Button
              variant={activeTab === 'terminal' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setActiveTab('terminal')}
              leftIcon={<CheckCircle2 className="w-4 h-4" />}
            >
              Daily Roster
            </Button>
            <Button
              variant={activeTab === 'history' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setActiveTab('history')}
              leftIcon={<Clock className="w-4 h-4" />}
            >
              Logs &amp; History
              {isFounder && unverifiedSelfLogs.length > 0 && (
                <span className="ml-1.5 px-1.5 py-0.2 rounded-full bg-status-warning text-navy text-[10px] font-extrabold">
                  {unverifiedSelfLogs.length}
                </span>
              )}
            </Button>
            <Button
              variant={activeTab === 'workforce' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setActiveTab('workforce')}
              leftIcon={<UserPlus className="w-4 h-4" />}
            >
              Workforce ({workers.filter((w) => w.active).length})
            </Button>
          </div>
        </div>

        {/* Founder Anti-Fraud Alert: Unverified Supervisor Self-Attendance */}
        {isFounder && unverifiedSelfLogs.length > 0 && (
          <div className="p-4 rounded-2xl bg-status-warning-bg/80 border border-status-warning/40 space-y-3 text-xs">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-start sm:items-center gap-2.5">
                <ShieldAlert className="w-5 h-5 text-status-warning shrink-0 mt-0.5 sm:mt-0" />
                <div>
                  <div className="font-bold text-navy text-sm">
                    Supervisor Self-Attendance Requires Founder Verification ({unverifiedSelfLogs.length})
                  </div>
                  <div className="text-ink-secondary">
                    To prevent a Supervisor from marking themselves Present while absent, self-logged Supervisor hours are held back from Payroll until you verify or reject them below.
                  </div>
                </div>
              </div>
              <Badge variant="warning" size="sm">
                Held from Payroll
              </Badge>
            </div>

            <div className="divide-y divide-surface-border/60 bg-white rounded-xl border border-surface-border overflow-hidden">
              {unverifiedSelfLogs.map((rec) => {
                const supWorker = workers.find((w) => w.id === rec.worker_id);
                const proj = projects.find((p) => p.id === rec.project_id);
                return (
                  <div
                    key={rec.id}
                    className="p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                  >
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-navy">{supWorker?.name || 'Supervisor'}</span>
                        <Badge variant="warning" size="sm">
                          {rec.status.replace('_', ' ')} ({rec.hours_worked}h)
                        </Badge>
                        <span className="text-ink-secondary">
                          · {proj?.name} · {rec.date}
                        </span>
                      </div>
                      {rec.notes && (
                        <div className="text-[11px] text-ink-muted font-mono">{rec.notes}</div>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        onClick={() => handleQuickVerifySelfAttendance(rec, true)}
                        leftIcon={<ShieldCheck className="w-3.5 h-3.5" />}
                      >
                        Verify On-Site
                      </Button>
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        onClick={() => handleQuickVerifySelfAttendance(rec, false)}
                        leftIcon={<XCircle className="w-3.5 h-3.5" />}
                      >
                        Reject (Absent)
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Active Project & Date Selector Bar (Only shown on Daily Roster tab) */}
        {activeTab === 'terminal' && (
          <div className="p-4 rounded-2xl bg-white border border-surface-border shadow-sm grid grid-cols-1 md:grid-cols-2 gap-4 items-center">
            <div>
              <label className="text-[11px] font-bold text-navy uppercase tracking-wider block mb-1">
                1. Select Project Site
              </label>
              <Select
                value={selectedProjectId}
                onChange={(e) => setSelectedProjectId(e.target.value)}
              >
                {accessibleProjects.length === 0 ? (
                  <option value="">No assigned project sites yet</option>
                ) : (
                  accessibleProjects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.location.split(',')[0]})
                    </option>
                  ))
                )}
              </Select>
            </div>

            <div>
              <label className="text-[11px] font-bold text-navy uppercase tracking-wider block mb-1">
                2. Select Attendance Date (Today or Yesterday for Supervisors)
              </label>
              <div className="flex items-center space-x-2">
                <Button
                  type="button"
                  variant={selectedDate === today ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setSelectedDate(today)}
                >
                  Today ({today.slice(5)})
                </Button>
                <Button
                  type="button"
                  variant={selectedDate === yesterday ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setSelectedDate(yesterday)}
                >
                  Yesterday ({yesterday.slice(5)})
                </Button>
                {isFounder && (
                  <Input
                    type="date"
                    value={selectedDate}
                    max={today}
                    onChange={(e) => setSelectedDate(e.target.value)}
                    className="py-1.5 text-xs"
                  />
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 1: TERMINAL / DAILY ROSTER */}
        {activeTab === 'terminal' && (
          <form onSubmit={handleBatchSubmit} className="space-y-4">
            {/* Compact Live Count Summary Bar */}
            <div className="grid grid-cols-4 gap-2.5">
              <div className="p-2.5 rounded-xl bg-status-success-bg/70 border border-status-success/20 text-status-success text-center">
                <div className="text-lg font-extrabold leading-tight">{presentCount}</div>
                <div className="text-[10px] font-bold uppercase tracking-wider">Present (8h)</div>
              </div>
              <div className="p-2.5 rounded-xl bg-status-warning-bg/70 border border-status-warning/20 text-status-warning text-center">
                <div className="text-lg font-extrabold leading-tight">{halfDayCount}</div>
                <div className="text-[10px] font-bold uppercase tracking-wider">Half Day (4h)</div>
              </div>
              <div className="p-2.5 rounded-xl bg-status-danger-bg/70 border border-status-danger/20 text-status-danger text-center">
                <div className="text-lg font-extrabold leading-tight">{absentCount}</div>
                <div className="text-[10px] font-bold uppercase tracking-wider">Absent (0h)</div>
              </div>
              <div className="p-2.5 rounded-xl bg-status-info-bg/70 border border-status-info/20 text-status-info text-center">
                <div className="text-lg font-extrabold leading-tight">{leaveCount}</div>
                <div className="text-[10px] font-bold uppercase tracking-wider">Leave (0h)</div>
              </div>
            </div>

            {/* Already-Synced Status Banner (prevents Founder confusion & Supervisor spam) */}
            {existingSiteDateRecords.length > 0 && (
              <div className="p-3.5 rounded-2xl bg-status-success-bg/80 border border-status-success/25 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="flex items-start sm:items-center gap-2.5 text-status-success">
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 sm:mt-0" />
                  <div>
                    <span className="font-bold">
                      Site Attendance Recorded &amp; Synced to Payroll Engine:
                    </span>{' '}
                    <span className="text-ink-secondary">
                      {existingSiteDateRecords.length} worker record{existingSiteDateRecords.length === 1 ? '' : 's'} saved for {selectedDate}
                      {latestSubmittedAt
                        ? ` (${new Date(latestSubmittedAt).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' })})`
                        : ''}
                      . No Founder re-submission needed unless editing below.
                    </span>
                  </div>
                </div>
                <Badge variant={hasUnsavedChanges ? 'warning' : 'success'} size="sm">
                  {hasUnsavedChanges ? 'Unsaved Edits' : 'Synced ✓'}
                </Badge>
              </div>
            )}

            {/* Filter, Group & Bulk-Action Toolbar */}
            <div className="p-3 rounded-2xl bg-white border border-surface-border shadow-sm flex flex-col lg:flex-row lg:items-center justify-between gap-2.5">
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 flex-1">
                <div className="w-full sm:w-64">
                  <Input
                    placeholder="Filter worker or craft..."
                    value={searchWorker}
                    onChange={(e) => setSearchWorker(e.target.value)}
                    leftIcon={<Search className="w-4 h-4" />}
                  />
                </div>

                <div className="w-full sm:w-52">
                  <Select
                    value={craftFilter}
                    onChange={(e) => setCraftFilter(e.target.value)}
                    options={[
                      { label: 'All Craft Groups', value: 'all' },
                      { label: 'Supervision & Foremen', value: 'supervision' },
                      { label: 'Masonry & Concrete', value: 'masonry' },
                      { label: 'Carpentry & Formworks', value: 'carpentry' },
                      { label: 'Steel, Electrical & Plumbing', value: 'mep_steel' },
                      { label: 'Finishing & General Labor', value: 'general' },
                    ]}
                  />
                </div>

                {candidateSupervisors.map((sup) => (
                  <Button
                    key={sup.id}
                    type="button"
                    variant="secondary"
                    size="sm"
                    isLoading={isAddingWorker}
                    onClick={() => handleEnrollSupervisor(sup)}
                    leftIcon={<UserPlus className="w-3.5 h-3.5" />}
                  >
                    Include {sup.name} on Roster
                  </Button>
                ))}
              </div>

              <div className="flex items-center justify-between sm:justify-end gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => handleMarkCrewPresent(filteredWorkers)}
                  leftIcon={<CheckCheck className="w-3.5 h-3.5" />}
                >
                  Mark Crew Present (8h)
                </Button>

                <div className="inline-flex rounded-xl border border-surface-border bg-surface-inset p-0.5">
                  <button
                    type="button"
                    onClick={() => setViewMode('compact')}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all ${
                      viewMode === 'compact'
                        ? 'bg-white text-navy shadow-sm'
                        : 'text-ink-secondary hover:text-navy'
                    }`}
                    title="Compact Grouped Table"
                  >
                    <LayoutList className="w-3.5 h-3.5" />
                    <span>Compact</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode('cards')}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all ${
                      viewMode === 'cards'
                        ? 'bg-white text-navy shadow-sm'
                        : 'text-ink-secondary hover:text-navy'
                    }`}
                    title="Expanded Cards"
                  >
                    <LayoutGrid className="w-3.5 h-3.5" />
                    <span>Cards</span>
                  </button>
                </div>
              </div>
            </div>

            {submissionSuccess && (
              <div className="p-3.5 rounded-2xl bg-status-success-bg border border-status-success/20 text-status-success text-xs font-semibold flex items-center space-x-2">
                <CheckCircle2 className="w-4 h-4 text-status-success" />
                <span>Attendance records saved and live in the Payroll Engine!</span>
              </div>
            )}

            {/* GROUPED WORKER ROSTER */}
            <div className="space-y-3">
              {groupedRosterWorkers.map(([groupKey, groupWorkers]) => {
                const isCollapsed = Boolean(collapsedGroups[groupKey]);
                const groupPresent = groupWorkers.filter(
                  (w) => (draftAttendance[w.id]?.status || 'present') === 'present'
                ).length;
                const groupHalf = groupWorkers.filter(
                  (w) => draftAttendance[w.id]?.status === 'half_day'
                ).length;
                const groupAbsent = groupWorkers.filter(
                  (w) =>
                    draftAttendance[w.id]?.status === 'absent' ||
                    draftAttendance[w.id]?.status === 'leave'
                ).length;

                return (
                  <div
                    key={groupKey}
                    className="rounded-2xl bg-white border border-surface-border shadow-sm overflow-hidden"
                  >
                    {/* Collapsible Craft Group Header */}
                    <div className="px-4 py-2.5 bg-surface-inset/70 border-b border-surface-border/60 flex flex-wrap items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => toggleGroupCollapse(groupKey)}
                        className="flex items-center gap-2 text-left font-bold text-xs text-navy hover:text-navy-deep"
                      >
                        {isCollapsed ? (
                          <ChevronRight className="w-4 h-4 text-ink-secondary" />
                        ) : (
                          <ChevronDown className="w-4 h-4 text-ink-secondary" />
                        )}
                        <span>{CRAFT_GROUP_META[groupKey].label}</span>
                        <Badge variant="neutral" size="sm">
                          {groupWorkers.length}
                        </Badge>
                      </button>

                      <div className="flex items-center gap-2 text-[11px]">
                        <span className="text-status-success font-bold">{groupPresent}P</span>
                        <span className="text-ink-muted">·</span>
                        <span className="text-status-warning font-bold">{groupHalf}½</span>
                        <span className="text-ink-muted">·</span>
                        <span className="text-status-danger font-bold">{groupAbsent}A</span>

                        <button
                          type="button"
                          onClick={() => handleMarkCrewPresent(groupWorkers)}
                          className="ml-2 px-2 py-0.5 rounded-lg bg-white border border-surface-border text-[11px] font-semibold text-navy hover:bg-surface-inset transition-colors"
                        >
                          All Present
                        </button>
                      </div>
                    </div>

                    {!isCollapsed && viewMode === 'compact' && (
                      <div className="divide-y divide-surface-border/60">
                        {groupWorkers.map((worker) => {
                          const currentDraft = draftAttendance[worker.id] || {
                            status: 'present',
                            hours_worked: 8,
                            notes: '',
                          };
                          const isSelfSup = isSelfSupervisorWorker(worker);
                          const savedRec = existingSiteDateRecords.find(
                            (a) => a.worker_id === worker.id
                          );
                          const isVerifiedByFounder = Boolean(savedRec?.is_founder_override);
                          const showNoteBox =
                            Boolean(expandedNoteWorkers[worker.id]) ||
                            Boolean(currentDraft.notes);

                          return (
                            <div
                              key={worker.id}
                              className={`px-4 py-2.5 text-xs transition-colors ${
                                isSelfSup ? 'bg-amber-50/40' : 'hover:bg-slate-50/80'
                              }`}
                            >
                              <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
                                {/* Left: Compact Worker Identity */}
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className="font-bold text-navy text-sm truncate">
                                      {worker.name}
                                    </span>
                                    <span className="text-ink-secondary text-[11px]">
                                      {worker.position} · ₱{worker.pay_rate}/
                                      {worker.pay_rate_type === 'hourly' ? 'hr' : 'd'}
                                    </span>
                                    {worker.position.toLowerCase().includes('supervisor') && (
                                      <Badge variant="warning" size="sm">
                                        Supervisor
                                      </Badge>
                                    )}
                                    {isSelfSup && (
                                      <Badge
                                        variant={isVerifiedByFounder ? 'success' : 'warning'}
                                        size="sm"
                                      >
                                        {isVerifiedByFounder
                                          ? 'Founder Verified ✓'
                                          : 'Your Row · GPS + Founder Approval Required'}
                                      </Badge>
                                    )}
                                  </div>
                                </div>

                                {/* Right: Segmented 1-Tap Status Pills + Hours + Note Toggle */}
                                <div className="flex items-center flex-wrap gap-1.5">
                                  {isSelfSup && (
                                    <button
                                      type="button"
                                      disabled={isLocatingGps}
                                      onClick={() =>
                                        stampSupervisorSelfCheckIn(worker.id, 'present', 8)
                                      }
                                      className="px-2.5 py-1 rounded-lg bg-navy text-white text-[11px] font-bold flex items-center gap-1 hover:bg-navy-deep transition-colors"
                                      title="Capture live GPS coordinates for your self check-in"
                                    >
                                      <MapPin className="w-3 h-3" />
                                      <span>{isLocatingGps ? 'Locating…' : 'GPS Check-In'}</span>
                                    </button>
                                  )}

                                  <div className="inline-flex rounded-xl bg-surface-inset p-0.5 border border-surface-border">
                                    {[
                                      {
                                        id: 'present',
                                        short: 'Present',
                                        activeClass:
                                          'bg-status-success text-white font-bold shadow-sm',
                                      },
                                      {
                                        id: 'half_day',
                                        short: 'Half',
                                        activeClass:
                                          'bg-status-warning text-white font-bold shadow-sm',
                                      },
                                      {
                                        id: 'absent',
                                        short: 'Absent',
                                        activeClass:
                                          'bg-status-danger text-white font-bold shadow-sm',
                                      },
                                      {
                                        id: 'leave',
                                        short: 'Leave',
                                        activeClass:
                                          'bg-status-info text-white font-bold shadow-sm',
                                      },
                                    ].map((st) => {
                                      const active = currentDraft.status === st.id;
                                      return (
                                        <button
                                          key={st.id}
                                          type="button"
                                          onClick={() =>
                                            handleStatusChange(worker, st.id as AttendanceStatus)
                                          }
                                          className={`px-2.5 py-1 rounded-lg text-[11px] transition-all ${
                                            active
                                              ? st.activeClass
                                              : 'text-ink-secondary hover:text-navy font-medium'
                                          }`}
                                        >
                                          {st.short}
                                        </button>
                                      );
                                    })}
                                  </div>

                                  <div className="flex items-center gap-1">
                                    <input
                                      type="number"
                                      step="0.5"
                                      min="0"
                                      max="24"
                                      value={currentDraft.hours_worked}
                                      onChange={(e) =>
                                        handleHoursChange(
                                          worker.id,
                                          parseFloat(e.target.value) || 0
                                        )
                                      }
                                      aria-label={`Hours worked for ${worker.name}`}
                                      className="w-14 py-1 px-1.5 text-center text-xs font-bold text-navy bg-surface-inset border border-surface-border rounded-lg focus:bg-white focus:outline-none"
                                    />
                                    <span className="text-[10px] text-ink-muted">h</span>
                                  </div>

                                  <button
                                    type="button"
                                    onClick={() => toggleNoteInput(worker.id)}
                                    className={`p-1.5 rounded-lg border transition-colors ${
                                      currentDraft.notes
                                        ? 'border-navy/30 bg-navy/5 text-navy'
                                        : 'border-transparent text-ink-muted hover:text-navy hover:bg-surface-inset'
                                    }`}
                                    title="Add or view activity note"
                                    aria-label={`Toggle note for ${worker.name}`}
                                  >
                                    <MessageSquare className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </div>

                              {showNoteBox && (
                                <div className="mt-2">
                                  <Input
                                    placeholder="Activity note (e.g. 2F slab rebar, concrete pouring)..."
                                    value={currentDraft.notes}
                                    onChange={(e) =>
                                      handleNotesChange(worker.id, e.target.value)
                                    }
                                    disabled={isSelfSup && currentDraft.notes.startsWith('[SELF-CHECKIN')}
                                    className="text-xs py-1.5"
                                  />
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {!isCollapsed && viewMode === 'cards' && (
                      <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
                        {groupWorkers.map((worker) => {
                          const currentDraft = draftAttendance[worker.id] || {
                            status: 'present',
                            hours_worked: 8,
                            notes: '',
                          };
                          const isSelfSup = isSelfSupervisorWorker(worker);

                          return (
                            <div
                              key={worker.id}
                              className="p-4 rounded-2xl bg-surface-inset/30 border border-surface-border space-y-3"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div>
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className="text-sm font-bold text-navy">
                                      {worker.name}
                                    </span>
                                    {worker.position.toLowerCase().includes('supervisor') && (
                                      <Badge variant="warning" size="sm">
                                        Supervisor
                                      </Badge>
                                    )}
                                  </div>
                                  <div className="text-[11px] text-ink-secondary">
                                    {worker.position} · ₱{worker.pay_rate}/
                                    {worker.pay_rate_type === 'hourly' ? 'hr' : 'day'}
                                  </div>
                                </div>

                                <div className="flex items-center space-x-1.5">
                                  <span className="text-[11px] text-ink-secondary">Hrs:</span>
                                  <input
                                    type="number"
                                    step="0.5"
                                    min="0"
                                    max="24"
                                    value={currentDraft.hours_worked}
                                    onChange={(e) =>
                                      handleHoursChange(
                                        worker.id,
                                        parseFloat(e.target.value) || 0
                                      )
                                    }
                                    className="w-14 p-1 text-center text-xs font-bold text-navy bg-white border border-surface-border rounded-lg"
                                  />
                                </div>
                              </div>

                              <div className="grid grid-cols-4 gap-1.5">
                                {[
                                  { id: 'present', label: 'Present' },
                                  { id: 'half_day', label: 'Half Day' },
                                  { id: 'absent', label: 'Absent' },
                                  { id: 'leave', label: 'Leave' },
                                ].map((item) => {
                                  const isSelected = currentDraft.status === item.id;
                                  return (
                                    <button
                                      key={item.id}
                                      type="button"
                                      onClick={() =>
                                        handleStatusChange(worker, item.id as AttendanceStatus)
                                      }
                                      className={`py-2 px-2 rounded-xl border text-[11px] font-bold transition-all ${
                                        isSelected
                                          ? 'bg-navy text-white border-navy'
                                          : 'bg-white border-surface-border text-ink-secondary hover:bg-surface-inset'
                                      }`}
                                    >
                                      {item.label}
                                    </button>
                                  );
                                })}
                              </div>

                              <Input
                                placeholder="Activity notes..."
                                value={currentDraft.notes}
                                onChange={(e) => handleNotesChange(worker.id, e.target.value)}
                                disabled={isSelfSup && currentDraft.notes.startsWith('[SELF-CHECKIN')}
                                className="text-xs py-1.5"
                              />
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}

              {filteredWorkers.length === 0 && (
                <div className="bg-white rounded-3xl border border-surface-border">
                  <EmptyState
                    title="No workers on this site"
                    description={
                      workers.length === 0
                        ? 'Register workers in the Workforce tab first — they will appear here grouped by craft.'
                        : 'No worker matches the current filter.'
                    }
                  />
                </div>
              )}
            </div>

            {/* Bottom Submit Sticky Bar */}
            <div className="sticky bottom-4 z-30 p-3.5 rounded-2xl bg-white/95 backdrop-blur-md border border-surface-border shadow-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="text-xs text-ink-secondary">
                {existingSiteDateRecords.length > 0 && !hasUnsavedChanges ? (
                  <span>
                    Attendance for <span className="font-bold text-navy">{selectedDate}</span> is already synced to the Payroll Engine. Change any worker&apos;s status or hours above if you need to update it.
                  </span>
                ) : (
                  <span>
                    Ready to save <span className="font-bold text-navy">{filteredWorkers.length} workers</span> ({presentCount} Present, {halfDayCount} Half Day, {absentCount} Absent) for {selectedDate}.
                  </span>
                )}
              </div>

              <Button
                type="submit"
                variant={
                  existingSiteDateRecords.length > 0 && !hasUnsavedChanges
                    ? 'secondary'
                    : 'primary'
                }
                size="md"
                isLoading={isSubmitting}
                disabled={
                  isSubmitting ||
                  !selectedProjectId ||
                  filteredWorkers.length === 0 ||
                  (existingSiteDateRecords.length > 0 && !hasUnsavedChanges)
                }
                leftIcon={
                  existingSiteDateRecords.length > 0 && !hasUnsavedChanges ? (
                    <CheckCircle2 className="w-4 h-4 text-status-success" />
                  ) : (
                    <Save className="w-4 h-4" />
                  )
                }
              >
                {existingSiteDateRecords.length > 0
                  ? hasUnsavedChanges
                    ? 'Save Attendance Changes'
                    : 'Synced to Payroll ✓'
                  : 'Submit Site Attendance'}
              </Button>
            </div>
          </form>
        )}

        {/* TAB 2: ATTENDANCE HISTORY & FOUNDER OVERRIDE (GROUPED BY DAILY SITE SHEETS) */}
        {activeTab === 'history' && (
          <div className="space-y-4">
            {/* Project Site, Status, Date & Worker Filters for History */}
            <div className="p-3.5 rounded-2xl bg-white border border-surface-border shadow-sm flex flex-col sm:flex-row flex-wrap items-center gap-2.5">
              <div className="w-full sm:w-64">
                <Input
                  placeholder="Search worker, craft, project, or notes..."
                  value={historySearchQuery}
                  onChange={(e) => setHistorySearchQuery(e.target.value)}
                  leftIcon={<Search className="w-4 h-4" />}
                />
              </div>

              <div className="w-full sm:w-56">
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

              <div className="w-full sm:w-40">
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

            {/* Grouped Daily Attendance Sheets */}
            <div className="space-y-3">
              {groupedHistorySheets.map((sheet) => {
                const proj = projects.find((p) => p.id === sheet.projectId);
                const isCollapsed = Boolean(collapsedHistorySheets[sheet.key]);
                const pCount = sheet.records.filter((r) => r.status === 'present').length;
                const hCount = sheet.records.filter((r) => r.status === 'half_day').length;
                const aCount = sheet.records.filter(
                  (r) => r.status === 'absent' || r.status === 'leave'
                ).length;

                return (
                  <div
                    key={sheet.key}
                    className="rounded-2xl bg-white border border-surface-border shadow-sm overflow-hidden"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setCollapsedHistorySheets((prev) => ({
                          ...prev,
                          [sheet.key]: !prev[sheet.key],
                        }))
                      }
                      className="w-full px-4 py-3 bg-surface-inset/70 border-b border-surface-border/60 flex flex-wrap items-center justify-between gap-2 text-left hover:bg-surface-inset transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        {isCollapsed ? (
                          <ChevronRight className="w-4 h-4 text-ink-secondary" />
                        ) : (
                          <ChevronDown className="w-4 h-4 text-ink-secondary" />
                        )}
                        <span className="font-bold text-navy text-xs sm:text-sm">
                          {sheet.date} · {proj?.name || 'Project Site'}
                        </span>
                        <Badge variant="neutral" size="sm">
                          {sheet.records.length} worker{sheet.records.length === 1 ? '' : 's'}
                        </Badge>
                      </div>

                      <div className="flex items-center gap-2 text-[11px]">
                        <span className="text-status-success font-bold">{pCount} Present</span>
                        <span className="text-ink-muted">·</span>
                        <span className="text-status-warning font-bold">{hCount} Half</span>
                        <span className="text-ink-muted">·</span>
                        <span className="text-status-danger font-bold">{aCount} Absent/Leave</span>
                      </div>
                    </button>

                    {!isCollapsed && (
                      <div className="divide-y divide-surface-border/60">
                        {sheet.records.map((rec) => {
                          const worker = workers.find((w) => w.id === rec.worker_id);
                          const isSelfLog = rec.worker_id === rec.recorded_by;
                          const isUnverifiedSelf =
                            isSelfLog &&
                            !rec.is_founder_override &&
                            (rec.status === 'present' || rec.status === 'half_day');

                          return (
                            <div
                              key={rec.id}
                              className="px-4 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs hover:bg-slate-50 transition-colors"
                            >
                              <div className="space-y-0.5 min-w-0">
                                <div className="flex items-center flex-wrap gap-1.5">
                                  <span className="font-bold text-navy">{worker?.name}</span>
                                  <span className="text-ink-secondary text-[11px]">
                                    ({worker?.position})
                                  </span>
                                  {isUnverifiedSelf && (
                                    <Badge variant="warning" size="sm">
                                      Unverified Supervisor Self-Log (Held from Payroll)
                                    </Badge>
                                  )}
                                  {isSelfLog && rec.is_founder_override && (
                                    <Badge variant="success" size="sm">
                                      Founder Verified Self-Log ✓
                                    </Badge>
                                  )}
                                  {!isSelfLog && rec.is_founder_override && (
                                    <Badge variant="navy" size="sm">
                                      Founder Override
                                    </Badge>
                                  )}
                                </div>
                                {rec.notes && (
                                  <div className="text-[11px] text-ink-muted truncate max-w-2xl">
                                    {rec.notes}
                                  </div>
                                )}
                              </div>

                              <div className="flex items-center gap-2 shrink-0">
                                <span className="font-bold text-navy">{rec.hours_worked}h</span>
                                <Badge
                                  variant={
                                    rec.status === 'present'
                                      ? 'success'
                                      : rec.status === 'half_day'
                                        ? 'warning'
                                        : 'danger'
                                  }
                                  size="sm"
                                  className="capitalize"
                                >
                                  {rec.status.replace('_', ' ')}
                                </Badge>

                                {isFounder && isUnverifiedSelf && (
                                  <>
                                    <Button
                                      type="button"
                                      variant="primary"
                                      size="sm"
                                      onClick={() => handleQuickVerifySelfAttendance(rec, true)}
                                    >
                                      Verify
                                    </Button>
                                    <Button
                                      type="button"
                                      variant="danger"
                                      size="sm"
                                      onClick={() => handleQuickVerifySelfAttendance(rec, false)}
                                    >
                                      Reject
                                    </Button>
                                  </>
                                )}

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
                                    Edit
                                  </Button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}

              {groupedHistorySheets.length === 0 && (
                <div className="bg-white rounded-3xl border border-surface-border">
                  <EmptyState
                    title="No attendance records match"
                    description={
                      attendance.length === 0
                        ? 'Submitted site attendance will appear here grouped by date and site.'
                        : 'Try selecting "All Project Sites" or clearing the date/search filter.'
                    }
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 3: WORKFORCE DIRECTORY (COMPACT & GROUPED BY CRAFT) */}
        {activeTab === 'workforce' && (
          <div className="space-y-4">
            {/* Inline Register Worker Form */}
            <form
              onSubmit={handleAddWorkerSubmit}
              className="p-4 rounded-2xl bg-white border border-surface-border shadow-sm space-y-3 text-xs"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-bold text-navy text-sm">Register Site Worker</h3>
                  <p className="text-xs text-ink-secondary">
                    Newly registered workers are automatically grouped by craft on the Daily Roster and Payroll Engine.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
                <div className="lg:col-span-2">
                  <Input
                    label="Worker Full Name"
                    placeholder="e.g. Danilo Santos"
                    value={workerName}
                    onChange={(e) => setWorkerName(e.target.value)}
                    required
                  />
                </div>

                <div>
                  <Select
                    label="Craft / Position"
                    value={workerPosition}
                    onChange={(e) => setWorkerPosition(e.target.value)}
                    options={[
                      { label: 'Foreman', value: 'Foreman' },
                      { label: 'Mason', value: 'Mason' },
                      { label: 'Carpenter', value: 'Carpenter' },
                      { label: 'Steelman', value: 'Steelman' },
                      { label: 'Electrician', value: 'Electrician' },
                      { label: 'Plumber', value: 'Plumber' },
                      { label: 'Welder / Tinsmith', value: 'Welder' },
                      { label: 'Painter / Finisher', value: 'Painter' },
                      { label: 'Skilled Laborer', value: 'Laborer' },
                      { label: 'Site Supervisor', value: 'Site Supervisor' },
                    ]}
                  />
                </div>

                <div>
                  <Input
                    label="Daily Rate (₱)"
                    type="number"
                    min="0"
                    step="50"
                    value={workerRate}
                    onChange={(e) => {
                      setWorkerRate(e.target.value);
                      setWorkerRateType('daily');
                    }}
                    required
                  />
                </div>

                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <Input
                      label="Contact Number"
                      placeholder="0917XXXXXXX"
                      value={workerPhone}
                      onChange={(e) => setWorkerPhone(e.target.value)}
                    />
                  </div>
                  <Button
                    type="submit"
                    variant="primary"
                    size="md"
                    isLoading={isAddingWorker}
                    leftIcon={<UserPlus className="w-4 h-4" />}
                  >
                    Add
                  </Button>
                </div>
              </div>
            </form>

            {/* Filter Bar for Workforce Directory */}
            <div className="p-3 rounded-2xl bg-white border border-surface-border shadow-sm flex flex-col sm:flex-row items-center justify-between gap-2.5">
              <div className="flex flex-col sm:flex-row items-center gap-2 w-full sm:w-auto">
                <div className="w-full sm:w-64">
                  <Input
                    placeholder="Search worker name or craft..."
                    value={workforceSearch}
                    onChange={(e) => setWorkforceSearch(e.target.value)}
                    leftIcon={<Search className="w-4 h-4" />}
                  />
                </div>
                <div className="w-full sm:w-52">
                  <Select
                    value={workforceCraftFilter}
                    onChange={(e) => setWorkforceCraftFilter(e.target.value)}
                    options={[
                      { label: 'All Craft Groups', value: 'all' },
                      { label: 'Supervision & Foremen', value: 'supervision' },
                      { label: 'Masonry & Concrete', value: 'masonry' },
                      { label: 'Carpentry & Formworks', value: 'carpentry' },
                      { label: 'Steel, Electrical & Plumbing', value: 'mep_steel' },
                      { label: 'Finishing & General Labor', value: 'general' },
                    ]}
                  />
                </div>
              </div>

              <Badge variant="neutral" size="sm">
                {workers.filter((w) => w.active).length} active / {workers.length} total
              </Badge>
            </div>

            {/* Grouped Compact Workforce List */}
            <div className="space-y-3">
              {groupedWorkforceDirectory.map(([groupKey, groupWorkers]) => (
                <div
                  key={groupKey}
                  className="rounded-2xl bg-white border border-surface-border shadow-sm overflow-hidden"
                >
                  <div className="px-4 py-2.5 bg-surface-inset/70 border-b border-surface-border/60 flex items-center justify-between">
                    <span className="font-bold text-xs text-navy">
                      {CRAFT_GROUP_META[groupKey].label}
                    </span>
                    <Badge variant="neutral" size="sm">
                      {groupWorkers.length} worker{groupWorkers.length === 1 ? '' : 's'}
                    </Badge>
                  </div>

                  <div className="divide-y divide-surface-border/60">
                    {groupWorkers.map((w) => (
                      <div
                        key={w.id}
                        className="px-4 py-2.5 flex items-center justify-between gap-3 text-xs hover:bg-slate-50 transition-colors"
                      >
                        <div className="flex items-center flex-wrap gap-2 min-w-0">
                          <span className="font-bold text-navy text-sm">{w.name}</span>
                          <span className="text-ink-secondary">
                            {w.position} · ₱{w.pay_rate}/
                            {w.pay_rate_type === 'hourly' ? 'hr' : 'day'}
                            {w.contact_number && w.contact_number !== '—'
                              ? ` · ${w.contact_number}`
                              : ''}
                          </span>
                          <Badge variant={w.active ? 'success' : 'neutral'} size="sm">
                            {w.active ? 'Active' : 'Inactive'}
                          </Badge>
                          {w.position.toLowerCase().includes('supervisor') && (
                            <Badge variant="warning" size="sm">
                              Supervisor
                            </Badge>
                          )}
                        </div>

                        {isFounder && (
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => openEditWorkerModal(w)}
                            leftIcon={<Settings2 className="w-3.5 h-3.5" />}
                          >
                            Manage
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {groupedWorkforceDirectory.length === 0 && (
                <div className="bg-white rounded-3xl border border-surface-border">
                  <EmptyState
                    title="No workers match"
                    description="Register craftsmen above or clear your search filter."
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* EDIT WORKER MODAL (Founder only) */}
      <Modal
        isOpen={Boolean(editingWorker)}
        onClose={() => setEditingWorker(null)}
        title="Manage Worker Profile"
        description="Update craft, daily/hourly wage rate, contact number, or active roster status."
      >
        {editingWorker && (
          <form onSubmit={handleEditWorkerSubmit} className="space-y-4 text-xs">
            <Input
              label="Full Name"
              value={editWorkerName}
              onChange={(e) => setEditWorkerName(e.target.value)}
              required
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input
                label="Craft / Position"
                value={editWorkerPosition}
                onChange={(e) => setEditWorkerPosition(e.target.value)}
                required
              />

              <Input
                label="Contact Number"
                placeholder="0917XXXXXXX"
                value={editWorkerPhone}
                onChange={(e) => setEditWorkerPhone(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input
                label="Wage Rate (PHP ₱)"
                type="number"
                min="0"
                step="50"
                value={editWorkerRate}
                onChange={(e) => setEditWorkerRate(e.target.value)}
                required
              />

              <Select
                label="Rate Type"
                value={editWorkerRateType}
                onChange={(e) => setEditWorkerRateType(e.target.value as 'daily' | 'hourly')}
                options={[
                  { label: 'Daily Rate (₱ / day)', value: 'daily' },
                  { label: 'Hourly Rate (₱ / hour)', value: 'hourly' },
                ]}
              />
            </div>

            <div className="pt-2 border-t border-surface-border flex items-center justify-between">
              <div className="space-y-0.5">
                <div className="font-bold text-navy">
                  Roster Status: {editingWorker.active ? 'Active' : 'Inactive'}
                </div>
                <div className="text-[11px] text-ink-secondary">
                  Inactive workers are hidden from daily attendance but kept in historical payroll.
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={async () => {
                  const ok = await toggleWorkerStatus(editingWorker.id);
                  if (ok) {
                    setEditingWorker(null);
                  }
                }}
              >
                {editingWorker.active ? 'Set Inactive' : 'Set Active'}
              </Button>
            </div>

            <div className="pt-3 flex justify-end space-x-2">
              <Button type="button" variant="secondary" onClick={() => setEditingWorker(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" isLoading={isSavingWorker}>
                Save Worker
              </Button>
            </div>
          </form>
        )}
      </Modal>

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
              <Button type="button" variant="secondary" onClick={() => setOverrideModalOpen(false)}>
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
