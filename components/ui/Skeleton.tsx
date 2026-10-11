import React from 'react';
import { clsx } from 'clsx';

/**
 * Neumorphic loading placeholder primitives. Keeps the exact geometry of KPI
 * cards and ledger rows while data hydrates or mutates.
 */
export const Skeleton: React.FC<{ className?: string }> = ({ className }) => (
  <div
    aria-hidden="true"
    className={clsx(
      'animate-pulse rounded-xl bg-gradient-to-r from-surface-inset via-surface to-surface-inset',
      className
    )}
  />
);

/** Placeholder for a stack of neumorphic list/table rows. */
export const SkeletonRows: React.FC<{ rows?: number; className?: string }> = ({
  rows = 5,
  className,
}) => (
  <div className={clsx('space-y-3', className)} aria-hidden="true">
    {Array.from({ length: rows }).map((_, index) => (
      <div
        key={index}
        className="p-4 rounded-2xl bg-white border border-surface-border shadow-[4px_4px_12px_rgba(11,31,58,0.04),-4px_-4px_12px_rgba(255,255,255,0.9)] flex items-center justify-between gap-4"
      >
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3.5 w-1/3" />
          <Skeleton className="h-3 w-2/3" />
        </div>
        <Skeleton className="h-8 w-24 rounded-xl" />
      </div>
    ))}
  </div>
);

/** Top-nav neumorphic page skeleton matching the KPI row and ledger table layout. */
export const SkeletonShell: React.FC = () => (
  <div className="min-h-screen bg-surface flex flex-col" aria-busy="true" aria-live="polite">
    <span className="sr-only">Loading your workspace…</span>
    {/* Top Navbar Skeleton */}
    <div className="h-16 bg-white/90 border-b border-surface-border/80 px-4 sm:px-6 lg:px-8 flex items-center justify-between max-w-7xl w-full mx-auto">
      <Skeleton className="h-8 w-28 rounded-xl" />
      <div className="hidden lg:flex items-center space-x-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-28 rounded-xl" />
        ))}
      </div>
      <div className="flex items-center space-x-2">
        <Skeleton className="h-10 w-10 rounded-xl" />
        <Skeleton className="h-10 w-10 rounded-xl" />
      </div>
    </div>

    {/* Main Workspace Skeleton */}
    <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      <div className="flex items-center justify-between pb-2 border-b border-surface-border/60">
        <div className="space-y-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-3.5 w-40" />
        </div>
        <Skeleton className="h-9 w-32 rounded-xl" />
      </div>

      {/* 4-Card KPI Row Skeleton */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="p-5 rounded-2xl bg-white border border-surface-border shadow-[4px_4px_12px_rgba(11,31,58,0.04),-4px_-4px_12px_rgba(255,255,255,0.9)] space-y-3"
          >
            <div className="flex items-center justify-between">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-9 w-9 rounded-xl" />
            </div>
            <Skeleton className="h-7 w-32" />
            <Skeleton className="h-3 w-40" />
          </div>
        ))}
      </div>

      <SkeletonRows rows={5} />
    </main>
  </div>
);
