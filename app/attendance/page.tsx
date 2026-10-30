'use client';

import React, { Suspense, useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { AppShell } from '@/components/layout/AppShell';
import { useDataStore } from '@/lib/data/store';
import { useAuth } from '@/lib/auth/authContext';
import { Attendance, AttendanceStatus, Worker } from '@/types';
import {
  CheckCircle2,
  Save,
  Search,
  UserPlus,
  HandCoins,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  X,
  XCircle,
  SlidersHorizontal,
  Lock,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';
import { formatDatePH } from '@/lib/email/format';
import {
  parseAttendanceDraft,
  serializeAttendanceDraft,
  type AttendanceDraftEntry,
  type AttendanceDraftMap,
} from '@/lib/attendance/drafts';
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

const CRAFT_FILTER_OPTIONS = [
  { label: 'All Craft Groups', value: 'all' },
  { label: 'Supervision & Foremen', value: 'supervision' },
  { label: 'Masonry & Concrete', value: 'masonry' },
  { label: 'Carpentry & Formworks', value: 'carpentry' },
  { label: 'Steel, Electrical & Plumbing', value: 'mep_steel' },
  { label: 'Finishing & General Labor', value: 'general' },
];

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

  // Sync activeTab with URL `?tab=history` or `?tab=workforce` and 0ms client-side tab events
  useEffect(() => {
    const tabParam = searchParams?.get('tab');
    if (tabParam === 'history' || tabParam === 'workforce') {
      setActiveTab(tabParam);
    } else {
      setActiveTab('terminal');
    }
  }, [searchParams]);

  useEffect(() => {
    const onTabEvent = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail === 'history' || detail === 'workforce' || detail === 'terminal') {
        setActiveTab(detail);
      }
    };
    window.addEventListener('bale:attendance-tab', onTabEvent);
    return () => window.removeEventListener('bale:attendance-tab', onTabEvent);
  }, []);

  const [craftFilter, setCraftFilter] = useState<string>('all');
  const [isCrewFilterSheetOpen, setIsCrewFilterSheetOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [expandedNoteWorkers, setExpandedNoteWorkers] = useState<Record<string, boolean>>({});

  // Workforce registration stays collapsed until the user asks to add a worker.
  const [isWorkerFormOpen, setIsWorkerFormOpen] = useState(false);
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

  // Terminal drafts stay local until the explicit Submit action writes official attendance.
  const [draftAttendance, setDraftAttendance] = useState<AttendanceDraftMap>({});
  const [dirtyDraftWorkerIds, setDirtyDraftWorkerIds] = useState<string[]>([]);
  const [draftStorageReadyKey, setDraftStorageReadyKey] = useState<string | null>(null);
  const [draftStorageStatus, setDraftStorageStatus] = useState<'ready' | 'saved' | 'error'>('ready');
  const initializedDraftContextRef = useRef<string | null>(null);

  const attendanceDraftStorageKey =
    user?.id && selectedProjectId && selectedDate
      ? `asinta-attendance-draft:v1:${encodeURIComponent(user.id)}:${encodeURIComponent(selectedProjectId)}:${selectedDate}`
      : null;

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [attendanceSaveFailed, setAttendanceSaveFailed] = useState(false);
  const [searchWorker, setSearchWorker] = useState('');

  // History tab filters & collapsible daily sheets
  const [historyProjectFilter, setHistoryProjectFilter] = useState<string>('all');
  const [historyStatusFilter, setHistoryStatusFilter] = useState<string>('all');
  const [historyDateFilter, setHistoryDateFilter] = useState<string>('');
  const [historySearchQuery, setHistorySearchQuery] = useState<string>('');
  const [isHistoryFilterSheetOpen, setIsHistoryFilterSheetOpen] = useState(false);
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

  const getBaselineDraftEntry = useCallback(
    (workerId: string): AttendanceDraftEntry => {
      const saved = attendance.find(
        (record) =>
          record.worker_id === workerId &&
          record.project_id === selectedProjectId &&
          record.date === selectedDate
      );
      if (saved) {
        return { status: saved.status, notes: saved.notes || '' };
      }

      const otherSite = otherSiteActiveAttendanceByWorker.get(workerId);
      if (otherSite) {
        return { status: 'absent', notes: `[At ${otherSite.projectName}]` };
      }

      // A new day/site starts unchecked, preserving the existing roll-call rule.
      return { status: null, notes: '' };
    },
    [attendance, selectedProjectId, selectedDate, otherSiteActiveAttendanceByWorker]
  );

  // Hydrate once per user/site/date. On later data refreshes, update untouched rows
  // from the server but never replace a worker's in-progress local selection.
  useEffect(() => {
    if (!isLoaded || !attendanceDraftStorageKey) return;

    const baseline: AttendanceDraftMap = {};
    siteRosterWorkers.forEach((worker) => {
      baseline[worker.id] = getBaselineDraftEntry(worker.id);
    });

    if (initializedDraftContextRef.current !== attendanceDraftStorageKey) {
      let restoredEntries: AttendanceDraftMap = {};
      let storageReadFailed = false;
      try {
        const raw = window.localStorage.getItem(attendanceDraftStorageKey);
        if (raw) {
          const parsed = parseAttendanceDraft(raw);
          if (parsed) {
            const knownWorkerIds = new Set(workers.map((worker) => worker.id));
            restoredEntries = Object.fromEntries(
              Object.entries(parsed).filter(([workerId, entry]) => {
                const savedBaseline = baseline[workerId];
                return (
                  knownWorkerIds.has(workerId) &&
                  Boolean(savedBaseline) &&
                  (entry.status !== savedBaseline?.status ||
                    entry.notes.trim() !== savedBaseline?.notes.trim())
                );
              })
            );
          } else {
            window.localStorage.removeItem(attendanceDraftStorageKey);
          }
        }
      } catch {
        storageReadFailed = true;
      }

      setDraftAttendance({ ...baseline, ...restoredEntries });
      setDirtyDraftWorkerIds(Object.keys(restoredEntries));
      setDraftStorageReadyKey(attendanceDraftStorageKey);
      setDraftStorageStatus(
        storageReadFailed ? 'error' : Object.keys(restoredEntries).length > 0 ? 'saved' : 'ready'
      );
      setAttendanceSaveFailed(false);
      initializedDraftContextRef.current = attendanceDraftStorageKey;
      return;
    }

    setDraftAttendance((current) => {
      const next = { ...baseline };
      dirtyDraftWorkerIds.forEach((workerId) => {
        if (current[workerId]) next[workerId] = current[workerId];
      });
      return next;
    });
  }, [
    isLoaded,
    attendanceDraftStorageKey,
    siteRosterWorkers,
    getBaselineDraftEntry,
    workers,
    dirtyDraftWorkerIds,
  ]);

  // Persist only locally changed rows; official attendance still requires Submit.
  useEffect(() => {
    if (
      !attendanceDraftStorageKey ||
      draftStorageReadyKey !== attendanceDraftStorageKey
    ) {
      return;
    }

    try {
      const entries: AttendanceDraftMap = {};
      dirtyDraftWorkerIds.forEach((workerId) => {
        const entry = draftAttendance[workerId];
        if (entry) entries[workerId] = entry;
      });

      if (Object.keys(entries).length === 0) {
        window.localStorage.removeItem(attendanceDraftStorageKey);
        setDraftStorageStatus('ready');
        return;
      }

      window.localStorage.setItem(
        attendanceDraftStorageKey,
        serializeAttendanceDraft(entries)
      );
      setDraftStorageStatus('saved');
    } catch {
      setDraftStorageStatus('error');
    }
  }, [
    attendanceDraftStorageKey,
    draftStorageReadyKey,
    dirtyDraftWorkerIds,
    draftAttendance,
  ]);

  const applyDraftChanges = (changes: AttendanceDraftMap) => {
    const changedEntries = Object.entries(changes);
    if (changedEntries.length === 0) return;

    setAttendanceSaveFailed(false);
    setDraftAttendance((current) => ({ ...current, ...changes }));
    setDirtyDraftWorkerIds((current) => {
      const next = new Set(current);
      changedEntries.forEach(([workerId, entry]) => {
        const baseline = getBaselineDraftEntry(workerId);
        if (
          entry.status !== baseline.status ||
          entry.notes.trim() !== baseline.notes.trim()
        ) {
          next.add(workerId);
        } else {
          next.delete(workerId);
        }
      });
      return Array.from(next);
    });
  };

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

    const current = draftAttendance[worker.id] || getBaselineDraftEntry(worker.id);
    applyDraftChanges({
      [worker.id]: {
        ...current,
        status,
      },
    });
  };

  const handleNotesChange = (workerId: string, notes: string) => {
    const current = draftAttendance[workerId] || getBaselineDraftEntry(workerId);
    applyDraftChanges({
      [workerId]: {
        ...current,
        notes,
      },
    });
  };

  // Fill only unmarked regular crew in a craft group as Present
  const handleMarkCrewPresent = (targetWorkers: Worker[]) => {
    const changes: AttendanceDraftMap = {};
    targetWorkers.forEach((worker) => {
      if (isSelfSupervisorWorker(worker)) return;
      const current = draftAttendance[worker.id] || getBaselineDraftEntry(worker.id);
      if (current.status) return;
      if (otherSiteActiveAttendanceByWorker.has(worker.id)) return;
      changes[worker.id] = { ...current, status: 'present' };
    });
    applyDraftChanges(changes);
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
    if (isSubmitting || !selectedProjectId || !user) return;
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
    setAttendanceSaveFailed(false);

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
      is_founder_override?: boolean;
    }> = [];

    // 1. Add all marked crew rows
    markableWorkers.forEach((w) => {
      const d = draftAttendance[w.id];
      if (!d || !d.status) return;
      const isSupRow =
        Boolean(findSupervisorAccountForWorker(w)) ||
        w.position.toLowerCase().includes('supervisor');
      const existingRec = existingSiteDateRecords.find((a) => a.worker_id === w.id);
      batch.push({
        worker_id: w.id,
        project_id: selectedProjectId,
        date: selectedDate,
        status: d.status,
        hours_worked: statusToHours(d.status),
        notes: d.notes.trim() || null,
        recorded_by: user.id,
        is_founder_override: isFounder
          ? Boolean(isSupRow || existingRec?.is_founder_override)
          : Boolean(existingRec?.is_founder_override),
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
            is_founder_override: Boolean(existingSelfOnSite.is_founder_override),
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
            is_founder_override: false,
          });
        }
      }
    }

    let success = false;
    try {
      success = await recordAttendanceBatch(batch);
    } catch {
      success = false;
    } finally {
      setIsSubmitting(false);
    }
    if (success) {
      setAttendanceSaveFailed(false);
      setDirtyDraftWorkerIds([]);
      setDraftStorageStatus('ready');
      if (attendanceDraftStorageKey) {
        try {
          window.localStorage.removeItem(attendanceDraftStorageKey);
        } catch {
          setDraftStorageStatus('error');
        }
      }
      showToast('success', 'Attendance saved and synced to Payroll.');
    } else {
      setAttendanceSaveFailed(true);
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
      setIsWorkerFormOpen(false);
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

  // Identify whether an attendance record belongs to a Site Supervisor
  const isSupervisorAttendanceRecord = useCallback(
    (rec: Attendance): boolean => {
      if (rec.worker_id === rec.recorded_by) return true;
      const notes = rec.notes || '';
      if (notes.includes('Pending Founder Review') || notes.includes('Founder Review:')) {
        return true;
      }
      const w = workers.find((item) => item.id === rec.worker_id);
      if (!w) return false;
      return (
        Boolean(findSupervisorAccountForWorker(w)) ||
        w.position.toLowerCase().includes('supervisor')
      );
    },
    [workers, findSupervisorAccountForWorker]
  );

  // Unverified Supervisor attendance logs across the ledger awaiting Founder sign-off
  const unverifiedSelfLogs = useMemo(
    () =>
      attendance.filter(
        (a) =>
          isSupervisorAttendanceRecord(a) &&
          !a.is_founder_override &&
          (a.status === 'present' || a.status === 'half_day')
      ),
    [attendance, isSupervisorAttendanceRecord]
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
  const presentCount = markableWorkers.filter(
    (worker) => draftAttendance[worker.id]?.status === 'present'
  ).length;
  const halfDayCount = markableWorkers.filter(
    (worker) => draftAttendance[worker.id]?.status === 'half_day'
  ).length;
  const absentCount = markableWorkers.filter(
    (worker) => draftAttendance[worker.id]?.status === 'absent'
  ).length;
  const leaveCount = markableWorkers.filter(
    (worker) => draftAttendance[worker.id]?.status === 'leave'
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

  const activeHistoryFilterCount =
    Number(historyProjectFilter !== 'all') +
    Number(historyStatusFilter !== 'all') +
    Number(Boolean(historyDateFilter));
  const hasAnyHistoryCriteria = Boolean(
    activeHistoryFilterCount || historySearchQuery.trim()
  );

  const clearHistoryFilters = () => {
    setHistoryProjectFilter('all');
    setHistoryStatusFilter('all');
    setHistoryDateFilter('');
    setHistorySearchQuery('');
  };

  const toggleGroupCollapse = (key: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleNoteInput = (workerId: string) => {
    setExpandedNoteWorkers((prev) => {
      const currentlyExpanded =
        prev[workerId] ?? Boolean(draftAttendance[workerId]?.notes);
      return { ...prev, [workerId]: !currentlyExpanded };
    });
  };

  return (
    <AppShell>
      <div key={activeTab} className="w-full space-y-4">
        {/* Clean Dedicated Page Header for each separated view */}
        <div className="blueprint-accent flex flex-col gap-3 border-b border-surface-border/60 pb-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl sm:text-2xl font-semibold text-navy tracking-tight truncate">
                {activeTab === 'history'
                  ? 'Attendance History'
                  : activeTab === 'workforce'
                    ? 'Workforce Roster'
                    : 'Daily Roll Call'}
              </h1>
            </div>
            <p className="text-xs text-ink-secondary mt-0.5 truncate">
              {activeTab === 'history'
                ? 'Submitted daily attendance logs & approval status'
                : activeTab === 'workforce'
                  ? `${workers.filter((w) => w.active).length} active craftsmen & supervisors`
                  : 'Mark crew on site'}
            </p>
          </div>

          {activeTab === 'workforce' && (
            <div className="flex flex-wrap gap-2">
              {isSupervisor && (
                <Link href="/advances?tab=requests" prefetch={false}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    leftIcon={<HandCoins className="h-4 w-4" />}
                  >
                    Bale Requests
                  </Button>
                </Link>
              )}
              <Button
                variant={isWorkerFormOpen ? 'secondary' : 'primary'}
                size="sm"
                onClick={() => setIsWorkerFormOpen((isOpen) => !isOpen)}
                aria-expanded={isWorkerFormOpen}
                aria-controls="workforce-worker-form"
                leftIcon={
                  isWorkerFormOpen ? (
                    <X className="h-4 w-4" />
                  ) : (
                    <UserPlus className="h-4 w-4" />
                  )
                }
                className="shrink-0"
              >
                {isWorkerFormOpen ? 'Close form' : 'Add Worker'}
              </Button>
            </div>
          )}
        </div>

        {/* Founder Review Banner: Supervisor Attendance Submitted with Crew Report */}
        {isFounder && unverifiedSelfLogs.length > 0 && (
          <div className="p-3.5 rounded-xl bg-status-warning-bg/60 border border-status-warning/25 space-y-3 text-xs">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-start sm:items-center gap-2.5">
                <ShieldAlert className="w-5 h-5 text-status-warning shrink-0 mt-0.5 sm:mt-0" />
                <div>
                  <div className="font-bold text-navy text-sm">
                    Supervisor approvals ({unverifiedSelfLogs.length})
                  </div>
                  <div className="text-ink-secondary">
                    Review these supervisor logs before they are included in Payroll.
                  </div>
                </div>
              </div>
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
                        className="min-h-11 sm:min-h-9"
                        onClick={() => handleFounderSupervisorReview(rec, 'present')}
                        leftIcon={<ShieldCheck className="w-3.5 h-3.5" />}
                      >
                        Approve Full Day
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="min-h-11 sm:min-h-9"
                        onClick={() => handleFounderSupervisorReview(rec, 'half_day')}
                      >
                        Half Day
                      </Button>
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        className="min-h-11 sm:min-h-9"
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
          <div className="rounded-xl border border-surface-border bg-white p-3 sm:p-3.5 grid grid-cols-1 md:grid-cols-2 gap-2.5 md:gap-3 items-center">
            <div>
              <label htmlFor="attendance-project" className="text-xs font-semibold text-ink-secondary block mb-1.5">
                Project Site
              </label>
              <Select
                id="attendance-project"
                value={selectedProjectId}
                disabled={isSubmitting}
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
              <span className="text-xs font-semibold text-ink-secondary block mb-1.5">
                Roll Call Date
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant={selectedDate === today ? 'primary' : 'secondary'}
                  size="sm"
                  className="min-h-11 sm:min-h-9"
                  disabled={isSubmitting}
                  onClick={() => setSelectedDate(today)}
                >
                  Today ({today.slice(5)})
                </Button>
                <Button
                  type="button"
                  variant={selectedDate === yesterday ? 'primary' : 'secondary'}
                  size="sm"
                  className="min-h-11 sm:min-h-9"
                  disabled={isSubmitting}
                  onClick={() => setSelectedDate(yesterday)}
                >
                  Yesterday ({yesterday.slice(5)})
                </Button>
                {isFounder && (
                  <Input
                    type="date"
                    aria-label="Roll call date"
                    value={selectedDate}
                    max={today}
                    disabled={isSubmitting}
                    onChange={(e) => setSelectedDate(e.target.value)}
                    className="py-2"
                  />
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 1: TERMINAL / DAILY ROSTER */}
        {activeTab === 'terminal' && (
          <form onSubmit={handleBatchSubmit} className="space-y-2.5 sm:space-y-3.5">
            {/* Compact progress summary: the roster remains the focus, counts stay scannable. */}
            <section
              aria-label="Attendance summary"
              className="rounded-xl border border-surface-border bg-white px-3 py-2.5 sm:px-3.5 sm:py-3"
            >
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-ink-primary">Crew status</h2>
                <span className="text-xs font-medium text-ink-secondary tabular-nums">
                  {checkedCount} of {markableWorkers.length} marked
                </span>
              </div>
              <div
                className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-inset"
                role="progressbar"
                aria-label="Attendance completion"
                aria-valuemin={0}
                aria-valuemax={Math.max(markableWorkers.length, 1)}
                aria-valuenow={checkedCount}
              >
                <div
                  className="h-full rounded-full bg-brand transition-[width] duration-200"
                  style={{
                    width: `${markableWorkers.length ? Math.round((checkedCount / markableWorkers.length) * 100) : 0}%`,
                  }}
                />
              </div>
              <ul
                aria-label="Attendance counts by status"
                className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]"
              >
                {[
                  { label: 'Present', count: presentCount, dot: 'bg-status-success' },
                  { label: 'Half day', count: halfDayCount, dot: 'bg-status-warning' },
                  { label: 'Absent', count: absentCount, dot: 'bg-status-danger' },
                  { label: 'Leave', count: leaveCount, dot: 'bg-status-info' },
                ].map((item) => (
                  <li key={item.label} className="inline-flex items-center gap-1.5 text-ink-secondary">
                    <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${item.dot}`} />
                    <span className="font-semibold text-ink-primary tabular-nums">{item.count}</span>
                    <span>{item.label}</span>
                  </li>
                ))}
              </ul>
              {dirtyDraftWorkerIds.length > 0 && (
                <div
                  role="status"
                  aria-live="polite"
                  className="mt-2 inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs"
                >
                  {draftStorageStatus === 'saved' ? (
                    <>
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-status-success" />
                      <span className="font-semibold text-status-success">Draft saved on this device</span>
                      <span className="text-ink-secondary">· Submit to record attendance</span>
                    </>
                  ) : draftStorageStatus === 'error' ? (
                    <span className="font-medium text-status-warning">
                      Draft saving is unavailable on this device. Keep this page open until you submit.
                    </span>
                  ) : (
                    <span className="text-ink-secondary">Saving draft on this device…</span>
                  )}
                </div>
              )}
            </section>

            {/* Search stays visible; the craft filter moves to a focused sheet on phones. */}
            <div className="rounded-xl border border-surface-border bg-white p-2.5 sm:p-3">
              <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_minmax(13rem,18rem)] md:items-center">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <Input
                      placeholder="Search workers..."
                      value={searchWorker}
                      onChange={(e) => setSearchWorker(e.target.value)}
                      leftIcon={<Search className="w-4 h-4" />}
                      className="min-w-0"
                      aria-label="Search roster workers"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsCrewFilterSheetOpen(true)}
                    aria-expanded={isCrewFilterSheetOpen}
                    aria-controls={isCrewFilterSheetOpen ? 'attendance-crew-filters' : undefined}
                    className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg border border-surface-border px-3 text-xs font-semibold text-navy transition-colors hover:bg-surface-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 md:hidden"
                  >
                    <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                    <span>Filters</span>
                    {craftFilter !== 'all' && (
                      <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-bold text-white">
                        1
                      </span>
                    )}
                  </button>
                </div>
                <div className="hidden md:block">
                  <Select
                    aria-label="Filter by craft group"
                    value={craftFilter}
                    onChange={(e) => setCraftFilter(e.target.value)}
                    options={CRAFT_FILTER_OPTIONS}
                  />
                </div>
              </div>

              {craftFilter !== 'all' && (
                <div className="mt-2 flex sm:hidden">
                  <button
                    type="button"
                    onClick={() => setCraftFilter('all')}
                    aria-label={`Remove craft filter: ${CRAFT_FILTER_OPTIONS.find((option) => option.value === craftFilter)?.label || 'selected group'}`}
                    className="inline-flex min-h-11 min-w-0 max-w-full items-center gap-1.5 rounded-full bg-surface-inset px-3 py-1 text-xs font-medium text-navy transition-colors hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                  >
                    <span className="truncate">
                      {CRAFT_FILTER_OPTIONS.find((option) => option.value === craftFilter)?.label || 'Selected craft'}
                    </span>
                    <X className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>

            <Modal
              isOpen={isCrewFilterSheetOpen}
              onClose={() => setIsCrewFilterSheetOpen(false)}
              title="Crew filters"
              description="Filter the roster by craft group."
              maxWidth="full"
              presentation="bottom-sheet"
            >
              <div id="attendance-crew-filters" className="space-y-4">
                <Select
                  label="Craft group"
                  value={craftFilter}
                  onChange={(e) => setCraftFilter(e.target.value)}
                  options={CRAFT_FILTER_OPTIONS}
                />
                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  {craftFilter !== 'all' && (
                    <Button
                      type="button"
                      variant="secondary"
                      className="min-h-11 w-full sm:w-auto"
                      onClick={() => setCraftFilter('all')}
                    >
                      Clear filter
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="primary"
                    className="min-h-11 w-full sm:w-auto"
                    onClick={() => setIsCrewFilterSheetOpen(false)}
                  >
                    Done
                  </Button>
                </div>
              </div>
            </Modal>

            {/* GROUPED WORKER ROSTER */}
            <div className="space-y-2 sm:space-y-2.5">
              {groupedRosterWorkers.map(([groupKey, groupWorkers]) => {
                const isCollapsed = Boolean(collapsedGroups[groupKey]);
                const groupMarkableWorkers = groupWorkers.filter(
                  (worker) => !isSelfSupervisorWorker(worker)
                );
                const groupPresent = groupMarkableWorkers.filter(
                  (w) => draftAttendance[w.id]?.status === 'present'
                ).length;
                const groupHalf = groupMarkableWorkers.filter(
                  (w) => draftAttendance[w.id]?.status === 'half_day'
                ).length;
                const groupAbsent = groupMarkableWorkers.filter(
                  (w) => draftAttendance[w.id]?.status === 'absent'
                ).length;
                const groupLeave = groupMarkableWorkers.filter(
                  (w) => draftAttendance[w.id]?.status === 'leave'
                ).length;
                const groupUnchecked = groupMarkableWorkers.filter(
                  (w) => !draftAttendance[w.id]?.status
                ).length;
                const hasUnmarkedCrew = groupMarkableWorkers.some(
                  (worker) =>
                    !draftAttendance[worker.id]?.status &&
                    !otherSiteActiveAttendanceByWorker.has(worker.id)
                );

                return (
                  <div
                    key={groupKey}
                    className="rounded-xl bg-white border border-surface-border overflow-hidden"
                  >
                    {/* Stable two-tier header: group total stays aligned; actions never share its title row. */}
                    <div className="border-b border-surface-border/70 bg-white px-3 py-2 sm:px-4">
                      <button
                        type="button"
                        onClick={() => toggleGroupCollapse(groupKey)}
                        aria-expanded={!isCollapsed}
                        className="flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25"
                      >
                        {isCollapsed ? (
                          <ChevronRight className="h-4 w-4 shrink-0 text-ink-secondary" />
                        ) : (
                          <ChevronDown className="h-4 w-4 shrink-0 text-ink-secondary" />
                        )}
                        <span className="min-w-0 flex-1 break-words text-sm font-semibold leading-snug text-navy">
                          {CRAFT_GROUP_META[groupKey].label}
                        </span>
                        <span className="inline-flex h-8 min-w-8 shrink-0 items-center justify-center rounded-full border border-surface-border bg-surface px-2 text-xs font-semibold tabular-nums text-navy">
                          {groupWorkers.length}
                          <span className="sr-only"> workers</span>
                        </span>
                      </button>

                      <div className="mt-1.5 flex flex-col gap-1.5 md:flex-row md:items-center md:justify-between">
                        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-ink-secondary">
                          <span><strong className="tabular-nums text-status-success">{groupPresent}</strong> present</span>
                          <span><strong className="tabular-nums text-status-warning">{groupHalf}</strong> half day</span>
                          <span><strong className="tabular-nums text-status-danger">{groupAbsent}</strong> absent</span>
                          <span><strong className="tabular-nums text-status-info">{groupLeave}</strong> leave</span>
                          {groupUnchecked > 0 && (
                            <span className="font-semibold text-status-warning">
                              {groupUnchecked} unmarked
                            </span>
                          )}
                        </div>

                        {hasUnmarkedCrew && (
                          <button
                            type="button"
                            onClick={() => handleMarkCrewPresent(groupWorkers)}
                            className="inline-flex min-h-11 w-fit max-w-full shrink-0 items-center rounded-lg px-2 text-xs font-semibold text-brand transition-colors hover:bg-brand/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25"
                          >
                            Mark remaining present
                          </button>
                        )}
                      </div>
                    </div>

                    {!isCollapsed && (
                      <div className="divide-y divide-surface-border/60">
                        {groupWorkers.map((worker) => {
                          const currentDraft = draftAttendance[worker.id] || {
                            status: null,
                            notes: '',
                          };
                          const isSelfSup = isSelfSupervisorWorker(worker);
                          const isAnySupRow =
                            Boolean(findSupervisorAccountForWorker(worker)) ||
                            worker.position.toLowerCase().includes('supervisor');
                          const savedRec = existingSiteDateRecords.find(
                            (a) => a.worker_id === worker.id
                          );
                          const otherSiteInfo = otherSiteActiveAttendanceByWorker.get(
                            worker.id
                          );
                          const isVerifiedByFounder = Boolean(savedRec?.is_founder_override);
                          const isPendingFounderApprovalOnRow =
                            isAnySupRow &&
                            Boolean(savedRec) &&
                            !isVerifiedByFounder &&
                            (savedRec?.status === 'present' || savedRec?.status === 'half_day');
                          const showNoteBox =
                            expandedNoteWorkers[worker.id] ?? Boolean(currentDraft.notes && !isSelfSup);

                          return (
                            <div
                              key={worker.id}
                              className={`px-3 py-2 sm:px-4 sm:py-3 text-xs transition-colors ${
                                isSelfSup || isPendingFounderApprovalOnRow
                                  ? 'bg-status-warning-bg/25'
                                  : 'bg-white hover:bg-surface-elevated'
                              }`}
                            >
                              <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between lg:gap-5">
                                {/* Worker identity stays above a full-width status selector on phones. */}
                                <div className="min-w-0 lg:flex-1">
                                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                                    <span className="break-words text-sm font-semibold text-ink-primary">
                                      {worker.name}
                                    </span>
                                    {isAnySupRow && (
                                      <Badge variant="warning" size="sm">
                                        Supervisor
                                      </Badge>
                                    )}
                                    {isFounder && isPendingFounderApprovalOnRow && (
                                      <Badge variant="warning" size="sm">
                                        Pending Founder Approval
                                      </Badge>
                                    )}
                                    {isFounder && isAnySupRow && savedRec && isVerifiedByFounder && (
                                      <Badge variant="success" size="sm">
                                        Founder Approved ✓
                                      </Badge>
                                    )}
                                    {!isSelfSup && !currentDraft.status && (
                                      <Badge variant="neutral" size="sm">
                                        Unmarked
                                      </Badge>
                                    )}
                                  </div>
                                  <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                                    <span className="break-words text-ink-secondary">
                                      {worker.position}
                                    </span>
                                    {otherSiteInfo && (
                                      <Badge variant="info" size="sm">
                                        Already at {otherSiteInfo.projectName} (
                                        {otherSiteInfo.record.status === 'present'
                                          ? 'Present'
                                          : 'Half Day'}
                                        )
                                      </Badge>
                                    )}
                                  </div>
                                </div>

                                {/* A Supervisor's own status remains locked; all other rows get equal-width choices. */}
                                {isSelfSup ? (
                                  <div className="flex w-full min-w-0 items-start gap-2 rounded-lg border border-surface-border bg-white px-3 py-2.5 text-[11px] font-semibold text-navy lg:w-[26rem] lg:shrink-0">
                                    <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-warning" />
                                    <span className="min-w-0 break-words leading-snug">
                                      {otherSiteInfo ? (
                                        `Logged via ${otherSiteInfo.projectName} (${selectedDate})`
                                      ) : savedRec ? (
                                        isVerifiedByFounder ? (
                                          `Founder Approved (${formatStatusLabel(savedRec.status)}) ✓`
                                        ) : (
                                          'Submitted as Present · Pending Founder Approval'
                                        )
                                      ) : (
                                        'Auto-logged when you submit crew roll call.'
                                      )}
                                    </span>
                                  </div>
                                ) : (
                                  <div className="w-full min-w-0 lg:w-[26rem] lg:shrink-0">
                                    <div
                                      role="group"
                                      aria-label={`Attendance status for ${worker.name}`}
                                      className="grid w-full grid-cols-4 gap-1 rounded-lg border border-surface-border bg-surface-inset/70 p-1"
                                    >
                                      {[
                                        {
                                          id: 'present',
                                          label: 'Present',
                                          activeClass: 'bg-status-success text-white font-semibold',
                                        },
                                        {
                                          id: 'half_day',
                                          label: 'Half Day',
                                          activeClass: 'bg-status-warning text-white font-semibold',
                                        },
                                        {
                                          id: 'absent',
                                          label: 'Absent',
                                          activeClass: 'bg-status-danger text-white font-semibold',
                                        },
                                        {
                                          id: 'leave',
                                          label: 'Leave',
                                          activeClass: 'bg-status-info text-white font-semibold',
                                        },
                                      ].map((status) => {
                                        const active = currentDraft.status === status.id;
                                        return (
                                          <button
                                            key={status.id}
                                            type="button"
                                            onClick={() =>
                                              handleStatusChange(
                                                worker,
                                                status.id as AttendanceStatus
                                              )
                                            }
                                            aria-pressed={active}
                                            className={`inline-flex min-h-11 min-w-0 w-full items-center justify-center whitespace-nowrap rounded-md px-1 text-[10px] font-medium leading-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25 sm:min-h-12 sm:px-1.5 sm:text-[11px] ${
                                              active
                                                ? status.activeClass
                                                : 'text-ink-secondary hover:bg-white hover:text-navy'
                                            }`}
                                          >
                                            {status.label}
                                          </button>
                                        );
                                      })}
                                    </div>

                                    <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                                      <button
                                        type="button"
                                        onClick={() => toggleNoteInput(worker.id)}
                                        aria-expanded={showNoteBox}
                                        aria-controls={`attendance-note-${worker.id}`}
                                        className={`inline-flex min-h-11 w-fit max-w-full items-center justify-center gap-2 rounded-lg border px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25 ${
                                          currentDraft.notes
                                            ? 'border-brand/30 bg-brand/5 text-brand'
                                            : 'border-surface-border bg-white text-ink-secondary hover:bg-surface-inset hover:text-navy'
                                        }`}
                                      >
                                        <MessageSquare className="h-3.5 w-3.5 shrink-0" />
                                        <span>
                                          {showNoteBox
                                            ? 'Hide note'
                                            : currentDraft.notes
                                              ? 'Edit note'
                                              : 'Add note'}
                                        </span>
                                      </button>

                                      {isFounder && isPendingFounderApprovalOnRow && savedRec && (
                                        <Button
                                          type="button"
                                          variant="primary"
                                          size="sm"
                                          className="min-h-11 w-fit max-w-full"
                                          onClick={() =>
                                            handleFounderSupervisorReview(savedRec, 'present')
                                          }
                                          leftIcon={<ShieldCheck className="h-3.5 w-3.5" />}
                                        >
                                          Approve ✓
                                        </Button>
                                      )}
                                    </div>

                                    {showNoteBox && (
                                      <div className="mt-2">
                                        <Input
                                          id={`attendance-note-${worker.id}`}
                                          placeholder="Activity note (e.g. 2F slab rebar, went home at noon)..."
                                          value={currentDraft.notes}
                                          onChange={(e) =>
                                            handleNotesChange(worker.id, e.target.value)
                                          }
                                          className="py-2"
                                        />
                                      </div>
                                    )}
                                  </div>
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

              {filteredWorkers.length === 0 && (
                <div className="bg-white rounded-xl border border-surface-border">
                  <EmptyState
                    title="No workers on this site"
                    description={
                      workers.length === 0
                        ? 'Add workers from the Workforce tab. They will appear here grouped by craft.'
                        : 'No worker matches the current filter.'
                    }
                  />
                </div>
              )}
            </div>

            {/* In-Flow Bottom Submit & Sync Card (Moves naturally with collapsed/expanded groups — never overlaps) */}
            <div className="mt-3 px-3 sm:px-4 py-3 rounded-xl bg-white border border-surface-border flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div
                role="status"
                aria-live="polite"
                aria-busy={isSubmitting}
                className="min-w-0 text-xs text-ink-secondary sm:flex-1"
              >
                <div>
                  {attendanceSaveFailed ? (
                    <span className="text-status-warning">
                      Attendance wasn&apos;t submitted. Your selections remain in the draft; retry when ready.
                    </span>
                  ) : uncheckedCount > 0 ? (
                    <span>
                      <strong className="font-semibold tabular-nums text-status-warning">{uncheckedCount}</strong> statuses left to choose
                    </span>
                  ) : existingSiteDateRecords.length > 0 && !hasUnsavedChanges ? (
                    <span className="inline-flex items-center gap-1.5 font-semibold text-status-success">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                      <span>Synced for {selectedDate}</span>
                    </span>
                  ) : (
                    <span>All crew statuses are selected.</span>
                  )}
                </div>
              </div>

              <Button
                type="submit"
                variant={
                  existingSiteDateRecords.length > 0 && !hasUnsavedChanges
                    ? 'secondary'
                    : 'primary'
                }
                size="sm"
                className="min-h-11 w-full sm:w-auto sm:min-h-9 shrink-0"
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
              >
                {uncheckedCount > 0
                  ? `Select ${uncheckedCount} remaining`
                  : attendanceSaveFailed
                    ? existingSiteDateRecords.length > 0
                      ? 'Retry Save'
                      : 'Retry Submit'
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
            {/* Keep search visible on mobile; reveal secondary filters only on request. */}
            <div className="space-y-3 rounded-2xl border border-surface-border bg-white p-3.5 shadow-sm">
              <div className="flex items-center gap-2 lg:hidden">
                <div className="min-w-0 flex-1">
                  <Input
                    aria-label="Search attendance history"
                    placeholder="Search workers, sites, notes..."
                    value={historySearchQuery}
                    onChange={(e) => setHistorySearchQuery(e.target.value)}
                    leftIcon={<Search className="h-4 w-4" />}
                    className="min-w-0"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setIsHistoryFilterSheetOpen(true)}
                  aria-expanded={isHistoryFilterSheetOpen}
                  aria-controls={isHistoryFilterSheetOpen ? 'attendance-history-filters' : undefined}
                  className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-full px-3 text-sm font-semibold text-navy transition-colors hover:bg-surface-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                >
                  <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                  <span>Filters</span>
                  {activeHistoryFilterCount > 0 && (
                    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-bold text-white">
                      {activeHistoryFilterCount}
                    </span>
                  )}
                </button>
              </div>

              {activeHistoryFilterCount > 0 && (
                <div
                  role="group"
                  aria-label="Active history filters"
                  className="flex flex-wrap gap-2 lg:hidden"
                >
                  {historyProjectFilter !== 'all' && (
                    <button
                      type="button"
                      onClick={() => setHistoryProjectFilter('all')}
                      aria-label={`Remove site filter: ${projects.find((project) => project.id === historyProjectFilter)?.name || 'selected site'}`}
                      className="inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full bg-surface-inset px-3 py-1 text-xs font-medium text-navy transition-colors hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                    >
                      <span className="break-words text-left">
                        Site · {projects.find((project) => project.id === historyProjectFilter)?.name || 'Selected'}
                      </span>
                      <X className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    </button>
                  )}
                  {historyStatusFilter !== 'all' && (
                    <button
                      type="button"
                      onClick={() => setHistoryStatusFilter('all')}
                      aria-label={`Remove status filter: ${historyStatusFilter.replace('_', ' ')}`}
                      className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-surface-inset px-3 py-1 text-xs font-medium text-navy transition-colors hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                    >
                      <span>Status · {historyStatusFilter === 'half_day' ? 'Half Day' : historyStatusFilter === 'leave' ? 'Approved Leave' : historyStatusFilter[0].toUpperCase() + historyStatusFilter.slice(1)}</span>
                      <X className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    </button>
                  )}
                  {historyDateFilter && (
                    <button
                      type="button"
                      onClick={() => setHistoryDateFilter('')}
                      aria-label={`Remove date filter: ${formatDatePH(historyDateFilter)}`}
                      className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-surface-inset px-3 py-1 text-xs font-medium text-navy transition-colors hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                    >
                      <span>Date · {formatDatePH(historyDateFilter)}</span>
                      <X className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    </button>
                  )}
                </div>
              )}

              <div className="hidden items-center gap-2 lg:grid lg:grid-cols-[minmax(12rem,2fr)_minmax(12rem,1.6fr)_minmax(8.5rem,1fr)_minmax(9rem,1.1fr)_auto]">
                <Input
                  placeholder="Search worker, craft, site, or notes..."
                  value={historySearchQuery}
                  onChange={(e) => setHistorySearchQuery(e.target.value)}
                  leftIcon={<Search className="h-4 w-4" />}
                  aria-label="Search attendance history"
                />
                <Select
                  aria-label="Filter by project site"
                  value={historyProjectFilter}
                  onChange={(e) => setHistoryProjectFilter(e.target.value)}
                  options={[
                    { label: 'All sites', value: 'all' },
                    ...accessibleProjects.map((project) => ({
                      label: `${project.name} (${project.location.split(',')[0]})`,
                      value: project.id,
                    })),
                  ]}
                />
                <Select
                  aria-label="Filter by attendance status"
                  value={historyStatusFilter}
                  onChange={(e) => setHistoryStatusFilter(e.target.value)}
                  options={[
                    { label: 'All statuses', value: 'all' },
                    { label: 'Present', value: 'present' },
                    { label: 'Half Day', value: 'half_day' },
                    { label: 'Absent', value: 'absent' },
                    { label: 'Approved Leave', value: 'leave' },
                  ]}
                />
                <Input
                  type="date"
                  value={historyDateFilter}
                  max={today}
                  onChange={(e) => setHistoryDateFilter(e.target.value)}
                  className="py-2"
                  aria-label="Filter by attendance date"
                />
                {hasAnyHistoryCriteria && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={clearHistoryFilters}
                  >
                    Reset
                  </Button>
                )}
              </div>
            </div>

            <Modal
              isOpen={isHistoryFilterSheetOpen}
              onClose={() => setIsHistoryFilterSheetOpen(false)}
              title="Attendance filters"
              description="Results update as you change a site, status, or date."
              maxWidth="full"
              presentation="bottom-sheet"
            >
              <div id="attendance-history-filters" className="space-y-4">
                <Select
                  label="Project site"
                  value={historyProjectFilter}
                  onChange={(e) => setHistoryProjectFilter(e.target.value)}
                  options={[
                    { label: 'All sites', value: 'all' },
                    ...accessibleProjects.map((project) => ({
                      label: `${project.name} (${project.location.split(',')[0]})`,
                      value: project.id,
                    })),
                  ]}
                />
                <Select
                  label="Attendance status"
                  value={historyStatusFilter}
                  onChange={(e) => setHistoryStatusFilter(e.target.value)}
                  options={[
                    { label: 'All statuses', value: 'all' },
                    { label: 'Present', value: 'present' },
                    { label: 'Half Day', value: 'half_day' },
                    { label: 'Absent', value: 'absent' },
                    { label: 'Approved Leave', value: 'leave' },
                  ]}
                />
                <Input
                  label="Attendance date"
                  type="date"
                  value={historyDateFilter}
                  max={today}
                  onChange={(e) => setHistoryDateFilter(e.target.value)}
                />
                <div className="flex flex-col-reverse gap-2 border-t border-surface-border/70 pt-3 sm:flex-row sm:justify-between">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={clearHistoryFilters}
                    disabled={!hasAnyHistoryCriteria}
                  >
                    Reset filters
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    onClick={() => setIsHistoryFilterSheetOpen(false)}
                  >
                    Done
                  </Button>
                </div>
              </div>
            </Modal>

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
                          const isSelfLog = isSupervisorAttendanceRecord(rec);
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
                <div className="bg-white rounded-xl border border-surface-border">
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
            {/* The header action reveals this single inline registration workflow. */}
            <section
              id="workforce-worker-form"
              aria-labelledby="workforce-worker-form-title"
              hidden={!isWorkerFormOpen}
              className="rounded-2xl border border-surface-border bg-white p-4 shadow-sm"
            >
              <form onSubmit={handleAddWorkerSubmit} className="space-y-4 text-xs">
                <div>
                  <h3 id="workforce-worker-form-title" className="text-sm font-bold text-navy">
                    Register Site Worker
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
                    New workers appear on Roll Call and Payroll. Supervisor accounts sync from Team Accounts.
                  </p>
                </div>

                <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  <div className="lg:col-span-2">
                    <Input
                      label="Worker Full Name"
                      placeholder="e.g. Danilo Santos"
                      value={workerName}
                      onChange={(e) => setWorkerName(e.target.value)}
                      required
                    />
                  </div>

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
                    label="Daily Rate (₱)"
                    type="number"
                    min="0"
                    step="50"
                    value={workerRate}
                    onChange={(e) => setWorkerRate(e.target.value)}
                    required
                  />

                  <Input
                    label="Contact Number"
                    placeholder="0917XXXXXXX"
                    value={workerPhone}
                    onChange={(e) => setWorkerPhone(e.target.value)}
                  />
                </div>

                <div className="flex justify-end">
                  <Button
                    type="submit"
                    variant="primary"
                    size="md"
                    isLoading={isAddingWorker}
                    leftIcon={<UserPlus className="h-4 w-4" />}
                    className="w-full sm:w-auto"
                  >
                    Add Worker to Roster
                  </Button>
                </div>
              </form>
            </section>

            {/* Filter Bar for Workforce Directory */}
            <div className="p-3 rounded-2xl bg-white border border-surface-border shadow-sm flex flex-col sm:flex-row items-center justify-between gap-2.5">
              <div className="flex flex-col sm:flex-row items-center gap-2 w-full sm:w-auto">
                <div className="w-full sm:w-64">
                  <Input
                    aria-label="Search workforce"
                    placeholder="Search worker name or craft..."
                    value={workforceSearch}
                    onChange={(e) => setWorkforceSearch(e.target.value)}
                    leftIcon={<Search className="w-4 h-4" />}
                  />
                </div>
                <div className="w-full sm:w-52">
                  <Select
                    aria-label="Filter workforce by craft group"
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
                <div className="bg-white rounded-xl border border-surface-border">
                  <EmptyState
                    title="No workers match"
                    description="Choose Add Worker above to register a craftsman, or clear your search filter."
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
