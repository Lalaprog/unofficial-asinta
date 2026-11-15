import React from 'react';

/** In-page shortcuts: keep all sections mounted and never perform an action. */
export function WorkspaceJumpLinks({label, links}: {label: string; links: {href: string; label: string}[]}) {
  return <nav aria-label={label} className="rounded-2xl border border-surface-border bg-white p-3 sm:p-4">
    <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-ink-secondary">Jump to</p>
    <div className="flex flex-wrap gap-2">
      {links.map(link => <a key={link.href} href={link.href} className="inline-flex min-h-11 items-center justify-center rounded-lg border border-surface-border bg-surface-inset px-3 py-2 text-center text-xs font-semibold text-navy transition-colors hover:border-brand/40 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2">{link.label}</a>)}
    </div>
  </nav>;
}
