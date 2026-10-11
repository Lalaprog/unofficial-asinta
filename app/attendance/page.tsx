'use client';

import React, { Suspense, useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/layout/AppShell';
import { useDataStore } from '@/lib/data/store';
import { useAuth } from '@/lib/auth/authContext';
import { Attendance, AttendanceStatus, Worker } from '@/types';
import {
  CheckCircle2,
  Save,
  Search,
  UserPlus,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  ChevronDown,
  ChevronRight,
  LayoutList,
  LayoutGrid,
  MessageSquare,
  CheckCheck,
  XCircle,
  Lock,
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

function statusToHours(status: AttendanceStatus): number {
  if (status === 'present') return 8;
  if (status === 'half_day') return 4;
  return 0;
}

function formatStatusLabel(status: AttendanceStatus): string {
  if (status === 'present') return 'Present (Full Day)';
  if (status === 'half_day') return 'Half Day';
  if (status === 'absent') return 'Absent';
  return 'Approved Leave';
}

function AttendancePageInner() {
  const { user, isFounder, isSupervisor } = useAuth();
  const searchParams = useSearchParams();
  const { showToast } = useToast();
  const {
    users,
    workers,
    projects,
    projectSupervisors,
    attendance,
    isLoaded,
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

  // Sync activeTab with URL `?tab=history` or `?tab=workforce` so History and Workforce
  // operate as standalone pages from both the Desktop Top Nav and Mobile Bottom Nav
  useEffect(() => {
    const tabParam = searchParams?.get('tab');
    if (tabParam === 'history' || tabParam === 'workforce') {
      setActiveTab(tabParam);
    } else {
      setActiveTab('terminal');
    }
  }, [searchParams]);

  // Compact vs Card view for Daily Roster (defaults to compact grouped rows)
  const [viewMode, setViewMode] = useState<'compact' | 'cards'>('compact');
  const [craftFilter, setCraftFilter] = useState<string>('all');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [expandedNoteWorkers, setExpandedNoteWorkers] = useState<Record<string, boolean>>({});

  // Quick Add Worker modal + Workforce tab state
  const [isQuickAddOpen, setIsQuickAddOpen] = useState(false);
  const [workerName, setWorkerName] = useState('');
  const [workerPosition, setWorkerPosition] = useState('Mason');
  const [workerRate, setWorkerRate] = useState('850');
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

  // Terminal active draft attendance records (`status: null` = not checked yet!)
  const [draftAttendance, setDraftAttendance] = useState<
    Record<
      string,
      {
        status: AttendanceStatus | null;
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
  const [overrideNotes, setOverrideNotes] = useState('');

  // Automatically ensure every Supervisor account in `users` (and the signed-in
  // Supervisor) has a linked 1:1 `workers` row so Supervisors never need to be
  // manually registered as workers.
  const autoEnrolledSupervisorIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isLoaded) return;
    const supervisorAccounts = [
      ...(isSupervisor && user ? [user] : []),
      ...users.filter((u) => u.role === 'supervisor'),
    ].filter((sup, idx, arr) => arr.findIndex((item) => item.id === sup.id) === idx);

    supervisorAccounts.forEach((sup) => {
      if (autoEnrolledSupervisorIdsRef.current.has(sup.id)) return;
      const alreadyInWorkers = workers.some(
        (w) =>
          w.id === sup.id ||
          w.name.trim().toLowerCase() === sup.name.trim().toLowerCase()
      );
      if (!alreadyInWorkers) {
        autoEnrolledSupervisorIdsRef.current.add(sup.id);
        void createWorker({
          id: sup.id,
          name: sup.name,
          position: 'Site Supervisor',
          pay_rate: 1200,
          pay_rate_type: 'daily',
          contact_number: '—',
          active: true,
        });
      }
    });
  }, [isLoaded, isSupervisor, user, users, workers, createWorker]);

  // Identify whether a worker row belongs to the currently signed-in Supervisor
  const isSelfSupervisorWorker = useCallback(
    (w: Worker): boolean => {
      if (!isSupervisor || !user) return false;
      return (
        w.id === user.id || w.name.trim().toLowerCase() === user.name.trim().toLowerCase()
      );
    },
    [isSupervisor, user]
  );

  // Identify whether a worker row represents a Supervisor account in `users`
  const findSupervisorAccountForWorker = useCallback(
    (w: Worker) => {
      if (isSupervisor && user && isSelfSupervisorWorker(w)) {
        return user;
      }
      return users.find(
        (u) =>
          u.role === 'supervisor' &&
          (u.id === w.id || u.name.trim().toLowerCase() === w.name.trim().toLowerCase())
      );
    },
    [isSupervisor, user, isSelfSupervisorWorker, users]
  );

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

  // Map of workers who are ALREADY marked Present or Half Day on ANOTHER project
  // site on `selectedDate` (Scenario 5 & 6: prevents double-marking a worker or
  // supervisor on two sites on the same day).
  const otherSiteActiveAttendanceByWorker = useMemo(() => {
    const map = new Map<string, { record: Attendance; projectName: string }>();
    attendance
      .filter(
        (a) =>
          a.date === selectedDate &&
          a.project_id !== selectedProjectId &&
          (a.status === 'present' || a.status === 'half_day')
      )
      .forEach((a) => {
        const projName =
          projects.find((p) => p.id === a.project_id)?.name || 'Another Site';
        map.set(a.worker_id, { record: a, projectName: projName });
      });
    return map;
  }, [attendance, selectedDate, selectedProjectId, projects]);

  // Workers visible on the Daily Roster for `selectedProjectId`:
  // - Regular craftsmen (active)
  // - Supervisors assigned to `selectedProjectId` (via `project_supervisors`),
  //   so only the Supervisor(s) supervising the selected project appear on its roster!
  const siteRosterWorkers = useMemo(() => {
    const assignedSupervisorIdsForSite = new Set(
      projectSupervisors
        .filter((ps) => ps.project_id === selectedProjectId)
        .map((ps) => ps.supervisor_id)
    );

    return workers
      .filter((w) => w.active)
      .filter((w) => {
        const linkedSup = findSupervisorAccountForWorker(w);
        const isSupervisorRow =
          Boolean(linkedSup) || w.position.toLowerCase().includes('supervisor');

        if (!isSupervisorRow) return true;

        // If this worker is a Supervisor:
        // 1. Show if they already have an attendance record on this site & date
        const hasRecordOnSite = attendance.some(
          (a) =>
            a.project_id === selectedProjectId &&
            a.date === selectedDate &&
            a.worker_id === w.id
        );
        if (hasRecordOnSite) return true;

        // 2. If linked to a Supervisor account, check `project_supervisors`
        if (linkedSup) {
          const allAssignedForSup = projectSupervisors.filter(
            (ps) => ps.supervisor_id === linkedSup.id
          );
          if (allAssignedForSup.length === 0) return true;
          return assignedSupervisorIdsForSite.has(linkedSup.id);
        }

        return true;
      });
  }, [
    workers,
    projectSupervisors,
    selectedProjectId,
    selectedDate,
    attendance,
    findSupervisorAccountForWorker,
  ]);

  // Load existing records for project and date into terminal.
  // When no attendance has been submitted yet for (selectedProjectId, selectedDate),
  // all workers start UNCHECKED (`status: null`) — except workers already marked
  // Present/Half Day on another site today, who default to `absent` on this site.
  useEffect(() => {
    if (!selectedProjectId) return;
    const existing = attendance.filter(
      (a) => a.project_id === selectedProjectId && a.date === selectedDate
    );

    const initialDraft: Record<
      string,
      { status: AttendanceStatus | null; notes: string }
    > = {};

    siteRosterWorkers.forEach((w) => {
      const match = existing.find((a) => a.worker_id === w.id);
      if (match) {
        initialDraft[w.id] = {
          status: match.status,
          notes: match.notes || '',
        };
      } else if (otherSiteActiveAttendanceByWorker.has(w.id)) {
        const otherSite = otherSiteActiveAttendanceByWorker.get(w.id)!;
        initialDraft[w.id] = {
          status: 'absent',
          notes: `[At ${otherSite.projectName}]`,
        };
      } else {
        // Start UNCHECKED so the Supervisor or Founder must explicitly check each worker
        initialDraft[w.id] = {
          status: null,
          notes: '',
        };
      }
    });

    setDraftAttendance(initialDraft);
    setSubmissionSuccess(false);
  }, [
    selectedProjectId,
    selectedDate,
    attendance,
    siteRosterWorkers,
    otherSiteActiveAttendanceByWorker,
  ]);

  const handleStatusChange = (worker: Worker, status: AttendanceStatus) => {
    // Supervisor cannot manually toggle their own row (auto-logged on crew submit)
    if (isSelfSupervisorWorker(worker)) {
      return;
    }

    // Warn if trying to mark a worker Present/Half Day when they are already
    // marked Present on another site today
    const otherSite = otherSiteActiveAttendanceByWorker.get(worker.id);
    if (
      otherSite &&
      otherSite.record.status === 'present' &&
      (status === 'present' || status === 'half_day')
    ) {
      showToast(
        'info',
        `${worker.name} is already marked Present (Full Day) at ${otherSite.projectName} on ${selectedDate}.`
      );
      return;
    }

    const current = draftAttendance[worker.id] || {
      status: null,
      notes: '',
    };

    setDraftAttendance({
      ...draftAttendance,
      [worker.id]: {
        ...current,
        status,
      },
    });
  };

  const handleNotesChange = (workerId: string, notes: string) => {
    const current = draftAttendance[workerId] || { status: null, notes: '' };
    setDraftAttendance({
      ...draftAttendance,
      [workerId]: {
        ...current,
        notes,
      },
    });
  };

  // Bulk mark all regular crew (or a specific craft group) Present
  const handleMarkCrewPresent = (targetWorkers: Worker[]) => {
    const updated = { ...draftAttendance };
    targetWorkers.forEach((w) => {
      if (isSelfSupervisorWorker(w)) return;
      if (otherSiteActiveAttendanceByWorker.has(w.id)) return;
      updated[w.id] = {
        status: 'present',
        notes: updated[w.id]?.notes || '',
      };
    });
    setDraftAttendance(updated);
  };

  // Existing submitted attendance records for the active project & date
  const existingSiteDateRecords = attendance.filter(
    (a) => a.project_id === selectedProjectId && a.date === selectedDate
  );

  // Workers that the current user must mark before submitting:
  // - For a Supervisor: all `siteRosterWorkers` EXCEPT their own locked row (`!isSelfSupervisorWorker(w)`)
  // - For a Founder: all `siteRosterWorkers`
  const markableWorkers = useMemo(
    () => siteRosterWorkers.filter((w) => !isSelfSupervisorWorker(w)),
    [siteRosterWorkers, isSelfSupervisorWorker]
  );

  const checkedCount = markableWorkers.filter(
    (w) => draftAttendance[w.id]?.status !== null && draftAttendance[w.id]?.status !== undefined
  ).length;
  const uncheckedCount = markableWorkers.length - checkedCount;

  const handleBatchSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProjectId || !user) return;
    if (selectedDate > today) {
      showToast('error', 'Attendance cannot be recorded for a future date.');
      return;
    }
    if (uncheckedCount > 0) {
      showToast(
        'error',
        `Please mark attendance status for the remaining ${uncheckedCount} worker(s) before submitting.`
      );
      return;
    }

    setIsSubmitting(true);

    const timeLabel = new Date().toLocaleTimeString('en-PH', {
      hour: '2-digit',
      minute: '2-digit',
    });

    const batch: Array<{
      worker_id: string;
      project_id: string;
      date: string;
      status: AttendanceStatus;
      hours_worked: number;
      notes?: string | null;
      recorded_by: string;
    }> = [];

    // 1. Add all marked crew rows
    markableWorkers.forEach((w) => {
      const d = draftAttendance[w.id];
      if (!d || !d.status) return;
      batch.push({
        worker_id: w.id,
        project_id: selectedProjectId,
        date: selectedDate,
        status: d.status,
        hours_worked: statusToHours(d.status),
        notes: d.notes.trim() || null,
        recorded_by: user.id,
      });
    });

    // 2. If a Supervisor is submitting the crew attendance, automatically handle
    //    their own attendance row:
    //    - On first submit of the day (if not already Present/Half Day on another site),
    //      auto-log the Supervisor as `present` (Pending Founder Review).
    //    - On subsequent updates (e.g. changing a worker to Half Day in the afternoon),
    //      preserve their existing row without duplicating or resetting Founder approval.
    if (isSupervisor) {
      const selfWorker = siteRosterWorkers.find((w) => isSelfSupervisorWorker(w));
      if (selfWorker) {
        const existingSelfOnSite = existingSiteDateRecords.find(
          (a) => a.worker_id === selfWorker.id
        );
        const otherSiteSelf = otherSiteActiveAttendanceByWorker.get(selfWorker.id);

        if (existingSelfOnSite) {
          // Preserve existing status & notes (append update timestamp if still pending)
          const updatedNote = existingSelfOnSite.is_founder_override
            ? existingSelfOnSite.notes
            : `[Auto-logged on site attendance submission · Updated ${timeLabel} · Pending Founder Review]`;
          batch.push({
            worker_id: selfWorker.id,
            project_id: selectedProjectId,
            date: selectedDate,
            status: existingSelfOnSite.status,
            hours_worked: statusToHours(existingSelfOnSite.status),
            notes: updatedNote,
            recorded_by: existingSelfOnSite.recorded_by || user.id,
          });
        } else if (!otherSiteSelf) {
          // First submission of the day for this Supervisor
          batch.push({
            worker_id: selfWorker.id,
            project_id: selectedProjectId,
            date: selectedDate,
            status: 'present',
            hours_worked: 8,
            notes: `[Auto-logged on site attendance submission @ ${timeLabel} · Pending Founder Review]`,
            recorded_by: user.id,
          });
        }
      }
    }

    const success = await recordAttendanceBatch(batch);
    setIsSubmitting(false);
    if (success) {
      setSubmissionSuccess(true);
      setTimeout(() => setSubmissionSuccess(false), 3000);
    }
  };

  // 1-Click Founder Review of Supervisor Attendance: Full Day, Half Day, or Absent
  const handleFounderSupervisorReview = async (
    rec: Attendance,
    decision: 'present' | 'half_day' | 'absent'
  ) => {
    const label =
      decision === 'present'
        ? 'Approved Full Day'
        : decision === 'half_day'
          ? 'Approved Half Day'
          : 'Marked Absent';
    const ok = await updateAttendanceRecord(
      rec.id,
      {
        status: decision,
        hours_worked: statusToHours(decision),
        notes: `[Founder Review: ${label} by ${user?.name || 'Founder'}]`,
      },
      true
    );
    if (ok) {
      showToast(
        'success',
        `Supervisor attendance ${label.toLowerCase()} and synced to Payroll Engine.`
      );
    }
  };

  const handleFounderOverrideSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRecordForOverride) return;

    const success = await updateAttendanceRecord(
      selectedRecordForOverride.id,
      {
        status: overrideStatus,
        hours_worked: statusToHours(overrideStatus),
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
      pay_rate_type: 'daily',
      contact_number: workerPhone.trim() || '—',
      active: true,
    });
    setIsAddingWorker(false);
    if (created) {
      setWorkerName('');
      setWorkerPhone('');
      setIsQuickAddOpen(false);
      showToast(
        'success',
        `Added ${created.name} (${created.position}) to the workforce roster.`
      );
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

  // Filtered workers on the Daily Roster (Supervisors placed at the top)
  const filteredWorkers = useMemo(() => {
    return siteRosterWorkers
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
  }, [siteRosterWorkers, craftFilter, searchWorker]);

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

  // Unverified Supervisor self-attendance logs across the ledger
  const unverifiedSelfLogs = attendance.filter(
    (a) =>
      a.worker_id === a.recorded_by &&
      !a.is_founder_override &&
      (a.status === 'present' || a.status === 'half_day')
  );

  // Determine whether the current draft has unsaved changes compared to saved records
  const hasUnsavedChanges =
    existingSiteDateRecords.length === 0
      ? uncheckedCount === 0 && markableWorkers.length > 0
      : markableWorkers.some((w) => {
          const draft = draftAttendance[w.id];
          const saved = existingSiteDateRecords.find((a) => a.worker_id === w.id);
          if (!saved || !draft || !draft.status) return true;
          return (
            draft.status !== saved.status ||
            (draft.notes || '').trim() !== (saved.notes || '').trim()
          );
        });

  const latestSubmittedAt = existingSiteDateRecords.reduce<string | null>((latest, rec) => {
    if (!rec.submitted_at) return latest;
    if (!latest || rec.submitted_at > latest) return rec.submitted_at;
    return latest;
  }, null);

  // Attendance summary counts for active date & project
  const presentCount = Object.values(draftAttendance).filter(
    (d) => d.status === 'present'
  ).length;
  const halfDayCount = Object.values(draftAttendance).filter(
    (d) => d.status === 'half_day'
  ).length;
  const absentCount = Object.values(draftAttendance).filter(
    (d) => d.status === 'absent'
  ).length;
  const leaveCount = Object.values(draftAttendance).filter(
    (d) => d.status === 'leave'
  ).length;

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
      <div key={activeTab} className="space-y-5 max-w-5xl mx-auto animate-page-enter">
        {/* Clean Dedicated Page Header for each separated view */}
        <div className="flex items-center justify-between gap-3 pb-3 border-b border-surface-border/60">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl sm:text-2xl font-extrabold text-navy tracking-tight truncate">
                {activeTab === 'history'
                  ? 'Attendance History'
                  : activeTab === 'workforce'
                    ? 'Workforce Roster'
                    : 'Daily Roll Call'}
              </h1>
              {activeTab === 'terminal' && existingSiteDateRecords.length > 0 && (
                <Badge variant={hasUnsavedChanges ? 'warning' : 'success'} size="sm">
                  {hasUnsavedChanges ? 'Unsaved Edits' : 'Synced ✓'}
                </Badge>
              )}
            </div>
            <p className="text-xs text-ink-secondary mt-0.5 truncate">
              {activeTab === 'history'
                ? 'Submitted daily attendance logs & approval status'
                : activeTab === 'workforce'
                  ? `${workers.filter((w) => w.active).length} active craftsmen & supervisors`
                  : `${selectedDate} · Check off crew members on site`}
            </p>
          </div>

          {activeTab === 'workforce' && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => setIsQuickAddOpen(true)}
              leftIcon={<UserPlus className="w-4 h-4" />}
              className="shrink-0"
            >
              Add Worker
            </Button>
          )}
        </div>

        {/* Founder Review Banner: Supervisor Attendance Submitted with Crew Report */}
        {isFounder && unverifiedSelfLogs.length > 0 && (
          <div className="p-4 rounded-2xl bg-status-warning-bg/80 border border-status-warning/40 space-y-3 text-xs">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-start sm:items-center gap-2.5">
                <ShieldAlert className="w-5 h-5 text-status-warning shrink-0 mt-0.5 sm:mt-0" />
                <div>
                  <div className="font-bold text-navy text-sm">
                    Supervisor Attendance Pending Founder Approval ({unverifiedSelfLogs.length})
                  </div>
                  <div className="text-ink-secondary">
                    Supervisors are automatically logged when they submit their site&apos;s crew attendance and held back from Payroll until you approve them below.
                  </div>
                </div>
              </div>
              <Badge variant="warning" size="sm">
                Awaiting Founder Approval
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
                          Site Supervisor
                        </Badge>
                        <span className="text-ink-secondary">
                          · Submitted crew attendance for <strong className="text-navy">{proj?.name}</strong> on <strong>{rec.date}</strong>
                        </span>
                      </div>
                      {rec.notes && (
                        <div className="text-[11px] text-ink-muted">{rec.notes}</div>
                      )}
                    </div>

                    <div className="flex items-center flex-wrap gap-1.5 shrink-0">
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        onClick={() => handleFounderSupervisorReview(rec, 'present')}
                        leftIcon={<ShieldCheck className="w-3.5 h-3.5" />}
                      >
                        Approve Full Day
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => handleFounderSupervisorReview(rec, 'half_day')}
                      >
                        Half Day
                      </Button>
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        onClick={() => handleFounderSupervisorReview(rec, 'absent')}
                        leftIcon={<XCircle className="w-3.5 h-3.5" />}
                      >
                        Mark Absent
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
          <div className="p-3.5 rounded-2xl bg-white border border-surface-border shadow-xs grid grid-cols-1 md:grid-cols-2 gap-3 items-center">
            <div>
              <label className="text-[10px] font-bold text-ink-secondary uppercase tracking-wider block mb-1">
                Project Site
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
              <label className="text-[10px] font-bold text-ink-secondary uppercase tracking-wider block mb-1">
                Roll Call Date
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
          <form onSubmit={handleBatchSubmit} className="space-y-3.5">
            {/* Single-Row 5-Column Live Count Strip (Fits cleanly on 1 row on Mobile & Desktop) */}
            <div className="grid grid-cols-5 gap-1.5 sm:gap-2.5">
              <div className="p-2 sm:p-2.5 rounded-xl bg-white border border-surface-border text-navy text-center shadow-2xs">
                <div className="text-sm sm:text-lg font-extrabold leading-tight tabular-nums">
                  {checkedCount}/{markableWorkers.length}
                </div>
                <div className="text-[9px] sm:text-[10px] font-bold uppercase tracking-wider text-ink-secondary truncate">
                  Checked
                </div>
              </div>
              <div className="p-2 sm:p-2.5 rounded-xl bg-status-success-bg/70 border border-status-success/20 text-status-success text-center">
                <div className="text-sm sm:text-lg font-extrabold leading-tight tabular-nums">{presentCount}</div>
                <div className="text-[9px] sm:text-[10px] font-bold uppercase tracking-wider truncate">Present</div>
              </div>
              <div className="p-2 sm:p-2.5 rounded-xl bg-status-warning-bg/70 border border-status-warning/20 text-status-warning text-center">
                <div className="text-sm sm:text-lg font-extrabold leading-tight tabular-nums">{halfDayCount}</div>
                <div className="text-[9px] sm:text-[10px] font-bold uppercase tracking-wider truncate">Half Day</div>
              </div>
              <div className="p-2 sm:p-2.5 rounded-xl bg-status-danger-bg/70 border border-status-danger/20 text-status-danger text-center">
                <div className="text-sm sm:text-lg font-extrabold leading-tight tabular-nums">{absentCount}</div>
                <div className="text-[9px] sm:text-[10px] font-bold uppercase tracking-wider truncate">Absent</div>
              </div>
              <div className="p-2 sm:p-2.5 rounded-xl bg-status-info-bg/70 border border-status-info/20 text-status-info text-center">
                <div className="text-sm sm:text-lg font-extrabold leading-tight tabular-nums">{leaveCount}</div>
                <div className="text-[9px] sm:text-[10px] font-bold uppercase tracking-wider truncate">Leave</div>
              </div>
            </div>

            {/* Filter, Group, Quick-Add & Bulk-Action Toolbar */}
            <div className="p-3 rounded-2xl bg-white border border-surface-border shadow-sm flex flex-col lg:flex-row lg:items-center justify-between gap-2.5">
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 flex-1">
                <div className="w-full sm:w-60">
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
              </div>

              <div className="flex items-center flex-wrap justify-between sm:justify-end gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setIsQuickAddOpen(true)}
                  leftIcon={<UserPlus className="w-3.5 h-3.5" />}
                >
                  + Add Worker
                </Button>

                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => handleMarkCrewPresent(filteredWorkers)}
                  leftIcon={<CheckCheck className="w-3.5 h-3.5" />}
                >
                  Mark Crew Present
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
                  (w) => draftAttendance[w.id]?.status === 'present'
                ).length;
                const groupHalf = groupWorkers.filter(
                  (w) => draftAttendance[w.id]?.status === 'half_day'
                ).length;
                const groupAbsent = groupWorkers.filter(
                  (w) =>
                    draftAttendance[w.id]?.status === 'absent' ||
                    draftAttendance[w.id]?.status === 'leave'
                ).length;
                const groupUnchecked = groupWorkers.filter(
                  (w) => !isSelfSupervisorWorker(w) && !draftAttendance[w.id]?.status
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
                        {groupUnchecked > 0 && (
                          <Badge variant="warning" size="sm">
                            {groupUnchecked} unchecked
                          </Badge>
                        )}
                      </button>

                      <div className="flex items-center gap-2 text-[11px]">
                        <span className="text-status-success font-bold">{groupPresent}P</span>
                        <span className="text-ink-muted">·</span>
                        <span className="text-status-warning font-bold">{groupHalf}½</span>
                        <span className="text-ink-muted">·</span>
                        <span className="text-status-danger font-bold">{groupAbsent}A</span>

                        {groupWorkers.some((w) => !isSelfSupervisorWorker(w)) && (
                          <button
                            type="button"
                            onClick={() => handleMarkCrewPresent(groupWorkers)}
                            className="ml-2 px-2 py-0.5 rounded-lg bg-white border border-surface-border text-[11px] font-semibold text-navy hover:bg-surface-inset transition-colors"
                          >
                            All Present
                          </button>
                        )}
                      </div>
                    </div>

                    {!isCollapsed && viewMode === 'compact' && (
                      <div className="divide-y divide-surface-border/60">
                        {groupWorkers.map((worker) => {
                          const currentDraft = draftAttendance[worker.id] || {
                            status: null,
                            notes: '',
                          };
                          const isSelfSup = isSelfSupervisorWorker(worker);
                          const savedRec = existingSiteDateRecords.find(
                            (a) => a.worker_id === worker.id
                          );
                          const otherSiteInfo = otherSiteActiveAttendanceByWorker.get(
                            worker.id
                          );
                          const isVerifiedByFounder = Boolean(savedRec?.is_founder_override);
                          const showNoteBox =
                            Boolean(expandedNoteWorkers[worker.id]) ||
                            Boolean(currentDraft.notes && !isSelfSup);

                          return (
                            <div
                              key={worker.id}
                              className={`px-4 py-2.5 text-xs transition-colors ${
                                isSelfSup
                                  ? 'bg-amber-50/40'
                                  : !currentDraft.status
                                    ? 'bg-amber-50/15 hover:bg-slate-50/80'
                                    : 'hover:bg-slate-50/80'
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
                                      {worker.position} · ₱{worker.pay_rate}/day
                                    </span>
                                    {worker.position.toLowerCase().includes('supervisor') && (
                                      <Badge variant="warning" size="sm">
                                        Supervisor
                                      </Badge>
                                    )}
                                    {otherSiteInfo && (
                                      <Badge variant="info" size="sm">
                                        Already at {otherSiteInfo.projectName} (
                                        {otherSiteInfo.record.status === 'present'
                                          ? 'Present'
                                          : 'Half Day'}
                                        )
                                      </Badge>
                                    )}
                                    {!isSelfSup && !currentDraft.status && (
                                      <Badge variant="neutral" size="sm">
                                        Not checked yet
                                      </Badge>
                                    )}
                                  </div>
                                </div>

                                {/* Right: Status Controls (or Locked Auto-Status for Supervisor's Own Row) */}
                                {isSelfSup ? (
                                  <div className="flex items-center gap-2">
                                    <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border border-surface-border text-[11px] font-semibold text-navy">
                                      <Lock className="w-3.5 h-3.5 text-status-warning" />
                                      {otherSiteInfo ? (
                                        <span>
                                          Logged via {otherSiteInfo.projectName} ({selectedDate})
                                        </span>
                                      ) : savedRec ? (
                                        isVerifiedByFounder ? (
                                          <span className="text-status-success font-bold">
                                            Founder Approved ({formatStatusLabel(savedRec.status)}) ✓
                                          </span>
                                        ) : (
                                          <span>
                                            Submitted as Present · Pending Founder Approval
                                          </span>
                                        )
                                      ) : (
                                        <span>
                                          Auto-logged as Present when you submit crew attendance · Founder Approval
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                ) : (
                                  <div className="flex items-center flex-wrap gap-1.5">
                                    <div className="inline-flex rounded-xl bg-surface-inset p-0.5 border border-surface-border">
                                      {[
                                        {
                                          id: 'present',
                                          label: 'Present',
                                          activeClass:
                                            'bg-status-success text-white font-bold shadow-sm',
                                        },
                                        {
                                          id: 'half_day',
                                          label: 'Half Day',
                                          activeClass:
                                            'bg-status-warning text-white font-bold shadow-sm',
                                        },
                                        {
                                          id: 'absent',
                                          label: 'Absent',
                                          activeClass:
                                            'bg-status-danger text-white font-bold shadow-sm',
                                        },
                                        {
                                          id: 'leave',
                                          label: 'Leave',
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
                                              handleStatusChange(
                                                worker,
                                                st.id as AttendanceStatus
                                              )
                                            }
                                            className={`px-3 py-1 rounded-lg text-[11px] transition-all ${
                                              active
                                                ? st.activeClass
                                                : 'text-ink-secondary hover:text-navy font-medium'
                                            }`}
                                          >
                                            {st.label}
                                          </button>
                                        );
                                      })}
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
                                )}
                              </div>

                              {showNoteBox && !isSelfSup && (
                                <div className="mt-2">
                                  <Input
                                    placeholder="Activity note (e.g. 2F slab rebar, went home at noon)..."
                                    value={currentDraft.notes}
                                    onChange={(e) =>
                                      handleNotesChange(worker.id, e.target.value)
                                    }
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
                            status: null,
                            notes: '',
                          };
                          const isSelfSup = isSelfSupervisorWorker(worker);
                          const savedRec = existingSiteDateRecords.find(
                            (a) => a.worker_id === worker.id
                          );

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
                                    {worker.position} · ₱{worker.pay_rate}/day
                                  </div>
                                </div>
                                {!isSelfSup && !currentDraft.status && (
                                  <Badge variant="warning" size="sm">
                                    Unchecked
                                  </Badge>
                                )}
                              </div>

                              {isSelfSup ? (
                                <div className="p-2.5 rounded-xl bg-white border border-surface-border text-[11px] font-semibold text-navy flex items-center gap-2">
                                  <Lock className="w-3.5 h-3.5 text-status-warning shrink-0" />
                                  <span>
                                    {savedRec
                                      ? savedRec.is_founder_override
                                        ? `Founder Approved (${formatStatusLabel(savedRec.status)}) ✓`
                                        : 'Submitted as Present · Pending Founder Approval'
                                      : 'Auto-logged as Present when you submit crew attendance'}
                                  </span>
                                </div>
                              ) : (
                                <>
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
                                            handleStatusChange(
                                              worker,
                                              item.id as AttendanceStatus
                                            )
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
                                    placeholder="Activity notes (optional)..."
                                    value={currentDraft.notes}
                                    onChange={(e) =>
                                      handleNotesChange(worker.id, e.target.value)
                                    }
                                    className="text-xs py-1.5"
                                  />
                                </>
                              )}
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
                        ? 'Click "+ Add Worker" above to register craftsmen — they will appear here grouped by craft.'
                        : 'No worker matches the current filter.'
                    }
                  />
                </div>
              )}
            </div>

            {/* Slim Single-Line Submit Action Bar (Never overlaps worker cards with paragraphs of text) */}
            <div className="sticky bottom-[68px] lg:bottom-12 z-20 px-3.5 py-2.5 rounded-2xl bg-white/95 backdrop-blur-md border border-surface-border shadow-[0_8px_24px_rgba(11,31,58,0.10)] flex items-center justify-between gap-3">
              <div className="text-xs text-ink-secondary truncate min-w-0">
                {uncheckedCount > 0 ? (
                  <span>
                    <strong className="text-navy tabular-nums">{checkedCount}/{markableWorkers.length}</strong> checked ·{' '}
                    <span className="text-status-warning font-semibold tabular-nums">{uncheckedCount} left</span>
                  </span>
                ) : existingSiteDateRecords.length > 0 && !hasUnsavedChanges ? (
                  <span className="inline-flex items-center gap-1.5 text-status-success font-semibold">
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                    <span>Synced for {selectedDate}</span>
                  </span>
                ) : (
                  <span>
                    <strong className="text-navy tabular-nums">{markableWorkers.length}/{markableWorkers.length}</strong> crew checked
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
                size="sm"
                isLoading={isSubmitting}
                disabled={
                  isSubmitting ||
                  !selectedProjectId ||
                  markableWorkers.length === 0 ||
                  uncheckedCount > 0 ||
                  (existingSiteDateRecords.length > 0 && !hasUnsavedChanges)
                }
                leftIcon={
                  existingSiteDateRecords.length > 0 && !hasUnsavedChanges ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-status-success" />
                  ) : (
                    <Save className="w-3.5 h-3.5" />
                  )
                }
                className="shrink-0"
              >
                {uncheckedCount > 0
                  ? `Mark ${uncheckedCount} More`
                  : existingSiteDateRecords.length > 0
                    ? hasUnsavedChanges
                      ? 'Save Changes'
                      : 'Synced ✓'
                    : 'Submit Roll Call'}
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
                        <span className="text-status-warning font-bold">{hCount} Half Day</span>
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
                                      Pending Founder Approval (Held from Payroll)
                                    </Badge>
                                  )}
                                  {isSelfLog && rec.is_founder_override && (
                                    <Badge variant="success" size="sm">
                                      Founder Approved ✓
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

                              <div className="flex items-center flex-wrap gap-1.5 shrink-0">
                                <Badge
                                  variant={
                                    rec.status === 'present'
                                      ? 'success'
                                      : rec.status === 'half_day'
                                        ? 'warning'
                                        : rec.status === 'leave'
                                          ? 'info'
                                          : 'danger'
                                  }
                                  size="sm"
                                >
                                  {formatStatusLabel(rec.status)}
                                </Badge>

                                {isFounder && isUnverifiedSelf && (
                                  <>
                                    <Button
                                      type="button"
                                      variant="primary"
                                      size="sm"
                                      onClick={() =>
                                        handleFounderSupervisorReview(rec, 'present')
                                      }
                                    >
                                      Full Day
                                    </Button>
                                    <Button
                                      type="button"
                                      variant="secondary"
                                      size="sm"
                                      onClick={() =>
                                        handleFounderSupervisorReview(rec, 'half_day')
                                      }
                                    >
                                      Half Day
                                    </Button>
                                    <Button
                                      type="button"
                                      variant="danger"
                                      size="sm"
                                      onClick={() =>
                                        handleFounderSupervisorReview(rec, 'absent')
                                      }
                                    >
                                      Absent
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
                    Newly registered workers are automatically grouped by craft on the Daily Roster and Payroll Engine. (Supervisors are synced automatically from Team Accounts.)
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
                    onChange={(e) => setWorkerRate(e.target.value)}
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
                    {groupWorkers.map((w) => {
                      const linkedSup = findSupervisorAccountForWorker(w);
                      const supProjectIds = linkedSup
                        ? projectSupervisors
                            .filter((ps) => ps.supervisor_id === linkedSup.id)
                            .map((ps) => ps.project_id)
                        : [];
                      const supProjects = projects.filter((p) =>
                        supProjectIds.includes(p.id)
                      );

                      return (
                        <div
                          key={w.id}
                          className="px-4 py-2.5 flex items-center justify-between gap-3 text-xs hover:bg-slate-50 transition-colors"
                        >
                          <div className="flex items-center flex-wrap gap-2 min-w-0">
                            <span className="font-bold text-navy text-sm">{w.name}</span>
                            <span className="text-ink-secondary">
                              {w.position} · ₱{w.pay_rate}/day
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
                            {supProjects.map((sp) => (
                              <span
                                key={sp.id}
                                className="px-2 py-0.5 rounded-lg bg-surface-inset border border-surface-border text-[11px] font-medium text-navy"
                              >
                                {sp.name}
                              </span>
                            ))}
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
                      );
                    })}
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

      {/* QUICK ADD WORKER MODAL (Accessible directly from Daily Roster) */}
      <Modal
        isOpen={isQuickAddOpen}
        onClose={() => setIsQuickAddOpen(false)}
        title="Quick Add Site Worker"
        description="Add a craftsman directly to the workforce roster without leaving your attendance sheet."
      >
        <form onSubmit={handleAddWorkerSubmit} className="space-y-4 text-xs">
          <Input
            label="Worker Full Name"
            placeholder="e.g. Danilo Santos"
            value={workerName}
            onChange={(e) => setWorkerName(e.target.value)}
            required
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
              ]}
            />

            <Input
              label="Daily Rate (PHP ₱)"
              type="number"
              min="0"
              step="50"
              value={workerRate}
              onChange={(e) => setWorkerRate(e.target.value)}
              required
            />
          </div>

          <Input
            label="Contact Number (Optional)"
            placeholder="0917XXXXXXX"
            value={workerPhone}
            onChange={(e) => setWorkerPhone(e.target.value)}
          />

          <div className="pt-2 flex justify-end space-x-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setIsQuickAddOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" isLoading={isAddingWorker}>
              Add Worker to Roster
            </Button>
          </div>
        </form>
      </Modal>

      {/* EDIT WORKER MODAL (Founder only) */}
      <Modal
        isOpen={Boolean(editingWorker)}
        onClose={() => setEditingWorker(null)}
        title="Manage Worker Profile"
        description="Update craft, daily wage rate, contact number, or active roster status."
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

            <Input
              label="Daily Wage Rate (PHP ₱ / day)"
              type="number"
              min="0"
              step="50"
              value={editWorkerRate}
              onChange={(e) => {
                setEditWorkerRate(e.target.value);
                setEditWorkerRateType('daily');
              }}
              required
            />

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

      {/* FOUNDER OVERRIDE MODAL (Status only — no manual hours box) */}
      <Modal
        isOpen={overrideModalOpen}
        onClose={() => setOverrideModalOpen(false)}
        title="Founder Attendance Override"
        description="Update site attendance status. An audit flag will be attached."
      >
        {selectedRecordForOverride && (
          <form onSubmit={handleFounderOverrideSubmit} className="space-y-4 text-xs">
            <div className="p-3 rounded-xl bg-surface-inset border border-surface-border space-y-1">
              <div className="font-bold text-navy">
                Worker: {workers.find((w) => w.id === selectedRecordForOverride.worker_id)?.name}
              </div>
              <div className="text-ink-secondary">
                Date: {selectedRecordForOverride.date}
              </div>
            </div>

            <Select
              label="Attendance Status"
              value={overrideStatus}
              onChange={(e) => setOverrideStatus(e.target.value as AttendanceStatus)}
            >
              <option value="present">Present (Full Day)</option>
              <option value="half_day">Half Day</option>
              <option value="absent">Absent</option>
              <option value="leave">Approved Leave</option>
            </Select>

            <Input
              label="Reason / Note (Optional)"
              placeholder="e.g. Went home at noon / Approved leave"
              value={overrideNotes}
              onChange={(e) => setOverrideNotes(e.target.value)}
            />

            <div className="pt-3 flex justify-end space-x-2">
              <Button type="button" variant="secondary" onClick={() => setOverrideModalOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" type="submit">
                Save Override
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </AppShell>
  );
}

export default function AttendancePage() {
  return (
    <Suspense fallback={null}>
      <AttendancePageInner />
    </Suspense>
  );
}
