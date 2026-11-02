/** Quantities are PostgreSQL integers; zero is a valid inventory count. */
export function parseToolQuantity(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const quantity = Number(value);
  return Number.isSafeInteger(quantity) && quantity <= 2147483647 ? quantity : null;
}
