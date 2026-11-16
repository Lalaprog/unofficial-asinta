import { describe, expect, it, vi } from 'vitest';
import type {
  Advance,
  AdvanceRequest,
  Attendance,
  Expense,
  Invoice,
  Payroll,
  Project,
  Tool,
} from '@/types';
import { calculateFinancialDashboardMetrics } from '@/lib/dashboard/financialMetrics';

const makeProject = (
  id: string,
  status: Project['status'] = 'active',
  budget_estimate = 1000
): Project => ({
  id,
  name: `Project ${id}`,
  client_id: 'client-1',
  location: 'Laguna',
  budget_estimate,
  status,
  start_date: '2026-01-01',
  target_completion_date: '2026-12-31',
  created_at: '2026-01-01T00:00:00.000Z',
});

const makeInvoice = (
  id: string,
  status: Invoice['status'],
  amount: number,
  amount_paid: number,
  due_date: string,
  project_id = 'project-1'
): Invoice => ({
  id,
  project_id,
  client_id: 'client-1',
  invoice_number: `INV-${id}`,
  amount,
  amount_paid,
  issue_date: '2026-01-01',
  due_date,
  status,
  automatic_reminders_enabled: false,
  reminders_paused_until: null,
  created_at: '2026-01-01T00:00:00.000Z',
});

const makePayroll = (
  status: Payroll['status'],
  net_pay: number,
  worker_id = 'worker-1',
  period_start = '2026-01-01',
  period_end = '2026-01-15'
): Payroll => ({
  id: `pay-${status}-${net_pay}-${worker_id}`,
  worker_id,
  period_start,
  period_end,
  gross_pay: net_pay,
  bale_deduction: 0,
  other_deductions: 0,
  net_pay,
  status,
  created_at: '2026-01-16T00:00:00.000Z',
});

const makeAdvance = (
  status: Advance['status'],
  amount: number,
  amount_deducted: number,
  project_id = 'project-1',
  worker_id = 'worker-1'
): Advance => ({
  id: `advance-${status}-${amount}-${project_id}`,
  worker_id,
  project_id,
  amount,
  amount_deducted,
  reason: 'Test advance',
  date: '2026-01-01',
  status,
  created_at: '2026-01-01T00:00:00.000Z',
});

const makeAdvanceRequest = (
  status: AdvanceRequest['status'],
  requested_amount: number,
  project_id = 'project-1'
): AdvanceRequest => ({
  id: `req-${status}-${requested_amount}-${project_id}`,
  worker_id: 'worker-1',
  project_id,
  requested_amount,
  submitted_by: 'supervisor-1',
  status,
  approved_by: null,
  approved_at: null,
  rejected_by: null,
  rejected_at: null,
  issued_by: null,
  issued_at: null,
  issued_advance_id: null,
  created_at: '2026-10-10T00:00:00.000Z',
  updated_at: '2026-10-10T00:00:00.000Z',
});

const makeAttendance = (
  worker_id: string,
  project_id: string,
  date: string
): Attendance => ({
  id: `att-${worker_id}-${project_id}-${date}`,
  worker_id,
  project_id,
  date,
  status: 'present',
  hours_worked: 8,
  notes: null,
  recorded_by: 'supervisor-1',
  is_founder_override: false,
  submitted_at: '2026-01-10T00:00:00.000Z',
  created_at: '2026-01-10T00:00:00.000Z',
});

const makeExpense = (
  project_id: string,
  amount: number,
  expense_date = '2026-01-10'
): Expense => ({
  id: `expense-${project_id}-${amount}-${expense_date}`,
  project_id,
  description: 'Recorded materials',
  category: 'materials',
  amount,
  expense_date,
  receipt_url: null,
  notes: null,
  ai_category_suggestion: null,
  ai_bale_detection: false,
  ai_confirmed: true,
  created_by: 'founder-1',
  created_at: '2026-01-10T00:00:00.000Z',
});

const makeTool = (condition: Tool['condition'], quantity: number, project_id: string | null): Tool => ({
  id: `tool-${condition}-${quantity}`,
  name: 'Power drill',
  quantity,
  condition,
  project_id,
  created_at: '2026-01-01T00:00:00.000Z',
});

describe('financial dashboard metrics', () => {
  it('defaults to the Philippine business date even when UTC is still the prior day', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-15T16:01:00Z'));
      const metrics=calculateFinancialDashboardMetrics({invoices:[],expenses:[],advances:[],payroll:[],projects:[],tools:[]});
      expect(metrics.asOfDate).toBe('2026-10-16');
    } finally { vi.useRealTimers(); }
  });
  it('excludes draft and cancelled invoices and calculates overdue vs current balances from open amounts', () => {
    const metrics = calculateFinancialDashboardMetrics(
      {
        invoices: [
          makeInvoice('overdue', 'pending', 1000, 250, '2026-05-01'),
          makeInvoice('status-overdue', 'overdue', 500, 100, '2026-10-20'),
          makeInvoice('current-open', 'pending', 600, 100, '2026-11-15'),
          makeInvoice('draft', 'draft', 700, 0, '2026-04-01'),
          makeInvoice('cancelled', 'cancelled', 900, 0, '2026-04-01'),
          makeInvoice('paid', 'paid', 200, 250, '2026-04-01'),
        ],
        payroll: [],
        advances: [],
        projects: [makeProject('project-1')],
        expenses: [],
        tools: [],
      },
      '2026-10-13'
    );

    expect(metrics.receivables.outstanding).toBe(1650);
    expect(metrics.receivables.openInvoiceCount).toBe(3);
    expect(metrics.receivables.overdue).toBe(1150);
    expect(metrics.receivables.overdueInvoiceCount).toBe(2);
    expect(metrics.receivables.currentNotDue).toBe(500);
    expect(metrics.receivables.currentNotDueCount).toBe(1);
  });

  it('separates approved payroll from vouchers needing review and keeps advances and Bale requests separate', () => {
    const metrics = calculateFinancialDashboardMetrics({
      invoices: [],
      payroll: [
        makePayroll('approved', 10000),
        makePayroll('draft', 2500),
        makePayroll('reviewed', 1500),
        makePayroll('paid', 9000),
      ],
      advances: [
        makeAdvance('active', 3000, 500),
        makeAdvance('partially_deducted', 1000, 250),
        makeAdvance('fully_deducted', 600, 600),
        makeAdvance('cancelled', 500, 0),
      ],
      advanceRequests: [
        makeAdvanceRequest('pending_approval', 1200),
        makeAdvanceRequest('approved_pending_payment', 800),
        makeAdvanceRequest('issued', 500),
      ],
      projects: [],
      expenses: [],
      tools: [],
    });

    expect(metrics.payroll.approvedUnpaid).toBe(10000);
    expect(metrics.payroll.approvedUnpaidCount).toBe(1);
    expect(metrics.payroll.needsReview).toBe(4000);
    expect(metrics.payroll.needsReviewCount).toBe(2);
    expect(metrics.advances.outstanding).toBe(3250);
    expect(metrics.advances.count).toBe(2);
    expect(metrics.baleRequests).toEqual({
      pendingApprovalCount: 1,
      pendingApprovalAmount: 1200,
      approvedPendingPaymentCount: 1,
      approvedPendingPaymentAmount: 800,
    });
  });

  it('compares current project estimates with recorded expenses and counts tool units by condition', () => {
    const metrics = calculateFinancialDashboardMetrics({
      invoices: [makeInvoice('site-invoice', 'partially_paid', 800, 200, '2026-12-01')],
      payroll: [],
      advances: [],
      projects: [
        makeProject('project-1', 'active', 1000),
        makeProject('planning', 'planning', 0),
        makeProject('complete', 'completed', 400),
        makeProject('cancelled', 'cancelled', 400),
      ],
      expenses: [makeExpense('project-1', 1200), makeExpense('planning', 100)],
      tools: [
        makeTool('excellent', 3, 'project-1'),
        makeTool('needs_repair', 2, 'project-1'),
        makeTool('damaged', 1, null),
      ],
    });

    expect(metrics.projects.map((project) => project.id)).toEqual(['project-1', 'planning']);
    expect(metrics.projectBudgetEstimateTotal).toBe(1000);
    expect(metrics.projectRecordedExpensesTotal).toBe(1300);
    expect(metrics.projectsOverEstimate.map((project) => project.id)).toEqual(['project-1']);
    expect(metrics.projects[0].spendPercent).toBe(120);
    expect(metrics.projects[1].spendPercent).toBeNull();
    expect(metrics.projects[1].isOverEstimate).toBe(false);
    expect(metrics.projects[0].outstandingInvoices).toBe(600);
    expect(metrics.projects[0].toolConditionCounts).toMatchObject({
      excellent: 3,
      needs_repair: 2,
      damaged: 0,
    });
    expect(metrics.tools).toMatchObject({
      totalUnits: 6,
      needsRepairUnits: 2,
      damagedUnits: 1,
      attentionUnits: 3,
      depotUnits: 1,
      depotAttentionUnits: 1,
    });
  });

  it('computes daily budget burn percentage and smartly falls back to 7-day or latest day activity', () => {
    // Case 1: Expense logged today (2026-10-15) -> activePeriod = 'today'
    const todayMetrics = calculateFinancialDashboardMetrics(
      {
        invoices: [],
        payroll: [],
        advances: [],
        projects: [makeProject('project-1', 'active', 10000)],
        expenses: [
          makeExpense('project-1', 2500, '2026-10-01'),
          makeExpense('project-1', 500, '2026-10-15'),
        ],
        tools: [],
      },
      '2026-10-15'
    );

    expect(todayMetrics.costBurn.activePeriod).toBe('today');
    expect(todayMetrics.costBurn.todayAmount).toBe(500);
    expect(todayMetrics.costBurn.todayBudgetPercent).toBe(5);
    expect(todayMetrics.costBurn.overallSpendPercent).toBe(30);

    // Case 2: ₱0 today, but expense logged 3 days ago -> activePeriod = 'last_7_days'
    const weekMetrics = calculateFinancialDashboardMetrics(
      {
        invoices: [],
        payroll: [],
        advances: [],
        projects: [makeProject('project-1', 'active', 10000)],
        expenses: [makeExpense('project-1', 1250, '2026-10-12')],
        tools: [],
      },
      '2026-10-15'
    );

    expect(weekMetrics.costBurn.activePeriod).toBe('last_7_days');
    expect(weekMetrics.costBurn.activeAmount).toBe(1250);
    expect(weekMetrics.costBurn.activeBudgetPercent).toBe(12.5);

    // Case 3: Older historical expense -> activePeriod = 'latest_day'
    const historicalMetrics = calculateFinancialDashboardMetrics(
      {
        invoices: [],
        payroll: [],
        advances: [],
        projects: [makeProject('project-1', 'active', 10000)],
        expenses: [makeExpense('project-1', 800, '2026-09-01')],
        tools: [],
      },
      '2026-10-15'
    );

    expect(historicalMetrics.costBurn.activePeriod).toBe('latest_day');
    expect(historicalMetrics.costBurn.activeAmount).toBe(800);
    expect(historicalMetrics.costBurn.activeBudgetPercent).toBe(8);
    expect(historicalMetrics.costBurn.referenceDate).toBe('2026-09-01');
  });

  it('scopes receivables, workforce pay, expenses, and tools when a project filter is selected', () => {
    const metrics = calculateFinancialDashboardMetrics(
      {
        invoices: [
          makeInvoice('inv-1', 'overdue', 1000, 0, '2026-10-01', 'project-1'),
          makeInvoice('inv-2', 'pending', 2000, 0, '2026-11-01', 'project-2'),
        ],
        payroll: [
          makePayroll('approved', 6000, 'worker-1', '2026-10-01', '2026-10-15'),
          makePayroll('approved', 4000, 'worker-2', '2026-10-01', '2026-10-15'),
        ],
        attendance: [
          makeAttendance('worker-1', 'project-1', '2026-10-05'),
          makeAttendance('worker-2', 'project-2', '2026-10-05'),
        ],
        advances: [
          makeAdvance('active', 1500, 0, 'project-1', 'worker-1'),
          makeAdvance('active', 900, 0, 'project-2', 'worker-2'),
        ],
        advanceRequests: [
          makeAdvanceRequest('pending_approval', 500, 'project-1'),
          makeAdvanceRequest('pending_approval', 700, 'project-2'),
        ],
        projects: [
          makeProject('project-1', 'active', 10000),
          makeProject('project-2', 'active', 20000),
        ],
        expenses: [
          makeExpense('project-1', 3000, '2026-10-15'),
          makeExpense('project-2', 7000, '2026-10-15'),
        ],
        tools: [
          makeTool('needs_repair', 2, 'project-1'),
          makeTool('damaged', 4, 'project-2'),
          makeTool('good', 5, null),
        ],
        selectedProjectId: 'project-1',
      },
      '2026-10-15'
    );

    expect(metrics.selectedProjectId).toBe('project-1');
    expect(metrics.selectedProject?.name).toBe('Project project-1');
    // All current projects remain available for the selector card
    expect(metrics.projects).toHaveLength(2);
    // Scoped figures reflect project-1 only
    expect(metrics.receivables.outstanding).toBe(1000);
    expect(metrics.payroll.approvedUnpaid).toBe(6000);
    expect(metrics.advances.outstanding).toBe(1500);
    expect(metrics.baleRequests.pendingApprovalCount).toBe(1);
    expect(metrics.projectBudgetEstimateTotal).toBe(10000);
    expect(metrics.projectRecordedExpensesTotal).toBe(3000);
    expect(metrics.costBurn.todayBudgetPercent).toBe(30);
    expect(metrics.tools.attentionUnits).toBe(2);
    expect(metrics.tools.depotUnits).toBe(5);
  });
});
