'use client';

import React, { useId } from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  hint?: string;
  options?: Array<{ label: string; value: string | number; disabled?: boolean }>;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, label, error, hint, options, children, id, ...props }, ref) => {
    const generatedId = useId();
    const selectId = id || generatedId;
    const errorId = `${selectId}-error`;
    const hintId = `${selectId}-hint`;
    const describedBy =
      [error ? errorId : null, !error && hint ? hintId : null].filter(Boolean).join(' ') || undefined;

    return (
      <div className="w-full flex flex-col space-y-1.5">
        {label && (
          <label
            htmlFor={selectId}
            className="text-xs font-semibold text-ink-secondary"
          >
            {label}
          </label>
        )}
        <div className="relative">
          <select
            id={selectId}
            ref={ref}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            className={twMerge(
              clsx(
                'w-full min-h-11 bg-white text-ink-primary text-base sm:text-sm rounded-lg border border-surface-border py-2.5 px-3.5 pr-8 appearance-none transition-colors duration-150',
                'focus:border-brand focus:ring-2 focus:ring-brand/15 focus:outline-none cursor-pointer',
                error && 'border-status-danger ring-1 ring-status-danger/30 bg-status-danger-bg/40',
                className
              )
            )}
            {...props}
          >
            {options
              ? options.map((opt) => (
                  <option key={String(opt.value)} value={opt.value} disabled={opt.disabled}>
                    {opt.label}
                  </option>
                ))
              : children}
          </select>
          <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-ink-secondary">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>
        {error && (
          <p id={errorId} className="text-xs font-medium text-status-danger">
            {error}
          </p>
        )}
        {hint && !error && (
          <p id={hintId} className="text-xs text-ink-secondary">
            {hint}
          </p>
        )}
      </div>
    );
  }
);

Select.displayName = 'Select';
