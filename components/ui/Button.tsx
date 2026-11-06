'use client';

import React from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'danger' | 'ghost' | 'soft';
  size?: 'sm' | 'md' | 'lg';
  isLoading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = 'primary',
      size = 'md',
      isLoading = false,
      leftIcon,
      rightIcon,
      children,
      disabled,
      ...props
    },
    ref
  ) => {
    const sizeClasses = {
      sm: 'min-h-11 px-3 py-1.5 text-xs font-medium rounded-lg gap-1.5 sm:min-h-9 sm:py-1.5',
      md: 'min-h-11 sm:min-h-9 px-3.5 py-2 sm:py-1.5 text-sm font-medium rounded-lg gap-2',
      lg: 'min-h-11 px-6 py-3 text-base font-semibold rounded-lg gap-2.5',
    };

    const variantClasses = {
      primary:
        'bg-brand text-white hover:bg-brand-deep border border-brand',
      secondary:
        'bg-white text-navy hover:bg-surface-elevated border border-surface-border hover:border-surface-borderHover',
      outline:
        'bg-transparent text-navy hover:bg-white border border-surface-border hover:border-brand/40',
      danger:
        'bg-status-danger text-white hover:bg-red-700 border border-status-danger',
      ghost:
        'bg-transparent text-ink-secondary hover:text-navy hover:bg-surface-inset border border-transparent',
      soft:
        'bg-surface-inset text-navy hover:bg-slate-200 border border-surface-border',
    };

    return (
      <button
        ref={ref}
        disabled={disabled || isLoading}
        className={twMerge(
          clsx(
            'inline-flex items-center justify-center font-sans transition-[color,background-color,border-color,box-shadow,transform] duration-200 motion-safe:active:scale-[0.96] sm:motion-safe:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none select-none cursor-pointer',
            sizeClasses[size],
            variantClasses[variant],
            className
          )
        )}
        {...props}
      >
        {isLoading ? (
          <svg className="animate-spin h-4 w-4 text-current" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        ) : (
          leftIcon
        )}
        {children}
        {!isLoading && rightIcon}
      </button>
    );
  }
);

Button.displayName = 'Button';
