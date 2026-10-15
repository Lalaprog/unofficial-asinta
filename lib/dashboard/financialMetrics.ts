import type {
  Advance,
  AdvanceRequest,
  Attendance,
  Expense,
  Invoice,
  Payroll,
  Project,
  Tool,
  ToolCondition,
} from '@/types';

export interface ProjectFinancialSummary {
  id: string;
  name: string;
  status: Project['status'];
  location: string;
  clientId: string;
  budgetEstimate: number;
  recordedExpenses: number;
  spendPercent: number | null;
  isOverEstimate: boolean;
  amountOverEstimate: number;
  outstandingInvoices: number;
  openInvoiceCount: number;
  overdueInvoices: number;
  overdueInvoiceCount: number;
  toolUnits: number;
  toolUnitsNeedingAttention: number;
  toolConditionCounts: Record<ToolCondition, number>;
}

export type CostBurnPeriod = 'today' | 'last_7_days' | 'latest_day' | 'none';

export interface CostBurnSummary {
  /** Which time window is highlighted by the smart indicator */
  activePeriod: CostBurnPeriod;
  /** Expense amount logged in the active period */
  activeAmount: number;
  /** Number of expense entries in the active period */
  activeCount: number;
  /** Percentage of the scoped budget estimate consumed in the active period (1 decimal place), or null if no budget estimate */
  activeBudgetPercent: number | null;
  /** Percentage share of total recorded expenses in the active period when no budget estimate is set */
  activeSpendSharePercent: number | null;
  /** ISO date reference for the active period */
  referenceDate: string | null;
  /** Expenses logged on asOfDate */
  todayAmount: number;
  todayCount: number;
  todayBudgetPercent: number | null;
  /** Expenses logged in the 7-day window ending on asOfDate */
  last7DaysAmount: number;
  last7DaysCount: number;
  last7DaysBudgetPercent: number | null;
  /** Overall budget utilization % for the active scope */
  overallSpendPercent: number | null;
  isOverEstimate: boolean;
  amountOverEstimate: number;
}

export interface FinancialDashboardMetrics {
  asOfDate: string;
  selectedProjectId: string | null;
  selectedProject: ProjectFinancialSummary | null;
  receivables: {
    outstanding: number;
    openInvoiceCount: number;
    overdue: number;
    overdueInvoiceCount: number;
    overdueInvoices: Invoice[];
    currentNotDue: number;
    currentNotDueCount: number;
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
  baleRequests: {
    pendingApprovalCount: number;
    pendingApprovalAmount: number;
    approvedPendingPaymentCount: number;
    approvedPendingPaymentAmount: number;
  };
  projects: ProjectFinancialSummary[];
  projectBudgetEstimateTotal: number;
  projectRecordedExpensesTotal: number;
  projectsOverEstimate: ProjectFinancialSummary[];
  costBurn: CostBurnSummary;
  tools: {
    totalUnits: number;
    needsRepairUnits: number;
    damagedUnits: number;
    attentionUnits: number;
    depotUnits: number;
    depotAttentionUnits: number;
  };
}

export interface FinancialDashboardInputs {
  invoices: Invoice[];
  payroll: Payroll[];
  advances: Advance[];
  projects: Project[];
  expenses: Expense[];
  tools: Tool[];
  attendance?: Attendance[];
  advanceRequests?: AdvanceRequest[];
  selectedProjectId?: string | null;
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

function shiftIsoDateDays(isoDate: string, deltaDays: number): string {
  const parts = isoDate.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return isoDate;
  const [year, month, day] = parts;
  const utc = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return utc.toISOString().slice(0, 10);
}

function roundOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Resolves the project site(s) associated with a payroll record using:
 * 1. Attendance logged by the worker during the payroll period
 * 2. Project site names recorded in `pay.notes`
 * 3. Fallback to the worker's overall attendance/advance project assignments
 */
export function resolvePayrollProjectIds(
  pay: Payroll,
  projects: Project[],
  attendance: Attendance[] = [],
  advances: Advance[] = []
): Set<string> {
  const periodProjectIds = new Set(
    attendance
      .filter(
        (a) =>
          a.worker_id === pay.worker_id &&
          a.date >= pay.period_start &&
          a.date <= pay.period_end
      )
      .map((a) => a.project_id)
  );

  if (pay.notes) {
    const notesLower = pay.notes.toLowerCase();
    projects.forEach((proj) => {
      if (proj.name && notesLower.includes(proj.name.toLowerCase())) {
        periodProjectIds.add(proj.id);
      }
    });
  }

  if (periodProjectIds.size === 0) {
    attendance
      .filter((a) => a.worker_id === pay.worker_id)
      .forEach((a) => periodProjectIds.add(a.project_id));
    advances
      .filter((adv) => adv.worker_id === pay.worker_id)
      .forEach((adv) => periodProjectIds.add(adv.project_id));
  }

  return periodProjectIds;
}

/**
 * Computes conservative, ledger-backed dashboard totals and supports optional
 * scoping to a single project selected from the dashboard filter card.
 */
export function calculateFinancialDashboardMetrics(
  inputs: FinancialDashboardInputs,
  asOfDate = new Date().toISOString().slice(0, 10)
): FinancialDashboardMetrics {
  const allEligibleInvoices = activeReceivableInvoices(inputs.invoices);
  const allOpenInvoices = allEligibleInvoices.filter(
    (invoice) => outstandingInvoiceBalance(invoice) > 0
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
    const projectInvoices = allOpenInvoices.filter((invoice) => invoice.project_id === project.id);
    const projectOverdueInvoices = projectInvoices.filter(
      (invoice) => invoice.status === 'overdue' || invoice.due_date < asOfDate
    );
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
      location: project.location || '',
      clientId: project.client_id,
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
      overdueInvoices: projectOverdueInvoices.reduce(
        (sum, invoice) => sum + outstandingInvoiceBalance(invoice),
        0
      ),
      overdueInvoiceCount: projectOverdueInvoices.length,
      toolUnits,
      toolUnitsNeedingAttention,
      toolConditionCounts,
    };
  });

  const validSelectedProject =
    inputs.selectedProjectId
      ? projectFinancials.find((project) => project.id === inputs.selectedProjectId) ?? null
      : null;
  const activeProjectId = validSelectedProject ? validSelectedProject.id : null;

  // Scope receivables
  const scopedOpenInvoices = activeProjectId
    ? allOpenInvoices.filter((invoice) => invoice.project_id === activeProjectId)
    : allOpenInvoices;
  const overdueInvoices = scopedOpenInvoices
    .filter((invoice) => invoice.status === 'overdue' || invoice.due_date < asOfDate)
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
  const outstandingTotal = scopedOpenInvoices.reduce(
    (sum, invoice) => sum + outstandingInvoiceBalance(invoice),
    0
  );
  const overdueTotal = overdueInvoices.reduce(
    (sum, invoice) => sum + outstandingInvoiceBalance(invoice),
    0
  );
  const currentNotDueTotal = Math.max(0, outstandingTotal - overdueTotal);
  const currentNotDueCount = Math.max(0, scopedOpenInvoices.length - overdueInvoices.length);

  // Scope payroll & advances & bale requests
  const scopedPayroll = activeProjectId
    ? inputs.payroll.filter((pay) =>
        resolvePayrollProjectIds(
          pay,
          inputs.projects,
          inputs.attendance ?? [],
          inputs.advances
        ).has(activeProjectId)
      )
    : inputs.payroll;

  const approvedPayroll = scopedPayroll.filter((item) => item.status === 'approved');
  const payrollNeedsReview = scopedPayroll.filter(
    (item) => item.status === 'draft' || item.status === 'reviewed'
  );

  const scopedAdvances = activeProjectId
    ? inputs.advances.filter((advance) => advance.project_id === activeProjectId)
    : inputs.advances;
  const outstandingAdvances = scopedAdvances.filter(
    (advance) => advance.status === 'active' || advance.status === 'partially_deducted'
  );

  const allAdvanceRequests = inputs.advanceRequests ?? [];
  const scopedAdvanceRequests = activeProjectId
    ? allAdvanceRequests.filter((req) => req.project_id === activeProjectId)
    : allAdvanceRequests;
  const pendingApprovalRequests = scopedAdvanceRequests.filter(
    (req) => req.status === 'pending_approval'
  );
  const approvedPendingPaymentRequests = scopedAdvanceRequests.filter(
    (req) => req.status === 'approved_pending_payment'
  );

  // Scope projects & expenses
  const scopedProjects = validSelectedProject ? [validSelectedProject] : projectFinancials;
  const projectBudgetEstimateTotal = scopedProjects.reduce(
    (sum, project) => sum + project.budgetEstimate,
    0
  );
  const projectRecordedExpensesTotal = scopedProjects.reduce(
    (sum, project) => sum + project.recordedExpenses,
    0
  );
  const currentProjectIdSet = new Set(scopedProjects.map((project) => project.id));
  const scopedExpenses = inputs.expenses.filter((expense) =>
    currentProjectIdSet.has(expense.project_id)
  );

  // Compute daily + 7-day + latest-day cost velocity
  const sevenDaysAgoDate = shiftIsoDateDays(asOfDate, -6);
  const todayExpenses = scopedExpenses.filter((expense) => expense.expense_date === asOfDate);
  const todayAmount = todayExpenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  const todayBudgetPercent =
    projectBudgetEstimateTotal > 0
      ? roundOneDecimal((todayAmount / projectBudgetEstimateTotal) * 100)
      : null;

  const last7DaysExpenses = scopedExpenses.filter(
    (expense) => expense.expense_date >= sevenDaysAgoDate && expense.expense_date <= asOfDate
  );
  const last7DaysAmount = last7DaysExpenses.reduce(
    (sum, expense) => sum + Number(expense.amount || 0),
    0
  );
  const last7DaysBudgetPercent =
    projectBudgetEstimateTotal > 0
      ? roundOneDecimal((last7DaysAmount / projectBudgetEstimateTotal) * 100)
      : null;

  let activePeriod: CostBurnPeriod = 'none';
  let activeAmount = 0;
  let activeCount = 0;
  let activeBudgetPercent: number | null = projectBudgetEstimateTotal > 0 ? 0 : null;
  let referenceDate: string | null = null;

  if (todayAmount > 0) {
    activePeriod = 'today';
    activeAmount = todayAmount;
    activeCount = todayExpenses.length;
    activeBudgetPercent = todayBudgetPercent;
    referenceDate = asOfDate;
  } else if (last7DaysAmount > 0) {
    activePeriod = 'last_7_days';
    activeAmount = last7DaysAmount;
    activeCount = last7DaysExpenses.length;
    activeBudgetPercent = last7DaysBudgetPercent;
    referenceDate = asOfDate;
  } else if (scopedExpenses.length > 0) {
    const eligibleByDate = scopedExpenses.filter((exp) => exp.expense_date <= asOfDate);
    const pool = eligibleByDate.length > 0 ? eligibleByDate : scopedExpenses;
    const latestDate = pool.reduce(
      (maxDate, exp) => (exp.expense_date > maxDate ? exp.expense_date : maxDate),
      pool[0].expense_date
    );
    const latestDayExpenses = pool.filter((exp) => exp.expense_date === latestDate);
    const latestDayAmount = latestDayExpenses.reduce(
      (sum, exp) => sum + Number(exp.amount || 0),
      0
    );
    activePeriod = 'latest_day';
    activeAmount = latestDayAmount;
    activeCount = latestDayExpenses.length;
    activeBudgetPercent =
      projectBudgetEstimateTotal > 0
        ? roundOneDecimal((latestDayAmount / projectBudgetEstimateTotal) * 100)
        : null;
    referenceDate = latestDate;
  }

  const activeSpendSharePercent =
    projectRecordedExpensesTotal > 0 && activeAmount > 0
      ? roundOneDecimal((activeAmount / projectRecordedExpensesTotal) * 100)
      : null;

  const overallSpendPercent =
    projectBudgetEstimateTotal > 0
      ? Math.round((projectRecordedExpensesTotal / projectBudgetEstimateTotal) * 100)
      : null;
  const isScopeOverEstimate =
    projectBudgetEstimateTotal > 0 && projectRecordedExpensesTotal > projectBudgetEstimateTotal;
  const amountScopeOverEstimate =
    projectBudgetEstimateTotal > 0
      ? Math.max(0, projectRecordedExpensesTotal - projectBudgetEstimateTotal)
      : 0;

  // Scope tools
  const scopedTools = activeProjectId
    ? inputs.tools.filter((tool) => tool.project_id === activeProjectId)
    : inputs.tools;
  const totalToolUnits = scopedTools.reduce(
    (sum, tool) => sum + Math.max(0, Number(tool.quantity || 0)),
    0
  );
  const needsRepairUnits = scopedTools
    .filter((tool) => tool.condition === 'needs_repair')
    .reduce((sum, tool) => sum + Math.max(0, Number(tool.quantity || 0)), 0);
  const damagedUnits = scopedTools
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
    selectedProjectId: activeProjectId,
    selectedProject: validSelectedProject,
    receivables: {
      outstanding: outstandingTotal,
      openInvoiceCount: scopedOpenInvoices.length,
      overdue: overdueTotal,
      overdueInvoiceCount: overdueInvoices.length,
      overdueInvoices,
      currentNotDue: currentNotDueTotal,
      currentNotDueCount,
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
    baleRequests: {
      pendingApprovalCount: pendingApprovalRequests.length,
      pendingApprovalAmount: pendingApprovalRequests.reduce(
        (sum, req) => sum + Number(req.requested_amount || 0),
        0
      ),
      approvedPendingPaymentCount: approvedPendingPaymentRequests.length,
      approvedPendingPaymentAmount: approvedPendingPaymentRequests.reduce(
        (sum, req) => sum + Number(req.requested_amount || 0),
        0
      ),
    },
    projects: projectFinancials,
    projectBudgetEstimateTotal,
    projectRecordedExpensesTotal,
    projectsOverEstimate: scopedProjects.filter((project) => project.isOverEstimate),
    costBurn: {
      activePeriod,
      activeAmount,
      activeCount,
      activeBudgetPercent,
      activeSpendSharePercent,
      referenceDate,
      todayAmount,
      todayCount: todayExpenses.length,
      todayBudgetPercent,
      last7DaysAmount,
      last7DaysCount: last7DaysExpenses.length,
      last7DaysBudgetPercent,
      overallSpendPercent,
      isOverEstimate: isScopeOverEstimate,
      amountOverEstimate: amountScopeOverEstimate,
    },
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
