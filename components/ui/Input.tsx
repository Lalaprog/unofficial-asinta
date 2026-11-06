'use client';

import React, { useId } from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  /** Reserve room for short validation messages to avoid layout jumps. */
  reserveMessageSpace?: boolean;
}

const LABEL_CLASSES = 'text-xs font-semibold text-ink-secondary';

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, hint, leftIcon, rightIcon, reserveMessageSpace, id, 'aria-describedby': callerDescription, 'aria-invalid': callerInvalid, ...props }, ref) => {
    // useId guarantees a unique id per field. The previous label-derived id
    // produced duplicate DOM ids whenever a page reused a label ("Start Date").
    const generatedId = useId();
    const inputId = id || generatedId;
    const errorId = `${inputId}-error`;
    const hintId = `${inputId}-hint`;
    const describedBy =
      [callerDescription, error ? errorId : null, !error && hint ? hintId : null].filter(Boolean).join(' ') || undefined;

    return (
      <div className="w-full flex flex-col space-y-1.5">
        {label && (
          <label htmlFor={inputId} className={LABEL_CLASSES}>
            {label}
          </label>
        )}
        <div className="relative flex items-center">
          {leftIcon && <div className="absolute left-3 text-ink-muted pointer-events-none">{leftIcon}</div>}
          <input
            id={inputId}
            ref={ref}
            aria-invalid={error ? true : callerInvalid}
            aria-describedby={describedBy}
            className={twMerge(
              clsx(
                'w-full min-h-11 sm:min-h-9 bg-white text-ink-primary placeholder:text-ink-muted text-base sm:text-sm rounded-lg border border-surface-border px-3 py-2 sm:py-1.5 transition-colors duration-150',
                'focus:border-brand focus:ring-2 focus:ring-brand/15 focus:outline-none',
                leftIcon ? 'pl-9' : 'pl-3.5',
                rightIcon ? 'pr-9' : 'pr-3.5',
                error && 'border-status-danger ring-1 ring-status-danger/30 bg-status-danger-bg/40',
                className
              )
            )}
            {...props}
          />
          {rightIcon && <div className="absolute right-3 text-ink-muted">{rightIcon}</div>}
        </div>
        {reserveMessageSpace ? (
          <div className="min-h-8 text-xs leading-4" aria-live="polite">
            {error ? <p id={errorId} className="font-medium text-status-danger">{error}</p> : hint ? <p id={hintId} className="text-ink-secondary">{hint}</p> : null}
          </div>
        ) : <>
          {error && <p id={errorId} className="text-xs font-medium text-status-danger">{error}</p>}
          {hint && !error && <p id={hintId} className="text-xs text-ink-secondary">{hint}</p>}
        </>}
      </div>
    );
  }
);

Input.displayName = 'Input';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, label, error, hint, id, 'aria-describedby': callerDescription, 'aria-invalid': callerInvalid, ...props }, ref) => {
    const generatedId = useId();
    const inputId = id || generatedId;
    const errorId = `${inputId}-error`;
    const hintId = `${inputId}-hint`;
    const describedBy =
      [callerDescription, error ? errorId : null, !error && hint ? hintId : null].filter(Boolean).join(' ') || undefined;

    return (
      <div className="w-full flex flex-col space-y-1.5">
        {label && (
          <label htmlFor={inputId} className={LABEL_CLASSES}>
            {label}
          </label>
        )}
        <textarea
          id={inputId}
          ref={ref}
          aria-invalid={error ? true : callerInvalid}
          aria-describedby={describedBy}
          className={twMerge(
            clsx(
              'w-full min-h-24 bg-white text-ink-primary placeholder:text-ink-muted text-base sm:text-sm rounded-lg border border-surface-border p-3 transition-colors duration-150',
              'focus:border-brand focus:ring-2 focus:ring-brand/15 focus:outline-none resize-none',
              error && 'border-status-danger ring-1 ring-status-danger/30 bg-status-danger-bg/40',
              className
            )
          )}
          {...props}
        />
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

Textarea.displayName = 'Textarea';
