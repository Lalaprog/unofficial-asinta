'use client';

import React from 'react';

interface FilterSummaryProps {
  count: number;
  itemName: string;
  active: boolean;
  onClear: () => void;
}

/** A consistent, accessible result count and escape hatch for list filters. */
export const FilterSummary: React.FC<FilterSummaryProps> = ({ count, itemName, active, onClear }) => (
  <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-ink-secondary">
    <p aria-live="polite" aria-atomic="true">
      {count} {itemName} {count === 1 ? 'result' : 'results'}{active ? ' · Filters applied' : ''}
    </p>
    {active && (
      <button
        type="button"
        onClick={onClear}
        className="inline-flex min-h-11 items-center rounded-lg px-2 font-semibold text-brand hover:bg-surface-inset hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
      >
        Clear filters
      </button>
    )}
  </div>
);
