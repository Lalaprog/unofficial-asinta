import { describe, expect, it } from 'vitest';
import { localDateInputValue, validateProjectForm, type ProjectFormValues } from '@/lib/projects/form';
import { confirmProjectDeletion } from '@/lib/projects/delete';

const valid: ProjectFormValues = {
  name: '  House Project  ', location: '  Batangas  ', budget_estimate: '0',
  status: 'active', start_date: '2027-01-01', target_completion_date: '2027-02-01',
};

describe('project form validation', () => {
  it('trims real values and permits a zero budget', () => {
    const result = validateProjectForm(valid, 'client-1');
    expect(result.errors).toEqual({});
    expect(result.normalized).toMatchObject({ name: 'House Project', location: 'Batangas', budget: 0 });
  });

  it('identifies each missing or whitespace field without inventing data', () => {
    const { errors } = validateProjectForm({ ...valid, name: ' ', location: '\t', budget_estimate: '', start_date: '', target_completion_date: '' }, '');
    expect(Object.keys(errors).sort()).toEqual(['budget_estimate', 'client_id', 'location', 'name', 'start_date', 'target_completion_date']);
  });

  it('rejects invalid money and impossible or reversed dates', () => {
    for (const budget of ['-1', '1.001', '1e3', '1000000000000', 'NaN']) {
      expect(validateProjectForm({ ...valid, budget_estimate: budget }).errors.budget_estimate, budget).toBeTruthy();
    }
    expect(validateProjectForm({ ...valid, budget_estimate: '999999999999.99' }).errors.budget_estimate).toBeUndefined();
    expect(validateProjectForm({ ...valid, target_completion_date: '2027-02-30' }).errors.target_completion_date).toMatch(/valid/);
    expect(validateProjectForm({ ...valid, target_completion_date: '2026-12-31' }).errors.target_completion_date).toMatch(/before/);
    expect(validateProjectForm({ ...valid, start_date: '0000-01-01' }).errors.start_date).toBeTruthy();
  });

  it('uses the local calendar date rather than UTC for new projects', () => {
    const date = new Date(2027, 0, 1, 0, 5);
    expect(localDateInputValue(date)).toBe('2027-01-01');
  });
});

describe('project deletion confirmation', () => {
  it('confirms only the deleted row with the expected id', async () => {
    expect(await confirmProjectDeletion('a', async () => ({ data: { id: 'a' }, error: null }))).toEqual({ confirmed: true });
    for (const data of [null, { id: 'other' }]) {
      expect(await confirmProjectDeletion('a', async () => ({ data, error: null }))).toMatchObject({ confirmed: false, error: expect.stringMatching(/refresh/i) });
    }
  });
  it('explains linked records and treats a lost response as uncertain', async () => {
    expect(await confirmProjectDeletion('a', async () => ({ data: null, error: { code: '23503' } }))).toMatchObject({ confirmed: false, error: expect.stringMatching(/linked/i) });
    expect(await confirmProjectDeletion('a', async () => { throw new Error('network'); })).toMatchObject({ confirmed: false, error: expect.stringMatching(/not confirmed/i) });
  });
});
