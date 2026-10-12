'use client';

import React from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'navy' | 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'outline';
  size?: 'sm' | 'md';
}

export const Badge: React.FC<BadgeProps> = ({
  className,
  variant = 'navy',
  size = 'md',
  children,
  ...props
}) => {
  const sizeClasses = {
    sm: 'px-2 py-0.5 text-[11px] font-medium rounded-md',
    md: 'px-2.5 py-1 text-xs font-medium rounded-lg',
  };

  // Status variants use the semantic status tokens (see tailwind.config.js) so
  // one meaning maps to one colour instead of a raw palette shade per component.
  const variantClasses = {
    navy: 'bg-navy/10 text-navy border border-navy/20',
    success: 'bg-status-success-bg text-status-success border border-status-success/20',
    warning: 'bg-status-warning-bg text-status-warning border border-status-warning/20',
    danger: 'bg-status-danger-bg text-status-danger border border-status-danger/20',
    info: 'bg-status-info-bg text-status-info border border-status-info/20',
    neutral: 'bg-slate-100 text-slate-700 border border-slate-200',
    outline: 'bg-transparent text-navy border border-surface-border',
  };

  return (
    <span
      className={twMerge(
        clsx(
          'inline-flex items-center justify-center font-sans font-medium select-none',
          sizeClasses[size],
          variantClasses[variant],
          className
        )
      )}
      {...props}
    >
      {children}
    </span>
  );
};
