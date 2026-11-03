import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('dashboard summary grid', () => {
  it('keeps the four-column container rule more specific than the later responsive utility', () => {
    const css = readFileSync('app/globals.css', 'utf8');
    expect(css).toMatch(/@container dashboard\s*\(min-width:\s*70rem\)\s*\{[\s\S]*?\.dashboard-summary-grid\.dashboard-summary-grid\s*\{\s*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  });
});
