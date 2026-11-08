import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('dashboard presentation', () => {
  it('removes the always-visible snapshot explanation but keeps the optional walkthrough', () => {
    const dashboard = readFileSync('app/dashboard/page.tsx', 'utf8');
    expect(dashboard).not.toContain('How to read this snapshot');
    expect(dashboard).not.toContain('How to read the dashboard figures');
    expect(dashboard).toContain('<DashboardWalkthrough />');
  });
});
