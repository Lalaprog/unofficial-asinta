/** Preserve legitimate zero values and avoid inventing attendance for old vouchers. */
export function formatRecordedWork(value: number | null | undefined, unit: string): string {
  if (value == null || !Number.isFinite(value)) return 'Not recorded';
  return `${value.toLocaleString('en-PH')} ${unit}`;
}
