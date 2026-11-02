import { describe, expect, it } from 'vitest';
import { parseToolQuantity } from '@/lib/tools/validation';

describe('equipment quantity', () => {
  it('preserves zero and accepts valid whole numbers', () => {
    expect(parseToolQuantity('0')).toBe(0);
    expect(parseToolQuantity(' 12 ')).toBe(12);
    expect(parseToolQuantity('2147483647')).toBe(2147483647);
  });

  it('rejects missing, negative, fractional, non-decimal and overflowing quantities', () => {
    for (const input of ['', ' ', '-1', '1.5', '1e3', '0x10', '2147483648']) {
      expect(parseToolQuantity(input)).toBeNull();
    }
  });
});
