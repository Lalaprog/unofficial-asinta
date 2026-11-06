/** Provider retry times are advisory; never invent a wait or shorten a long one. */
export const MAX_RETRY_SECONDS = 7 * 24 * 60 * 60;
export function validRetryAfter(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_RETRY_SECONDS) return undefined;
  return Math.ceil(value);
}
export function parseRetryAfterHeader(value: string | null | undefined): number | undefined {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value.trim())) return undefined;
  return validRetryAfter(Number(value));
}
export function formatRetryWait(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} minute${Math.ceil(seconds / 60) === 1 ? '' : 's'}`;
  if (seconds < 86400) return `${Math.ceil(seconds / 3600)} hour${Math.ceil(seconds / 3600) === 1 ? '' : 's'}`;
  return `${Math.ceil(seconds / 86400)} day${Math.ceil(seconds / 86400) === 1 ? '' : 's'}`;
}
