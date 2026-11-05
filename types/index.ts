export type UserRole = 'founder' | 'supervisor';

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  created_at: string;
}

export interface Worker {
  id: string;
  name: string;
  contact_number: string;
  position: string;
  pay_rate: number;
  pay_rate_type: 'daily' | 'hourly';
  active: boolean;
  created_at: string;
}

export interface Client {
  id: string;
  name: string;
  contact_person: string;
  phone: string;
  email: string;
  address: string;
  created_at: string;
}

export type ProjectStatus = 'planning' | 'active' | 'on_hold' | 'completed' | 'cancelled';

export interface Project {
  id: string;
  name: string;
  /** Null when the signed-in role cannot view financial/client details. */
  client_id: string | null;
  location: string;
  budget_estimate: number | null;
  status: ProjectStatus;
  start_date: string;
  target_completion_date: string;
  created_at: string;
}

export interface ProjectSupervisor {
  id: string;
  project_id: string;
  supervisor_id: string;
  created_at: string;
}

export type InvoiceStatus = 'draft' | 'pending' | 'partially_paid' | 'paid' | 'overdue' | 'cancelled';

export interface Invoice {
  id: string;
  project_id: string;
  client_id: string;
  invoice_number: string;
  amount: number;
  amount_paid: number;
  issue_date: string;
  due_date: string;
  status: InvoiceStatus;
  notes?: string;
  /** Per-invoice opt-in for automatic reminders (defaults to false). */
  automatic_reminders_enabled: boolean;
  /** When set to a future timestamp, reminders are paused for this invoice. */
  reminders_paused_until: string | null;
  created_at: string;
}

import type { ExpenseCategory } from '@/lib/ai/categories';

// The category list lives in one place only — see lib/ai/categories.ts.
export type { ExpenseCategory };

export interface ExpenseLineItem {
  name: string;
  quantity: string | null;
  amount: number | null;
}

export interface Expense {
  id: string;
  project_id: string;
  description: string;
  /** Optional longer details and receipt items; the expense amount remains authoritative. */
  details?: string | null;
  line_items?: ExpenseLineItem[] | null;
  revision?: number;
  category: ExpenseCategory;
  amount: number;
  expense_date: string;
  /** Storage PATH inside the private `receipts` bucket (not a URL). */
  receipt_url: string | null;
  notes: string | null;
  /**
   * Supplier / shop name — the key for vendor memory (lib/ai/vendorMemory.ts)
   * and for duplicate detection (lib/expenses/anomalies.ts). Prefilled by the
   * AI draft, editable by the Founder, never a financial value itself.
   */
  vendor?: string | null;
  ai_category_suggestion: ExpenseCategory | null;
  ai_bale_detection: boolean | null;
  /* `ai_approval_suggestion` was dropped by migration 20261006000001: it held a
     decorative routing string that nothing read. */
  ai_confirmed: boolean;
  created_by: string;
  created_at: string;
}

export type AdvanceStatus = 'active' | 'partially_deducted' | 'fully_deducted' | 'cancelled';

export type AdvanceRequestStatus =
  | 'pending_approval'
  | 'approved_pending_payment'
  | 'rejected'
  | 'issued';

export interface AdvanceRequest {
  id: string;
  worker_id: string;
  project_id: string;
  requested_amount: number;
  submitted_by: string;
  status: AdvanceRequestStatus;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  issued_by: string | null;
  issued_at: string | null;
  issued_advance_id: string | null;
  created_at: string;
  updated_at: string;
}

export type AdvanceRequestNotificationType =
  | 'advance_request_submitted'
  | 'advance_request_approved'
  | 'advance_request_rejected'
  | 'advance_request_issued';

export interface UserNotification {
  id: string;
  recipient_id: string;
  event_type: AdvanceRequestNotificationType;
  advance_request_id: string | null;
  worker_id: string | null;
  project_id: string | null;
  requested_amount: number;
  created_at: string;
  read_at: string | null;
}

export interface Advance {
  id: string;
  worker_id: string;
  project_id: string;
  amount: number;
  amount_deducted: number;
  reason: string;
  date: string;
  status: AdvanceStatus;
  created_at: string;
}

export type AttendanceStatus = 'present' | 'absent' | 'half_day' | 'leave';

export interface Attendance {
  id: string;
  worker_id: string;
  project_id: string;
  date: string;
  status: AttendanceStatus;
  hours_worked: number;
  notes: string | null;
  recorded_by: string;
  is_founder_override: boolean;
  submitted_at: string;
  created_at: string;
}

export type PayrollStatus = 'draft' | 'reviewed' | 'approved' | 'paid';

export interface Payroll {
  id: string;
  worker_id: string;
  period_start: string;
  period_end: string;
  gross_pay: number;
  bale_deduction: number;
  other_deductions: number;
  net_pay: number;
  status: PayrollStatus;
  days_worked?: number;
  hours_worked?: number;
  notes?: string;
  created_at: string;
}

export type ToolCondition = 'excellent' | 'good' | 'fair' | 'needs_repair' | 'damaged';

export interface Tool {
  id: string;
  name: string;
  quantity: number;
  condition: ToolCondition;
  project_id: string | null;
  created_at: string;
}

export type SMSLogStatus = 'delivered' | 'sent' | 'pending' | 'failed';

export interface SMSLog {
  id: string;
  invoice_id: string | null;
  recipient: string;
  phone: string;
  message: string;
  /**
   * Honest gateway status: 'sent' = provider accepted, 'delivered' = provider
   * delivery receipt only, 'pending' = queued or simulation, 'failed' = error.
   */
  status: SMSLogStatus;
  provider_message_id?: string | null;
  error_message?: string | null;
  /** True when PhilSMS was not configured and nothing left the server. */
  simulated?: boolean;
  provider_status?: string | null;
  updated_at?: string | null;
  sent_at: string;
}

// ---------------------------------------------------------------------------
// Communications (email + reminder automation)
// ---------------------------------------------------------------------------

export type EmailTemplateType =
  | 'initial_request'
  | 'upcoming_reminder'
  | 'due_today'
  | 'overdue'
  | 'payment_acknowledgment'
  | 'final_demand';

export interface EmailTemplate {
  id: string;
  template_type: EmailTemplateType;
  subject_template: string;
  body_template: string;
  version: number;
  active: boolean;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 'accepted' = the SMTP server accepted the message (Nodemailer success).
 * 'delivered' is reserved for explicit provider delivery confirmations.
 */
export type EmailLogStatus = 'pending' | 'accepted' | 'failed' | 'delivered' | 'bounced';

export interface EmailLog {
  id: string;
  invoice_id: string;
  recipient: string;
  subject: string;
  body_text: string;
  body_html: string;
  template_type: EmailTemplateType;
  template_version: number;
  status: EmailLogStatus;
  provider_message_id: string | null;
  error_message: string | null;
  sent_by: string | null;
  sent_at: string | null;
  created_at: string;
  idempotency_key: string;
}

export type ReminderChannel = 'sms' | 'email';
export type ReminderDispatchStatus = 'pending' | 'sent' | 'failed' | 'skipped';
export type ReminderType = 'upcoming' | 'due_today' | 'overdue' | 'follow_up';

export interface ReminderDispatch {
  id: string;
  invoice_id: string;
  channel: ReminderChannel;
  reminder_type: ReminderType;
  scheduled_date: string;
  idempotency_key: string;
  status: ReminderDispatchStatus;
  provider_message_id: string | null;
  error_message: string | null;
  sent_at: string | null;
  created_at: string;
}

export interface AppNotification {
  id: string;
  title: string;
  message: string;
  type: 'info' | 'warning' | 'success' | 'alert';
  read: boolean;
  timestamp: string;
  link?: string;
}
