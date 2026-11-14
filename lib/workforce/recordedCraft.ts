export type RecordedCraft = {label: string; capturedAt: string};

/** Old backends omit both fields; older source rows explicitly return null.
 * Never represent an invalid or half-present observation as historical fact. */
export function parseRecordedCraft(row: Record<string, unknown>): RecordedCraft | null {
  const label = row.entry_craft;
  const at = row.entry_craft_at;
  if ((label === undefined && at === undefined) || (label === null && at === null)) return null;
  if (typeof label !== 'string' || Array.from(label).length < 1 || Array.from(label).length > 80 || typeof at !== 'string' || !Number.isFinite(Date.parse(at))) {
    throw new Error('Invalid recorded craft observation');
  }
  return {label, capturedAt: at};
}
