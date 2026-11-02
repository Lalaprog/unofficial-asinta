/**
 * Centralized, reusable SMS templates for BALE billing reminders.
 *
 * Pure module (no I/O) — shared by the manual composer, the invoice SMS
 * modal, the reminder approval queue, and the automatic reminder scheduler.
 * Plain text only: no Markdown, no unicode currency symbols (GSM-7 safe).
 */

import { formatPesoForSMS, parseManilaDate } from '@/lib/email/format';
import { resolveClientGreetingName } from '@/lib/email/templates';

export type ReminderType = 'upcoming' | 'due_today' | 'overdue' | 'follow_up';

export interface ReminderSMSData {
  /** Client contact person (preferred greeting). */
  contactPerson?: string | null;
  /** Client / company name fallback. */
  companyName?: string | null;
  invoiceNumber: string;
  projectName: string;
  outstandingBalance: number;
  /** ISO date YYYY-MM-DD. */
  dueDate: string;
  /**
   * Date of the latest SUCCESSFUL (accepted or provider-confirmed delivered)
   * Request for Payment email, ISO string. When absent the SMS must not
   * claim an email was sent.
   */
  paymentRequestSentDate?: string | null;
}

/** GSM-safe date, e.g. "15 Jan 2026". Shares the ISO parsing with formatDatePH. */
export function formatDateForSMS(isoDate: string | null | undefined): string {
  const date = parseManilaDate(isoDate);
  if (!date) return '';
  return date.toLocaleDateString('en-PH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Manila',
  });
}

/**
 * Builds the payment reminder SMS.
 * - Uses the "emailed on" wording ONLY when a successful email log exists.
 * - Prefers the contact person, then the company name, then "Valued Client".
 */
export function buildReminderSMS(data: ReminderSMSData): string {
  const clientName = resolveClientGreetingName(data.contactPerson, data.companyName);
  const balance = formatPesoForSMS(data.outstandingBalance);
  const dueDate = formatDateForSMS(data.dueDate);

  const emailReference = data.paymentRequestSentDate
    ? `Please refer to the Request for Payment emailed on ${formatDateForSMS(data.paymentRequestSentDate)}.`
    : 'Please review the payment details for this invoice.';

  return (
    `Dear ${clientName}, this is a gentle reminder regarding ${data.invoiceNumber} for ${data.projectName}. ` +
    `The outstanding balance is ${balance}, due on ${dueDate}. ` +
    `${emailReference} Thank you and God bless. ` +
    `This is a system-generated message. Please do not reply.`
  );
}

/**
 * Determines the reminder type from the due date relative to "today"
 * (both ISO YYYY-MM-DD strings, evaluated in Asia/Manila).
 */
export function detectReminderType(dueDate: string, todayIso: string): ReminderType {
  if (todayIso < dueDate) return 'upcoming';
  if (todayIso === dueDate) return 'due_today';
  return 'overdue';
}

// GSM 03.38 basic character set (plus extension chars counted as 2).
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑܧ¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENDED = '^{}\\[~]|€';

export interface SMSSegmentEstimate {
  characterCount: number;
  encoding: 'GSM-7' | 'UCS-2';
  segments: number;
}

/**
 * Estimates SMS segments: GSM-7 → 160 chars (153/segment when concatenated);
 * any non-GSM character forces UCS-2 → 70 chars (67/segment concatenated).
 */
export function estimateSMSSegments(message: string): SMSSegmentEstimate {
  let gsm = true;
  let units = 0;

  for (const char of message) {
    if (GSM_BASIC.includes(char)) {
      units += 1;
    } else if (GSM_EXTENDED.includes(char)) {
      units += 2;
    } else {
      gsm = false;
      break;
    }
  }

  if (!gsm) {
    const length = [...message].length;
    return {
      characterCount: length,
      encoding: 'UCS-2',
      segments: length === 0 ? 0 : length <= 70 ? 1 : Math.ceil(length / 67),
    };
  }

  return {
    characterCount: units,
    encoding: 'GSM-7',
    segments: units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153),
  };
}
