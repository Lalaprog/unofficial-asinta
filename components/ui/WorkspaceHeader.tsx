import React from 'react';

interface WorkspaceHeaderProps {
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}

/** A consistent entry point for task-oriented workspaces. */
export function WorkspaceHeader({ eyebrow, title, description, action }: WorkspaceHeaderProps) {
  return (
    <header data-page-guide="intro" className="animate-page-enter relative overflow-hidden rounded-2xl border border-[#e3ddd2] bg-[#f8f6f0] px-4 py-5 shadow-sm sm:px-6 sm:py-6">
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-brand/75 via-[#b5a68e]/55 to-transparent" />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-brand">{eyebrow}</p>
          <h1 className="mt-1.5 break-words text-2xl font-semibold tracking-tight text-navy sm:text-3xl">{title}</h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-secondary">{description}</p>
        </div>
        {action && <div data-page-guide="action" className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
      </div>
    </header>
  );
}
