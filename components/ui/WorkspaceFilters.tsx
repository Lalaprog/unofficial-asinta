import React from 'react';

interface WorkspaceFiltersProps {
  title: string;
  children: React.ReactNode;
  summary: React.ReactNode;
}

/** Keeps list controls and their result feedback in one clearly labelled region. */
export function WorkspaceFilters({ title, children, summary }: WorkspaceFiltersProps) {
  return (
    <section aria-label={title} className="rounded-2xl border border-surface-border bg-white p-4 shadow-sm">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-navy">{title}</h2>
        <span className="text-xs text-ink-secondary">Search or narrow the list</span>
      </div>
      {children}
      <div className="mt-2 border-t border-surface-border/70 pt-1">{summary}</div>
    </section>
  );
}
