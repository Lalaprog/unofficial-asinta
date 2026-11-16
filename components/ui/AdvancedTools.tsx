'use client';

import React, {useId, useState} from 'react';
import {ChevronDown} from 'lucide-react';

/**
 * One closed-by-default drawer for review, correction and legacy tools.
 * The primary workflow stays on the page; everything that used to compete
 * with it lives here. Nothing is hidden permanently and no action changes.
 */
export function AdvancedTools({
  title,
  description,
  children,
  defaultOpen = false,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return <section className="overflow-hidden rounded-2xl border border-surface-border bg-white">
    <button
      type="button"
      aria-expanded={open}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onClick={() => setOpen(value => !value)}
      className="flex min-h-11 w-full items-center justify-between gap-3 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand sm:p-5"
    >
      <span>
        <span id={`${id}-title`} className="block text-sm font-semibold text-navy">{title}</span>
        <span id={`${id}-description`} className="mt-1 block text-xs text-ink-secondary">{description}</span>
      </span>
      <ChevronDown aria-hidden="true" className={`h-4 w-4 shrink-0 text-ink-secondary transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} />
    </button>
    {open && <div className="space-y-3 border-t border-surface-border/70 p-4 sm:p-5">{children}</div>}
  </section>;
}
