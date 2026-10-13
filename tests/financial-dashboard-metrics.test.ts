import { describe, expect, it } from 'vitest';
import type { Advance, Expense, Invoice, Payroll, Project, Tool } from '@/types';
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

const makePayroll = (status: Payroll['status'], net_pay: number): Payroll => ({
  id: `pay-${status}-${net_pay}`,
  worker_id: 'worker-1',
  period_start: '2026-01-01',
  period_end: '2026-01-15',
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
  amount_deducted: number
): Advance => ({
  id: `advance-${status}-${amount}`,
  worker_id: 'worker-1',
  project_id: 'project-1',
  amount,
  amount_deducted,
  reason: 'Test advance',
  date: '2026-01-01',
  status,
  created_at: '2026-01-01T00:00:00.000Z',
});

const makeExpense = (project_id: string, amount: number): Expense => ({
  id: `expense-${project_id}-${amount}`,
  project_id,
  description: 'Recorded materials',
  category: 'materials',
  amount,
  expense_date: '2026-01-10',
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
  it('excludes draft and cancelled invoices and calculates overdue balances from open amounts', () => {
    const metrics = calculateFinancialDashboardMetrics(
      {
        invoices: [
          makeInvoice('overdue', 'pending', 1000, 250, '2026-05-01'),
          makeInvoice('status-overdue', 'overdue', 500, 100, '2026-10-20'),
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

    expect(metrics.receivables.outstanding).toBe(1150);
    expect(metrics.receivables.openInvoiceCount).toBe(2);
    expect(metrics.receivables.overdue).toBe(1150);
    expect(metrics.receivables.overdueInvoiceCount).toBe(2);
  });

  it('separates approved payroll from vouchers needing review and keeps advances separate', () => {
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
});
