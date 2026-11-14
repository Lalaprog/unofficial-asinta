'use client';

import { isInvoiceOverdue } from '@/lib/invoices/overdue';
import { manilaDateISO } from '@/lib/dates/manila';
import { verifyBaleReviewRows } from '@/lib/attendance/baleReview';
import { loadBaleRequests, mergeLoadedBaleRequest, type BaleRequestCoverage } from '@/lib/attendance/loadBaleRequests';

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { SupabaseClient, PostgrestError } from '@supabase/supabase-js';
import {
  Project,
  Invoice,
  Expense,
  Worker,
  Client,
  Advance,
  AdvanceRequest,
  UserNotification,
  Attendance,
  Payroll,
  Tool,
  SMSLog,
  ProjectSupervisor,
  User,
  ExpenseCategory,
  AttendanceStatus,
} from '@/types';
import { createClient as createSupabaseClient } from '@/lib/supabase/client';
import { useAuth } from '@/lib/auth/authContext';
import { useToast } from '@/components/ui/Toast';
import { writeAuditEntry, auditFailureMessage, type AuditEntry } from '@/lib/audit/log';
import { confirmProjectDeletion } from '@/lib/projects/delete';
import { parsePayrollInputSnapshot } from '@/lib/payroll/inputSnapshot';
import { prepareInvoicePayment, type InvoicePaymentResult } from '@/lib/invoices/payment';

interface DataStoreContextType {
  // State (loaded from live Supabase PostgreSQL)
  projects: Project[];
  invoices: Invoice[];
  expenses: Expense[];
  workers: Worker[];
  clients: Client[];
  advances: Advance[];
  advanceRequests: AdvanceRequest[];
  /** Omitted from the most recent successful loaded view; not live counts. */
  baleRequestCoverage: BaleRequestCoverage | null;
  userNotifications: UserNotification[];
  attendance: Attendance[];
  payroll: Payroll[];
  tools: Tool[];
  smsLogs: SMSLog[];
  projectSupervisors: ProjectSupervisor[];
  users: User[];
  isLoaded: boolean;
  isLoading: boolean;
  loadError: string | null;
  refresh: (options?: { silent?: boolean }) => Promise<void>;

  // Project Actions
  createProject: (data: Omit<Project, 'id' | 'created_at'>) => Promise<Project | null>;
  updateProject: (id: string, data: Partial<Project>) => Promise<Project | null>;
  deleteProject: (id: string) => Promise<boolean>;
  getProjectById: (id: string) => Project | undefined;
  getProjectsForSupervisor: (supervisorId: string) => Project[];

  // Client Actions
  createClient: (data: Omit<Client, 'id' | 'created_at'>) => Promise<Client | null>;
  updateClient: (id: string, data: Partial<Client>) => Promise<Client | null>;
  deleteClient: (id: string) => Promise<boolean>;

  // Worker Actions
  createWorker: (
    data: Omit<Worker, 'id' | 'created_at'> & { id?: string }
  ) => Promise<Worker | null>;
  updateWorker: (id: string, data: Partial<Worker>) => Promise<Worker | null>;
  toggleWorkerStatus: (id: string) => Promise<boolean>;

  // Invoice Actions
  createInvoice: (data: Omit<Invoice, 'id' | 'created_at'>) => Promise<Invoice | null>;
  updateInvoice: (id: string, data: Partial<Invoice>) => Promise<Invoice | null>;
  recordInvoicePayment: (invoice: Invoice, amount: string) => Promise<InvoicePaymentResult>;
  deleteInvoice: (id: string) => Promise<boolean>;

  // Expense Actions
  createExpense: (data: Omit<Expense, 'id' | 'created_at'>, recordId?: string) => Promise<Expense | null>;
  updateExpense: (id: string, data: Partial<Expense>, expectedRevision?: number) => Promise<Expense | null>;
  deleteExpense: (id: string) => Promise<boolean>;

  // Bale / Advance Actions
  createAdvance: (
    data: Omit<Advance, 'id' | 'created_at' | 'amount_deducted' | 'status'>
  ) => Promise<Advance | null>;
  createAdvanceRequest: (data: {
    worker_id: string;
    project_id: string;
    requested_amount: number;
    request_id?: string;
    request_period_start?: string;
  }) => Promise<AdvanceRequest | null>;
  reviewAdvanceRequest: (id: string, decision: 'approve' | 'reject') => Promise<boolean>;
  approveAdvanceRequests: (ids: string[]) => Promise<boolean>;
  issueAdvanceRequest: (id: string) => Promise<boolean>;
  markUserNotificationsRead: (ids: string[]) => Promise<boolean>;
  recordAdvanceDeduction: (id: string, deductionAmount: number) => Promise<boolean>;
  updateAdvanceStatus: (id: string, status: Advance['status']) => Promise<boolean>;

  // Attendance Actions
  recordAttendanceBatch: (records: Array<{
    worker_id: string;
    project_id: string;
    date: string;
    status: AttendanceStatus;
    hours_worked: number;
    notes?: string | null;
    recorded_by: string;
    is_founder_override?: boolean;
  }>) => Promise<boolean>;
  updateAttendanceRecord: (
    id: string,
    data: Partial<Attendance>,
    isFounderOverride?: boolean
  ) => Promise<boolean>;
  getAttendanceForProjectAndDate: (projectId: string, date: string) => Attendance[];

  // Payroll Actions
  createPayrollRun: (
    periodStart: string,
    periodEnd: string,
    projectId?: string
  ) => Promise<Payroll[] | null>;
  updatePayrollStatus: (id: string, status: Payroll['status']) => Promise<boolean>;

  // Tool Actions
  createTool: (data: Omit<Tool, 'id' | 'created_at'>) => Promise<Tool | null>;
  updateTool: (id: string, data: Partial<Tool>) => Promise<Tool | null>;
  deleteTool: (id: string) => Promise<boolean>;

  // SMS Actions
  sendSMS: (params: { invoiceId?: string; clientId?: string; message: string }) => Promise<boolean>;

  // Analytics
  getFounderMetrics: () => {
    totalProjects: number;
    activeProjects: number;
    totalInvoiced: number;
    totalCollected: number;
    totalOutstanding: number;
    totalOverdue: number;
    overdueInvoicesCount: number;
    totalExpenses: number;
    expensesByCategory: Record<ExpenseCategory, number>;
    totalPayrollPending: number;
    totalBaleBalance: number;
    projectFinancials: Array<{
      id: string;
      name: string;
      budget: number;
      invoiced: number;
      collected: number;
      expenses: number;
      profit: number;
      margin: number;
    }>;
  };
}

const DataStoreContext = createContext<DataStoreContextType | undefined>(undefined);

// ---------------------------------------------------------------------------
// Row mappers — Postgres NUMERIC columns may arrive as strings depending on
// the PostgREST serialization, so numeric fields are coerced explicitly.
// ---------------------------------------------------------------------------

const toNumber = (value: unknown, fallback = 0): number => {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const toOptionalNumber = (value: unknown): number | undefined =>
  value === null || value === undefined ? undefined : toNumber(value);

const mapProject = (row: any): Project => ({
  ...row,
  budget_estimate: row.budget_estimate == null ? null : toNumber(row.budget_estimate),
});

const mapInvoice = (row: any): Invoice => ({
  ...row,
  amount: toNumber(row.amount),
  amount_paid: toNumber(row.amount_paid),
  automatic_reminders_enabled: Boolean(row.automatic_reminders_enabled),
  reminders_paused_until: row.reminders_paused_until ?? null,
});

const mapExpense = (row: any): Expense => ({
  ...row,
  amount: toNumber(row.amount),
});

const mapWorker = (row: any): Worker => ({
  ...row,
  pay_rate: toNumber(row.pay_rate),
});

const mapClient = (row: any): Client => ({
  ...row,
});

const mapAdvance = (row: any): Advance => ({
  ...row,
  amount: toNumber(row.amount),
  amount_deducted: toNumber(row.amount_deducted),
});

const mapAdvanceRequest = (row: any): AdvanceRequest => ({
  ...row,
  requested_amount: toNumber(row.requested_amount),
});

const mapUserNotification = (row: any): UserNotification => ({
  ...row,
  requested_amount: toNumber(row.requested_amount),
});

const mapAttendance = (row: any): Attendance => ({
  ...row,
  hours_worked: toNumber(row.hours_worked),
});

const mapPayroll = (row: any): Payroll => ({
  ...row,
  gross_pay: toNumber(row.gross_pay),
  bale_deduction: toNumber(row.bale_deduction),
  other_deductions: toNumber(row.other_deductions),
  net_pay: toNumber(row.net_pay),
  days_worked: toOptionalNumber(row.days_worked),
  hours_worked: toOptionalNumber(row.hours_worked),
});

const mapTool = (row: any): Tool => ({
  ...row,
  quantity: toNumber(row.quantity, 1),
});

const round2 = (n: number) => Math.round(n * 100) / 100;

export const DataStoreProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const supabase = useMemo(() => createSupabaseClient(), []);
  const { user: authUser, isLoading: authLoading, assurance } = useAuth();
  // Never hydrate cached ledger data, subscribe, or issue data requests until
  // the current session has passed the server-verified assurance check.
  const user = assurance === 'ready' ? authUser : null;
  const { showToast } = useToast();

  const [isLoaded, setIsLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [projects, setProjects] = useState<Project[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [advances, setAdvances] = useState<Advance[]>([]);
  const [advanceRequests, setAdvanceRequests] = useState<AdvanceRequest[]>([]);
  const [baleRequestCoverage, setBaleRequestCoverage] = useState<BaleRequestCoverage | null>(null);
  const [userNotifications, setUserNotifications] = useState<UserNotification[]>([]);
  const [attendance, setAttendance] = useState<Attendance[]>([]);
  const [payroll, setPayroll] = useState<Payroll[]>([]);
  const [tools, setTools] = useState<Tool[]>([]);
  const [smsLogs, setSmsLogs] = useState<SMSLog[]>([]);
  const [projectSupervisors, setProjectSupervisors] = useState<ProjectSupervisor[]>([]);
  const [users, setUsers] = useState<User[]>([]);

  const inFlightRef = useRef<number | null>(null);
  const requestSequence = useRef(0);
  const sessionKey = user ? `${user.id}:${user.role}` : null;
  const activeSessionRef = useRef(sessionKey);
  activeSessionRef.current = sessionKey;
  const loadedSessionRef = useRef<string | null>(null);

  // -------------------------------------------------------------------------
  // Initial & background load — every SELECT runs with the authenticated
  // user's JWT so PostgreSQL RLS policies determine which rows are visible.
  // -------------------------------------------------------------------------
  const loadAll = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!activeSessionRef.current || inFlightRef.current !== null) return;
      const token = ++requestSequence.current;
      const requestSession = activeSessionRef.current;
      inFlightRef.current = token;
      if (!options?.silent) {
        setIsLoading(true);
      }

      try {
        const results = await Promise.all([
          supabase.rpc('visible_projects').order('created_at', { ascending: false }),
          supabase.from('invoices').select('*').order('created_at', { ascending: false }),
          supabase.from('expenses').select('*').order('created_at', { ascending: false }),
          supabase.from('workers').select('*').order('created_at', { ascending: true }),
          supabase.from('clients').select('*').order('created_at', { ascending: true }),
          supabase.from('advances').select('*').order('created_at', { ascending: false }),
          loadBaleRequests(supabase).then(result => ({...result,error:null})),
          supabase.from('attendance').select('*').order('date', { ascending: false }),
          supabase.from('payroll').select('*').order('created_at', { ascending: false }),
          supabase.from('tools').select('*').order('created_at', { ascending: true }),
          supabase.from('sms_logs').select('*').order('sent_at', { ascending: false }),
          supabase.from('project_supervisors').select('*'),
          supabase.from('users').select('*').order('created_at', { ascending: true }),
          supabase.from('user_notifications').select('*').order('created_at', { ascending: false }),
        ]);

        // A response from a previous account/role or an overtaken refresh must
        // never repopulate the new session's state or cache.
        if (inFlightRef.current !== token || activeSessionRef.current !== requestSession) return;
        const firstError = results.find((r) => r.error)?.error as PostgrestError | undefined;
        if (firstError) {
          console.error('Supabase data load failed:', firstError.message);
          setLoadError('The latest ledger sync failed. Previously loaded data may be stale; check the connection and retry before relying on it.');
          return;
        }
        // A null or malformed SELECT response is not evidence of an empty table.
        // Do not publish or cache any part of this batch unless all reads succeeded.
        if (results.some((result) => !Array.isArray(result.data))) {
          setLoadError('The latest ledger sync returned incomplete data. Previously loaded data may be stale; retry before relying on it.');
          return;
        }

        const nextProjects = (results[0].data ?? []).map(mapProject);
        const nextInvoices = (results[1].data ?? []).map(mapInvoice);
        const nextExpenses = (results[2].data ?? []).map(mapExpense);
        const nextWorkers = (results[3].data ?? []).map(mapWorker);
        const nextClients = (results[4].data ?? []).map(mapClient);
        const nextAdvances = (results[5].data ?? []).map(mapAdvance);
        const nextAdvanceRequests = (results[6].data ?? []).map(mapAdvanceRequest);
        const nextAttendance = (results[7].data ?? []).map(mapAttendance);
        const nextPayroll = (results[8].data ?? []).map(mapPayroll);
        const nextTools = (results[9].data ?? []).map(mapTool);
        const nextSmsLogs = results[10].data ?? [];
        const nextProjectSupervisors = results[11].data ?? [];
        const nextUsers = results[12].data ?? [];
        const nextUserNotifications = (results[13].data ?? []).map(mapUserNotification);

        setProjects(nextProjects);
        setInvoices(nextInvoices);
        setExpenses(nextExpenses);
        setWorkers(nextWorkers);
        setClients(nextClients);
        setAdvances(nextAdvances);
        setAdvanceRequests(nextAdvanceRequests);
        setBaleRequestCoverage(results[6].coverage);
        setUserNotifications(nextUserNotifications);
        setAttendance(nextAttendance);
        setPayroll(nextPayroll);
        setTools(nextTools);
        setSmsLogs(nextSmsLogs);
        setProjectSupervisors(nextProjectSupervisors);
        setUsers(nextUsers);
        setIsLoaded(true);
        setLoadError(null);

        if (user?.id && typeof window !== 'undefined') {
          try {
            window.sessionStorage.setItem(
              `bale-ledger-cache:v4:${user.id}:${user.role}`,
              JSON.stringify({
                projects: nextProjects,
                invoices: nextInvoices,
                expenses: nextExpenses,
                workers: nextWorkers,
                clients: nextClients,
                advances: nextAdvances,
                advanceRequests: nextAdvanceRequests,
                baleRequestCoverage: results[6].coverage,
                userNotifications: nextUserNotifications,
                attendance: nextAttendance,
                payroll: nextPayroll,
                tools: nextTools,
                smsLogs: nextSmsLogs,
                projectSupervisors: nextProjectSupervisors,
                users: nextUsers,
              })
            );
          } catch {
            // Non-fatal if sessionStorage quota is exceeded.
          }
        }
      } catch (e: any) {
        if (inFlightRef.current !== token || activeSessionRef.current !== requestSession) return;
        console.error('Unexpected error while loading BALE data:', e);
        setLoadError('The latest ledger sync failed. Previously loaded data may be stale; check the connection and retry before relying on it.');
      } finally {
        if (inFlightRef.current === token) {
          setIsLoading(false);
          inFlightRef.current = null;
        }
      }
    },
    [supabase, user?.id, user?.role]
  );

  const clearAll = useCallback(() => {
    setProjects([]);
    setInvoices([]);
    setExpenses([]);
    setWorkers([]);
    setClients([]);
    setAdvances([]);
    setAdvanceRequests([]);
    setBaleRequestCoverage(null);
    setUserNotifications([]);
    setAttendance([]);
    setPayroll([]);
    setTools([]);
    setSmsLogs([]);
    setProjectSupervisors([]);
    setUsers([]);
    setIsLoaded(false);
    setIsLoading(false);
    setLoadError(null);
  }, []);

  // Load when a user is authenticated (with instant sessionStorage cache
  // hydration + live Supabase Realtime & background sync); clear when signed out.
  useEffect(() => {
    if (authLoading && sessionKey) return;
    if (loadedSessionRef.current !== sessionKey) {
      loadedSessionRef.current = sessionKey;
      clearAll();
    }
    // A shared tab must not leave a previous user's cached ledger available
    // after sign-out or when another account/role signs in.
    const currentCacheKey = user ? `bale-ledger-cache:v4:${user.id}:${user.role}` : null;
    if (typeof window !== 'undefined') {
      try {
        const staleKeys = Array.from({ length: window.sessionStorage.length }, (_, i) => window.sessionStorage.key(i))
          .filter((key): key is string => Boolean(key?.startsWith('bale-ledger-cache:') && key !== currentCacheKey));
        staleKeys.forEach((key) => window.sessionStorage.removeItem(key));
      } catch {
        // Storage may be disabled; the network data load still works.
      }
    }
    if (!user) {
      clearAll();
      return;
    }

    if (typeof window !== 'undefined') {
      try {
        const cachedRaw = currentCacheKey ? window.sessionStorage.getItem(currentCacheKey) : null;
        if (cachedRaw) {
          const cached = JSON.parse(cachedRaw);
          const fields = ['projects','invoices','expenses','workers','clients','advances','advanceRequests','userNotifications','attendance','payroll','tools','smsLogs','projectSupervisors','users'];
          const coverage = cached?.baleRequestCoverage;
          if (cached && fields.every((field) => Array.isArray(cached[field])) && coverage &&
              Number.isSafeInteger(coverage.openOmitted) && coverage.openOmitted >= 0 &&
              Number.isSafeInteger(coverage.historyOmitted) && coverage.historyOmitted >= 0) {
            setProjects(cached.projects);
            setInvoices(cached.invoices);
            setExpenses(cached.expenses);
            setWorkers(cached.workers);
            setClients(cached.clients);
            setAdvances(cached.advances);
            setAdvanceRequests(cached.advanceRequests);
            setBaleRequestCoverage(coverage);
            setUserNotifications(cached.userNotifications);
            setAttendance(cached.attendance);
            setPayroll(cached.payroll);
            setTools(cached.tools);
            setSmsLogs(cached.smsLogs);
            setProjectSupervisors(cached.projectSupervisors);
            setUsers(cached.users);
            setIsLoaded(true);
            setLoadError('Showing a saved tab snapshot while the ledger syncs. It may be stale; wait for verification before relying on it.');
          }
        }
      } catch {
        // Ignore malformed cache.
      }
    }

    loadAll();

    // Real-time subscription + silent focus/interval sync so Founder and
    // Supervisor screens stay updated without manual page refreshes.
    let debounceTimer: number | undefined;
    const triggerSilentSync = () => {
      if (typeof window === 'undefined') return;
      if (debounceTimer) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        loadAll({ silent: true });
      }, 500);
    };

    const channel =
      typeof (supabase as any).channel === 'function'
        ? supabase
            .channel(`bale-live-${user.id}`)
            .on('postgres_changes', { event: '*', schema: 'public' }, () => {
              triggerSilentSync();
            })
            .subscribe()
        : null;

    const handleVisibilityOrFocus = () => {
      if (document.visibilityState === 'visible') {
        triggerSilentSync();
      }
    };

    window.addEventListener('focus', handleVisibilityOrFocus);
    document.addEventListener('visibilitychange', handleVisibilityOrFocus);
    const pollInterval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadAll({ silent: true });
      }
    }, 25_000);

    return () => {
      // Discard pending loads before this account, role or provider changes.
      inFlightRef.current = null;
      if (debounceTimer) window.clearTimeout(debounceTimer);
      window.removeEventListener('focus', handleVisibilityOrFocus);
      document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
      window.clearInterval(pollInterval);
      if (channel && typeof (supabase as any).removeChannel === 'function') {
        supabase.removeChannel(channel);
      }
    };
  }, [user, authLoading, loadAll, clearAll, supabase, sessionKey]);

  const refresh = useCallback(async () => {
    inFlightRef.current = null;
    await loadAll();
  }, [loadAll]);

  // -------------------------------------------------------------------------
  // Mutation helper — runs a Supabase mutation, surfaces failures as error
  // toasts and returns the resulting row (or null).
  // -------------------------------------------------------------------------
  const runMutation = useCallback(
    async <T,>(label: string, fn: (client: SupabaseClient) => PromiseLike<{ data: T | null; error: PostgrestError | null }>, unconfirmedMessage?: string): Promise<T | null> => {
      try {
        const { data, error } = await fn(supabase);
        if (error) {
          console.error(`${label} failed:`, error.message);
          showToast('error', unconfirmedMessage || `${label} failed: ${error.message}`);
          return null;
        }
        if (data === null && unconfirmedMessage) showToast('error', unconfirmedMessage);
        return data;
      } catch (e: any) {
        console.error(`${label} threw:`, e);
        showToast('error', unconfirmedMessage || `${label} failed: ${e?.message || 'Supabase request error'}`);
        return null;
      }
    },
    [supabase, showToast]
  );

  /**
   * Appends an entry to the audit trail for a money-relevant mutation.
   *
   * Failures are surfaced, never swallowed: the ledger write has already
   * succeeded at this point, so saying "saved" without mentioning the missing
   * trail entry would be a lie about the state of the books.
   */
  const recordAudit = useCallback(
    async (entry: Omit<AuditEntry, 'actorId' | 'actorEmail'>) => {
      const result = await writeAuditEntry(supabase, {
        ...entry,
        actorId: user?.id ?? null,
        actorEmail: user?.email ?? null,
      });
      if (!result.ok) {
        console.error('Audit trail write failed:', result.error);
        showToast('error', auditFailureMessage('This change', result.error));
      }
    },
    [supabase, user, showToast]
  );

  // --- PROJECT ACTIONS ---
  // Direct project RETURNING queries use only public project columns. The
  // role-aware RPC re-reads the authoritative row after a confirmed write.
  const projectPublicColumns = 'id,name,location,status,start_date,target_completion_date,created_at';
  const readProjectAfterWrite = async (id: string): Promise<Project | null> => {
    const row = await runMutation('Reload project', (db) =>
      db.rpc('visible_projects').eq('id', id).maybeSingle(),
      'The project may have been saved, but its details could not be reloaded. Refresh and check before retrying.'
    );
    return row ? mapProject(row) : null;
  };

  const createProject = async (data: Omit<Project, 'id' | 'created_at'>): Promise<Project | null> => {
    const row = await runMutation<{id:string}>('Create project', (db) =>
      db.from('projects').insert(data).select(projectPublicColumns).single(),
      'Project creation was not confirmed. Refresh and check the project list before retrying.'
    );
    if (!row) return null;
    const mapped = await readProjectAfterWrite(row.id);
    if (mapped) setProjects((prev) => [mapped, ...prev.filter((p) => p.id !== mapped.id)]);
    return mapped;
  };

  const updateProject = async (id: string, data: Partial<Project>): Promise<Project | null> => {
    const row = await runMutation<{id:string}>('Update project', (db) =>
      db.from('projects').update(data).eq('id', id).select(projectPublicColumns).single(),
      'Project update was not confirmed. Refresh and check the project before retrying.'
    );
    if (!row) return null;
    const mapped = await readProjectAfterWrite(row.id);
    if (mapped) setProjects((prev) => prev.map((p) => (p.id === id ? mapped : p)));
    return mapped;
  };

  const deleteProject = async (id: string): Promise<boolean> => {
    // Require the deleted row before changing local state: a zero-row response
    // (including one caused by RLS) does not prove anything was removed.
    const result = await confirmProjectDeletion(id, () =>
      supabase.from('projects').delete().eq('id', id).select('id').maybeSingle()
    );
    if (!result.confirmed) {
      showToast('error', result.error || 'Project deletion was not confirmed.');
      return false;
    }
    setProjects((prev) => prev.filter((p) => p.id !== id));
    return true;
  };

  const getProjectById = (id: string) => projects.find((p) => p.id === id);

  const getProjectsForSupervisor = (supervisorId: string): Project[] => {
    const assignedIds = projectSupervisors
      .filter((ps) => ps.supervisor_id === supervisorId)
      .map((ps) => ps.project_id);
    return projects.filter((p) => assignedIds.includes(p.id));
  };

  // --- CLIENT ACTIONS ---
  const createClient = async (data: Omit<Client, 'id' | 'created_at'>): Promise<Client | null> => {
    const row = await runMutation('Create client', (db) =>
      db.from('clients').insert(data).select().single()
    );
    const mapped = row ? mapClient(row) : null;
    if (mapped) setClients((prev) => [mapped, ...prev]);
    return mapped;
  };

  const updateClient = async (id: string, data: Partial<Client>): Promise<Client | null> => {
    const row = await runMutation('Update client', (db) =>
      db.from('clients').update(data).eq('id', id).select().single()
    );
    const mapped = row ? mapClient(row) : null;
    if (mapped) setClients((prev) => prev.map((c) => (c.id === id ? mapped : c)));
    return mapped;
  };

  const deleteClient = async (id: string): Promise<boolean> => {
    const ok = await runMutation('Delete client', async (db) => {
      const { error } = await db.from('clients').delete().eq('id', id);
      return { data: !error, error };
    });
    if (ok) {
      setClients((prev) => prev.filter((c) => c.id !== id));
      return true;
    }
    return false;
  };

  // --- WORKER ACTIONS ---
  const createWorker = async (
    data: Omit<Worker, 'id' | 'created_at'> & { id?: string }
  ): Promise<Worker | null> => {
    if (user?.role === 'supervisor') {
      try {
        const response = await fetch('/api/workers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        const result = (await response.json().catch(() => ({}))) as {
          ok?: boolean;
          worker?: Record<string, unknown>;
          error?: string;
        };
        if (!response.ok || !result.ok || !result.worker) {
          showToast('error', result.error || 'Could not register worker.');
          return null;
        }
        const mapped = mapWorker(result.worker);
        setWorkers((prev) => {
          const exists = prev.some((w) => w.id === mapped.id);
          return exists ? prev.map((w) => (w.id === mapped.id ? mapped : w)) : [...prev, mapped];
        });
        return mapped;
      } catch {
        showToast('error', 'Could not contact the server to register worker.');
        return null;
      }
    }

    const row = await runMutation('Create worker', (db) =>
      db.from('workers').upsert(data, { onConflict: 'id' }).select().single()
    );
    const mapped = row ? mapWorker(row) : null;
    if (mapped) {
      setWorkers((prev) => {
        const exists = prev.some((w) => w.id === mapped.id);
        return exists ? prev.map((w) => (w.id === mapped.id ? mapped : w)) : [...prev, mapped];
      });
    }
    return mapped;
  };

  const updateWorker = async (id: string, data: Partial<Worker>): Promise<Worker | null> => {
    const row = await runMutation('Update worker', (db) =>
      db.from('workers').update(data).eq('id', id).select().single()
    );
    const mapped = row ? mapWorker(row) : null;
    if (mapped) setWorkers((prev) => prev.map((w) => (w.id === id ? mapped : w)));
    return mapped;
  };

  const toggleWorkerStatus = async (id: string): Promise<boolean> => {
    const current = workers.find((w) => w.id === id);
    if (!current) {
      showToast('error', 'Worker not found in the current ledger snapshot.');
      return false;
    }
    const row = await runMutation('Toggle worker status', (db) =>
      db.from('workers').update({ active: !current.active }).eq('id', id).select().single()
    );
    const mapped = row ? mapWorker(row) : null;
    if (mapped) setWorkers((prev) => prev.map((w) => (w.id === id ? mapped : w)));
    return Boolean(mapped);
  };

  // --- INVOICE ACTIONS ---
  const createInvoice = async (data: Omit<Invoice, 'id' | 'created_at'>): Promise<Invoice | null> => {
    const row = await runMutation('Create invoice', (db) =>
      db.from('invoices').insert(data).select().single()
    );
    const mapped = row ? mapInvoice(row) : null;
    if (mapped) {
      setInvoices((prev) => [mapped, ...prev]);
      await recordAudit({
        action: 'insert',
        table: 'invoices',
        recordId: mapped.id,
        before: null,
        after: mapped as unknown as Record<string, unknown>,
      });
    }
    return mapped;
  };

  const updateInvoice = async (id: string, data: Partial<Invoice>): Promise<Invoice | null> => {
    // Keep legacy financial-edit behavior, but never derive a status for a
    // reminder-only change from a stale browser snapshot.
    const current = invoices.find((invoice) => invoice.id === id);
    if (current && data.status === undefined && (data.amount !== undefined || data.amount_paid !== undefined)) {
      const total = data.amount !== undefined ? Number(data.amount) : current.amount;
      const paid = data.amount_paid !== undefined ? Number(data.amount_paid) : current.amount_paid;
      if (paid >= total && total > 0) data = { ...data, status: 'paid' };
      else if (paid > 0 && paid < total) data = { ...data, status: 'partially_paid' };
    }

    // Snapshot BEFORE the write: this is what the trail diffs against.
    const before = invoices.find((i) => i.id === id) ?? null;

    const row = await runMutation('Update invoice', (db) =>
      db.from('invoices').update(data).eq('id', id).select().single()
    );
    const mapped = row ? mapInvoice(row) : null;
    if (mapped) {
      setInvoices((prev) => prev.map((i) => (i.id === id ? mapped : i)));
      await recordAudit({
        action: 'update',
        table: 'invoices',
        recordId: id,
        before: before as unknown as Record<string, unknown> | null,
        after: mapped as unknown as Record<string, unknown>,
      });
    }
    return mapped;
  };

  const recordInvoicePayment = async (invoice: Invoice, amount: string): Promise<InvoicePaymentResult> => {
    const payment = prepareInvoicePayment(invoice, amount);
    if (!payment) return 'invalid';

    // The database applies this as ONE conditional update. If another updated
    // client changed the reviewed financial state first, this matches no row.
    // This does not stop old clients or privileged integrations bypassing it.
    let row: unknown;
    try {
      const result = await supabase.from('invoices')
        .update({ amount_paid: payment.amountPaid, status: payment.status })
        .eq('id', invoice.id)
        .eq('amount', invoice.amount)
        .eq('amount_paid', invoice.amount_paid)
        .eq('status', invoice.status)
        .select().maybeSingle();
      if (result.error) return 'unconfirmed';
      if (!result.data) return 'stale';
      row = result.data;
    } catch {
      // A lost response does not prove the update failed. Never auto-retry.
      return 'unconfirmed';
    }

    const mapped = mapInvoice(row);
    setInvoices((prev) => prev.map((current) => current.id === mapped.id ? mapped : current));
    // Existing audit writes remain separate. Failure cannot roll the payment
    // back, so the UI must not invite another payment attempt.
    try {
      const audit = await writeAuditEntry(supabase, {
        actorId: user?.id ?? null, actorEmail: user?.email ?? null,
        action: 'update', table: 'invoices', recordId: invoice.id,
        before: invoice as unknown as Record<string, unknown>,
        after: mapped as unknown as Record<string, unknown>,
      });
      return audit.ok ? 'recorded' : 'audit_unconfirmed';
    } catch {
      return 'audit_unconfirmed';
    }
  };

  const deleteInvoice = async (id: string): Promise<boolean> => {
    const before = invoices.find((i) => i.id === id) ?? null;
    const ok = await runMutation('Delete invoice', async (db) => {
      const { error } = await db.from('invoices').delete().eq('id', id);
      return { data: !error, error };
    });
    if (ok) {
      setInvoices((prev) => prev.filter((i) => i.id !== id));
      // A deletion with no snapshot would be an untraceable gap in the books.
      await recordAudit({
        action: 'delete',
        table: 'invoices',
        recordId: id,
        before: before as unknown as Record<string, unknown> | null,
        after: null,
      });
      return true;
    }
    return false;
  };

  // --- EXPENSE ACTIONS ---
  const createExpense = async (data: Omit<Expense, 'id' | 'created_at'>, recordId?: string): Promise<Expense | null> => {
    const insertData: Omit<Expense, 'id' | 'created_at'> & { id?: string } = recordId ? { ...data, id: recordId } : data;
    const row = await runMutation('Record expense', (db) =>
      db.from('expenses').insert(insertData).select().single()
    );
    const mapped = row ? mapExpense(row) : null;
    if (mapped) {
      setExpenses((prev) => [mapped, ...prev]);
      await recordAudit({
        action: 'insert',
        table: 'expenses',
        recordId: mapped.id,
        before: null,
        after: mapped as unknown as Record<string, unknown>,
      });
    }
    return mapped;
  };

  const updateExpense = async (id: string, data: Partial<Expense>, expectedRevision?: number): Promise<Expense | null> => {
    const before = expenses.find((e) => e.id === id) ?? null;
    const row = await runMutation('Update expense', (db) =>
      (expectedRevision === undefined ? db.from('expenses').update(data).eq('id', id) : db.from('expenses').update(data).eq('id', id).eq('revision', expectedRevision)).select().single()
    );
    const mapped = row ? mapExpense(row) : null;
    if (mapped) {
      setExpenses((prev) => prev.map((e) => (e.id === id ? mapped : e)));
      await recordAudit({
        action: 'update',
        table: 'expenses',
        recordId: id,
        before: before as unknown as Record<string, unknown> | null,
        after: mapped as unknown as Record<string, unknown>,
      });
    }
    return mapped;
  };

  const deleteExpense = async (id: string): Promise<boolean> => {
    const before = expenses.find((e) => e.id === id) ?? null;
    const ok = await runMutation('Delete expense', async (db) => {
      const { error } = await db.from('expenses').delete().eq('id', id);
      return { data: !error, error };
    });
    if (ok) {
      setExpenses((prev) => prev.filter((e) => e.id !== id));
      await recordAudit({
        action: 'delete',
        table: 'expenses',
        recordId: id,
        before: before as unknown as Record<string, unknown> | null,
        after: null,
      });
      return true;
    }
    return false;
  };

  // --- BALE / ADVANCES ACTIONS ---
  const createAdvance = async (
    data: Omit<Advance, 'id' | 'created_at' | 'amount_deducted' | 'status'>
  ): Promise<Advance | null> => {
    const row = await runMutation('Record bale advance', (db) =>
      db
        .from('advances')
        .insert({ ...data, amount_deducted: 0, status: 'active' })
        .select()
        .single()
    );
    const mapped = row ? mapAdvance(row) : null;
    if (mapped) {
      setAdvances((prev) => [mapped, ...prev]);
      await recordAudit({
        action: 'insert',
        table: 'advances',
        recordId: mapped.id,
        before: null,
        after: mapped as unknown as Record<string, unknown>,
      });
    }
    return mapped;
  };

  const createAdvanceRequest = async (data: {
    worker_id: string;
    project_id: string;
    requested_amount: number;
    request_id?: string;
    request_period_start?: string;
  }): Promise<AdvanceRequest | null> => {
    if (!user?.id || (Boolean(data.request_id) !== Boolean(data.request_period_start)) || !Number.isFinite(data.requested_amount) || data.requested_amount <= 0) {
      showToast('error', 'Enter a valid requested amount before submitting.');
      return null;
    }

    const requestSession=activeSessionRef.current;
    if (!requestSession) return null;
    const response = await runMutation('Submit Bale request', (db) => data.request_id
      ? db.rpc('submit_weekly_bale_request', {p_request:data.request_id, p_worker:data.worker_id, p_project:data.project_id, p_amount:round2(data.requested_amount), p_period_start:data.request_period_start})
      : db.from('advance_requests')
        .insert({
          worker_id: data.worker_id,
          project_id: data.project_id,
          requested_amount: round2(data.requested_amount),
          submitted_by: user.id,
        })
        .select()
        .single(),
      'Bale request not confirmed. Check the request list before retrying.'
    );
    if (activeSessionRef.current!==requestSession) return null;
    const row = data.request_id ? (response && typeof response.replayed === 'boolean' ? response.request : null) : response;
    const mapped = row ? mapAdvanceRequest(row) : null;
    if (!mapped || typeof mapped.id !== 'string' || !mapped.id || (data.request_id && mapped.id !== data.request_id) || mapped.worker_id !== data.worker_id ||
        mapped.project_id !== data.project_id || mapped.submitted_by !== user.id ||
        mapped.requested_amount !== round2(data.requested_amount)) return null;
    setAdvanceRequests((prev) => mergeLoadedBaleRequest(prev,mapped));
    // A locally merged response can shift the bounded view; only a fresh
    // count-backed load can establish its omission warning again.
    setBaleRequestCoverage(null);
    // Supersede any load started before the write so it cannot republish an
    // older queue after this response. A failed reread stays visibly stale.
    void refresh();
    showToast('success', data.request_id && response?.replayed ? 'Existing Bale request confirmed. Check its current status.' : 'Bale request sent to the Founder for approval.');
    return mapped;
  };

  const reviewAdvanceRequest = async (
    id: string,
    decision: 'approve' | 'reject'
  ): Promise<boolean> => {
    const expected = advanceRequests.find(request => request.id === id);
    const actor = user?.id;
    const requestSession = activeSessionRef.current;
    if (!expected || !actor || !requestSession || expected.status !== 'pending_approval') return false;
    const row = await runMutation<unknown>('Review Bale request', (db) =>
      db.rpc('review_advance_request', {
        p_request_id: id,
        p_decision: decision,
      }),
      'Review not confirmed. Check the request status before retrying.'
    );
    if (activeSessionRef.current !== requestSession) return false;
    let mapped: AdvanceRequest;
    try {
      mapped = verifyBaleReviewRows(Array.isArray(row) ? row : [row], [expected], decision, actor)[0];
    } catch {
      showToast('error', 'Review not confirmed. It may have been recorded; check the request status before retrying.');
      return false;
    }

    setAdvanceRequests((prev) => prev.map((request) =>
      request.id === id && request.status === expected.status && request.updated_at === expected.updated_at ? mapped : request
    ));
    showToast(
      'success',
      decision === 'approve'
        ? 'Request approved. It is now waiting to be paid.'
        : 'Bale request rejected.'
    );
    return true;
  };

  const approveAdvanceRequests = async (ids: string[]): Promise<boolean> => {
    const requestIds = Array.from(new Set(ids));
    if (requestIds.length === 0 || requestIds.length !== ids.length) {
      showToast('error', 'Select a unique set of requests before approving.');
      return false;
    }

    const actor = user?.id;
    const requestSession = activeSessionRef.current;
    const expected = requestIds.map(id => advanceRequests.find(request => request.id === id));
    if (!actor || !requestSession || expected.some(request => !request || request.status !== 'pending_approval') || new Set(expected.map(request => request?.project_id)).size !== 1) return false;
    const rows = await runMutation<unknown>('Approve selected Bale requests', (db) =>
      db.rpc('approve_advance_requests', { p_request_ids: requestIds }),
      'Batch approval not confirmed. Check every request status before retrying.'
    );
    if (activeSessionRef.current !== requestSession) return false;
    let mappedRows: AdvanceRequest[];
    try {
      mappedRows = verifyBaleReviewRows(rows, expected as AdvanceRequest[], 'approve', actor);
    } catch {
      showToast('error', 'Batch approval not confirmed. It may have been recorded; check every request status before retrying.');
      return false;
    }

    const updatedById = new Map(mappedRows.map((request) => [request.id, request]));
    const expectedById = new Map((expected as AdvanceRequest[]).map(request => [request.id, request]));
    setAdvanceRequests((prev) => prev.map((request) => {
      const prior = expectedById.get(request.id);
      return prior && request.status === prior.status && request.updated_at === prior.updated_at
        ? updatedById.get(request.id) ?? request : request;
    }));
    showToast(
      'success',
      `${mappedRows.length} request${mappedRows.length === 1 ? '' : 's'} approved. Payment is still awaiting confirmation.`
    );
    return true;
  };

  const markUserNotificationsRead = async (ids: string[]): Promise<boolean> => {
    const requestedIds = Array.from(new Set(ids)).filter((id) =>
      userNotifications.some((notification) => notification.id === id && !notification.read_at)
    );
    if (requestedIds.length === 0) return true;

    const rows = await runMutation<any[]>('Mark notifications as read', (db) =>
      db
        .from('user_notifications')
        .update({ read_at: new Date().toISOString() })
        .in('id', requestedIds)
        .select('*')
    );
    if (!rows) return false;

    const mappedRows = rows.map(mapUserNotification);
    if (mappedRows.length !== requestedIds.length) {
      showToast('error', 'Some alerts could not be marked read. Please refresh and try again.');
      return false;
    }

    const updatedById = new Map(mappedRows.map((notification) => [notification.id, notification]));
    setUserNotifications((previous) =>
      previous.map((notification) => updatedById.get(notification.id) ?? notification)
    );
    return true;
  };

  const issueAdvanceRequest = async (id: string): Promise<boolean> => {
    const issuedAdvanceId = await runMutation<string>('Issue approved Bale request', (db) =>
      db.rpc('issue_advance_request', { p_request_id: id })
    );
    if (!issuedAdvanceId) return false;

    showToast('success', 'Payment recorded and added to issued advances.');
    await refresh();
    return true;
  };

  const recordAdvanceDeduction = async (id: string, deductionAmount: number): Promise<boolean> => {
    const row = await runMutation('Record advance deduction', (db) =>
      db.rpc('record_advance_deduction_atomic', { p_advance_id: id, p_amount: deductionAmount })
    );
    if (row) {
      const mapped = mapAdvance(row);
      setAdvances((prev) => prev.map((a) => (a.id === id ? mapped : a)));
    }
    // A lost response may hide a committed manual deduction. Refresh before
    // any retry; unlike payroll payment, manual deductions are not idempotent.
    await refresh();
    return Boolean(row);
  };

  const updateAdvanceStatus = async (id: string, status: Advance['status']): Promise<boolean> => {
    const row = await runMutation('Update advance status', (db) =>
      db.rpc('set_advance_status_atomic', { p_advance_id: id, p_status: status })
    );
    if (row) {
      const mapped = mapAdvance(row);
      setAdvances((prev) => prev.map((a) => (a.id === id ? mapped : a)));
    }
    await refresh();
    return Boolean(row);
  };

  // --- ATTENDANCE ACTIONS ---
  const recordAttendanceBatch = async (
    records: Array<{
      worker_id: string;
      project_id: string;
      date: string;
      status: AttendanceStatus;
      hours_worked: number;
      notes?: string | null;
      recorded_by: string;
      is_founder_override?: boolean;
    }>
  ): Promise<boolean> => {
    const now = new Date().toISOString();
    const rows = records.map((rec) => ({
      worker_id: rec.worker_id,
      project_id: rec.project_id,
      date: rec.date,
      status: rec.status,
      hours_worked: rec.hours_worked,
      notes: rec.notes || null,
      recorded_by: rec.recorded_by,
      submitted_at: now,
      ...(typeof rec.is_founder_override === 'boolean'
        ? { is_founder_override: rec.is_founder_override }
        : {}),
    }));

    // Upsert keyed on the UNIQUE(worker_id, project_id, date) constraint so
    // re-submitting a day's roster updates existing records.
    const inserted = await runMutation('Submit attendance', (db) =>
      db
        .from('attendance')
        .upsert(rows, { onConflict: 'worker_id,project_id,date' })
        .select()
    );
    if (!inserted) return false;

    const mappedRows = (inserted as any[]).map(mapAttendance);
    setAttendance((prev) => {
      const next = [...prev];
      mappedRows.forEach((row) => {
        const idx = next.findIndex(
          (a) => a.worker_id === row.worker_id && a.project_id === row.project_id && a.date === row.date
        );
        if (idx >= 0) next[idx] = row;
        else next.unshift(row);
      });
      return next;
    });
    return true;
  };

  const updateAttendanceRecord = async (
    id: string,
    data: Partial<Attendance>,
    isFounderOverride = false
  ): Promise<boolean> => {
    const payload: Partial<Attendance> = {
      ...data,
      submitted_at: new Date().toISOString(),
    };
    if (isFounderOverride) {
      payload.is_founder_override = true;
    }
    const row = await runMutation('Update attendance record', (db) =>
      db.from('attendance').update(payload).eq('id', id).select().single()
    );
    const mapped = row ? mapAttendance(row) : null;
    if (mapped) setAttendance((prev) => prev.map((a) => (a.id === id ? mapped : a)));
    return Boolean(mapped);
  };

  const getAttendanceForProjectAndDate = (projectId: string, date: string) => {
    return attendance.filter((a) => a.project_id === projectId && a.date === date);
  };

  // --- PAYROLL ACTIONS ---
  const createPayrollRun = async (
    periodStart: string,
    periodEnd: string,
    projectId?: string
  ): Promise<Payroll[] | null> => {
    if (!periodStart || !periodEnd || periodEnd < periodStart) {
      showToast('error', 'Period end date must be on or after the period start date.');
      return null;
    }

    // Never fall back to the capped shared store: the RPC reads all relevant
    // inputs in one server-side snapshot and fails if its safety limits are exceeded.
    let snapshot;
    try {
      const { data, error } = await supabase.rpc('payroll_input_snapshot', {
        p_period_start: periodStart,
        p_period_end: periodEnd,
        p_project_id: projectId && projectId !== 'all' ? projectId : null,
      });
      if (error) throw new Error(error.message);
      const input = parsePayrollInputSnapshot(data);
      snapshot = {
        attendance: input.attendance.map(mapAttendance),
        workers: input.workers.map(mapWorker),
        projects: input.projects.map(mapProject),
        users: input.users,
        advances: input.advances.map(mapAdvance),
        payroll: input.payroll.map(mapPayroll),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not load payroll inputs.';
      showToast('error', `Payroll not generated: ${message}`);
      return null;
    }
    const targetProject = projectId && projectId !== 'all'
      ? snapshot.projects.find((p) => p.id === projectId)
      : undefined;
    if (projectId && projectId !== 'all' && !targetProject) {
      showToast('error', 'Payroll not generated: the selected project is unavailable. Refresh and choose a valid site.');
      return null;
    }

    // Reuse exact-period draft/reviewed vouchers visible in this snapshot.
    // Concurrent runs are not serialized and can still create duplicates.
    const rowsToInsert: Array<Omit<Payroll, 'id' | 'created_at'>> = [];
    const rowsToUpdate: Array<{ id: string; before: Payroll; patch: Partial<Payroll> }> = [];
    let skippedFinalizedCount = 0;
    let unverifiedSupervisorSelfCount = 0;

    snapshot.workers
      .filter((w) => w.active)
      .forEach((w) => {
        const rawWorkerAtt = snapshot.attendance.filter(
          (a) =>
            a.worker_id === w.id &&
            a.date >= periodStart &&
            a.date <= periodEnd &&
            (!targetProject || a.project_id === targetProject.id)
        );

        // Anti-fraud control: Supervisor attendance for Present/Half-Day must be
        // verified by a Founder (is_founder_override === true) before it counts
        // toward payroll disbursement.
        const isSupervisorWorker =
          w.position.toLowerCase().includes('supervisor') ||
          snapshot.users.some(
            (u) =>
              u.role === 'supervisor' &&
              (u.id === w.id ||
                u.name.trim().toLowerCase() === w.name.trim().toLowerCase())
          );

        const workerAtt = rawWorkerAtt.filter((a) => {
          const isSupRecord =
            a.worker_id === a.recorded_by ||
            (a.notes || '').includes('Pending Founder Review') ||
            isSupervisorWorker;
          const isUnverifiedSelfLog =
            isSupRecord &&
            !a.is_founder_override &&
            (a.status === 'present' || a.status === 'half_day');
          if (isUnverifiedSelfLog) {
            unverifiedSupervisorSelfCount += 1;
            return false;
          }
          return true;
        });

        // Skip workers who logged 0 verified attendance records in the selected period
        // so empty ₱0 payslips are not spammed into the ledger.
        if (workerAtt.length === 0) {
          return;
        }

        // Cap each calendar date at max 1.0 effective day (8 hours) so a
        // Supervisor or worker assigned to two sites on the same day is never
        // double-paid for a single calendar date.
        const dayCreditsByDate = new Map<string, number>();
        workerAtt.forEach((a) => {
          const prev = dayCreditsByDate.get(a.date) || 0;
          const credit = a.status === 'present' ? 1 : a.status === 'half_day' ? 0.5 : 0;
          dayCreditsByDate.set(a.date, Math.min(1, prev + credit));
        });
        const effectiveDays = Array.from(dayCreditsByDate.values()).reduce(
          (sum, val) => sum + val,
          0
        );
        const hoursTotal = effectiveDays * 8;

        const gross = w.pay_rate_type === 'daily' ? effectiveDays * w.pay_rate : hoursTotal * w.pay_rate;

        const activeBales = snapshot.advances.filter(
          (adv) =>
            adv.worker_id === w.id &&
            (adv.status === 'active' || adv.status === 'partially_deducted') &&
            (!targetProject || adv.project_id === targetProject.id)
        );
        const totalBaleOutstanding = activeBales.reduce(
          (sum, adv) => sum + (adv.amount - adv.amount_deducted),
          0
        );

        // Default suggested deduction: either ₱1,500 or 30% of gross pay,
        // capped by the outstanding bale balance.
        let suggestedDeduction = 0;
        if (totalBaleOutstanding > 0 && gross > 0) {
          suggestedDeduction = Math.min(
            totalBaleOutstanding,
            Math.min(1500, Math.floor(gross * 0.3))
          );
        }

        const net = Math.max(0, gross - suggestedDeduction);

        const siteIds = Array.from(new Set(workerAtt.map((a) => a.project_id)));
        const siteNames = siteIds
          .map((pid) => snapshot.projects.find((p) => p.id === pid)?.name)
          .filter(Boolean) as string[];
        const siteLabel = targetProject
          ? ` — Site: ${targetProject.name}`
          : siteNames.length > 0
            ? ` — Site: ${siteNames.join(', ')}`
            : '';

        const existingForPeriod = snapshot.payroll.find(
          (p) =>
            p.worker_id === w.id &&
            p.period_start === periodStart &&
            p.period_end === periodEnd
        );

        if (existingForPeriod) {
          if (existingForPeriod.status === 'approved' || existingForPeriod.status === 'paid') {
            skippedFinalizedCount += 1;
            return;
          }
          rowsToUpdate.push({
            id: existingForPeriod.id,
            before: existingForPeriod,
            patch: {
              gross_pay: Math.round(gross),
              bale_deduction: suggestedDeduction,
              net_pay: Math.round(Math.max(0, gross - suggestedDeduction - existingForPeriod.other_deductions)),
              days_worked: effectiveDays,
              hours_worked: hoursTotal,
              notes: `Auto-computed from ${effectiveDays} days attendance${siteLabel}`,
            },
          });
          return;
        }

        rowsToInsert.push({
          worker_id: w.id,
          period_start: periodStart,
          period_end: periodEnd,
          gross_pay: Math.round(gross),
          bale_deduction: suggestedDeduction,
          other_deductions: 0,
          net_pay: Math.round(net),
          status: 'draft',
          days_worked: effectiveDays,
          hours_worked: hoursTotal,
          notes: `Auto-computed from ${effectiveDays} days attendance${siteLabel}`,
        });
      });

    if (rowsToInsert.length === 0 && rowsToUpdate.length === 0) {
      if (skippedFinalizedCount > 0) {
        showToast(
          'info',
          `Payroll for ${periodStart} → ${periodEnd} is already approved/paid (${skippedFinalizedCount} voucher${skippedFinalizedCount === 1 ? '' : 's'}). No changes were submitted for those finalized vouchers.`
        );
      } else if (unverifiedSupervisorSelfCount > 0) {
        showToast(
          'info',
          `${unverifiedSupervisorSelfCount} Supervisor self-attendance log(s) require Founder verification on the Attendance page before payroll can be computed.`
        );
      } else {
        showToast(
          'error',
          targetProject
            ? `No eligible attendance found for ${targetProject.name} in ${periodStart} → ${periodEnd}.`
            : `No eligible attendance found in ${periodStart} → ${periodEnd}. Check active workers and submitted attendance.`
        );
      }
      return null;
    }

    const resultingRows: Payroll[] = [];

    if (rowsToInsert.length > 0) {
      const inserted = await runMutation('Create payroll run', (db) =>
        db.from('payroll').insert(rowsToInsert).select(),
        'Could not confirm the payroll run. Refresh and inspect vouchers and audit entries before retrying.'
      );
      if (!inserted) return null;
      const mappedInserted = (inserted as any[]).map(mapPayroll).reverse();
      setPayroll((prev) => [...mappedInserted, ...prev]);
      for (const payslip of mappedInserted) {
        await recordAudit({
          action: 'insert',
          table: 'payroll',
          recordId: payslip.id,
          before: null,
          after: payslip as unknown as Record<string, unknown>,
        });
      }
      resultingRows.push(...mappedInserted);
      if (mappedInserted.length !== rowsToInsert.length) {
        showToast('error', 'Payroll response was incomplete. Some vouchers may have been created without audit entries. Refresh and inspect the ledger and audit before retrying.');
        await refresh();
        return null;
      }
    }

    let failedUpdates = 0;
    if (rowsToUpdate.length > 0) {
      for (const item of rowsToUpdate) {
        const updatedRow = await runMutation('Recalculate draft payroll', (db) =>
          db.from('payroll').update(item.patch).eq('id', item.id).eq('status', item.before.status).select().single()
        );
        if (updatedRow) {
          const mappedUpdated = mapPayroll(updatedRow);
          setPayroll((prev) => prev.some((p) => p.id === item.id) ? prev.map((p) => (p.id === item.id ? mappedUpdated : p)) : [mappedUpdated, ...prev]);
          await recordAudit({
            action: 'update',
            table: 'payroll',
            recordId: item.id,
            before: item.before as unknown as Record<string, unknown>,
            after: mappedUpdated as unknown as Record<string, unknown>,
          });
          resultingRows.push(mappedUpdated);
        } else {
          failedUpdates += 1;
        }
      }
    }

    if (failedUpdates > 0) {
      showToast('error', `Could not confirm ${failedUpdates} voucher update(s). Refresh and inspect the ledger and audit before retrying.`);
      await refresh();
      return null;
    }

    if (rowsToInsert.length > 0 && rowsToUpdate.length > 0) {
      showToast(
        'success',
        `Created ${rowsToInsert.length} new voucher(s) and refreshed ${rowsToUpdate.length} existing draft voucher(s).`
      );
    } else if (rowsToUpdate.length > 0) {
      showToast(
        'success',
        `Refreshed ${rowsToUpdate.length} existing draft payroll voucher(s) for ${periodStart} → ${periodEnd}.`
      );
    } else {
      showToast('success', `Generated ${rowsToInsert.length} payroll voucher(s) for ${periodStart} → ${periodEnd}.`);
    }

    return resultingRows;
  };

  const updatePayrollStatus = async (id: string, status: Payroll['status']): Promise<boolean> => {
    // No client-side fallback: if the transactional migration is missing, fail
    // closed rather than recording only one side of a financial transaction.
    const result = await runMutation<{ payroll: any; advances: any[]; outcome: string }>(
      'Update payroll status', (db) =>
        db.rpc('set_payroll_status_atomic', { p_payroll_id: id, p_status: status })
    );
    if (result?.payroll) {
      const mapped = mapPayroll(result.payroll);
      setPayroll((prev) => prev.map((p) => (p.id === id ? mapped : p)));
      const changed = (result.advances || []).map(mapAdvance);
      setAdvances((prev) => prev.map((a) => changed.find((updated) => updated.id === a.id) || a));
    }
    // Also refresh after an unconfirmed response, which may have committed.
    await refresh();
    return Boolean(result?.payroll);
  };

  // --- TOOLS ACTIONS ---
  const createTool = async (data: Omit<Tool, 'id' | 'created_at'>): Promise<Tool | null> => {
    const row = await runMutation('Create tool', (db) =>
      db.from('tools').insert(data).select().single()
    );
    const mapped = row ? mapTool(row) : null;
    if (mapped) setTools((prev) => [mapped, ...prev]);
    return mapped;
  };

  const updateTool = async (id: string, data: Partial<Tool>): Promise<Tool | null> => {
    const row = await runMutation('Update tool', (db) =>
      db.from('tools').update(data).eq('id', id).select().single()
    );
    const mapped = row ? mapTool(row) : null;
    if (mapped) setTools((prev) => prev.map((t) => (t.id === id ? mapped : t)));
    return mapped;
  };

  const deleteTool = async (id: string): Promise<boolean> => {
    const ok = await runMutation('Delete tool', async (db) => {
      const { error } = await db.from('tools').delete().eq('id', id);
      return { data: !error, error };
    });
    if (ok) {
      setTools((prev) => prev.filter((t) => t.id !== id));
      return true;
    }
    return false;
  };

  // --- SMS ACTIONS ---
  const sendSMS = async (params: {
    invoiceId?: string;
    clientId?: string;
    message: string;
  }): Promise<boolean> => {
    try {
      // The server resolves the authoritative recipient (invoice → client or
      // client record), normalizes the phone number, dispatches through the
      // gateway, and records the honest outcome in sms_logs itself.
      const res = await fetch('/api/sms/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });

      const result: {
        success?: boolean;
        simulated?: boolean;
        uncertain?: boolean;
        logUpdateFailed?: boolean;
        error?: string | null;
        log?: SMSLog | null;
      } | null = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(result?.error || `SMS gateway responded with status ${res.status}`);
      }

      if (result?.log) {
        const logRow = result.log;
        setSmsLogs((prev) => [logRow, ...prev.filter((l) => l.id !== logRow.id)]);
      }

      if (!result) {
        showToast('error', 'SMS outcome is unconfirmed. Check the provider and dispatch history before retrying.');
        return false;
      }
      if (result?.logUpdateFailed) {
        showToast('error', 'SMS log update was not confirmed. Check the provider and dispatch history before retrying.');
      }
      if (result?.simulated) {
        showToast(
          'info',
          'PHILSMS_API_KEY is not configured — the message was logged in simulation mode and has not left the server.'
        );
      } else if (result?.uncertain) {
        showToast('error', 'SMS outcome is unconfirmed. Check the provider and dispatch history before retrying; the message may have been sent.');
      } else if (!result?.success) {
        showToast('error', `SMS dispatch failed: ${result?.error || 'gateway error'}`);
      }
      return Boolean(result?.success);
    } catch (e: any) {
      showToast('error', `SMS outcome not confirmed: ${e?.message || 'network error'}. Check the provider and dispatch history before retrying.`);
      return false;
    }
  };

  // --- ANALYTICS ---
  const getFounderMetrics = () => {
    const totalProjects = projects.length;
    const activeProjects = projects.filter((p) => p.status === 'active').length;

    const totalInvoiced = invoices.reduce((sum, i) => sum + Number(i.amount || 0), 0);
    const totalCollected = invoices.reduce((sum, i) => sum + Number(i.amount_paid || 0), 0);
    const totalOutstanding = Math.max(0, totalInvoiced - totalCollected);

    const today = manilaDateISO();
    const overdueInvoices = invoices.filter((i) => isInvoiceOverdue(i, today));
    const totalOverdue = overdueInvoices.reduce(
      (sum, i) => sum + (Number(i.amount) - Number(i.amount_paid)),
      0
    );

    const totalExpenses = expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);

    const expensesByCategory: Record<ExpenseCategory, number> = {
      materials: 0,
      labor: 0,
      equipment: 0,
      permits: 0,
      transportation: 0,
      other: 0,
    };

    expenses.forEach((e) => {
      if (expensesByCategory[e.category] !== undefined) {
        expensesByCategory[e.category] += Number(e.amount || 0);
      }
    });

    const pendingPayroll = payroll.filter(
      (p) => p.status === 'draft' || p.status === 'reviewed' || p.status === 'approved'
    );
    const totalPayrollPending = pendingPayroll.reduce((sum, p) => sum + Number(p.net_pay || 0), 0);

    const totalBaleBalance = advances
      .filter((a) => a.status === 'active' || a.status === 'partially_deducted')
      .reduce((sum, a) => sum + (Number(a.amount) - Number(a.amount_deducted)), 0);

    const projectFinancials = projects.map((p) => {
      const projInvoices = invoices.filter((i) => i.project_id === p.id);
      const projExpenses = expenses.filter((e) => e.project_id === p.id);

      const pInvoiced = projInvoices.reduce((sum, i) => sum + Number(i.amount || 0), 0);
      const pCollected = projInvoices.reduce((sum, i) => sum + Number(i.amount_paid || 0), 0);
      const pExpTotal = projExpenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
      const pProfit = pCollected - pExpTotal;
      const margin = pCollected > 0 ? (pProfit / pCollected) * 100 : 0;

      return {
        id: p.id,
        name: p.name,
        budget: p.budget_estimate ?? 0,
        invoiced: pInvoiced,
        collected: pCollected,
        expenses: pExpTotal,
        profit: pProfit,
        margin: Math.round(margin * 10) / 10,
      };
    });

    return {
      totalProjects,
      activeProjects,
      totalInvoiced,
      totalCollected,
      totalOutstanding,
      totalOverdue,
      overdueInvoicesCount: overdueInvoices.length,
      totalExpenses,
      expensesByCategory,
      totalPayrollPending,
      totalBaleBalance,
      projectFinancials,
    };
  };

  return (
    <DataStoreContext.Provider
      value={{
        projects,
        invoices,
        expenses,
        workers,
        clients,
        advances,
        advanceRequests,
        baleRequestCoverage,
        userNotifications,
        attendance,
        payroll,
        tools,
        smsLogs,
        projectSupervisors,
        users,
        isLoaded,
        isLoading,
        loadError,
        refresh,
        createProject,
        updateProject,
        deleteProject,
        getProjectById,
        getProjectsForSupervisor,
        createClient,
        updateClient,
        deleteClient,
        createWorker,
        updateWorker,
        toggleWorkerStatus,
        createInvoice,
        updateInvoice,
        recordInvoicePayment,
        deleteInvoice,
        createExpense,
        updateExpense,
        deleteExpense,
        createAdvance,
        createAdvanceRequest,
        reviewAdvanceRequest,
        approveAdvanceRequests,
        issueAdvanceRequest,
        markUserNotificationsRead,
        recordAdvanceDeduction,
        updateAdvanceStatus,
        recordAttendanceBatch,
        updateAttendanceRecord,
        getAttendanceForProjectAndDate,
        createPayrollRun,
        updatePayrollStatus,
        createTool,
        updateTool,
        deleteTool,
        sendSMS,
        getFounderMetrics,
      }}
    >
      {children}
    </DataStoreContext.Provider>
  );
};

export const useDataStore = () => {
  const context = useContext(DataStoreContext);
  if (!context) {
    throw new Error('useDataStore must be used within a DataStoreProvider');
  }
  return context;
};
