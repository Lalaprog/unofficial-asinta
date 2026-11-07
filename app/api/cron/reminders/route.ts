import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient, isServiceRoleConfigured } from '@/lib/supabase/admin';
import { deliverAndLogSMS } from '@/lib/sms/deliver';
import { readReminderSettings } from '@/lib/reminders/settings';
import { normalizePhilippineMobile } from '@/lib/sms/phone';
import { buildReminderSMS, DEFAULT_SMS_TEMPLATE, validateSMSTemplate } from '@/lib/sms/templates';
import {
  buildDispatchIdempotencyKey,
  checkReminderEligibility,
  determineDueReminder,
  getManilaClock,
  isAuthorizedCronRequest,
  isGlobalAutomaticRemindersEnabled,
  isWithinSendingHours,
} from '@/lib/reminders/scheduler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Database numerics can arrive as numbers or strings. Never treat a missing or
// malformed paid amount as zero: doing so could overstate the balance.
function invoiceNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return Number.NaN;
  return Number(value);
}

// Fail closed if a value used for eligibility, addressing or the message has
// changed since the message was prepared. This is not a transactional lock.
function sameFields(before: Record<string, unknown> | null, after: Record<string, unknown> | null, fields: string[]): boolean {
  return Boolean(before && after && fields.every((field) => Object.is(before[field], after[field])));
}

/**
 * Secure scheduled-reminder endpoint.
 *
 * Invoke with:  Authorization: Bearer <CRON_SECRET>
 * Compatible with Vercel Cron (which injects that header automatically when
 * CRON_SECRET is set) and any generic scheduler that can send an HTTP
 * request with a header. See docs/COMMUNICATIONS_SETUP.md.
 *
 * Safety model:
 * - Server switch (AUTOMATIC_REMINDERS_ENABLED) and persisted Founder master
 *   and SMS switches must all be on. The Founder switch is rollout-locked off.
 * - Invoice-level automatic_reminders_enabled must be true and not paused.
 * - Paid / cancelled / zero-balance invoices are excluded.
 * - Sends only Monday–Saturday, 8:00 AM–6:00 PM Asia/Manila.
 * - The UNIQUE reminder_dispatches.idempotency_key constraint makes every
 *   reminder duplicate-safe even if the cron overlaps or re-runs.
 */
async function runReminderCron(req: NextRequest) {
  if (!isAuthorizedCronRequest(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!isGlobalAutomaticRemindersEnabled()) {
    return NextResponse.json({
      ran: false,
      reason: 'automatic_reminders_globally_disabled',
      message: 'AUTOMATIC_REMINDERS_ENABLED is not "true". No reminders were sent.',
    });
  }

  const now = new Date();
  if (!isWithinSendingHours(now)) {
    return NextResponse.json({
      ran: false,
      reason: 'outside_sending_hours',
      message: 'Outside professional sending hours (Mon–Sat 8:00–18:00 Asia/Manila). No reminders were sent.',
    });
  }

  if (!process.env.PHILSMS_API_KEY) {
    return NextResponse.json({
      ran: false,
      reason: 'philsms_not_configured',
      message: 'PHILSMS_API_KEY is not configured. Automatic reminders never send in simulation mode.',
    });
  }

  if (!isServiceRoleConfigured()) {
    return NextResponse.json(
      { error: 'SUPABASE_SERVICE_ROLE_KEY is not configured on the server.' },
      { status: 503 }
    );
  }

  const db = createServiceRoleClient();
  const settings = await readReminderSettings(db);
  if (!settings) return NextResponse.json({ error: 'Reminder settings unavailable; no reminders were sent.' }, { status: 503 });
  if (!settings.master_enabled || !settings.sms_enabled) {
    return NextResponse.json({ ran: false, reason: 'founder_reminders_disabled', message: 'Automatic SMS reminders are off.' });
  }
  // Fail closed if the saved template cannot be read; never silently send an
  // old/default message when a Founder may have saved different wording.
  const { data: smsTemplateRow, error: smsTemplateError } = await db.from('sms_template_settings').select('message_template').eq('singleton', true).maybeSingle();
  const smsTemplate = smsTemplateRow?.message_template ?? DEFAULT_SMS_TEMPLATE;
  if (smsTemplateError || typeof smsTemplate !== 'string' || !validateSMSTemplate(smsTemplate).valid) {
    return NextResponse.json({ error: 'SMS template unavailable; no reminders were sent.' }, { status: 503 });
  }
  const todayIso = getManilaClock(now).dateIso;

  const { data: invoices, error: invoicesError } = await db
    .from('invoices')
    .select('id, invoice_number, client_id, project_id, amount, amount_paid, due_date, status, automatic_reminders_enabled, reminders_paused_until')
    .eq('automatic_reminders_enabled', true)
    .not('status', 'in', '(paid,cancelled,draft)');

  if (invoicesError) {
    return NextResponse.json({ error: 'Failed to load candidate invoices' }, { status: 500 });
  }

  const results: Array<Record<string, unknown>> = [];
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const invoice of invoices || []) {
    const record: Record<string, unknown> = { invoice: invoice.invoice_number };
    try {
      const reminderType = determineDueReminder(invoice.due_date, todayIso);
      if (!reminderType) {
        continue; // Nothing due today for this invoice — not even a skip.
      }
      record.reminderType = reminderType;

      const [{ data: client }, { data: project }] = await Promise.all([
        db.from('clients').select('id, name, contact_person, phone').eq('id', invoice.client_id).maybeSingle(),
        db.from('projects').select('id, name').eq('id', invoice.project_id).maybeSingle(),
      ]);

      const normalizedPhone = normalizePhilippineMobile(client?.phone);
      const eligibility = checkReminderEligibility({
        invoiceStatus: invoice.status,
        invoiceAmount: invoiceNumber(invoice.amount),
        amountPaid: invoiceNumber(invoice.amount_paid),
        automaticRemindersEnabled: invoice.automatic_reminders_enabled === true,
        remindersPausedUntil: invoice.reminders_paused_until,
        clientPhoneNormalized: normalizedPhone,
        now,
      });

      const idempotencyKey = buildDispatchIdempotencyKey(invoice.id, 'sms', reminderType, todayIso);

      if (!eligibility.eligible) {
        // Record the skip (idempotently) so Founders can see why.
        await db.from('reminder_dispatches').upsert(
          {
            invoice_id: invoice.id,
            channel: 'sms',
            reminder_type: reminderType,
            scheduled_date: todayIso,
            idempotency_key: idempotencyKey,
            status: 'skipped',
            error_message: eligibility.reason,
          },
          { onConflict: 'idempotency_key', ignoreDuplicates: true }
        );
        record.outcome = 'skipped';
        record.reason = eligibility.reason;
        skipped += 1;
        results.push(record);
        continue;
      }

      // Duplicate protection: has this reminder already been dispatched?
      const { data: existing } = await db
        .from('reminder_dispatches')
        .select('id, status, error_message')
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();

      // An unsuccessful response can still follow provider acceptance. Never
      // replay a recorded key automatically, including legacy failed rows.
      if (existing) {
        record.outcome = 'duplicate_skipped';
        record.previousStatus = existing.status;
        skipped += 1;
        results.push(record);
        continue;
      }
      const { data: inserted, error: insertError } = await db
        .from('reminder_dispatches')
        .insert({
          invoice_id: invoice.id,
          channel: 'sms',
          reminder_type: reminderType,
          scheduled_date: todayIso,
          idempotency_key: idempotencyKey,
          status: 'pending',
        })
        .select('id')
        .single();
      if (insertError || !inserted) {
        // Unique-key race with an overlapping run, or an insert failure:
        // fail closed instead of sending without an idempotency record.
        record.outcome = 'duplicate_skipped';
        skipped += 1;
        results.push(record);
        continue;
      }
      const dispatchId = inserted.id;

      // Latest SUCCESSFUL initial-request email (accepted or truly delivered).
      const { data: emailLog, error: emailLogError } = await db
        .from('email_logs')
        .select('sent_at')
        .eq('invoice_id', invoice.id)
        .eq('template_type', 'initial_request')
        .in('status', ['accepted', 'delivered'])
        .order('sent_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const message = buildReminderSMS({
        contactPerson: client?.contact_person,
        companyName: client?.name,
        invoiceNumber: invoice.invoice_number,
        projectName: project?.name || 'your project',
        outstandingBalance: (Number(invoice.amount) || 0) - (Number(invoice.amount_paid) || 0),
        dueDate: invoice.due_date,
        paymentRequestSentDate: emailLog?.sent_at || null,
      }, smsTemplate);
      if (message.length > 1000) {
        await db.from('reminder_dispatches').update({ status: 'skipped', error_message: 'SMS message exceeds 1,000 characters.' }).eq('id', dispatchId);
        record.outcome = 'skipped'; record.reason = 'message_too_long'; skipped += 1; results.push(record); continue;
      }

      const recipientName = (client?.contact_person || '').trim() || client?.name || 'Client';

      // Check the prepared data again after claiming the slot. A change, read
      // error or deletion means the prepared message may no longer be safe.
      // This reduces stale sends but does not lock records through provider I/O.
      const [latestInvoice, latestClient, latestProject, latestTemplate, latestEmailLog] = await Promise.all([
        db.from('invoices').select('id, invoice_number, client_id, project_id, amount, amount_paid, due_date, status, automatic_reminders_enabled, reminders_paused_until').eq('id', invoice.id).maybeSingle(),
        db.from('clients').select('id, name, contact_person, phone').eq('id', invoice.client_id).maybeSingle(),
        db.from('projects').select('id, name').eq('id', invoice.project_id).maybeSingle(),
        db.from('sms_template_settings').select('message_template').eq('singleton', true).maybeSingle(),
        db.from('email_logs').select('sent_at').eq('invoice_id', invoice.id).eq('template_type', 'initial_request').in('status', ['accepted', 'delivered']).order('sent_at', { ascending: false }).limit(1).maybeSingle(),
      ]);
      const detailsChanged = Boolean(
        latestInvoice.error || latestClient.error || latestProject.error || latestTemplate.error || emailLogError || latestEmailLog.error ||
        !sameFields(invoice, latestInvoice.data, ['id', 'invoice_number', 'client_id', 'project_id', 'amount', 'amount_paid', 'due_date', 'status', 'automatic_reminders_enabled', 'reminders_paused_until']) ||
        !sameFields(client, latestClient.data, ['id', 'name', 'contact_person', 'phone']) ||
        !sameFields(project, latestProject.data, ['id', 'name']) ||
        (latestTemplate.data?.message_template ?? DEFAULT_SMS_TEMPLATE) !== smsTemplate ||
        (latestEmailLog.data?.sent_at ?? null) !== (emailLog?.sent_at ?? null)
      );
      // The saved switch is checked last; in-flight provider requests cannot
      // be recalled and data can still change after these best-effort checks.
      const currentSettings = await readReminderSettings(db);
      if (!currentSettings || !currentSettings.master_enabled || !currentSettings.sms_enabled) {
        await db.from('reminder_dispatches').update({ status: 'skipped', error_message: 'Automatic reminder settings unavailable or disabled.' }).eq('id', dispatchId);
        record.outcome = 'skipped'; record.reason = 'reminders_disabled_or_unavailable';
        skipped += 1; results.push(record); continue;
      }
      const sendTime = new Date();
      if (detailsChanged || !isWithinSendingHours(sendTime) || getManilaClock(sendTime).dateIso !== todayIso || !isGlobalAutomaticRemindersEnabled() || !process.env.PHILSMS_API_KEY) {
        const reason = detailsChanged ? 'details_changed_or_unavailable' : 'sending_window_or_service_unavailable';
        await db.from('reminder_dispatches').update({ status: 'skipped', error_message: reason }).eq('id', dispatchId);
        record.outcome = 'skipped'; record.reason = reason;
        skipped += 1; results.push(record); continue;
      }

      const outcome = await deliverAndLogSMS({
        db,
        invoiceId: invoice.id,
        recipient: recipientName,
        phone: normalizedPhone as string,
        message,
      });

      const nowIso = new Date().toISOString();
      if (outcome.success) {
        await db
          .from('reminder_dispatches')
          .update({
            status: 'sent',
            provider_message_id: outcome.providerMessageId,
            sent_at: nowIso,
          })
          .eq('id', dispatchId);
        record.outcome = 'sent';
        sent += 1;
      } else {
        const errorMessage = outcome.error || 'Unknown gateway failure';
        await db
          .from('reminder_dispatches')
          .update({ status: outcome.uncertain ? 'pending' : 'failed', error_message: errorMessage })
          .eq('id', dispatchId);
        record.outcome = outcome.uncertain ? 'unconfirmed' : 'failed';
        record.reason = errorMessage;
        failed += 1;
      }
      results.push(record);
    } catch {
      record.outcome = 'unconfirmed';
      record.reason = 'unexpected_error';
      failed += 1;
      results.push(record);
    }
  }

  return NextResponse.json({
    ran: true,
    manilaDate: todayIso,
    candidates: (invoices || []).length,
    sent,
    failed,
    skipped,
    results,
  });
}

export async function GET(req: NextRequest) {
  return runReminderCron(req);
}

export async function POST(req: NextRequest) {
  return runReminderCron(req);
}
