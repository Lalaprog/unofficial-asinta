'use client';

import React, { useId, useState } from 'react';
import { Select, type SelectProps } from '@/components/ui/Select';

interface SearchableSelectProps extends Omit<SelectProps, 'children' | 'options' | 'value'> {
  label: string;
  value: string;
  options: Array<{ label: string; value: string; disabled?: boolean }>;
  /** An always-visible option, such as an empty placeholder or "All". */
  fixedOption?: { label: string; value: string; disabled?: boolean };
  searchLabel: string;
  /** Short lists retain the normal native select without extra controls. */
  searchThreshold?: number;
}

/**
 * An optional filter for a native select, rather than a custom combobox.
 * Searching never changes the selected value; a selected option stays visible
 * even when it doesn't match. This preserves keyboard, mobile and form behavior.
 */
export function SearchableSelect({
  label, value, options, fixedOption, searchLabel, searchThreshold = 8, disabled, ...props
}: SearchableSelectProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchId = useId();
  const filter = query.trim().toLocaleLowerCase();
  const matches = filter ? options.filter((option) => option.label.toLocaleLowerCase().includes(filter)) : options;
  const selected = options.find((option) => option.value === value);
  const selectedIsExtra = Boolean(filter && selected && !matches.some((option) => option.value === value));
  // Retain the original option order, including the selected choice if filtered out.
  const visible = filter ? options.filter((option) => option.value === value || option.label.toLocaleLowerCase().includes(filter)) : options;

  return (
    <div className="space-y-1.5">
      {(options.length >= searchThreshold || searchOpen) && (
        <div>
          <button
            type="button"
            disabled={disabled}
            aria-expanded={searchOpen}
            aria-controls={searchId}
            aria-label={searchOpen ? `Close ${searchLabel.toLocaleLowerCase()}` : undefined}
            onClick={() => {
              setSearchOpen((open) => !open);
              setQuery('');
            }}
            className="min-h-11 sm:min-h-9 rounded-lg text-xs font-semibold text-brand underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 disabled:opacity-50"
          >
            {searchOpen ? 'Close search' : searchLabel}
          </button>
          <div id={searchId} hidden={!searchOpen} className="space-y-1.5 pb-1">
            <label htmlFor={`${searchId}-input`} className="text-xs font-semibold text-ink-secondary">{searchLabel}</label>
            <input
              id={`${searchId}-input`}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }}
              disabled={disabled}
              autoComplete="off"
              className="w-full min-h-11 sm:min-h-9 rounded-lg border border-surface-border bg-white px-3.5 py-2 sm:py-1.5 text-base text-ink-primary focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/15 sm:text-sm"
            />
            {filter && (
              <p role="status" className="text-xs text-ink-secondary">
                {matches.length === 0 ? 'No matching options.' : `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}.`}
                {selectedIsExtra && ' Your current selection remains available.'}
              </p>
            )}
          </div>
        </div>
      )}
      <Select
        {...props}
        label={label}
        value={value}
        disabled={disabled}
        options={fixedOption ? [fixedOption, ...visible] : visible}
      />
    </div>
  );
}
