'use client';

import React, { Suspense, useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { AppShell } from '@/components/layout/AppShell';
import { useDataStore } from '@/lib/data/store';
import { useAuth } from '@/lib/auth/authContext';
import { useQuickAction } from '@/lib/mobile/quickActions';
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
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { formatDatePH } from '@/lib/email/format';
import { manilaDateISO, shiftCalendarDate } from '@/lib/dates/manila';
import { useManilaToday } from '@/lib/dates/useManilaToday';
import {
  parseCompleteAttendanceDraft,
  serializeAttendanceDraft,
  type AttendanceDraftEntry,
  type AttendanceDraftMap,
} from '@/lib/attendance/drafts';
import { useToast } from '@/components/ui/Toast';
import { usePendingApprovals } from '@/lib/attendance/usePendingApprovals';
import { useAttendanceHistory } from '@/lib/attendance/useAttendanceHistory';
import { useProjectRollCall } from '@/lib/attendance/useProjectRollCall';
import { loadProjectRollCall, projectRollCallFingerprint, type ProjectRollCallSnapshot } from '@/lib/attendance/project-roll-call';
import { useProjectTeam } from '@/lib/attendance/useProjectTeam';
import { RollCallWalkthrough } from '@/components/dashboard/RollCallWalkthrough';
import type { HistoryRecord, HistorySheet } from '@/lib/attendance/history';
import { HistorySheetRecords } from '@/components/attendance/HistorySheetRecords';
import { AttendanceHistoryCalendar } from '@/components/attendance/AttendanceHistoryCalendar';
import { SupervisorFoundationPanels } from '@/components/attendance/SupervisorFoundationPanels';
import { WorkerCategoryFoundation } from '@/components/workforce/WorkerCategoryFoundation';
import { WorkerCategorySelect } from '@/components/workforce/WorkerCategorySelect';
import { CATEGORY_CHANGED, useActiveCategories } from '@/lib/workforce/useActiveCategories';
import { categoryWorkforceEnabled } from '@/lib/workforce/categoryCatalog';
import { AssignmentHistory } from '@/components/workforce/AssignmentHistory';
import { assignmentHistoryPreviewEnabled } from '@/lib/workforce/assignmentHistory';
import { weeklyWorkerCutoverMode } from '@/lib/finance/featureAvailability';

const EMPTY_ROLL_CALL: ProjectRollCallSnapshot = { workerIds: [], records: [] };

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

// Integrated categories are distinct groups, including archived categories still on workers.
// Prefix prevents a category literally named "all" from colliding with the reset filter.
function workerCraftGroup(position: string): string {
  return categoryWorkforceEnabled() ? `category:${position.trim() || 'Unspecified'}` : getCraftGroup(position);
}
function craftGroupLabel(key: string): string {
  return key.startsWith('category:') ? key.slice('category:'.length) : CRAFT_GROUP_META[key as CraftGroupKey].label;
}
function craftGroupOrder(a: string, b: string): number {
  if (categoryWorkforceEnabled()) return craftGroupLabel(a).localeCompare(craftGroupLabel(b));
  return CRAFT_GROUP_META[a as CraftGroupKey].order - CRAFT_GROUP_META[b as CraftGroupKey].order;
}
function craftOptions(positions: string[]) {
  if (!categoryWorkforceEnabled()) return CRAFT_FILTER_OPTIONS;
  return [{ label: 'All Craft Groups', value: 'all' }, ...Array.from(new Set(positions.map(workerCraftGroup))).sort(craftGroupOrder).map(value => ({label: craftGroupLabel(value), value}))];
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
  const { user, isFounder, isSupervisor, assurance, isLoading: authLoading } = useAuth();
  const searchParams = useSearchParams();
  const { showToast } = useToast();
  const pendingApprovals = usePendingApprovals(isFounder, user?.id);
  const categories = useActiveCategories(user?.id, assurance);
  const {
    users,
    workers,
    projects,
    projectSupervisors,
    attendance,
    isLoaded,
    loadError,
    refresh,
    createWorker,
    updateWorker,
    toggleWorkerStatus,
    recordAttendanceBatch,
    updateAttendanceRecord,
    getProjectsForSupervisor,
  } = useDataStore();

  useEffect(() => { if (!categories.enabled) return; const changed = () => { void refresh(); }; window.addEventListener(CATEGORY_CHANGED, changed); return () => window.removeEventListener(CATEGORY_CHANGED, changed); }, [categories.enabled, refresh]);

  // Accessible projects for user
  const accessibleProjects =
    isSupervisor && user ? getProjectsForSupervisor(user.id) : projects;

  // Terminal workflow state
  const today = useManilaToday();
  const yesterday = shiftCalendarDate(today, -1);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    accessibleProjects[0]?.id || ''
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
  useQuickAction('/attendance', ['worker'], (isFounder || isSupervisor) && assurance === 'ready' && !authLoading && isLoaded, () => {
    setActiveTab('workforce');
    setIsWorkerFormOpen(true);
    window.history.replaceState(null, '', '/attendance?tab=workforce');
    window.dispatchEvent(new CustomEvent('bale:attendance-tab', { detail: 'workforce' }));
    window.setTimeout(() => document.getElementById('workforce-worker-form')?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }), 100);
  });
  const [workerName, setWorkerName] = useState('');
  const [workerPosition, setWorkerPosition] = useState('Mason');
  const [workerRate, setWorkerRate] = useState('850');
  const [workerPhone, setWorkerPhone] = useState('');
  const [isAddingWorker, setIsAddingWorker] = useState(false);
  const [workforceSearch, setWorkforceSearch] = useState('');
  const [workforceCraftFilter, setWorkforceCraftFilter] = useState<string>('all');
  const [workforceStatusFilter, setWorkforceStatusFilter] = useState('active');
  const [selectedWorkers, setSelectedWorkers] = useState<string[]>([]);
  const [workerRemovalOpen, setWorkerRemovalOpen] = useState(false);
  const [workerRestoreTarget, setWorkerRestoreTarget] = useState<Worker | null>(null);
  const [workerRemovalPending, setWorkerRemovalPending] = useState(false);
  const [workerRemovalResults, setWorkerRemovalResults] = useState<Array<{ id: string; name: string; status: string }>>([]);
  const workerRemovalLock = useRef(false);

  const [editingWorker, setEditingWorker] = useState<Worker | null>(null);
  const [editWorkerName, setEditWorkerName] = useState('');
  const [editWorkerPosition, setEditWorkerPosition] = useState('');
  const [editWorkerRate, setEditWorkerRate] = useState('');
  const [editWorkerRateType, setEditWorkerRateType] = useState<'daily' | 'hourly'>('daily');
  const [editWorkerPhone, setEditWorkerPhone] = useState('');
  const [isSavingWorker, setIsSavingWorker] = useState(false);

  // Terminal drafts stay local until the explicit Submit action writes official attendance.
  // Keep entries and their dirty markers in one state update so a queued
  // baseline refresh cannot erase a selection made at the same time.
  const [draftState, setDraftState] = useState<{ entries: AttendanceDraftMap; dirtyIds: string[] }>({ entries: {}, dirtyIds: [] });
  const draftAttendance = draftState.entries;
  const dirtyDraftWorkerIds = draftState.dirtyIds;
  const [draftStorageReadyKey, setDraftStorageReadyKey] = useState<string | null>(null);
  const [draftReadySnapshot, setDraftReadySnapshot] = useState<ProjectRollCallSnapshot | null>(null);
  const [draftStorageStatus, setDraftStorageStatus] = useState<'ready' | 'saved' | 'error'>('ready');
  const initializedDraftContextRef = useRef<string | null>(null);

  const attendanceDraftStorageKey =
    user?.id && selectedProjectId && selectedDate
      ? `asinta-attendance-draft:v1:${encodeURIComponent(user.id)}:${encodeURIComponent(selectedProjectId)}:${selectedDate}`
      : null;

  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitLock = useRef(false);
  const [attendanceSaveFailed, setAttendanceSaveFailed] = useState(false);
  const [unreadableDraft, setUnreadableDraft] = useState(false);
  const [discardHiddenDraftOpen, setDiscardHiddenDraftOpen] = useState(false);
  const [isReviewingSupervisor, setIsReviewingSupervisor] = useState(false);
  const reviewInFlightRef = useRef(false);
  const [searchWorker, setSearchWorker] = useState('');
  // Snapshot keeps a just-marked worker visible and focused until the user refreshes.
  const [unmarkedWorkerIds, setUnmarkedWorkerIds] = useState<string[] | null>(null);

  useEffect(() => {
    setUnmarkedWorkerIds(null);
  }, [selectedProjectId, selectedDate]);

  // History tab filters & collapsible daily sheets
  const [historyProjectFilter, setHistoryProjectFilter] = useState<string>('all');
  const [historyStatusFilter, setHistoryStatusFilter] = useState<string>('all');
  const [historyDateFilter, setHistoryDateFilter] = useState<string>('');
  const [historySearchQuery, setHistorySearchQuery] = useState<string>('');
  const [isHistoryFilterSheetOpen, setIsHistoryFilterSheetOpen] = useState(false);
  const [expandedHistorySheets, setExpandedHistorySheets] = useState<Record<string, boolean>>({});
  const [historyRevision, setHistoryRevision] = useState(0);
  const [debouncedHistorySearch, setDebouncedHistorySearch] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedHistorySearch(historySearchQuery), 300);
    return () => window.clearTimeout(timer);
  }, [historySearchQuery]);
  const historyFilters = {projectId:historyProjectFilter, status:historyStatusFilter, date:historyDateFilter, search:debouncedHistorySearch};
  const isHistorySearchSettling = historySearchQuery !== debouncedHistorySearch;
  const history = useAttendanceHistory<HistorySheet>('sheets', activeTab === 'history' && !isHistorySearchSettling, user?.id, historyFilters, historyRevision);

  useEffect(() => {
    setExpandedHistorySheets({});
  }, [historyProjectFilter, historyStatusFilter, historyDateFilter, historySearchQuery]);

  // Founder Override modal
  const [overrideModalOpen, setOverrideModalOpen] = useState(false);
  const [selectedRecordForOverride, setSelectedRecordForOverride] = useState<Attendance | null>(null);
  const [overrideStatus, setOverrideStatus] = useState<AttendanceStatus>('present');
  const [overrideNotes, setOverrideNotes] = useState('');

  // A worker is linked to an account by ID, never by name. Names are only
  // used below to flag a possible collision for review, not to infer identity.
  const isSelfSupervisorWorker = useCallback(
    (w: Worker): boolean => Boolean(isSupervisor && user && w.id === user.id),
    [isSupervisor, user]
  );

  const findSupervisorAccountForWorker = useCallback(
    (w: Worker) => {
      if (isSupervisor && user && w.id === user.id) return user;
      return users.find((u) => u.role === 'supervisor' && u.id === w.id);
    },
    [isSupervisor, user, users]
  );

  // During the coordinated cutover, linked Supervisors use one company-wide
  // daily record. Existing site rows stay visible as history, not new pay input.
  const generalSupervisorCutover = weeklyWorkerCutoverMode();
  const isLockedRollCallWorker = useCallback((w: Worker): boolean =>
    isSelfSupervisorWorker(w) || (generalSupervisorCutover && (
      Boolean(findSupervisorAccountForWorker(w)) || projectSupervisors.some((ps) => ps.supervisor_id === w.id)
    )), [isSelfSupervisorWorker, generalSupervisorCutover, findSupervisorAccountForWorker, projectSupervisors]);

  // Pause this UI's submission when an active workforce profile has the same
  // name as a supervisor but a different ID. This is a review signal, not
  // proof of identity, and does not merge or change any historical records.
  const possibleSupervisorDuplicates = useMemo(() => {
    const accounts = [...users.filter((u) => u.role === 'supervisor'), ...(isSupervisor && user ? [user] : [])]
      .filter((account, index, all) => all.findIndex((item) => item.id === account.id) === index);
    return accounts.filter((account) => {
      const assignments = projectSupervisors.filter((ps) => ps.supervisor_id === account.id);
      if (assignments.length > 0 && !assignments.some((ps) => ps.project_id === selectedProjectId)) return false;
      const name = account.name.trim().toLowerCase();
      return Boolean(name) && workers.some((w) => w.active && w.id !== account.id && w.name.trim().toLowerCase() === name);
    });
  }, [users, workers, projectSupervisors, selectedProjectId, isSupervisor, user]);
  const missingSupervisorWorker = Boolean(isSupervisor && user && isLoaded && !workers.some((w) => w.id === user.id && w.active));
  const supervisorIdentityNeedsReview = possibleSupervisorDuplicates.length > 0;

  // Update selectedProjectId when accessible projects change
  useEffect(() => {
    if (!accessibleProjects.some((p) => p.id === selectedProjectId)) {
      const nextProjectId = accessibleProjects[0]?.id || '';
      if (nextProjectId !== selectedProjectId) setSelectedProjectId(nextProjectId);
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

  const rollCall = useProjectRollCall(user?.id, selectedProjectId, selectedDate, activeTab === 'terminal' && isLoaded && !loadError);
  const workforceTeam = useProjectTeam(user?.id, selectedProjectId, isSupervisor && activeTab === 'workforce' && isLoaded && !loadError);
  const rosterReady = rollCall.status === 'ready' && Boolean(rollCall.snapshot) && isLoaded && !loadError;
  const rollCallSnapshot = rosterReady ? rollCall.snapshot! : EMPTY_ROLL_CALL;
  const draftReady = rosterReady && draftStorageReadyKey === attendanceDraftStorageKey && draftReadySnapshot === rollCallSnapshot;
  const existingSiteDateRecords = rollCallSnapshot.records;
  const unavailableAssignedIds = useMemo(() => rollCallSnapshot.workerIds.filter(
    (id) => !workers.some((worker) => worker.id === id && worker.active)
  ), [rollCallSnapshot, workers]);

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

  // Active assigned crew plus active workers with saved attendance for this
  // site/date. An assigned Supervisor is included when there is a team to
  // submit; an empty team alone must not create self-attendance.
  const siteRosterWorkers = useMemo(() => {
    const assigned = new Set(rollCallSnapshot.workerIds);
    const recorded = new Set(existingSiteDateRecords.map((record) => record.worker_id));
    const supervisors = new Set(projectSupervisors.filter((ps) => ps.project_id === selectedProjectId).map((ps) => ps.supervisor_id));
    const hasTeam = rollCallSnapshot.workerIds.length > 0;
    return workers.filter((worker) => worker.active && (
      assigned.has(worker.id) || recorded.has(worker.id) || (hasTeam && supervisors.has(worker.id))
    ));
  }, [workers, rollCallSnapshot, existingSiteDateRecords, projectSupervisors, selectedProjectId]);
  const unavailableSavedRecords = useMemo(() => existingSiteDateRecords.filter(
    (record) => !workers.some((worker) => worker.id === record.worker_id && worker.active)
  ), [existingSiteDateRecords, workers]);
  const hiddenDraftIds = useMemo(() => {
    const visible = new Set(siteRosterWorkers.filter((worker) => !generalSupervisorCutover || !isLockedRollCallWorker(worker)).map((worker) => worker.id));
    return dirtyDraftWorkerIds.filter((id) => !visible.has(id));
  }, [dirtyDraftWorkerIds, siteRosterWorkers, generalSupervisorCutover, isLockedRollCallWorker]);

  const getBaselineDraftEntry = useCallback(
    (workerId: string): AttendanceDraftEntry => {
      const saved = existingSiteDateRecords.find((record) => record.worker_id === workerId);
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
    [existingSiteDateRecords, otherSiteActiveAttendanceByWorker]
  );

  // Hydrate once per user/site/date. On later data refreshes, update untouched rows
  // from the server but never replace a worker's in-progress local selection.
  useEffect(() => {
    if (!rosterReady || !attendanceDraftStorageKey) return;

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
          const parsed = parseCompleteAttendanceDraft(raw);
          if (parsed) {
            restoredEntries = Object.fromEntries(
              Object.entries(parsed).filter(([workerId, entry]) => {
                const savedBaseline = baseline[workerId];
                return !savedBaseline || entry.status !== savedBaseline.status || entry.notes.trim() !== savedBaseline.notes.trim();
              })
            );
          } else {
            storageReadFailed = true;
          }
        }
      } catch {
        storageReadFailed = true;
      }

      setUnreadableDraft(storageReadFailed);
      setDraftState({ entries: { ...baseline, ...restoredEntries }, dirtyIds: Object.keys(restoredEntries) });
      setDraftStorageReadyKey(attendanceDraftStorageKey);
      setDraftReadySnapshot(rollCallSnapshot);
      setDraftStorageStatus(
        storageReadFailed ? 'error' : Object.keys(restoredEntries).length > 0 ? 'saved' : 'ready'
      );
      setAttendanceSaveFailed(false);
      initializedDraftContextRef.current = attendanceDraftStorageKey;
      return;
    }

    setDraftState((current) => {
      const next = { ...baseline };
      current.dirtyIds.forEach((workerId) => {
        if (current.entries[workerId]) next[workerId] = current.entries[workerId];
      });
      return { ...current, entries: next };
    });
    setDraftReadySnapshot(rollCallSnapshot);
  }, [
    rosterReady,
    rollCallSnapshot,
    attendanceDraftStorageKey,
    siteRosterWorkers,
    getBaselineDraftEntry,
    workers,
  ]);

  // Persist only locally changed rows; official attendance still requires Submit.
  useEffect(() => {
    if (
      unreadableDraft ||
      !draftReady ||
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
    unreadableDraft,
    draftReady,
    attendanceDraftStorageKey,
    draftStorageReadyKey,
    dirtyDraftWorkerIds,
    draftAttendance,
  ]);

  const applyDraftChanges = (changes: AttendanceDraftMap) => {
    const changedEntries = Object.entries(changes);
    if (changedEntries.length === 0) return;

    setAttendanceSaveFailed(false);
    setDraftState((current) => {
      const next = new Set(current.dirtyIds);
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
      return { entries: { ...current.entries, ...changes }, dirtyIds: Array.from(next) };
    });
  };

  const handleStatusChange = (worker: Worker, status: AttendanceStatus) => {
    // Supervisor cannot manually toggle their own row (auto-logged on crew submit)
    if (isSubmitting || isLockedRollCallWorker(worker)) {
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
    if (isSubmitting) return;
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
    if (isSubmitting) return;
    const changes: AttendanceDraftMap = {};
    targetWorkers.forEach((worker) => {
      if (isLockedRollCallWorker(worker)) return;
      const current = draftAttendance[worker.id] || getBaselineDraftEntry(worker.id);
      if (current.status) return;
      if (otherSiteActiveAttendanceByWorker.has(worker.id)) return;
      changes[worker.id] = { ...current, status: 'present' };
    });
    applyDraftChanges(changes);
  };

  // Workers that the current user must mark before submitting:
  // - For a Supervisor: all `siteRosterWorkers` EXCEPT their own locked row (`!isSelfSupervisorWorker(w)`)
  // - For a Founder: all `siteRosterWorkers`
  const markableWorkers = useMemo(
    () => siteRosterWorkers.filter((w) => !isLockedRollCallWorker(w)),
    [siteRosterWorkers, isLockedRollCallWorker]
  );

  const checkedCount = markableWorkers.filter(
    (w) => draftAttendance[w.id]?.status !== null && draftAttendance[w.id]?.status !== undefined
  ).length;
  const uncheckedCount = markableWorkers.length - checkedCount;

  const handleBatchSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitLock.current || isSubmitting || !selectedProjectId || !user) return;
    if (supervisorIdentityNeedsReview) {
      showToast('error', 'Supervisor workforce details need review before submitting Roll Call.');
      return;
    }
    if (!draftReady || unreadableDraft || hiddenDraftIds.length > 0 || unavailableAssignedIds.length > 0) {
      showToast('error', 'Review the project team and draft before submitting Roll Call.');
      return;
    }
    if (selectedDate > manilaDateISO()) {
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

    submitLock.current = true;
    setIsSubmitting(true);
    setAttendanceSaveFailed(false);
    // Recheck before writing. This reduces stale submissions, but is not a
    // database lock: data may still change after this read.
    try {
      const fresh = await loadProjectRollCall(selectedProjectId, selectedDate);
      if (projectRollCallFingerprint(fresh) !== projectRollCallFingerprint(rollCallSnapshot)) {
        showToast('error', 'The project team or saved attendance changed. Review the refreshed list before submitting.');
        await rollCall.reload();
        submitLock.current = false;
        setIsSubmitting(false);
        return;
      }
    } catch {
      showToast('error', 'Could not recheck the project team and saved attendance. Try again after refreshing.');
      submitLock.current = false;
      setIsSubmitting(false);
      return;
    }

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
      if (existingRec && existingRec.status === d.status && (existingRec.notes || '').trim() === d.notes.trim()) return;
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
    if (isSupervisor && !generalSupervisorCutover) {
      const selfWorker = siteRosterWorkers.find((w) => isSelfSupervisorWorker(w));
      if (selfWorker) {
        const existingSelfOnSite = existingSiteDateRecords.find(
          (a) => a.worker_id === selfWorker.id
        );
        const otherSiteSelf = otherSiteActiveAttendanceByWorker.get(selfWorker.id);

        if (!existingSelfOnSite && !otherSiteSelf && rollCallSnapshot.workerIds.length > 0) {
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

    // Historical rows remain visible, but a moved worker's old site record
    // must not be submitted by a Supervisor as if still assigned here. This is
    // a UX check only; the database guard is separately required for security.
    if (isSupervisor) {
      const assigned = new Set(rollCallSnapshot.workerIds);
      if (batch.some((row) => row.worker_id !== user.id && !assigned.has(row.worker_id))) {
        submitLock.current = false;
        setIsSubmitting(false);
        showToast('error', 'An edited worker is no longer assigned to this site. Your draft is kept; ask the Founder to review the saved history.');
        return;
      }
    }

    if (batch.length === 0) {
      submitLock.current = false;
      setIsSubmitting(false);
      showToast('info', 'There are no changes to submit.');
      return;
    }
    let success = false;
    try {
      success = await recordAttendanceBatch(batch);
    } catch {
      success = false;
    } finally {
      submitLock.current = false;
      setIsSubmitting(false);
    }
    if (success) {
      setAttendanceSaveFailed(false);
      setDraftState((current) => ({ ...current, dirtyIds: [] }));
      setDraftStorageStatus('ready');
      if (attendanceDraftStorageKey) {
        try {
          window.localStorage.removeItem(attendanceDraftStorageKey);
        } catch {
          setDraftStorageStatus('error');
        }
      }
      showToast('success', generalSupervisorCutover ? 'Crew attendance saved. Supervisor attendance is recorded separately.' : 'Attendance saved. Supervisor self-attendance may still require Founder review before payroll.');
      if (isFounder) void pendingApprovals.refresh();
      void rollCall.reload();
      setHistoryRevision((n) => n + 1);
    } else {
      setAttendanceSaveFailed(true);
    }
  };

  // 1-Click Founder Review of Supervisor Attendance: Full Day, Half Day, or Absent
  const handleFounderSupervisorReview = async (
    rec: Attendance,
    decision: 'present' | 'half_day' | 'absent'
  ) => {
    if (generalSupervisorCutover && (users.some(u => u.id === rec.worker_id && u.role === 'supervisor') || projectSupervisors.some(ps => ps.supervisor_id === rec.worker_id))) { showToast('error', 'Legacy site-based Supervisor attendance is read-only; use general daily attendance.'); return; }
    if (reviewInFlightRef.current) return;
    reviewInFlightRef.current = true;
    setIsReviewingSupervisor(true);
    try {
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
        showToast('success', `Supervisor attendance ${label.toLowerCase()} and saved.`);
        setHistoryRevision((n) => n + 1);
      }
      await pendingApprovals.refresh();
    } finally {
      reviewInFlightRef.current = false;
      setIsReviewingSupervisor(false);
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
      setHistoryRevision((n) => n + 1);
      void pendingApprovals.refresh();
    }
  };

  const handleAddWorkerSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workerName.trim() || isAddingWorker || (categories.enabled && !categories.items?.some(c=>c.label===workerPosition))) return;
    setIsAddingWorker(true);
    const created = await createWorker({
      name: workerName.trim(),
      position: categories.enabled ? workerPosition : workerPosition.trim() || 'Mason',
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
        `Registered ${created.name} (${created.position}). Add them to a project separately before Roll Call.`
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
    if (!editingWorker || isSavingWorker || (categories.enabled && editWorkerPosition!==editingWorker.position && !categories.items?.some(c=>c.label===editWorkerPosition))) return;
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

  const collectUnmarkedWorkerIds = () => siteRosterWorkers
    .filter((worker) => !isLockedRollCallWorker(worker))
    .filter((worker) => !(draftAttendance[worker.id] || getBaselineDraftEntry(worker.id)).status)
    .map((worker) => worker.id);

  const rosterCraftOptions = useMemo(() => craftOptions(siteRosterWorkers.map(w => w.position)), [siteRosterWorkers]);
  useEffect(() => { if (!rosterCraftOptions.some(option => option.value === craftFilter)) setCraftFilter('all'); }, [rosterCraftOptions, craftFilter]);

  // Filtered workers on the Daily Roster (Supervisors placed at the top)
  const filteredWorkers = useMemo(() => {
    const unmarkedIds = unmarkedWorkerIds ? new Set(unmarkedWorkerIds) : null;
    return siteRosterWorkers
      .filter((w) => {
        if (unmarkedIds && !unmarkedIds.has(w.id)) return false;
        if (craftFilter !== 'all' && workerCraftGroup(w.position) !== craftFilter) {
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
  }, [siteRosterWorkers, craftFilter, searchWorker, unmarkedWorkerIds]);

  // Group filteredWorkers by CraftGroupKey for compact collapsible display
  const groupedRosterWorkers = useMemo(() => {
    const map = new Map<string, Worker[]>();
    filteredWorkers.forEach((w) => {
      const key = workerCraftGroup(w.position);
      const list = map.get(key) || [];
      list.push(w);
      map.set(key, list);
    });
    return Array.from(map.entries()).sort(
      (a, b) => craftGroupOrder(a[0], b[0])
    );
  }, [filteredWorkers]);

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

  // Supervisors see only the current project's team in the workforce view.
  // Never present a failed or pending scoped read as an empty directory.
  const workforceScopedWorkers = useMemo(() => {
    if (!isSupervisor) return workers;
    if (workforceTeam.status !== 'ready') return [];
    const assigned = new Set(workforceTeam.ids);
    return workers.filter((worker) => assigned.has(worker.id) && worker.id !== user?.id);
  }, [workers, isSupervisor, workforceTeam.status, workforceTeam.ids, user?.id]);

  const workforceCraftOptions = useMemo(() => craftOptions(workforceScopedWorkers.map(w => w.position)), [workforceScopedWorkers]);
  useEffect(() => { if (!workforceCraftOptions.some(option => option.value === workforceCraftFilter)) setWorkforceCraftFilter('all'); }, [workforceCraftOptions, workforceCraftFilter]);

  const missingWorkforceProfiles = isSupervisor && workforceTeam.status === 'ready'
    ? workforceTeam.ids.filter((id) => id !== user?.id && !workers.some((worker) => worker.id === id)).length
    : 0;

  // Group Workforce tab workers by craft group
  const groupedWorkforceDirectory = useMemo(() => {
    const filtered = workforceScopedWorkers.filter((w) => {
      if (workforceStatusFilter === 'removed' ? !w.removed_at : Boolean(w.removed_at)) return false;
      if (workforceStatusFilter === 'active' && !w.active) return false;
      if (workforceStatusFilter === 'inactive' && w.active) return false;
      if (workforceCraftFilter !== 'all' && workerCraftGroup(w.position) !== workforceCraftFilter) {
        return false;
      }
      if (!workforceSearch.trim()) return true;
      const q = workforceSearch.toLowerCase();
      return w.name.toLowerCase().includes(q) || w.position.toLowerCase().includes(q);
    });

    const map = new Map<string, Worker[]>();
    filtered.forEach((w) => {
      const key = workerCraftGroup(w.position);
      const list = map.get(key) || [];
      list.push(w);
      map.set(key, list);
    });
    return Array.from(map.entries()).sort(
      (a, b) => craftGroupOrder(a[0], b[0])
    );
  }, [workforceScopedWorkers, workforceCraftFilter, workforceSearch, workforceStatusFilter]);

  const selectedWorkerDetails = workers.filter((worker) => selectedWorkers.includes(worker.id));
  const visibleWorkerIds = groupedWorkforceDirectory.flatMap(([, group]) => group.filter((worker) => !worker.removed_at).map((worker) => worker.id));
  const changeWorkersRemoved = async (action: 'remove' | 'restore', target: Worker[]) => {
    if (workerRemovalLock.current || !isFounder || target.length === 0 || target.length > 100) return;
    workerRemovalLock.current = true;
    setWorkerRemovalPending(true);
    const ids = target.map((worker) => worker.id);
    const names = new Map(target.map((worker) => [worker.id, worker.name]));
    const statuses = action === 'remove' ? ['removed', 'already_removed', 'missing'] : ['restored', 'already_available', 'missing'];
    try {
      const response = await fetch('/api/workers/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, action }) });
      const data = await response.json();
      if (!response.ok || !data.ok || !Array.isArray(data.results) || data.results.length !== ids.length ||
        new Set(data.results.map((item: { id: string }) => item.id)).size !== ids.length ||
        data.results.some((item: { id: string; status: string }) => !names.has(item.id) || !statuses.includes(item.status))) {
        throw new Error('Change was not confirmed.');
      }
      setWorkerRemovalResults(data.results.map((item: { id: string; status: string }) => ({ id: item.id, name: names.get(item.id) || 'Worker', status: item.status })));
      if (action === 'remove') setSelectedWorkers([]);
      setWorkerRemovalOpen(false); setWorkerRestoreTarget(null);
      try { await refresh(); } catch { showToast('error', 'The change was confirmed, but the roster could not refresh. Refresh before making more changes.'); }
    } catch {
      setSelectedWorkers([]); setWorkerRemovalOpen(false); setWorkerRestoreTarget(null); setWorkerRemovalResults([]);
      showToast('error', 'Change was not confirmed. Refresh the roster and check before trying again.');
      try { await refresh(); } catch { /* Check the roster before retrying. */ }
    } finally {
      workerRemovalLock.current = false;
      setWorkerRemovalPending(false);
    }
  };

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
      {activeTab === 'terminal' && <RollCallWalkthrough isSupervisor={isSupervisor} />}
      <div key={activeTab} className="animate-panel-enter w-full space-y-4">
        {/* Clean Dedicated Page Header for each separated view */}
        <div data-page-guide="intro" className="animate-mobile-lift blueprint-accent relative flex flex-col gap-4 overflow-hidden rounded-2xl border border-[#e3ddd2] bg-[#f8f6f0] px-4 py-5 shadow-sm sm:flex-row sm:items-end sm:justify-between sm:px-6 sm:py-6">
          <div className="min-w-0">
            <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-brand">Workforce &amp; attendance</p>
            <div className="flex items-center gap-2.5">
              <h1 className="text-2xl sm:text-3xl font-semibold text-navy tracking-tight break-words">
                {activeTab === 'history'
                  ? 'Attendance History'
                  : activeTab === 'workforce'
                    ? 'Workforce Roster'
                    : 'Daily Roll Call'}
              </h1>
            </div>
            <p className="text-xs text-ink-secondary mt-0.5 leading-relaxed">
              {activeTab === 'history'
                ? 'Submitted daily attendance logs & approval status'
                : activeTab === 'workforce'
                  ? isSupervisor ? 'Workers assigned to the selected project' : `${workers.filter((w) => w.active).length} active craftsmen & supervisors`
                  : 'Mark crew on site'}
            </p>
          </div>

          {activeTab !== 'workforce' && (
            <Link href="/attendance?tab=workforce" prefetch={false} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg border border-surface-border bg-white px-3 text-xs font-medium text-navy hover:bg-surface-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2">
              <UserPlus className="h-4 w-4" aria-hidden="true" />
              Workforce &amp; Add Worker
            </Link>
          )}

          {activeTab === 'workforce' && (
            <div className="flex flex-wrap gap-2">
              <Link href="/attendance" prefetch={false} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-surface-border bg-white px-3 text-xs font-medium text-navy hover:bg-surface-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2">
                Back to Daily Roll Call
              </Link>
              {isSupervisor && (
                <Link href="/advances?tab=requests" prefetch={false} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-surface-border bg-white px-3 text-xs font-medium text-navy hover:bg-surface-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2">
                  <HandCoins className="h-4 w-4" aria-hidden="true" />
                  Bale Requests
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

        {activeTab === 'terminal' && assurance === 'ready' && !authLoading && (isFounder || isSupervisor) && <SupervisorFoundationPanels />}

        {/* Founder Review Banner: Supervisor Attendance Submitted with Crew Report */}
        {isFounder && (pendingApprovals.loading || pendingApprovals.error || (pendingApprovals.total ?? 0) > 0) && (
          <div className="p-3.5 rounded-xl bg-status-warning-bg/60 border border-status-warning/25 space-y-3 text-xs">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-start sm:items-center gap-2.5">
                <ShieldAlert className="w-5 h-5 text-status-warning shrink-0 mt-0.5 sm:mt-0" />
                <div>
                  <div className="font-bold text-navy text-sm">
                    Supervisor approvals {pendingApprovals.total !== null ? `(${pendingApprovals.total} pending)` : ''}
                  </div>
                  <div className="text-ink-secondary">
                    Review these supervisor logs before payroll. This queue reflects the last check; refresh for changes made elsewhere.
                  </div>
                </div>
              </div>
            </div>

            {pendingApprovals.loading && <p role="status" className="text-ink-secondary">Loading pending approvals…</p>}
            {pendingApprovals.error && <p role="alert" className="text-status-danger">Could not load the approval queue. Retry before assuming there are no pending approvals.</p>}
            {pendingApprovals.items.length > 0 && <div className="divide-y divide-surface-border/60 bg-white rounded-xl border border-surface-border overflow-hidden">
              {pendingApprovals.items.map((rec) => {
                const legacyLocked = generalSupervisorCutover && (users.some(u => u.id === rec.worker_id && u.role === 'supervisor') || projectSupervisors.some(ps => ps.supervisor_id === rec.worker_id));
                return (
                  <div
                    key={rec.id}
                    className="p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                  >
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-navy">{rec.worker_name || 'Supervisor'}</span>
                        <Badge variant="warning" size="sm">
                          Site Supervisor
                        </Badge>
                        <span className="text-ink-secondary">
                          · Attendance at <strong className="text-navy">{rec.project_name || 'Project Site'}</strong> on <strong>{rec.date}</strong>
                        </span>
                      </div>
                      {legacyLocked && <p className="font-semibold text-status-warning">Historical site record is read-only; review general daily attendance and reconcile this history separately.</p>}
                      {rec.notes && (
                        <div className="whitespace-pre-wrap break-words text-[11px] text-ink-muted">{rec.notes}</div>
                      )}
                    </div>

                    <div className="flex items-center flex-wrap gap-1.5 shrink-0">
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        className="min-h-11 sm:min-h-9"
                        disabled={legacyLocked || isReviewingSupervisor || pendingApprovals.loading || Boolean(pendingApprovals.error)}
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
                        disabled={legacyLocked || isReviewingSupervisor || pendingApprovals.loading || Boolean(pendingApprovals.error)}
                        onClick={() => handleFounderSupervisorReview(rec, 'half_day')}
                      >
                        Half Day
                      </Button>
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        className="min-h-11 sm:min-h-9"
                        disabled={legacyLocked || isReviewingSupervisor || pendingApprovals.loading || Boolean(pendingApprovals.error)}
                        onClick={() => handleFounderSupervisorReview(rec, 'absent')}
                        leftIcon={<XCircle className="w-3.5 h-3.5" />}
                      >
                        Mark Absent
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>}
            <div className="flex flex-wrap gap-2">
              {pendingApprovals.hasMore && (
                <Button type="button" variant="secondary" size="sm" disabled={pendingApprovals.loading} onClick={pendingApprovals.loadMore}>
                  Show more pending approvals
                </Button>
              )}
              <Button type="button" variant="secondary" size="sm" disabled={pendingApprovals.loading} onClick={() => void pendingApprovals.refresh()}>
                {pendingApprovals.error ? 'Retry approvals' : 'Refresh approvals'}
              </Button>
            </div>
          </div>
        )}

        {isFounder && !pendingApprovals.loading && !pendingApprovals.error && pendingApprovals.total === 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-surface-border bg-white px-3.5 py-2 text-xs text-ink-secondary">
            <span>No pending supervisor approvals at last check.</span>
            <Button type="button" variant="ghost" size="sm" onClick={() => void pendingApprovals.refresh()}>Refresh approvals</Button>
          </div>
        )}

        {activeTab === 'terminal' && supervisorIdentityNeedsReview && (
          <div role="alert" className="rounded-xl border border-status-warning/30 bg-status-warning-bg p-4 text-sm text-navy">
            <strong>Supervisor workforce details need review.</strong>{' '}
            An active worker has the same name as a Supervisor assigned here, but is not linked to that account. This may or may not be the same person. Roll Call submission is paused to prevent duplicate attendance. Please ask the Founder to check the profiles and their history. Do not delete or change them based on name alone.
          </div>
        )}
        {activeTab === 'terminal' && missingSupervisorWorker && !supervisorIdentityNeedsReview && (
          <div role="status" className="rounded-xl border border-surface-border bg-white p-4 text-sm text-ink-secondary">
            Your account does not have an active linked workforce profile, so your attendance will not be auto-logged. Ask the Founder if this is unexpected.
          </div>
        )}

        {/* Active Project & Date Selector Bar (Only shown on Daily Roster tab) */}
        {activeTab === 'terminal' && (
          <div data-roll-call-guide="site" className="rounded-xl border border-surface-border bg-white p-3 sm:p-3.5 grid grid-cols-1 md:grid-cols-2 gap-2.5 md:gap-3 items-start">
            <div>
              <SearchableSelect
                id="attendance-project"
                label="Project Site"
                searchLabel="Search attendance sites"
                value={selectedProjectId}
                disabled={isSubmitting}
                onChange={(e) => setSelectedProjectId(e.target.value)}
                fixedOption={accessibleProjects.length === 0 ? { value: '', label: 'No assigned project sites yet' } : undefined}
                options={accessibleProjects.map((p) => ({
                  value: p.id,
                  label: `${p.name} (${p.location.split(',')[0]})`,
                }))}
              />
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
                  className="min-h-11 sm:min-h-11"
                  disabled={isSubmitting}
                  onClick={() => setSelectedDate(manilaDateISO())}
                >
                  Today ({today.slice(5)})
                </Button>
                <Button
                  type="button"
                  variant={selectedDate === yesterday ? 'primary' : 'secondary'}
                  size="sm"
                  className="min-h-11 sm:min-h-11"
                  disabled={isSubmitting}
                  onClick={() => setSelectedDate(shiftCalendarDate(manilaDateISO(), -1))}
                >
                  Yesterday ({yesterday.slice(5)})
                </Button>
                {isFounder && (
                  <div className="w-full sm:w-44">
                    <Input
                      type="date"
                      aria-label="Roll call date"
                      value={selectedDate}
                      max={today}
                      disabled={isSubmitting}
                      onChange={(e) => setSelectedDate(e.target.value)}
                      className="py-2"
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 1: TERMINAL / DAILY ROSTER */}
        {activeTab === 'terminal' && !draftReady && (
          <div className="rounded-xl border border-surface-border bg-white p-4 text-sm">
            {!selectedProjectId
              ? <p role="status">Choose an available project to see its Roll Call.</p>
              : rollCall.status === 'error' || loadError
                ? <><p role="alert" className="text-status-danger">Could not load the complete project team and saved attendance. Your draft has not been submitted.</p><Button type="button" variant="secondary" size="sm" onClick={() => void (loadError ? refresh() : rollCall.reload())}>Retry roster</Button></>
                : <p role="status">{rosterReady ? 'Restoring this device’s draft…' : 'Loading project team and saved attendance…'}</p>}
          </div>
        )}
        {activeTab === 'terminal' && draftReady && (
          <form onSubmit={handleBatchSubmit} className="space-y-2.5 sm:space-y-3.5">
            {unavailableAssignedIds.length > 0 && <div role="alert" className="rounded-xl border border-status-warning/30 bg-status-warning-bg p-4 text-sm text-navy">Some assigned workers are inactive or their details are unavailable. Check the project team before submitting.</div>}
            {unreadableDraft && <div role="alert" className="rounded-xl border border-status-warning/30 bg-status-warning-bg p-4 text-sm text-navy">Could not read the draft storage on this device. Nothing was submitted or deliberately deleted. Check browser storage before submitting.</div>}
            {hiddenDraftIds.length > 0 && <div role="alert" className="rounded-xl border border-status-warning/30 bg-status-warning-bg p-4 text-sm text-navy">
              <p>A saved draft includes {hiddenDraftIds.length} worker(s) unavailable for Roll Call or no longer in the current roster. The draft is preserved on this device. Review the project team or discard only these hidden draft selections before submitting.</p>
              <Button type="button" variant="secondary" size="sm" onClick={() => setDiscardHiddenDraftOpen(true)}>Review hidden draft selections</Button>
            </div>}
            {rollCallSnapshot.workerIds.length === 0 && <div role="status" className="rounded-xl border border-surface-border bg-white p-4 text-sm text-ink-secondary">No workers are assigned to this project yet. Saved attendance for this date remains visible below. <Link href={`/projects/${encodeURIComponent(selectedProjectId)}`} className="font-semibold text-brand underline">Manage project workers</Link></div>}
            {unavailableSavedRecords.length > 0 && <section aria-label="Saved attendance for unavailable workers" className="rounded-xl border border-surface-border bg-white p-4 text-sm">
              <h2 className="font-semibold text-navy">Saved attendance for unavailable workers</h2>
              <p className="mt-1 text-xs text-ink-secondary">These saved records are shown read-only. Worker details may be unavailable to your account. Use Attendance History for more information.</p>
              <ul className="mt-2 space-y-2">{unavailableSavedRecords.map((record) => <li key={record.id} className="text-xs text-ink-secondary"><strong>{record.worker_name || 'Worker (details unavailable)'}</strong> · {formatStatusLabel(record.status)}{record.notes ? ` · ${record.notes}` : ''}</li>)}</ul>
            </section>}
            {/* Compact progress summary: the roster remains the focus, counts stay scannable. */}
            <section
              data-roll-call-guide="summary"
              aria-label="Attendance summary"
              className="rounded-xl border border-surface-border bg-white px-3 py-2.5 sm:px-3.5 sm:py-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <h2 className="text-sm font-semibold text-ink-primary">Crew status</h2>
                <p className="text-xs font-medium text-ink-secondary tabular-nums" aria-live="polite">
                  {checkedCount} of {markableWorkers.length} marked · {uncheckedCount} remaining
                </p>
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
            <div data-roll-call-guide="filters" className="rounded-xl border border-surface-border bg-white p-2.5 sm:p-3">
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
                    options={rosterCraftOptions}
                  />
                </div>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-surface-border/70 pt-2">
                <button
                  type="button"
                  aria-pressed={unmarkedWorkerIds !== null}
                  disabled={!isLoaded || !attendanceDraftStorageKey || draftStorageReadyKey !== attendanceDraftStorageKey || isSubmitting}
                  onClick={() => setUnmarkedWorkerIds((current) => current === null ? collectUnmarkedWorkerIds() : null)}
                  className={`inline-flex min-h-11 items-center rounded-lg border px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
                    unmarkedWorkerIds !== null ? 'border-brand bg-brand text-white' : 'border-surface-border bg-white text-navy hover:bg-surface-inset'
                  }`}
                >
                  Unmarked only
                </button>
                {unmarkedWorkerIds !== null && (
                  <>
                    <button
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => setUnmarkedWorkerIds(collectUnmarkedWorkerIds())}
                      className="inline-flex min-h-11 items-center rounded-lg px-2 text-xs font-semibold text-brand hover:bg-brand/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50"
                    >
                      Refresh unmarked list
                    </button>
                    <span className="text-xs text-ink-secondary">Marked workers stay visible until you refresh the list.</span>
                  </>
                )}
              </div>

              {craftFilter !== 'all' && (
                <div className="mt-2 flex sm:hidden">
                  <button
                    type="button"
                    onClick={() => setCraftFilter('all')}
                    aria-label={`Remove craft filter: ${rosterCraftOptions.find((option) => option.value === craftFilter)?.label || 'selected group'}`}
                    className="inline-flex min-h-11 min-w-0 max-w-full items-center gap-1.5 rounded-full bg-surface-inset px-3 py-1 text-xs font-medium text-navy transition-colors hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                  >
                    <span className="truncate">
                      {rosterCraftOptions.find((option) => option.value === craftFilter)?.label || 'Selected craft'}
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
                  options={rosterCraftOptions}
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
            <div data-roll-call-guide="crew" className="space-y-2 sm:space-y-2.5">
              {groupedRosterWorkers.map(([groupKey, groupWorkers]) => {
                const isCollapsed = Boolean(collapsedGroups[groupKey]);
                const groupMarkableWorkers = groupWorkers.filter(
                  (worker) => !isLockedRollCallWorker(worker)
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
                        aria-controls={`attendance-group-${encodeURIComponent(groupKey)}`}
                        className="flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                      >
                        {isCollapsed ? (
                          <ChevronRight className="h-4 w-4 shrink-0 text-ink-secondary" />
                        ) : (
                          <ChevronDown className="h-4 w-4 shrink-0 text-ink-secondary" />
                        )}
                        <span className="min-w-0 flex-1 break-words text-sm font-semibold leading-snug text-navy">
                          {craftGroupLabel(groupKey)}
                        </span>
                        <span className="inline-flex h-8 min-w-8 shrink-0 items-center justify-center rounded-full border border-surface-border bg-surface px-2 text-xs font-semibold tabular-nums text-navy">
                          {groupWorkers.length}
                          <span className="sr-only"> workers</span>
                        </span>
                      </button>

                      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                        <div className="flex flex-wrap items-start gap-x-3">
                          <div className="inline-flex min-h-11 items-center text-xs font-semibold text-ink-secondary tabular-nums">
                            {groupUnchecked} unmarked{(searchWorker.trim() || unmarkedWorkerIds !== null) ? ' among shown workers' : ''}
                          </div>
                          <details className="text-xs text-ink-secondary">
                            <summary className="min-h-11 w-fit cursor-pointer py-3 font-medium text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">Status breakdown{(searchWorker.trim() || unmarkedWorkerIds !== null) ? ' (shown workers)' : ''}</summary>
                            <div className="flex flex-wrap gap-x-3 gap-y-1 pb-2 tabular-nums">
                              <span>{groupPresent} present</span>
                              <span>{groupHalf} half day</span>
                              <span>{groupAbsent} absent</span>
                              <span>{groupLeave} leave</span>
                            </div>
                          </details>
                        </div>
                        {hasUnmarkedCrew && (
                          <button
                            type="button"
                            disabled={isSubmitting}
                            onClick={() => handleMarkCrewPresent(groupWorkers)}
                            className="inline-flex min-h-11 w-fit max-w-full shrink-0 items-center rounded-lg px-2 text-xs font-semibold text-brand transition-colors hover:bg-brand/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50"
                          >
                            {(searchWorker.trim() || unmarkedWorkerIds !== null) ? 'Mark visible unmarked present' : 'Mark remaining present'}
                          </button>
                        )}
                      </div>
                    </div>

                    <div
                      id={`attendance-group-${encodeURIComponent(groupKey)}`}
                      ref={(node) => { node?.toggleAttribute('inert', isCollapsed); }}
                      aria-hidden={isCollapsed || undefined}
                      className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${isCollapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'}`}
                    >
                      <div className="min-h-0 overflow-hidden">
                        <div className="divide-y divide-surface-border/60">
                        {groupWorkers.map((worker) => {
                          const currentDraft = draftAttendance[worker.id] || {
                            status: null,
                            notes: '',
                          };
                          const isSelfSup = isSelfSupervisorWorker(worker);
                          const isGeneralSup = generalSupervisorCutover && isLockedRollCallWorker(worker);
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
                                    {isFounder && !isGeneralSup && isPendingFounderApprovalOnRow && (
                                      <Badge variant="warning" size="sm">
                                        Pending Founder Approval
                                      </Badge>
                                    )}
                                    {isFounder && !isGeneralSup && isAnySupRow && savedRec && isVerifiedByFounder && (
                                      <Badge variant="success" size="sm">
                                        Founder Approved ✓
                                      </Badge>
                                    )}
                                    {!isSelfSup && !isGeneralSup && !currentDraft.status && (
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
                                {isSelfSup || isGeneralSup ? (
                                  <div className="flex w-full min-w-0 items-start gap-2 rounded-lg border border-surface-border bg-white px-3 py-2.5 text-[11px] font-semibold text-navy lg:w-[26rem] lg:shrink-0">
                                    <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-warning" />
                                    <span className="min-w-0 break-words leading-snug">
                                      {isGeneralSup ? (
                                        savedRec ? `Historical site record: ${formatStatusLabel(savedRec.status)}. Supervisor attendance is recorded separately in General Daily Attendance.` : 'Supervisor attendance is recorded separately in General Daily Attendance.'
                                      ) : otherSiteInfo ? (
                                        `Logged via ${otherSiteInfo.projectName} (${selectedDate})`
                                      ) : savedRec ? (
                                        isVerifiedByFounder ? (
                                          `Founder Approved (${formatStatusLabel(savedRec.status)}) ✓`
                                        ) : (
                                          `Submitted: ${formatStatusLabel(savedRec.status)}${savedRec.status === 'present' || savedRec.status === 'half_day' ? ' · Pending Founder Approval' : ''}`
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
                                            disabled={isSubmitting}
                                            onClick={() =>
                                              handleStatusChange(
                                                worker,
                                                status.id as AttendanceStatus
                                              )
                                            }
                                            aria-pressed={active}
                                            className={`inline-flex min-h-11 min-w-0 w-full items-center justify-center whitespace-nowrap rounded-md px-1 text-[10px] font-medium leading-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand sm:min-h-12 sm:px-1.5 sm:text-[11px] ${
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
                                        className={`inline-flex min-h-11 w-fit max-w-full items-center justify-center gap-2 rounded-lg border px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
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
                                          aria-label={`Activity note for ${worker.name}`}
                                          placeholder="Activity note (e.g. 2F slab rebar, went home at noon)..."
                                          value={currentDraft.notes}
                                          disabled={isSubmitting}
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
                      </div>
                    </div>
                  </div>
                );
              })}

              {filteredWorkers.length === 0 && (
                <div className="bg-white rounded-xl border border-surface-border">
                  <EmptyState
                    title={unmarkedWorkerIds !== null ? 'No workers in this view' : 'No workers on this site'}
                    description={
                      siteRosterWorkers.length === 0
                        ? 'Add workers to this project in Project Details to begin a new Roll Call.'
                        : unmarkedWorkerIds !== null
                          ? 'Refresh the unmarked list or turn off Unmarked only to see the full roster.'
                          : 'No worker matches the current filter.'
                    }
                  />
                </div>
              )}
            </div>

            <ConfirmDialog isOpen={discardHiddenDraftOpen} title="Discard hidden draft selections?" message="Only the unavailable or hidden selections listed by this warning will be removed from this device. Saved attendance and payroll are not changed." destructive confirmLabel="Discard hidden selections" onCancel={() => setDiscardHiddenDraftOpen(false)} onConfirm={() => { setDraftState((current) => ({ dirtyIds: current.dirtyIds.filter((id) => !hiddenDraftIds.includes(id)), entries: Object.fromEntries(Object.entries(current.entries).filter(([id]) => !hiddenDraftIds.includes(id))) })); setDiscardHiddenDraftOpen(false); }} />

            {/* In-Flow Bottom Submit & Sync Card (Moves naturally with collapsed/expanded groups — never overlaps) */}
            <div data-roll-call-guide="submit" className="mt-3 px-3 sm:px-4 py-3 rounded-xl bg-white border border-surface-border flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div
                role="status"
                aria-live="polite"
                aria-busy={isSubmitting}
                className="min-w-0 text-xs text-ink-secondary sm:flex-1"
              >
                <div>
                  {attendanceSaveFailed ? (
                    <span className="text-status-warning">
                      Attendance submission could not be confirmed. Your selections remain in the draft; check the saved records before retrying.
                    </span>
                  ) : markableWorkers.length === 0 ? (
                    <span>No crew ready to submit.</span>
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
                  supervisorIdentityNeedsReview ||
                  unreadableDraft ||
                  hiddenDraftIds.length > 0 ||
                  unavailableAssignedIds.length > 0 ||
                  draftStorageReadyKey !== attendanceDraftStorageKey ||
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
            <div data-page-guide="filters" className="space-y-3 rounded-2xl border border-surface-border bg-white p-3.5 shadow-sm">
              <div className="flex items-center gap-2 lg:hidden">
                <div className="min-w-0 flex-1">
                  <Input
                    aria-label="Search attendance history"
                    maxLength={200}
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
                      aria-label={`Site · ${projects.find((project) => project.id === historyProjectFilter)?.name || 'Selected'} — remove filter`}
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
                      aria-label={`Status · ${historyStatusFilter === 'half_day' ? 'Half Day' : historyStatusFilter === 'leave' ? 'Approved Leave' : historyStatusFilter[0].toUpperCase() + historyStatusFilter.slice(1)} — remove filter`}
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
                      aria-label={`Date · ${formatDatePH(historyDateFilter)} — remove filter`}
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
                  maxLength={200}
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

            <div className="grid gap-4 lg:grid-cols-[minmax(19rem,0.85fr)_minmax(0,1.15fr)] lg:items-start">
              <AttendanceHistoryCalendar userId={user?.id} today={today} filters={historyFilters} settling={isHistorySearchSettling} revision={historyRevision} onSelectDate={setHistoryDateFilter} />
              <div className="min-w-0 space-y-3">
                <div className="space-y-1 text-xs text-ink-secondary">
                  <p aria-live="polite">{history.loading || isHistorySearchSettling ? 'Updating results…' : history.error ? 'History could not be loaded; retry to update results.' : `Showing ${history.items.length} date/site ${history.items.length === 1 ? 'sheet' : 'sheets'} from the server. Counts reflect the current filters.`}</p>
                  <p>Results are a snapshot; refresh to include changes made elsewhere.</p>
                </div>
                <div data-page-guide="list" className="space-y-2">
                  {history.items.map((sheet) => {
                    const key = `${sheet.date}::${sheet.project_id}`;
                    const isExpanded = Boolean(expandedHistorySheets[key]);
                    const sheetId = `history-sheet-${encodeURIComponent(key)}`;
                    return <div key={key} className="overflow-hidden rounded-2xl border border-surface-border bg-white shadow-sm">
                      <button type="button" aria-expanded={isExpanded} aria-controls={isExpanded ? sheetId : undefined}
                        onClick={() => setExpandedHistorySheets((prev) => ({...prev,[key]:!prev[key]}))}
                        className="flex min-h-11 w-full flex-wrap items-center gap-x-3 gap-y-1 bg-surface-inset/70 px-4 py-3 text-left transition-colors hover:bg-surface-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand">
                        {isExpanded ? <ChevronDown className="h-4 w-4 shrink-0 text-ink-secondary" aria-hidden="true" /> : <ChevronRight className="h-4 w-4 shrink-0 text-ink-secondary" aria-hidden="true" />}
                        <span className="min-w-0 flex-1 break-words text-xs font-bold text-navy sm:text-sm">{formatDatePH(sheet.date)} · {sheet.project_name || 'Project Site'}</span>
                        <span className="text-xs font-medium tabular-nums text-ink-secondary">{sheet.record_count} {sheet.record_count === 1 ? 'record' : 'records'}</span>
                        <span className="flex w-full flex-wrap gap-x-3 gap-y-0.5 pl-7 text-[11px] font-medium text-ink-secondary">
                          <span>{sheet.present_count} Present</span><span>{sheet.half_day_count} Half Day</span><span>{sheet.absent_count} Absent</span><span>{sheet.leave_count} Leave</span>
                          {sheet.pending_count > 0 && <span className="font-semibold text-status-warning">{sheet.pending_count} pending Founder review</span>}
                        </span>
                      </button>
                      {isExpanded && <div id={sheetId}><HistorySheetRecords sheet={sheet} filters={historyFilters} userId={user?.id} revision={historyRevision} isFounder={isFounder} reviewing={isReviewingSupervisor}
                        onReview={handleFounderSupervisorReview}
                        onEdit={(rec: HistoryRecord) => {setSelectedRecordForOverride(rec);setOverrideStatus(rec.status);setOverrideNotes(rec.notes || '');setOverrideModalOpen(true);}} /></div>}
                    </div>;
                  })}
                  {(history.loading || isHistorySearchSettling) && <p role="status" className="text-xs text-ink-secondary">Loading attendance history…</p>}
                  {history.error && <div className="space-y-2 rounded-xl border border-surface-border bg-white p-4 text-xs"><p role="alert" className="text-status-danger">Unable to load attendance history. Please retry.</p><Button type="button" variant="secondary" size="sm" onClick={history.retry}>Retry history</Button></div>}
                  {history.hasMore && !history.error && <Button type="button" variant="secondary" className="w-full sm:w-auto" disabled={history.loading} onClick={history.loadMore}>Show more date/site sheets</Button>}
                  {!history.loading && !history.error && !isHistorySearchSettling && history.items.length === 0 && <div className="rounded-xl border border-surface-border bg-white"><EmptyState title="No attendance records match" description="Try clearing the site, date, status or search filters." /></div>}
                  <Button type="button" variant="ghost" size="sm" disabled={history.loading || isHistorySearchSettling} onClick={() => setHistoryRevision((n) => n + 1)}>Refresh history</Button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: WORKFORCE DIRECTORY (COMPACT & GROUPED BY CRAFT) */}
        {activeTab === 'workforce' && (
          <div className="space-y-4">
            <WorkerCategoryFoundation userId={user?.id} isFounder={isFounder} assurance={assurance} authLoading={authLoading} />
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
                    Add registered workers to a project to include them in that project’s Roll Call. Supervisor accounts sync from Team Accounts.
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

                  {categories.enabled ? <WorkerCategorySelect categories={categories} label="Craft / Position" value={workerPosition} onChange={setWorkerPosition}/> : (
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
                  )}

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
                    disabled={categories.enabled && !categories.items?.some(c=>c.label===workerPosition)}
                    leftIcon={<UserPlus className="h-4 w-4" />}
                    className="w-full sm:w-auto"
                  >
                    {isSupervisor ? 'Register Worker' : 'Add Worker to Roster'}
                  </Button>
                </div>
              </form>
            </section>

            {isSupervisor && <div className="rounded-xl border border-surface-border bg-white p-3 space-y-2">
              <label htmlFor="workforce-project" className="block text-xs font-semibold text-ink-secondary">Workforce project</label>
              <select id="workforce-project" value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)} disabled={accessibleProjects.length === 0} className="min-h-11 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy sm:w-auto sm:min-w-56">
                {accessibleProjects.length === 0 && <option value="">No assigned projects</option>}
                {accessibleProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
              <p className="text-xs text-ink-secondary">Only the selected project&apos;s assigned workers are shown.</p>
              {workforceTeam.status === 'loading' && <p role="status" className="text-xs text-ink-secondary">Loading project workforce…</p>}
              {workforceTeam.status === 'error' && <p role="alert" className="text-xs text-status-danger">Could not load this project&apos;s workforce. <button type="button" className="underline" onClick={workforceTeam.reload}>Try again</button></p>}
              {missingWorkforceProfiles > 0 && <p role="alert" className="text-xs text-status-danger">Some assigned worker profiles could not be loaded. This list may be incomplete; refresh and check before relying on it.</p>}
            </div>}

            {/* Filter Bar for Workforce Directory */}
            <div data-page-guide="filters" className="p-3 rounded-2xl bg-white border border-surface-border shadow-sm flex flex-col sm:flex-row items-center justify-between gap-2.5">
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
                    options={workforceCraftOptions}
                  />
                </div>
                <div className="w-full sm:w-36">
                  <Select aria-label="Filter workforce by status" value={workforceStatusFilter} onChange={(e) => setWorkforceStatusFilter(e.target.value)} options={[{ label: 'Active', value: 'active' }, { label: 'Inactive', value: 'inactive' }, { label: 'Active and inactive', value: 'all' }, ...(isFounder ? [{ label: 'Removed', value: 'removed' }] : [])]} />
                </div>
              </div>

              {(!isSupervisor || workforceTeam.status === 'ready') && <Badge variant="neutral" size="sm">
                {workforceScopedWorkers.filter((w) => w.active && !w.removed_at).length} active / {workforceScopedWorkers.filter((w) => !w.removed_at).length} {missingWorkforceProfiles > 0 ? 'loaded' : 'in workforce'}
              </Badge>}
            </div>

            {isFounder && (
              <div className="rounded-xl border border-surface-border bg-white p-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" variant="secondary" size="sm" disabled={workerRemovalPending || !isLoaded || Boolean(loadError) || visibleWorkerIds.length === 0} onClick={() => {
                    const combined = Array.from(new Set([...selectedWorkers, ...visibleWorkerIds]));
                    if (combined.length > 100) { showToast('error', 'Select at most 100 workers at a time. Narrow the filter or select individuals.'); return; }
                    setSelectedWorkers(combined);
                  }}>Select visible</Button>
                  <Button type="button" variant="ghost" size="sm" disabled={workerRemovalPending || selectedWorkers.length === 0} onClick={() => setSelectedWorkers([])}>Clear selection</Button>
                  <span className="text-xs text-ink-secondary">{selectedWorkers.length} selected (including selections outside the current filter)</span>
                  <Button type="button" variant="danger" size="sm" disabled={workerRemovalPending || !isLoaded || Boolean(loadError) || selectedWorkers.length === 0 || selectedWorkerDetails.length !== selectedWorkers.length} onClick={() => setWorkerRemovalOpen(true)}>Remove selected</Button>
                </div>
                <p className="text-xs text-ink-secondary">Removed workers are hidden from normal lists; their history remains. Use the Removed filter to review or restore them.</p>
              </div>
            )}
            {workerRemovalResults.length > 0 && (
              <div role="status" className="rounded-xl border border-surface-border bg-white p-3 text-xs space-y-1">
                <p className="font-semibold text-navy">Worker removal results</p>
                {workerRemovalResults.map((item, index) => <p key={`${item.id}-${index}`}><strong>{item.name} (ID {item.id.slice(0, 8)}):</strong> {item.status === 'removed' ? 'Removed from workforce and current project teams; history kept.' : item.status === 'restored' ? 'Restored as inactive; project teams were not restored.' : item.status === 'already_removed' ? 'Already removed.' : item.status === 'already_available' ? 'Already in the workforce.' : 'Not found; refresh and check.'}</p>)}
                <button type="button" className="underline" onClick={() => setWorkerRemovalResults([])}>Dismiss results</button>
              </div>
            )}
            <Modal isOpen={workerRemovalOpen} onClose={() => { if (!workerRemovalPending) setWorkerRemovalOpen(false); }} title="Remove selected workers?" description="Attendance, payroll and Bale history stay. Workers are removed from current project teams and future payroll generation, including unprocessed dates. Finish any payroll first. Supervisor logins and project access are not removed. Review every selected worker below." role="alertdialog" dismissOnBackdrop={false} dismissOnEscape={!workerRemovalPending} showCloseButton={!workerRemovalPending} maxWidth="md">
              <ul className="max-h-56 overflow-y-auto rounded-lg border border-surface-border divide-y divide-surface-border text-xs">
                {selectedWorkerDetails.map((worker) => <li key={worker.id} className="p-2">{worker.name} · {worker.position} · {worker.active ? 'Active' : 'Inactive'} · ID {worker.id.slice(0, 8)}</li>)}
              </ul>
              <div className="mt-3 flex justify-end gap-2"><Button type="button" variant="secondary" disabled={workerRemovalPending} onClick={() => setWorkerRemovalOpen(false)}>Cancel</Button><Button type="button" variant="danger" isLoading={workerRemovalPending} onClick={() => void changeWorkersRemoved('remove', selectedWorkerDetails)}>Remove workers</Button></div>
            </Modal>

            <ConfirmDialog isOpen={Boolean(workerRestoreTarget)} title="Restore worker?" message={`${workerRestoreTarget?.name || 'This worker'} will return as inactive. Reactivation and adding them to project teams are separate steps.`} confirmLabel="Restore as inactive" isPending={workerRemovalPending} onCancel={() => setWorkerRestoreTarget(null)} onConfirm={() => { if (workerRestoreTarget) void changeWorkersRemoved('restore', [workerRestoreTarget]); }} />

            {/* Grouped Compact Workforce List */}
            <div data-page-guide="list" className="space-y-3">
              {groupedWorkforceDirectory.map(([groupKey, groupWorkers]) => (
                <div
                  key={groupKey}
                  className="rounded-2xl bg-white border border-surface-border shadow-sm overflow-hidden"
                >
                  <div className="px-4 py-2.5 bg-surface-inset/70 border-b border-surface-border/60 flex items-center justify-between">
                    <span className="font-bold text-xs text-navy">
                      {craftGroupLabel(groupKey)}
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
                          className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs hover:bg-slate-50 transition-colors"
                        >
                          <div className="flex items-center flex-wrap gap-2 min-w-0">
                            {isFounder && !w.removed_at && <label className="inline-flex min-h-11 min-w-11 items-center justify-center"><input type="checkbox" aria-label={`Select ${w.name}, ${w.position}, ${w.active ? 'active' : 'inactive'} for removal`} checked={selectedWorkers.includes(w.id)} disabled={workerRemovalPending || !isLoaded || Boolean(loadError)} onChange={(e) => {
                              const checked = e.target.checked;
                              if (checked && selectedWorkers.length >= 100) { showToast('error', 'Select at most 100 workers at a time.'); return; }
                              setSelectedWorkers((current) => checked ? [...current, w.id] : current.filter((id) => id !== w.id));
                            }} className="h-4 w-4 rounded border-surface-border" /></label>}
                            <span className="font-bold text-navy text-sm">{w.name}</span>
                            <span className="text-ink-secondary">
                              {w.position} · ₱{w.pay_rate}/day
                              {w.contact_number && w.contact_number !== '—'
                                ? ` · ${w.contact_number}`
                                : ''}
                            </span>
                            <Badge variant={w.active ? 'success' : 'neutral'} size="sm">
                              {w.removed_at ? 'Removed' : w.active ? 'Active' : 'Inactive'}
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

                          {isFounder && (w.removed_at ? (
                            <Button type="button" variant="secondary" size="sm" disabled={workerRemovalPending} onClick={() => setWorkerRestoreTarget(w)}>Restore</Button>
                          ) : (
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              onClick={() => openEditWorkerModal(w)}
                              leftIcon={<Settings2 className="w-3.5 h-3.5" />}
                            >
                              Manage
                            </Button>
                          ))}
                          {isFounder && user?.id && assurance === 'ready' && !authLoading && assignmentHistoryPreviewEnabled() && <AssignmentHistory key={`${user.id}:${w.id}`} workerId={w.id} workerName={w.name} />}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}

              {groupedWorkforceDirectory.length === 0 && (!isSupervisor || (workforceTeam.status === 'ready' && missingWorkforceProfiles === 0)) && (
                <div className="bg-white rounded-xl border border-surface-border">
                  <EmptyState
                    title="No workers match"
                    description="Change the search or filters to see other workers, or choose Add Worker above to register a worker."
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
              {categories.enabled && !users.some(u=>u.id===editingWorker.id&&u.role==='supervisor') ? <WorkerCategorySelect categories={categories} label="Craft / Position" value={editWorkerPosition} onChange={setEditWorkerPosition} allowUnchanged={editWorkerPosition===editingWorker.position}/> : <Input
                label="Craft / Position"
                value={editWorkerPosition}
                onChange={(e) => setEditWorkerPosition(e.target.value)}
                readOnly={categories.enabled}
                required
              />}

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
              <Button type="submit" variant="primary" isLoading={isSavingWorker} disabled={categories.enabled && editWorkerPosition!==editingWorker.position && !categories.items?.some(c=>c.label===editWorkerPosition)}>
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
            <p className="rounded-xl border border-status-warning/25 bg-status-warning-bg p-3 leading-relaxed text-ink-secondary">If this date is covered by approved or paid payroll, review and settle any correction separately. This legacy status edit does not change the saved voucher or automatically record an adjustment. It can also make saved regular/OT details stale.</p>
            <div className="p-3 rounded-xl bg-surface-inset border border-surface-border space-y-1">
              <div className="font-bold text-navy">
                Worker: {(selectedRecordForOverride as HistoryRecord).worker_name || workers.find((w) => w.id === selectedRecordForOverride.worker_id)?.name || 'Worker'}
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
