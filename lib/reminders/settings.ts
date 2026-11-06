/**
 * A missing, unreadable or malformed row never authorizes an automatic send.
 * The database also keeps master_enabled locked OFF during the staged rollout.
 */
export interface ReminderSettings {
  master_enabled: boolean;
  email_enabled: boolean;
  sms_enabled: boolean;
  revision: number;
}

export function isReminderSettings(value: unknown): value is ReminderSettings {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.master_enabled === 'boolean' && typeof row.email_enabled === 'boolean' &&
    typeof row.sms_enabled === 'boolean' && Number.isSafeInteger(row.revision) && Number(row.revision) > 0;
}

export async function readReminderSettings(db: { from: (table: string) => any }): Promise<ReminderSettings | null> {
  try {
    const { data, error } = await db.from('reminder_settings')
      .select('master_enabled,email_enabled,sms_enabled,revision').eq('singleton', true).maybeSingle();
    return !error && isReminderSettings(data) ? data : null;
  } catch {
    return null;
  }
}
