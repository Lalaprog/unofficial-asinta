/**
 * Temporary UI release gate for unfinished PR #103 features and paid review.
 * Next.js inlines this NEXT_PUBLIC value at build time. It is not authorization
 * or a database safety gate. Only enable on a separately verified deployment
 * after its matching schema, permissions, workflows and recovery plan are ready.
 */
/** Explicit build-time opt-in for the coordinated DEVELOPMENT cutover only.
 * It is not a backend, scheduler, authorization or recovery check. */
export function developmentFinanceCutoverEnabled(): boolean {
  return process.env.NEXT_PUBLIC_DEVELOPMENT_FINANCE_CUTOVER === 'true';
}

export function financeFoundationEnabled(): boolean {
  return (process.env.NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW === 'true' || developmentFinanceCutoverEnabled());
}

/** Both weekly write surfaces require the same complete display configuration.
 * This prevents a build from exposing weekly writes alongside legacy controls
 * or exposing just one half of the workflow. It does not verify backend state,
 * authorize writes, protect older deployments, or schedule expiry. */
function coordinatedWeeklyWritePreviewEnabled(): boolean {
  return financeFoundationEnabled() && weeklyWorkerCutoverMode()
    && (process.env.NEXT_PUBLIC_WEEKLY_BALE_RELEASE_PREVIEW === 'true' || developmentFinanceCutoverEnabled())
    && (process.env.NEXT_PUBLIC_WEEKLY_WORKER_ACTIONS_PREVIEW === 'true' || developmentFinanceCutoverEnabled());
}

/** Experimental weekly Bale release panel; not authorization or schema verification. */
export function weeklyBaleReleasePreviewEnabled(): boolean {
  return coordinatedWeeklyWritePreviewEnabled();
}

/** Read-only health remains visible during a partially configured cutover so
 * an operator can investigate; the RPC and independent monitoring are required. */
export function weeklyBaleExpiryHealthPreviewEnabled(): boolean {
  return financeFoundationEnabled() && weeklyWorkerCutoverMode()
    && (process.env.NEXT_PUBLIC_WEEKLY_BALE_EXPIRY_HEALTH_PREVIEW === 'true' || developmentFinanceCutoverEnabled());
}

/** Experimental source-bound weekly write UI; never enable without its complete reviewed backend and cutover. */
export function weeklyWorkerActionsPreviewEnabled(): boolean {
  return coordinatedWeeklyWritePreviewEnabled();
}

/** Requires the reviewed refresh backend and the base weekly action gates; not authorization. */
export function weeklyWorkerRefreshPreviewEnabled(): boolean {
  return weeklyWorkerActionsPreviewEnabled() && (process.env.NEXT_PUBLIC_WEEKLY_WORKER_REFRESH_PREVIEW === 'true' || developmentFinanceCutoverEnabled());
}

/** Experimental return and revision-bound payment UI; requires the complete return backend. */
export function weeklyWorkerReturnPreviewEnabled(): boolean {
  return weeklyWorkerRefreshPreviewEnabled() && (process.env.NEXT_PUBLIC_WEEKLY_WORKER_RETURN_PREVIEW === 'true' || developmentFinanceCutoverEnabled());
}

/** Hide legacy payroll writes when the explicit cutover mode is requested.
 * Intentionally independent of other gates: a misconfigured build must not
 * bring legacy write buttons back. This is not a backend security boundary. */
export function weeklyWorkerCutoverMode(): boolean {
  return (process.env.NEXT_PUBLIC_WEEKLY_WORKER_CUTOVER_PREVIEW === 'true' || developmentFinanceCutoverEnabled());
}

/** Separate read-only historical payment/Bale evidence, not a schema or authorization check. */
export function historicalFinanceEvidencePreviewEnabled(): boolean {
  return financeFoundationEnabled() && (process.env.NEXT_PUBLIC_HISTORICAL_FINANCE_EVIDENCE_PREVIEW === 'true' || developmentFinanceCutoverEnabled());
}

/** Historical assertion writes require their own gate and all reviewed evidence candidates. */
export function historicalFinanceEntryPreviewEnabled(): boolean {
  return historicalFinanceEvidencePreviewEnabled() && (process.env.NEXT_PUBLIC_HISTORICAL_FINANCE_ENTRY_PREVIEW === 'true' || developmentFinanceCutoverEnabled());
}

/** Read-only paid allocation evidence; not a complete project cost or schema check. */
export function projectPaidWorkerEvidencePreviewEnabled(): boolean {
  return financeFoundationEnabled() && (process.env.NEXT_PUBLIC_PROJECT_PAID_WORKER_EVIDENCE_PREVIEW === 'true' || developmentFinanceCutoverEnabled());
}

/** Temporary, unsaved project-cost reconciliation scratchpad; not a final accounting figure. */
export function projectCostReconciliationPreviewEnabled(): boolean {
  return financeFoundationEnabled() && (process.env.NEXT_PUBLIC_PROJECT_COST_RECONCILIATION_PREVIEW === 'true' || developmentFinanceCutoverEnabled());
}

/** Separate read-only external worker attribution evidence, not included in cost totals. */
export function historicalWorkerAttributionPreviewEnabled(): boolean {
  return projectCostReconciliationPreviewEnabled() && (process.env.NEXT_PUBLIC_HISTORICAL_WORKER_ATTRIBUTION_PREVIEW === 'true' || developmentFinanceCutoverEnabled());
}

/** Attribution entry needs its own default-off gate and the external history surface.
 * This is a display gate only, not authorization or a backend readiness check. */
export function historicalWorkerAttributionEntryPreviewEnabled(): boolean {
  return historicalExternalWorkerPreviewEnabled() && (process.env.NEXT_PUBLIC_HISTORICAL_WORKER_ATTRIBUTION_ENTRY_PREVIEW === 'true' || developmentFinanceCutoverEnabled());
}

/** Separate combined historical scratch review; read-only and never a saved ledger. */
export function historicalCostReviewPreviewEnabled(): boolean {
  return historicalWorkerAttributionPreviewEnabled() && (process.env.NEXT_PUBLIC_HISTORICAL_COST_REVIEW_PREVIEW === 'true' || developmentFinanceCutoverEnabled());
}

/** Separate experimental durable review UI; requires the scratchpad and its uninstalled backend. */
export function projectCostReviewLedgerPreviewEnabled(): boolean {
  return projectCostReconciliationPreviewEnabled() && (process.env.NEXT_PUBLIC_PROJECT_COST_REVIEW_LEDGER_PREVIEW === 'true' || developmentFinanceCutoverEnabled());
}

/** Read-only experimental confirmed rental links; not a write UI or schema check. */
export function confirmedRentalPreviewEnabled(): boolean {
  return financeFoundationEnabled() && (process.env.NEXT_PUBLIC_CONFIRMED_RENTAL_PREVIEW === 'true' || developmentFinanceCutoverEnabled());
}

/** Separate write-UI gate for the uninstalled rental confirmation candidate. */
export function rentalConfirmationPreviewEnabled(): boolean {
  return confirmedRentalPreviewEnabled() && (process.env.NEXT_PUBLIC_RENTAL_CONFIRMATION_PREVIEW === 'true' || developmentFinanceCutoverEnabled());
}

/** Experimental cases for paid Supervisor or external-worker assertions; requires all coordinated backends. */
export function paidPeriodAssertionCasesPreviewEnabled(): boolean {
  return financeFoundationEnabled() && (process.env.NEXT_PUBLIC_PAID_PERIOD_ASSERTION_CASES_PREVIEW === 'true' || developmentFinanceCutoverEnabled());
}

/** Separate coordinated revision upgrade. Never enable against the old ledger. */
export function supervisorPayrollRevisionPreviewEnabled(): boolean {
  return supervisorPayrollLedgerPreviewEnabled() && process.env.NEXT_PUBLIC_SUPERVISOR_PAYROLL_REVISION_PREVIEW === 'true';
}

/** Experimental Supervisor ledger; requires its full uninstalled backend and coordinated cutover. */
export function supervisorPayrollLedgerPreviewEnabled(): boolean {
  return supervisorPayrollPreviewEnabled() && (process.env.NEXT_PUBLIC_SUPERVISOR_PAYROLL_LEDGER_PREVIEW === 'true' || developmentFinanceCutoverEnabled());
}

/** Experimental historical external-payroll assertions; requires coordinated backend and cutover. */
export function historicalExternalWorkerPreviewEnabled(): boolean {
  return financeFoundationEnabled() && (process.env.NEXT_PUBLIC_HISTORICAL_EXTERNAL_WORKER_PREVIEW === 'true' || developmentFinanceCutoverEnabled());
}

/** Read-only time details in history/site logs; requires the uninstalled batch RPC. */
export function attendanceTimeHistoryPreviewEnabled(): boolean {
  return financeFoundationEnabled() && (process.env.NEXT_PUBLIC_ATTENDANCE_TIME_HISTORY_PREVIEW === 'true' || developmentFinanceCutoverEnabled());
}

/** Independent gate for the uninstalled Supervisor payroll planning RPCs. */
export function supervisorPayrollPreviewEnabled(): boolean {
  return financeFoundationEnabled() && (process.env.NEXT_PUBLIC_SUPERVISOR_PAYROLL_PREVIEW === 'true' || developmentFinanceCutoverEnabled());
}

/** Independent gate for the uninstalled leave-summary RPC and its UI. */
export function supervisorLeaveNotificationsPreviewEnabled(): boolean {
  return financeFoundationEnabled() && (process.env.NEXT_PUBLIC_SUPERVISOR_LEAVE_NOTIFICATIONS_PREVIEW === 'true' || developmentFinanceCutoverEnabled());
}

/** Founder-only paid attendance drift signal. Requires its separate uninstalled read-only RPC. */
export function paidAttendanceReviewPreviewEnabled(): boolean {
  return financeFoundationEnabled() && (process.env.NEXT_PUBLIC_PAID_ATTENDANCE_REVIEW_PREVIEW === 'true' || developmentFinanceCutoverEnabled());
}

/** A second independent display gate; the experimental adjustment RPCs must exist first. */
export function paidAdjustmentsPreviewEnabled(): boolean {
  return financeFoundationEnabled() && (process.env.NEXT_PUBLIC_PAID_ADJUSTMENTS_PREVIEW === 'true' || developmentFinanceCutoverEnabled());
}

/** The development preview must point at the explicitly configured Supabase
 * project before exposing these controls. This is not an Auth, schema or
 * backend-health check; a different release must make its own decision. */
function developmentCorrectionTargetMatches(): boolean {
  const ref = process.env.NEXT_PUBLIC_DEVELOPMENT_CORRECTION_SUPABASE_REF;
  if (!ref || !/^[a-z0-9]{20}$/.test(ref)) return false;
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || '');
    return url.protocol === 'https:' && url.hostname === `${ref}.supabase.co` &&
      !url.port && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
}

/** Separate opt-in for correction evidence; installed only on development and never enabled by the development cutover flag alone. */
export function projectCostCorrectionPreviewEnabled(): boolean {
  return financeFoundationEnabled() && process.env.NEXT_PUBLIC_PROJECT_COST_CORRECTION_PREVIEW === 'true' &&
    (!developmentFinanceCutoverEnabled() || developmentCorrectionTargetMatches());
}

/** Read-only single-case cross-site illustration, separately opted in. */
export function crossSiteIllustrationPreviewEnabled(): boolean {
  return projectCostCorrectionPreviewEnabled() && process.env.NEXT_PUBLIC_CROSS_SITE_ILLUSTRATION_PREVIEW === 'true';
}

/** Read-only source inspection and unsaved cross-site destination preview. */
export function crossSiteSourceReviewPreviewEnabled(): boolean {
  return correctedProjectCostReviewPreviewEnabled() && process.env.NEXT_PUBLIC_CROSS_SITE_SOURCE_REVIEW_PREVIEW === 'true';
}

/** Independent opt-in for the unfinished cross-site ledger writer and history. */
export function crossSiteLedgerPreviewEnabled(): boolean {
  return crossSiteSourceReviewPreviewEnabled() && process.env.NEXT_PUBLIC_CROSS_SITE_LEDGER_PREVIEW === 'true';
}

/** Separate opt-in for correction-inclusive reviews; neither finance cutover nor
 * correction evidence alone enables this unfinished UI or verifies its backend. */
export function correctedProjectCostReviewPreviewEnabled(): boolean {
  return projectCostCorrectionPreviewEnabled() && process.env.NEXT_PUBLIC_CORRECTED_PROJECT_COST_REVIEW_PREVIEW === 'true';
}
