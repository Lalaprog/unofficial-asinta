import type { Advance, Expense, Invoice, Payroll, Project, Tool, ToolCondition } from '@/types';

export interface ProjectFinancialSummary {
  id: string;
  name: string;
  status: Project['status'];
  budgetEstimate: number;
  recordedExpenses: number;
  spendPercent: number | null;
  isOverEstimate: boolean;
  amountOverEstimate: number;
  outstandingInvoices: number;
  openInvoiceCount: number;
  toolUnits: number;
  toolUnitsNeedingAttention: number;
  toolConditionCounts: Record<ToolCondition, number>;
}

export interface FinancialDashboardMetrics {
  asOfDate: string;
  receivables: {
    outstanding: number;
    openInvoiceCount: number;
    overdue: number;
    overdueInvoiceCount: number;
    overdueInvoices: Invoice[];
  };
  payroll: {
    approvedUnpaid: number;
    approvedUnpaidCount: number;
    needsReview: number;
    needsReviewCount: number;
  };
  advances: {
    outstanding: number;
    count: number;
  };
  projects: ProjectFinancialSummary[];
  projectBudgetEstimateTotal: number;
  projectRecordedExpensesTotal: number;
  projectsOverEstimate: ProjectFinancialSummary[];
  tools: {
    totalUnits: number;
    needsRepairUnits: number;
    damagedUnits: number;
    attentionUnits: number;
    depotUnits: number;
    depotAttentionUnits: number;
  };
}

interface FinancialDashboardInputs {
  invoices: Invoice[];
  payroll: Payroll[];
  advances: Advance[];
  projects: Project[];
  expenses: Expense[];
  tools: Tool[];
}

const TOOL_CONDITIONS: ToolCondition[] = [
  'excellent',
  'good',
  'fair',
  'needs_repair',
  'damaged',
];

function outstandingInvoiceBalance(invoice: Invoice): number {
  return Math.max(0, Number(invoice.amount || 0) - Number(invoice.amount_paid || 0));
}

function activeReceivableInvoices(invoices: Invoice[]): Invoice[] {
  return invoices.filter(
    (invoice) => invoice.status !== 'draft' && invoice.status !== 'cancelled'
  );
}

function emptyToolConditionCounts(): Record<ToolCondition, number> {
  return {
    excellent: 0,
    good: 0,
    fair: 0,
    needs_repair: 0,
    damaged: 0,
  };
}

/**
 * Computes conservative, ledger-backed dashboard totals. It deliberately does
 * not forecast project costs or allocate payroll by site: neither has reliable
 * source data in the current schema.
 */
export function calculateFinancialDashboardMetrics(
  inputs: FinancialDashboardInputs,
  asOfDate = new Date().toISOString().slice(0, 10)
): FinancialDashboardMetrics {
  const eligibleInvoices = activeReceivableInvoices(inputs.invoices);
  const openInvoices = eligibleInvoices.filter(
    (invoice) => outstandingInvoiceBalance(invoice) > 0
  );
  const overdueInvoices = openInvoices
    .filter((invoice) => invoice.status === 'overdue' || invoice.due_date < asOfDate)
    .sort((a, b) => a.due_date.localeCompare(b.due_date));

  const approvedPayroll = inputs.payroll.filter((item) => item.status === 'approved');
  const payrollNeedsReview = inputs.payroll.filter(
    (item) => item.status === 'draft' || item.status === 'reviewed'
  );
  const outstandingAdvances = inputs.advances.filter(
    (advance) => advance.status === 'active' || advance.status === 'partially_deducted'
  );

  const currentProjects = inputs.projects
    .filter((project) => project.status !== 'completed' && project.status !== 'cancelled')
    .sort((a, b) => {
      const statusOrder: Record<Project['status'], number> = {
        active: 0,
        on_hold: 1,
        planning: 2,
        completed: 3,
        cancelled: 4,
      };
      return statusOrder[a.status] - statusOrder[b.status] || a.name.localeCompare(b.name);
    });

  const projectFinancials = currentProjects.map((project): ProjectFinancialSummary => {
    const recordedExpenses = inputs.expenses
      .filter((expense) => expense.project_id === project.id)
      .reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
    const budgetEstimate = Number(project.budget_estimate || 0);
    const projectInvoices = openInvoices.filter((invoice) => invoice.project_id === project.id);
    const projectTools = inputs.tools.filter((tool) => tool.project_id === project.id);
    const toolConditionCounts = emptyToolConditionCounts();

    projectTools.forEach((tool) => {
      toolConditionCounts[tool.condition] += Math.max(0, Number(tool.quantity || 0));
    });

    const toolUnits = TOOL_CONDITIONS.reduce(
      (sum, condition) => sum + toolConditionCounts[condition],
      0
    );
    const toolUnitsNeedingAttention =
      toolConditionCounts.needs_repair + toolConditionCounts.damaged;
    const isOverEstimate = budgetEstimate > 0 && recordedExpenses > budgetEstimate;

    return {
      id: project.id,
      name: project.name,
      status: project.status,
      budgetEstimate,
      recordedExpenses,
      spendPercent: budgetEstimate > 0 ? Math.round((recordedExpenses / budgetEstimate) * 100) : null,
      isOverEstimate,
      amountOverEstimate:
        budgetEstimate > 0 ? Math.max(0, recordedExpenses - budgetEstimate) : 0,
      outstandingInvoices: projectInvoices.reduce(
        (sum, invoice) => sum + outstandingInvoiceBalance(invoice),
        0
      ),
      openInvoiceCount: projectInvoices.length,
      toolUnits,
      toolUnitsNeedingAttention,
      toolConditionCounts,
    };
  });

  const totalToolUnits = inputs.tools.reduce(
    (sum, tool) => sum + Math.max(0, Number(tool.quantity || 0)),
    0
  );
  const needsRepairUnits = inputs.tools
    .filter((tool) => tool.condition === 'needs_repair')
    .reduce((sum, tool) => sum + Math.max(0, Number(tool.quantity || 0)), 0);
  const damagedUnits = inputs.tools
    .filter((tool) => tool.condition === 'damaged')
    .reduce((sum, tool) => sum + Math.max(0, Number(tool.quantity || 0)), 0);
  const depotTools = inputs.tools.filter((tool) => tool.project_id === null);
  const depotUnits = depotTools.reduce(
    (sum, tool) => sum + Math.max(0, Number(tool.quantity || 0)),
    0
  );
  const depotAttentionUnits = depotTools
    .filter((tool) => tool.condition === 'needs_repair' || tool.condition === 'damaged')
    .reduce((sum, tool) => sum + Math.max(0, Number(tool.quantity || 0)), 0);

  return {
    asOfDate,
    receivables: {
      outstanding: openInvoices.reduce(
        (sum, invoice) => sum + outstandingInvoiceBalance(invoice),
        0
      ),
      openInvoiceCount: openInvoices.length,
      overdue: overdueInvoices.reduce(
        (sum, invoice) => sum + outstandingInvoiceBalance(invoice),
        0
      ),
      overdueInvoiceCount: overdueInvoices.length,
      overdueInvoices,
    },
    payroll: {
      approvedUnpaid: approvedPayroll.reduce(
        (sum, item) => sum + Number(item.net_pay || 0),
        0
      ),
      approvedUnpaidCount: approvedPayroll.length,
      needsReview: payrollNeedsReview.reduce(
        (sum, item) => sum + Number(item.net_pay || 0),
        0
      ),
      needsReviewCount: payrollNeedsReview.length,
    },
    advances: {
      outstanding: outstandingAdvances.reduce(
        (sum, advance) =>
          sum + Math.max(0, Number(advance.amount || 0) - Number(advance.amount_deducted || 0)),
        0
      ),
      count: outstandingAdvances.length,
    },
    projects: projectFinancials,
    projectBudgetEstimateTotal: projectFinancials.reduce(
      (sum, project) => sum + project.budgetEstimate,
      0
    ),
    projectRecordedExpensesTotal: projectFinancials.reduce(
      (sum, project) => sum + project.recordedExpenses,
      0
    ),
    projectsOverEstimate: projectFinancials.filter((project) => project.isOverEstimate),
    tools: {
      totalUnits: totalToolUnits,
      needsRepairUnits,
      damagedUnits,
      attentionUnits: needsRepairUnits + damagedUnits,
      depotUnits,
      depotAttentionUnits,
    },
  };
}
