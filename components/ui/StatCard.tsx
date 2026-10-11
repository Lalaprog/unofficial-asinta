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
          'h-full min-w-0 p-5 rounded-2xl bg-white border transition-all duration-200 flex flex-col justify-between',
          highlight
            ? 'border-navy/30 bg-gradient-to-br from-white to-slate-50/70 shadow-[7px_7px_20px_rgba(11,31,58,0.08),-7px_-7px_20px_rgba(255,255,255,0.95)]'
            : alert
            ? 'border-status-danger/20 bg-status-danger-bg/20 shadow-[6px_6px_18px_rgba(197,40,40,0.06),-6px_-6px_18px_rgba(255,255,255,0.95)]'
            : 'border-surface-border/70 shadow-[6px_6px_18px_rgba(11,31,58,0.06),-6px_-6px_18px_rgba(255,255,255,0.95)]',
          onClick && 'cursor-pointer hover:shadow-[8px_8px_22px_rgba(11,31,58,0.10),-8px_-8px_22px_rgba(255,255,255,1)] hover:-translate-y-0.5',
          className
        )
      )}
    >
      <div className="flex items-start justify-between gap-2 min-w-0">
        <span className="text-xs font-semibold uppercase tracking-wider text-ink-secondary truncate">
          {title}
        </span>
        {icon && (
          <div
            className={clsx(
              'p-2 rounded-xl text-navy shrink-0',
              alert
                ? 'bg-status-danger-bg/60 text-status-danger'
                : 'bg-surface-inset text-navy shadow-[inset_1px_1px_3px_rgba(11,31,58,0.06)]'
            )}
          >
            {icon}
          </div>
        )}
      </div>

      <div className="mt-3 min-w-0">
        <div className="text-2xl lg:text-3xl font-bold tracking-tight text-navy tabular-nums truncate">
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
