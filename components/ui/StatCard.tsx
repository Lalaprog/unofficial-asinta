'use client';

import React from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: React.ReactNode;
  trend?: {
    value: string;
    isPositive?: boolean;
  };
  highlight?: boolean;
  alert?: boolean;
  className?: string;
  onClick?: () => void;
}

export const StatCard: React.FC<StatCardProps> = ({
  title,
  value,
  subtitle,
  icon,
  trend,
  highlight = false,
  alert = false,
  className,
  onClick,
}) => {
  return (
    <div
      onClick={onClick}
      className={twMerge(
        clsx(
          'h-full min-w-0 p-4 sm:p-5 rounded-xl bg-white border transition-colors duration-150 flex flex-col justify-between',
          highlight
            ? 'border-brand/25'
            : alert
            ? 'border-status-danger/25 bg-status-danger-bg/20'
            : 'border-surface-border',
          onClick && 'cursor-pointer hover:border-brand/35 focus-within:ring-2 focus-within:ring-brand/15',
          className
        )
      )}
    >
      <div className="flex items-start justify-between gap-2 min-w-0">
        <span className="text-xs font-medium text-ink-secondary truncate">
          {title}
        </span>
        {icon && (
          <div
            className={clsx(
              'p-2 rounded-lg text-brand shrink-0',
              alert
                ? 'bg-status-danger-bg/60 text-status-danger'
                : 'bg-surface-inset text-brand'
            )}
          >
            {icon}
          </div>
        )}
      </div>

      <div className="mt-3 min-w-0">
        <div className="text-2xl lg:text-3xl font-semibold tracking-tight text-navy tabular-nums truncate">
          {value}
        </div>
        {(subtitle || trend) && (
          <div className="mt-1.5 flex items-center gap-2 text-xs text-ink-secondary min-w-0">
            {trend && (
              <span
                className={clsx(
                  'font-semibold px-1.5 py-0.5 rounded-md text-[11px] shrink-0',
                  trend.isPositive
                    ? 'bg-status-success-bg text-status-success border border-status-success/20'
                    : 'bg-status-danger-bg text-status-danger border border-status-danger/20'
                )}
              >
                {trend.value}
              </span>
            )}
            {subtitle && <span className="truncate">{subtitle}</span>}
          </div>
        )}
      </div>
    </div>
  );
};
