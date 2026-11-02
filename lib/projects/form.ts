import type { ProjectStatus } from '@/types';

export interface ProjectFormValues {
  name: string;
  location: string;
  budget_estimate: string;
  status: ProjectStatus;
  start_date: string;
  target_completion_date: string;
}
export type ProjectFieldErrors = Partial<Record<keyof ProjectFormValues | 'client_id', string>>;

/** Local calendar date, not UTC: users may be ahead of UTC around midnight. */
export function localDateInputValue(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Match the database's numeric(14,2), without fabricating missing values. */
export function validateProjectForm(values: ProjectFormValues, clientId?: string): {
  errors: ProjectFieldErrors;
  normalized: ProjectFormValues & { budget: number };
} {
  const name = values.name.trim();
  const location = values.location.trim();
  const rawBudget = values.budget_estimate.trim();
  const budget = Number(rawBudget);
  const errors: ProjectFieldErrors = {};
  if (!name) errors.name = 'Enter a project name.';
  if (!location) errors.location = 'Enter the site location.';
  if (clientId !== undefined && !clientId.trim()) errors.client_id = 'Select a client.';
  if (!/^\d+(?:\.\d{1,2})?$/.test(rawBudget) || !Number.isFinite(budget) || budget > 999999999999.99) {
    errors.budget_estimate = 'Enter an estimate from 0 to 999,999,999,999.99, with at most two decimal places.';
  }
  const validStart = isDate(values.start_date);
  const validTarget = isDate(values.target_completion_date);
  if (!validStart) errors.start_date = 'Enter a valid start date.';
  if (!validTarget) errors.target_completion_date = 'Enter a valid target completion date.';
  else if (validStart && values.target_completion_date < values.start_date) {
    errors.target_completion_date = 'Target completion cannot be before the start date.';
  }
  return { errors, normalized: { ...values, name, location, budget } };
}
