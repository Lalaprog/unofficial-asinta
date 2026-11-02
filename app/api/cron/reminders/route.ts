import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient, isServiceRoleConfigured } from '@/lib/supabase/admin';
import { deliverAndLogSMS } from '@/lib/sms/deliver';
import { normalizePhilippineMobile } from '@/lib/sms/phone';
import { buildReminderSMS } from '@/lib/sms/templates';
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

/**
 * Secure scheduled-reminder endpoint.
 *
 * Invoke with:  Authorization: Bearer <CRON_SECRET>
 * Compatible with Vercel Cron (which injects that header automatically when
 * CRON_SECRET is set) and any generic scheduler that can send an HTTP
 * request with a header. See docs/COMMUNICATIONS_SETUP.md.
 *
 * Safety model:
 * - Global switch (AUTOMATIC_REMINDERS_ENABLED) must be 'true'.
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
        invoiceAmount: Number(invoice.amount) || 0,
        amountPaid: Number(invoice.amount_paid) || 0,
        automaticRemindersEnabled: Boolean(invoice.automatic_reminders_enabled),
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
      const { data: emailLog } = await db
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
      });

      const recipientName = (client?.contact_person || '').trim() || client?.name || 'Client';

      // Shared delivery + honest logging (see lib/sms/deliver.ts). The
      // reminder_dispatches transition stays here because it is specific to
      // the scheduled-reminder pipeline.
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
