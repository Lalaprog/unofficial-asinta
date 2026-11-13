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

/** Read-only paid allocation evidence; not a complete project cost or schema check. */
export function projectPaidWorkerEvidencePreviewEnabled(): boolean {
  return financeFoundationEnabled() && process.env.NEXT_PUBLIC_PROJECT_PAID_WORKER_EVIDENCE_PREVIEW === 'true';
}

/** Read-only experimental confirmed rental links; not a write UI or schema check. */
export function confirmedRentalPreviewEnabled(): boolean {
  return financeFoundationEnabled() && process.env.NEXT_PUBLIC_CONFIRMED_RENTAL_PREVIEW === 'true';
}

/** Separate write-UI gate for the uninstalled rental confirmation candidate. */
export function rentalConfirmationPreviewEnabled(): boolean {
  return confirmedRentalPreviewEnabled() && process.env.NEXT_PUBLIC_RENTAL_CONFIRMATION_PREVIEW === 'true';
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
