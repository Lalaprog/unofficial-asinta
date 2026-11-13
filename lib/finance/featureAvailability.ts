/**
 * Temporary UI release gate for unfinished PR #103 features and paid review.
 * Next.js inlines this NEXT_PUBLIC value at build time. It is not authorization
 * or a database safety gate. Only enable on a separately verified deployment
 * after its matching schema, permissions, workflows and recovery plan are ready.
 */
export function financeFoundationEnabled(): boolean {
  return process.env.NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW === 'true';
}

/** Experimental weekly Bale release panel; not authorization or schema verification. */
export function weeklyBaleReleasePreviewEnabled(): boolean {
  return financeFoundationEnabled() && process.env.NEXT_PUBLIC_WEEKLY_BALE_RELEASE_PREVIEW === 'true';
}

/** Independent display gate for the uninstalled expiry job health RPC. */
export function weeklyBaleExpiryHealthPreviewEnabled(): boolean {
  return weeklyBaleReleasePreviewEnabled() && process.env.NEXT_PUBLIC_WEEKLY_BALE_EXPIRY_HEALTH_PREVIEW === 'true';
}

/** Experimental source-bound weekly write UI; never enable without its complete reviewed backend and cutover. */
export function weeklyWorkerActionsPreviewEnabled(): boolean {
  return financeFoundationEnabled() && process.env.NEXT_PUBLIC_WEEKLY_WORKER_ACTIONS_PREVIEW === 'true';
}

/** Requires the reviewed refresh backend and the base weekly action gates; not authorization. */
export function weeklyWorkerRefreshPreviewEnabled(): boolean {
  return weeklyWorkerActionsPreviewEnabled() && process.env.NEXT_PUBLIC_WEEKLY_WORKER_REFRESH_PREVIEW === 'true';
}

/** Experimental return and revision-bound payment UI; requires the complete return backend. */
export function weeklyWorkerReturnPreviewEnabled(): boolean {
  return weeklyWorkerRefreshPreviewEnabled() && process.env.NEXT_PUBLIC_WEEKLY_WORKER_RETURN_PREVIEW === 'true';
}

/** Hide legacy payroll writes when the explicit cutover mode is requested.
 * Intentionally independent of other gates: a misconfigured build must not
 * bring legacy write buttons back. This is not a backend security boundary. */
export function weeklyWorkerCutoverMode(): boolean {
  return process.env.NEXT_PUBLIC_WEEKLY_WORKER_CUTOVER_PREVIEW === 'true';
}

/** Separate read-only historical payment/Bale evidence, not a schema or authorization check. */
export function historicalFinanceEvidencePreviewEnabled(): boolean {
  return financeFoundationEnabled() && process.env.NEXT_PUBLIC_HISTORICAL_FINANCE_EVIDENCE_PREVIEW === 'true';
}

/** Historical assertion writes require their own gate and all reviewed evidence candidates. */
export function historicalFinanceEntryPreviewEnabled(): boolean {
  return historicalFinanceEvidencePreviewEnabled() && process.env.NEXT_PUBLIC_HISTORICAL_FINANCE_ENTRY_PREVIEW === 'true';
}

/** Read-only paid allocation evidence; not a complete project cost or schema check. */
export function projectPaidWorkerEvidencePreviewEnabled(): boolean {
  return financeFoundationEnabled() && process.env.NEXT_PUBLIC_PROJECT_PAID_WORKER_EVIDENCE_PREVIEW === 'true';
}

/** Temporary, unsaved project-cost reconciliation scratchpad; not a final accounting figure. */
export function projectCostReconciliationPreviewEnabled(): boolean {
  return financeFoundationEnabled() && process.env.NEXT_PUBLIC_PROJECT_COST_RECONCILIATION_PREVIEW === 'true';
}

/** Separate experimental durable review UI; requires the scratchpad and its uninstalled backend. */
export function projectCostReviewLedgerPreviewEnabled(): boolean {
  return projectCostReconciliationPreviewEnabled() && process.env.NEXT_PUBLIC_PROJECT_COST_REVIEW_LEDGER_PREVIEW === 'true';
}

/** Read-only experimental confirmed rental links; not a write UI or schema check. */
export function confirmedRentalPreviewEnabled(): boolean {
  return financeFoundationEnabled() && process.env.NEXT_PUBLIC_CONFIRMED_RENTAL_PREVIEW === 'true';
}

/** Separate write-UI gate for the uninstalled rental confirmation candidate. */
export function rentalConfirmationPreviewEnabled(): boolean {
  return confirmedRentalPreviewEnabled() && process.env.NEXT_PUBLIC_RENTAL_CONFIRMATION_PREVIEW === 'true';
}

/** Experimental cases for paid Supervisor or external-worker assertions; requires all coordinated backends. */
export function paidPeriodAssertionCasesPreviewEnabled(): boolean {
  return financeFoundationEnabled() && process.env.NEXT_PUBLIC_PAID_PERIOD_ASSERTION_CASES_PREVIEW === 'true';
}

/** Experimental Supervisor ledger; requires its full uninstalled backend and coordinated cutover. */
export function supervisorPayrollLedgerPreviewEnabled(): boolean {
  return supervisorPayrollPreviewEnabled() && process.env.NEXT_PUBLIC_SUPERVISOR_PAYROLL_LEDGER_PREVIEW === 'true';
}

/** Experimental historical external-payroll assertions; requires coordinated backend and cutover. */
export function historicalExternalWorkerPreviewEnabled(): boolean {
  return financeFoundationEnabled() && process.env.NEXT_PUBLIC_HISTORICAL_EXTERNAL_WORKER_PREVIEW === 'true';
}

/** Read-only time details in history/site logs; requires the uninstalled batch RPC. */
export function attendanceTimeHistoryPreviewEnabled(): boolean {
  return financeFoundationEnabled() && process.env.NEXT_PUBLIC_ATTENDANCE_TIME_HISTORY_PREVIEW === 'true';
}

/** Independent gate for the uninstalled Supervisor payroll planning RPCs. */
export function supervisorPayrollPreviewEnabled(): boolean {
  return financeFoundationEnabled() && process.env.NEXT_PUBLIC_SUPERVISOR_PAYROLL_PREVIEW === 'true';
}

/** Independent gate for the uninstalled leave-summary RPC and its UI. */
export function supervisorLeaveNotificationsPreviewEnabled(): boolean {
  return financeFoundationEnabled() && process.env.NEXT_PUBLIC_SUPERVISOR_LEAVE_NOTIFICATIONS_PREVIEW === 'true';
}

/** A second independent display gate; the experimental adjustment RPCs must exist first. */
export function paidAdjustmentsPreviewEnabled(): boolean {
  return financeFoundationEnabled() && process.env.NEXT_PUBLIC_PAID_ADJUSTMENTS_PREVIEW === 'true';
}
